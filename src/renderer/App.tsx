import { useState, useEffect, useCallback, useRef } from 'react';
import Layout from './components/Layout';
import PlayView from './components/PlayView';
import WorldsView from './components/WorldsView';
import IdentityView from './components/IdentityView';
import { LaunchStep } from './components/ForgeLine';
import { SetupView } from './components/SetupView';
import DockNav from './components/DockNav';

export type View = 'auth' | 'play' | 'worlds' | 'settings';

interface WorldData {
  id: string;
  name: string;
  type: 'managed' | 'personal';
  version: string;
  loader: string;
  loaderVersion: string;
  ramAllocation: number;
  assignedServer: { ip: string; port: number; label?: string } | null;
  lastPlayedAt: number | null;
  broken: boolean;
  createdAt: number;
}

const STEP_LABELS: Record<string, string> = {
  'authenticating': 'Authenticating',
  'preparing-java': 'Preparing Java',
  'ensuring-version': 'Downloading Minecraft',
  'installing-fabric': 'Installing Fabric',
  'injecting-server': 'Injecting Server Config',
  'installing-mods': 'Installing Mods & Packs',
  'launching': 'Launching',
  'running': 'Running',
  'closed': 'Closed',
};

const ALL_STEPS = ['authenticating', 'preparing-java', 'ensuring-version', 'installing-fabric', 'injecting-server', 'installing-mods', 'launching', 'running'];

// MCLC streams its file-transfer telemetry as launch-steps whose names are
// raw event types ('assets', 'classes', 'natives', …) belonging to no display
// stage. Route them into a weighted, monotonic composite that drives the
// 'ensuring-version' step — the Minecraft client download — with real
// measured progress. Weights approximate each transfer's share of the bytes;
// unseen buckets contribute 0 (never invented), and the composite never
// regresses. This is measurement, not animation: no timers, no fake percent.
const MCLC_BUCKETS: readonly { match: RegExp; weight: number }[] = [
  { match: /asset/i, weight: 0.55 },
  { match: /class|librar/i, weight: 0.35 },
  { match: /native/i, weight: 0.1 },
];

function mclcBucketIndex(step: string): number {
  for (let i = 0; i < MCLC_BUCKETS.length; i++) {
    if (MCLC_BUCKETS[i].match.test(step)) return i;
  }
  return -1;
}

function compositeMclc(buckets: Record<number, number>): number {
  let composite = 0;
  for (let i = 0; i < MCLC_BUCKETS.length; i++) {
    composite += (Math.min(100, Math.max(0, buckets[i] ?? 0)) / 100) * MCLC_BUCKETS[i].weight;
  }
  return Math.min(1, composite);
}

