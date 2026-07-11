import { useState, useEffect, useCallback, useRef } from 'react';
import Layout from './components/Layout';
import PlayView from './components/PlayView';
import WorldsView from './components/WorldsView';
import IdentityView from './components/IdentityView';
import { LaunchStep } from './components/ForgeLine';
import SettingsView from './components/SettingsView';
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

function App() {
  const [currentView, setCurrentView] = useState<View>('play');
  const [appVersion, setAppVersion] = useState<string>('');

  // Launch state
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchSteps, setLaunchSteps] = useState<LaunchStep[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const launchingRef = useRef(false);

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

  // Subscribe to launch-step events
  useEffect(() => {
    const handler = (step: string, status: string) => {
      setLaunchSteps((prev) => {
        const existing = prev.find((s) => s.step === step);
        if (existing) {
          return prev.map((s) =>
            s.step === step ? { ...s, status: status as LaunchStep['status'] } : s
          );
        }
        return [
          ...prev,
          { step, label: STEP_LABELS[step] || step, status: status as LaunchStep['status'] },
        ];
      });
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
    return () => window.electronAPI.removeLaunchListeners();
  }, []);

  const startLaunch = useCallback(async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;

    setLaunching(true);
    setLaunchError(null);
    setIsRunning(false);
    setLaunchSteps(
      ALL_STEPS.map((s) => ({ step: s, label: STEP_LABELS[s] || s, status: 'pending' as const }))
    );

    try {
      let javaPath: string;
      try {
        javaPath = await window.electronAPI.getJavaPath();
      } catch {
        javaPath = 'java';
      }

      const result = await window.electronAPI.launchGame(javaPath);
      if (!result.success) {
        throw new Error(result.error || 'Launch failed');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Launch failed';
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
  }, []);

  const retryLaunch = useCallback(() => {
    setLaunchError(null);
    setLaunchSteps([]);
    setLaunching(false);
    setIsRunning(false);
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

  const renderView = () => {
    switch (currentView) {
      case 'auth':
        return <IdentityView />;
      case 'play':
        return (
          <PlayView
            launching={launching}
            launchError={launchError}
            launchSteps={launchSteps}
            isRunning={isRunning}
            onPlay={startLaunch}
            onRetry={retryLaunch}
            activeWorld={activeWorld}
            worlds={worlds}
            onSetActiveWorld={handleSetActiveWorld}
          />
        );
      case 'worlds':
        return (
          <WorldsView
            worlds={worlds}
            activeWorldId={activeWorld?.id || null}
            onSetActive={handleSetActiveWorld}
            onWorldsChanged={loadWorlds}
          />
        );
      case 'settings':
        return <SettingsView activeWorld={activeWorld} />;
      default:
        return null;
    }
  };

  return (
    <>
      <Layout version={appVersion}>
        {renderView()}
      </Layout>

      <DockNav currentView={currentView} onNavigate={setCurrentView} />

      {/* Hearth glow */}
      <div className="hearth" />
    </>
  );
}

export default App;