function App() {
  const [currentView, setCurrentView] = useState<View>('play');
  const [appVersion, setAppVersion] = useState<string>('');

  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchSteps, setLaunchSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const launchingRef = useRef(false);
  // True while the user has asked to abandon the in-flight launch. A cancel
  // settles the launch promise by REJECTING it (launch-service's stall-race
  // rejects with E307 so the await can't hang), and a deliberate cancel must
  // not surface as "Hit a snag." — this flag is what tells the two apart.
  const cancelRequestedRef = useRef(false);

  // MCLC download composite — reset at the start of every launch attempt.
  const mclcRef = useRef<{ buckets: Record<number, number>; composite: number }>({ buckets: {}, composite: 0 });

  // One warm flare from the hearth the instant a launch begins — the room
  // acknowledges the ignition before any step data arrives.
  const [hearthFlare, setHearthFlare] = useState(false);
  const prevLaunchingRef = useRef(false);

  // World state
  const [worlds, setWorlds] = useState<WorldData[]>([]);
  const [activeWorld, setActiveWorld] = useState<WorldData | null>(null);

  const loadWorlds = useCallback(async () => {
    try {
      const w = await window.electronAPI.getWorlds() as WorldData[];
      setWorlds(w);
      const active = await window.electronAPI.getActiveWorld() as WorldData | null;
      setActiveWorld(active);
    } catch { /* non-fatal — worlds system may not be ready */ }
  }, []);

  useEffect(() => {
    window.electronAPI.getAppVersion().then((version: string) => {
      setAppVersion(version);
    });

    window.electronAPI.isGameRunning().then((running: boolean) => {
      if (running) {
        setIsRunning(true);
        setLaunching(false);
        setLaunchSteps([]);
      }
    });

    loadWorlds();
  }, []);

  // Upsert a seeded step's status/fraction. 'done' is terminal within a
  // launch attempt: the work already happened, and a later re-emission of
  // 'working' (launch-game re-confirming an already-provisioned phase) must
  // not resurrect it — that would visibly rewind the filament.
  const upsertStep = useCallback((step: string, status: LaunchStep['status'], progress?: number) => {
    setLaunchSteps((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (s.step !== step) return s;
        if (s.status === 'done' && status === 'working') return s;
        const merged = progress !== undefined ? { ...s, status, progress } : { ...s, status };
        // Skip identity rewrites (high-frequency MCLC events often re-emit
        // the same values) so unchanged frames don't re-render the tree.
        if (merged.status === s.status && merged.progress === s.progress) return s;
        changed = true;
        return merged;
      });
      return changed ? next : prev;
    });
  }, []);

  // Subscribe to launch-step + java-progress events (app scope — App never
  // unmounts, so progress survives navigation by construction, REPORT-001).
  useEffect(() => {
    const handler = (step: string, status: string, progress: number) => {
      if (STEP_LABELS[step]) {
        // Known pipeline step: status only. launch-service's own percent
        // numbers are global display values, not stage fractions — ignored.
        upsertStep(step, status as LaunchStep['status']);
      } else {
        // Unknown names: MCLC file-transfer telemetry → composite → the
        // client-download step. Anything else carries no display value.
        // 'version-jar' is a real measured fraction (byte counter for the
        // client jar — the long silent single-file transfer) and maps onto
        // the same Minecraft-download step the composite feeds.
        if (step === 'version-jar' && typeof progress === 'number') {
          const pct = Math.min(100, Math.max(0, progress));
          const mclc = mclcRef.current;
          // Fold the jar into the assets bucket slot, weight-adjusted: jar
          // ≈ a tenth of first-launch transfer volume, so its measured 0..100
          // enters the composite at 0.55 × 0.1. Monotonic max, like the rest.
          const folded = pct * 0.1;
          const m = mclc.buckets[0] ?? 0;
          if (folded > m) mclc.buckets[0] = folded;
          mclc.composite = Math.max(mclc.composite, compositeMclc(mclc.buckets));
          upsertStep('ensuring-version', 'working', mclc.composite);
          return;
        }
        const bucket = mclcBucketIndex(step);
        if (bucket >= 0 && typeof progress === 'number') {
          const pct = Math.min(100, Math.max(0, progress));
          const mclc = mclcRef.current;
          mclc.buckets[bucket] = Math.max(mclc.buckets[bucket] ?? 0, pct);
          mclc.composite = Math.max(mclc.composite, compositeMclc(mclc.buckets));
          upsertStep('ensuring-version', 'working', mclc.composite);
        }
      }
      if (status === 'done' && step === 'running') {
        setIsRunning(true);
        setLaunching(false);
      }
      if (status === 'done' && step === 'stopped') {
        setIsRunning(false);
        setLaunching(false);
        setLaunchSteps([]);
      }
    };
    window.electronAPI.onLaunchStep(handler);

    // Real Java provisioning progress (0..100, monotonic by construction in
    // the provisioner): drives the Igniting stage's measured fraction.
    const onJava = (p: { phase: string; percent: number; message?: string }) => {
      upsertStep('preparing-java', 'working', Math.min(100, Math.max(0, p.percent)) / 100);
    };
    window.electronAPI.onJavaProgress(onJava);

    return () => {
      window.electronAPI.removeLaunchListeners();
      window.electronAPI.removeJavaProgressListeners();
    };
  }, [upsertStep]);

  // Hearth flare on the launching rising edge.
  useEffect(() => {
    if (launching && !prevLaunchingRef.current) {
      setHearthFlare(true);
      const t = setTimeout(() => setHearthFlare(false), 1150);
      prevLaunchingRef.current = launching;
      return () => clearTimeout(t);
    }
    prevLaunchingRef.current = launching;
  }, [launching]);

  const startLaunch = useCallback(async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    cancelRequestedRef.current = false;

    setLaunching(true);
    setLaunchError(null);
    setIsRunning(false);
    setLaunchSteps(
      ALL_STEPS.map((s) => ({ step: s, label: STEP_LABELS[s] || s, status: 'pending' as const }))
    );
    mclcRef.current = { buckets: {}, composite: 0 };

    try {
      let javaPath: string;
      try {
        javaPath = await window.electronAPI.getJavaPath();
        // Provisioning (or cache-hit) finished: Igniting is complete at the
        // measured 100 — never wait for launch-game to re-confirm it.
        upsertStep('preparing-java', 'done', 1);
      } catch {
        javaPath = 'java';
      }

      const result = await window.electronAPI.launchGame(javaPath);
      if (!result.success) {
        throw new Error(result.error || 'Launch failed');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Launch failed';
      // The user asked for this to stop. Return to the neutral state — a
      // deliberate cancel is not a failure, and "Hit a snag." would be a lie.
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
        setLaunching(false);
        setIsRunning(false);
        setLaunchSteps([]);
        return;
      }
      setLaunchError(message);
      setLaunching(false);
      setIsRunning(false);
      setLaunchSteps((prev) =>
        prev.map((s) =>
          s.status === 'working' || s.status === 'pending'
            ? { ...s, status: 'error' as const }
            : s
        )
      );
    } finally {
      launchingRef.current = false;
    }
  }, [upsertStep]);

  /**
   * Abandon an in-flight launch. The UI returns to neutral IMMEDIATELY rather
   * than waiting for the launch promise to settle — cancel must feel instant.
   * main's cancelLaunch() stops the watchdog, kills a spawned game process if
   * one exists, and rejects the pending stall-race so the await cannot hang.
   */
  const cancelLaunch = useCallback(async () => {
    if (!launchingRef.current) return;
    cancelRequestedRef.current = true;
    setLaunching(false);
    setLaunchError(null);
    setLaunchSteps([]);
    setIsRunning(false);
    try {
      await window.electronAPI.cancelLaunch();
    } catch (err) {
      // The launch promise still carries the rejection; nothing to surface.
      console.warn('[launch] cancel failed:', err);
    }
  }, []);

  const retryLaunch = useCallback(() => {
    setLaunchError(null);
    setLaunchSteps([]);
    setLaunching(false);
    setIsRunning(false);
    mclcRef.current = { buckets: {}, composite: 0 };
  }, []);

  const handleSetActiveWorld = useCallback(async (id: string) => {
    // Optimistic: move the ember/active state immediately so switching feels
    // instant (the disk write is <1ms; the round-trip should never be felt).
    const target = worlds.find((w) => w.id === id) || null;
    if (target) setActiveWorld(target);

    const result = await window.electronAPI.setActiveWorld(id);
    if (!result.success) {
      console.warn('[worlds] switch failed:', result.error);
    }
    // Always reconcile with the registry's truth — success confirms the
    // optimistic state, failure reverts it. The UI can never drift.
    await loadWorlds();
  }, [worlds, loadWorlds]);

  // Play directly from the Worlds shelf: make the world active, hand the
  // user back to the Play view so they watch the launch filament, then run
  // the same guarded pipeline the Play CTA uses (launchingRef still guards
  // against double-fire). Broken worlds never reach here from the UI —
  // the shelf's Play button is disabled — but the guard is belt-and-braces.
  const handlePlayWorld = useCallback(async (worldId: string) => {
    const target = worlds.find((w) => w.id === worldId);
    if (!target || target.broken) return;
    if (launchingRef.current || isRunning) return;
    await handleSetActiveWorld(worldId);
    setCurrentView('play');
    startLaunch();
  }, [worlds, isRunning, handleSetActiveWorld, startLaunch]);

  // Keep-alive navigation: every view stays mounted and visibility is driven
  // by CSS display instead of mount/unmount. The Play scene (two WebGL
  // contexts + three.js shader compilation) is the cost the old switch()
  // paid on every return trip — a measured 70–95ms main-thread freeze on
  // Worlds→Play. Hiding rather than unmounting keeps those contexts alive,
  // and PlayView's IntersectionObserver keeps its RAF paused while hidden,
  // so nothing burns GPU in the background. One-time effects elsewhere
  // (worlds list, identity accounts) still run on first mount as before;
  // nothing in these views depends on remounting to refresh its data.
  const renderView = () => (
    <>
      <div className="h-full" style={{ display: currentView === 'auth' ? 'block' : 'none' }}>
        <IdentityView />
      </div>
      <div className="h-full" style={{ display: currentView === 'play' ? 'block' : 'none' }}>
        <PlayView
          launching={launching}
          launchError={launchError}
          launchSteps={launchSteps}
          isRunning={isRunning}
          onPlay={startLaunch}
          onRetry={retryLaunch}
          onCancelLaunch={cancelLaunch}
          activeWorld={activeWorld}
          worlds={worlds}
          onSetActiveWorld={handleSetActiveWorld}
        />
      </div>
      <div className="h-full" style={{ display: currentView === 'worlds' ? 'block' : 'none' }}>
        <WorldsView
          worlds={worlds}
          activeWorldId={activeWorld?.id || null}
          onSetActive={handleSetActiveWorld}
          onWorldsChanged={loadWorlds}
          onPlayWorld={handlePlayWorld}
        />
      </div>
      <div className="h-full" style={{ display: currentView === 'settings' ? 'block' : 'none' }}>
        <SetupView activeWorld={activeWorld} onWorldsChanged={loadWorlds} />
      </div>
    </>
  );

  return (
    <>
      <Layout version={appVersion}>
        {renderView()}
      </Layout>

      <DockNav currentView={currentView} onNavigate={setCurrentView} />

      {/* Hearth glow */}
      <div className={hearthFlare ? 'hearth catching' : 'hearth'} />
    </>
  );
}

export default App;