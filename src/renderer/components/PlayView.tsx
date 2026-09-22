import React, { useState, useEffect, useMemo, useRef } from 'react';
import ForgeLine, { LaunchStep } from './ForgeLine';
import PlayerIdentity from './fx/PlayerIdentity';
import BlurText from './fx/BlurText';
import WorldSwitcher from './WorldSwitcher';
import SideRays from './fx/SideRays';
import MagicRings from './fx/MagicRings';
// The atmosphere (WorldBeacon / React Bits LightPillar) used to be a page layer
// behind the stage. It is now a scene element INSIDE the WebGL canvas
// (PlayerDirector ATMOSPHERE_CONFIG), for three reasons: a page layer can never
// sit behind the character, it drew a hard cut at the canvas top edge, and by
// owning the band above the stage it capped how large the hero could be. The
// component is kept in the repo (fx/WorldBeacon.tsx) but no longer mounted.
import { SMP_SERVER_HOST, SMP_SERVER_PORT } from '../../shared/constants';
import { isOomReason, mapDiagnosisToActions, unmatchedModNote } from '../../shared/oracle-recovery';
import type { InstalledMod, ModUpdateInfoLike, RecoveryAction } from '../../shared/oracle-recovery';

// SideRays (React Bits, ogl — vendor-pristine, locked owner config) is the
// approved ambient light field for this composition: an amber directional
// glow from the top-right that belongs to the ROOM, not the character. It
// mounts as the first layer of the Play view (z-0, pointer-events none per
// its vendor CSS) behind the content column (stage/rail ride z-10), exactly
// where the WorldBeacon page layer lived — the skin canvas is opaque, so no
// page layer can sit behind the character itself; the field frames it from
// the sides and above the hero band instead. Character, camera, stage and
// in-canvas lighting are untouched (PlayerDirector owns those).

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
}

interface PlayViewProps {
  launching: boolean;
  launchError: string | null;
  launchSteps: LaunchStep[];
  isRunning: boolean;
  onPlay: () => void;
  onRetry: () => void;
  /** Abandon an in-flight launch. Optional so the view still renders in any
   *  older composition — the affordance simply doesn't appear without it. */
  onCancelLaunch?: () => void;
  /** Quiet entry to the console. sessionId null = live session; a crashed
   *  session's id preloads the evidence view straight to the Oracle pin. */
  onOpenConsole?: (sessionId: string | null) => void;
  activeWorld: WorldData | null;
  worlds: WorldData[];
  onSetActiveWorld: (id: string) => void;
}

const STAGES = [
  { id: 'auth', label: 'Authenticating', real: ['authenticating'] },
  { id: 'jre',  label: 'Igniting',       real: ['preparing-java'] },
  { id: 'mods', label: 'Forging',        real: ['ensuring-version', 'installing-fabric', 'installing-mods', 'injecting-server'] },
  { id: 'mc',   label: 'Launching',      real: ['launching', 'running'] },
] as const;

const SERVER_HOST = SMP_SERVER_HOST;

/**
 * The hero composition's two independent heights (see the HERO LAYER comment
 * in the markup below).
 *
 *   HERO_SLOT   the vertical space the DOCUMENT reserves for the hero. The
 *               eyebrow, h1, sub-line, CTA and dock are all positioned by this
 *               and nothing else — it is the composition's spine.
 *   HERO_CANVAS the WebGL stage's actual height. It may exceed HERO_SLOT at any
 *               time: the canvas is absolutely positioned inside the slot, so
 *               hero scale stops being a layout input entirely.
 *
 * WHY THIS MATTERS (measured, pass 019): canvas height → character height →
 * CTA position used to be one chain. Raising the canvas to 352px pushed the CTA
 * bottom to 696.8 against a dock top of 692.4 — a collision. Decoupling removes
 * the chain, so hero scale can now be judged purely visually.
 *
 * THE CEILING IS NOT THIS SLOT, IT IS THE CHROME. The hero's usable band runs
 * from the eyebrow (ends ~142, then mb-3) to the top of the h1 (501.6) — about
 * 351px — and both of those are frozen UI. At 87.4% of the canvas that caps the
 * character at ~307px = 38.3% of an 800px viewport. The current 348px canvas
 * puts the character at 303.2px = 37.9%, i.e. within 4px of the structural
 * maximum. Beyond it, one of three collisions is unavoidable: the head meets
 * the eyebrow, the feet/pool meet the h1, or the floor strip is cropped away
 * (which would cost the grounding). Do not raise HERO_CANVAS past ~352 without
 * deciding which of those the composition should accept.
 */
const HERO_SLOT = 'clamp(200px, 38vh, 380px)';
/**
 * 52vh = 416px at 1280x800 — the RENDER FRAME, deliberately larger than the
 * slot the document reserves (348px). The canvas is absolutely positioned, so
 * the extra 68px overhangs invisibly inside the page; what it buys is INTERNAL
 * breathing room around the character, which is what stops the scene reading as
 * a PNG clipped by a rectangle.
 *
 * 023's defect, measured (probe-024-baseline.mjs): the character's head had
 * **0.0 CSS px** of margin at the canvas' top edge, and the floor light's trace
 * reached **0.0** at the left edge. A frame the same size as the composition
 * cannot show the room around the subject — hence pass 024's separation of
 * render frame (this) from the document slot (HERO_SLOT).
 *
 * HERO_SLOT is deliberately NOT raised alongside it. The content column is
 * centred, so extra slot height pushes the CTA down by half of it: 348 → 416
 * would move the CTA from 629.8 to ~663.8, i.e. its bottom 712.8 against a dock
 * top of 692.4 — a 20px collision. Gates 13/14 and §15 require the CTA and dock
 * to stay exactly where they are, and §6 defines this fix as a larger render
 * frame, so only HERO_CANVAS grows.
 */
const HERO_CANVAS = 'clamp(280px, 46vh, 460px)';

const EMBER_KEY = 'mu-launcher-embers';
function getEmberCount(): number {
  try { return parseInt(localStorage.getItem(EMBER_KEY) || '0', 10); } catch { return 0; }
}

/** The active stage label while launching — it becomes the hero word. */
function activeStageLabel(steps: LaunchStep[]): string {
  for (const stage of STAGES) {
    const real: readonly string[] = stage.real;
    const relevant = steps.filter((s) => real.includes(s.step));
    if (relevant.some((s) => s.status === 'working')) return stage.label;
  }
  return 'Igniting';
}

const PlayView: React.FC<PlayViewProps> = ({
  launching, launchError, launchSteps, isRunning, onPlay, onRetry, onCancelLaunch,
  activeWorld, worlds, onSetActiveWorld, onOpenConsole,
}) => {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [hasLaunchedBefore] = useState(getEmberCount() > 0);
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [serverStatus, setServerStatus] = useState<{ online: boolean; players?: { online: number; max: number } } | null>(null);
  // THE ORACLE — the active world's last-crash attribution, surfaced as a
  // warning banner before the user launches again. null = no crash found.
  const [crashWarning, setCrashWarning] = useState<{ modName?: string; reason?: string } | null>(null);
  // Mod Update Notifier — count of outdated mods in the active world.
  const [modUpdateCount, setModUpdateCount] = useState(0);
  // ORACLE RECOVERY — the attribution→action layer's renderer state. The
  // context pieces (installed files, update-checker product) come from the
  // SAME IPC calls this view already makes; the mapping itself is pure
  // (src/shared/oracle-recovery.ts) and never invents a pipeline.
  const [recoveryMods, setRecoveryMods] = useState<InstalledMod[]>([]);
  const [recoveryUpdates, setRecoveryUpdates] = useState<ModUpdateInfoLike[]>([]);
  const [recoveryBusy, setRecoveryBusy] = useState<string | null>(null);
  const [recoveryDone, setRecoveryDone] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  // Skin sync — bump to remount PlayerIdentity so the hero re-pulls the
  // worn skin (hit the fresh write-through cache, zero network) after an
  // equip in the Identity Studio. The view is keep-alive: without this,
  // the hero's skin would stay stale in memory forever.
  const [playerSkinEpoch, setPlayerSkinEpoch] = useState(0);

  useEffect(() => { checkAuth(); }, []);

  // Push sync: any auth/account mutation anywhere in the app (sign-in from
  // the Account tab, removal, switch, startup import) re-checks here — the
  // Play gate can no longer go stale while IdentityView holds new state.
  useEffect(() => {
    window.electronAPI.onAuthChanged(() => { checkAuth(); });
    return () => window.electronAPI.removeAuthChangedListeners();
  }, []);

  // Live Server Pulse — poll status on mount and every 30s. The pinger
  // lives in the main process (SLP over a raw socket); failures come back
  // as { online: false }, never as a throw, so the UI just degrades to
  // the offline line. The target follows the active world's assigned
  // server when one exists, falling back to the built-in SMP host.
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const host = activeWorld?.assignedServer?.ip || SERVER_HOST;
        const port = activeWorld?.assignedServer?.port || SMP_SERVER_PORT;
        const status = await window.electronAPI.pingServer(host, port);
        setServerStatus(status);
      } catch { setServerStatus({ online: false }); }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [activeWorld]);

  // THE ORACLE — diagnose the active world's most recent crash on mount and
  // on every world switch. diagnoseLastCrash never throws; a non-throwing
  // guard keeps a failed IPC from ever wedging the view.
  useEffect(() => {
    if (!activeWorld) return;
    setRecoveryDone(null);
    setRecoveryError(null);
    setRecoveryBusy(null);
    window.electronAPI.diagnoseWorld(activeWorld.id).then((result) => {
      if (result.crashed) {
        setCrashWarning({ modName: result.modName, reason: result.reason });
      } else {
        setCrashWarning(null);
        setRecoveryMods([]);
      }
    }).catch(() => setCrashWarning(null));
    // The recovery context's mod list — the same listMods call the Mod
    // Manager uses. A failure just means no mod actions can be honestly
    // offered (the pure mapping then yields console-only).
    window.electronAPI.listMods(activeWorld.id)
      .then((list) => setRecoveryMods(Array.isArray(list) ? list : []))
      .catch(() => setRecoveryMods([]));
  }, [activeWorld]);

  // Mod Update Notifier — check on mount and on every world switch. The
  // backend returns the updates array directly; any failure just keeps the
  // count quiet.
  useEffect(() => {
    if (!activeWorld) return;
    window.electronAPI.checkModUpdates(activeWorld.id).then((result) => {
      const updates = Array.isArray(result) ? result : [];
      setModUpdateCount(updates.length);
      setRecoveryUpdates(updates); // the "has an update?" branch feeds from this
    }).catch(() => { setModUpdateCount(0); setRecoveryUpdates([]); });
  }, [activeWorld]);

  // ORACLE RECOVERY — the decision table, evaluated from renderer state.
  // Pure (src/shared/oracle-recovery.ts): an undefined attribution yields
  // console-only; an unmatched mod name yields console-only + the honest
  // note; the fallback 'open-console' action rides the existing
  // onOpenConsole(null) path. Actions recompute as context arrives.
  const recoveryActions: RecoveryAction[] = useMemo(
    () => (crashWarning
      ? mapDiagnosisToActions(crashWarning, {
          mods: recoveryMods,
          updates: recoveryUpdates,
          ramAllocation: activeWorld?.ramAllocation,
        })
      : []),
    [crashWarning, recoveryMods, recoveryUpdates, activeWorld?.ramAllocation],
  );
  const recoveryNote = useMemo(
    () => (crashWarning ? unmatchedModNote(crashWarning, { mods: recoveryMods, updates: recoveryUpdates }) : null),
    [crashWarning, recoveryMods, recoveryUpdates],
  );
  // Honest head-line vocabulary: a named mod states the fact; an OOM
  // attribution (low confidence) gets the "might be" downgrade; an unknown
  // attribution gets the no-hope line — never a repair button.
  const crashHeadline = crashWarning?.modName
    ? `${crashWarning.modName} caused your last crash.`
    : isOomReason(crashWarning?.reason)
      ? 'your world might have run out of memory.'
      : "couldn't name this one. details in the console.";

  // Skin sync — a successful equip in the Identity Studio must reach the hero
  // immediately: remount PlayerIdentity (keep-alive means it never re-fetches
  // on its own) so it re-pulls the skin through the written-through cache.
  useEffect(() => {
    window.electronAPI.onSkinChanged(() => {
      setPlayerSkinEpoch((e) => e + 1);
    });
    return () => window.electronAPI.removeSkinChangedListeners();
  }, []);

  // Outside-click + Escape close the switcher. Owning this at the eyebrow
  // wrapper — which contains BOTH the trigger and the popover — is what makes
  // switching reliable: a click on the trigger reads as "inside", so the
  // trigger's own toggle runs cleanly instead of racing a popover-owned
  // mousedown listener (the old bug: close-on-mousedown fired a beat before
  // the trigger's click, flickering the popover open↔closed).
  const eyebrowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showSwitcher) return;
    const onDown = (e: MouseEvent) => {
      if (eyebrowRef.current && !eyebrowRef.current.contains(e.target as Node)) {
        setShowSwitcher(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSwitcher(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showSwitcher]);

  const checkAuth = async () => {
    setCheckingAuth(true);
    try {
      const status = await window.electronAPI.getAuthStatus();
      setIsLoggedIn(status.loggedIn && status.profile !== null);
      if (status.profile) setProfileName(status.profile.name);
    } catch { setIsLoggedIn(false); }
    finally { setCheckingAuth(false); }
  };

  const handlePlay = () => {
    if (!isLoggedIn) { setShowAuthPanel(true); return; }
    setShowSwitcher(false); // never leave a stale popover open across a launch
    try { localStorage.setItem(EMBER_KEY, String(getEmberCount() + 1)); } catch { /* ignore */ }
    onPlay();
  };

  // ── ORACLE RECOVERY — the executor ──────────────────────────────────────
  // Mapping → existing pipelines, nothing else: perform-mod-update,
  // mod-delete, update-world-settings, onOpenConsole. Failures leave ALL
  // state unchanged (honest failure: "nothing changed") and speak human.
  const handleRecovery = async (action: RecoveryAction) => {
    if (!activeWorld || recoveryBusy) return;
    setRecoveryBusy(action.id);
    setRecoveryError(null);
    setRecoveryDone(null);
    try {
      if (action.id === 'open-console') {
        onOpenConsole?.(null);
        return;
      }
      if (action.id === 'update-mod') {
        const update = recoveryUpdates.find((u) => u.filename === action.filename);
        if (!update) {
          setRecoveryError("couldn't reach modrinth. nothing changed.");
          return;
        }
        const result = await window.electronAPI.performModUpdate(
          activeWorld.id, update.filename, update.downloadUrl, update.newFilename,
        );
        if (!result.success) {
          setRecoveryError(
            /fetch|network|ENOTFOUND|HTTP|timed? out/i.test(result.error ?? '')
              ? "couldn't reach modrinth. nothing changed."
              : "couldn't update the mod. nothing changed.",
          );
          return;
        }
        setRecoveryDone(`${(crashWarning?.modName ?? 'the mod').toLowerCase()} updated. relaunch?`);
      } else if (action.id === 'remove-mod') {
        if (!action.filename) return;
        const result = await window.electronAPI.deleteMod(activeWorld.id, action.filename);
        if (!result.success) {
          setRecoveryError("couldn't remove the mod. nothing changed.");
          return;
        }
        setRecoveryDone(`${(crashWarning?.modName ?? 'the mod').toLowerCase()} removed. relaunch?`);
      } else if (action.id === 'adjust-memory') {
        // Same control the Setup screen owns (update-world-settings, RAM
        // bounds 1024–16384) — doubling the current allocation, clamped.
        const next = Math.min(16384, Math.max(1024, (activeWorld.ramAllocation || 4096) * 2));
        const result = await window.electronAPI.updateWorldSettings(activeWorld.id, { ramAllocation: next });
        if (!result.success) {
          setRecoveryError("couldn't change memory. nothing changed.");
          return;
        }
        setRecoveryDone(`gave the game ${next} MB. relaunch?`);
      }
      // A changed mods/ directory re-pulls the recovery context so the
      // actions can't drift from what the disk actually holds.
      const list = await window.electronAPI.listMods(activeWorld.id).catch(() => []);
      setRecoveryMods(Array.isArray(list) ? list : []);
    } catch {
      setRecoveryError("couldn't reach modrinth. nothing changed.");
    } finally {
      setRecoveryBusy(null);
    }
  };

  // ── Connecting (initial auth check) ─────────────────────────────────────
  if (checkingAuth && !launching) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="dot-breathe h-[6px] w-[6px] rounded-full bg-ember" />
        <p className="microlabel">Establishing connection</p>
      </div>
    );
  }

  // One display word carries the state (Law 2). Keyed so it rises on change.
  const hero = launchError
    ? 'Hit a snag.'
    : isRunning
      ? 'In the world.'
      : launching
        ? `${activeStageLabel(launchSteps)}.`
        : isLoggedIn
          ? 'Ready.'
          : 'Almost there.';

  const sub = launchError
    ? launchError
    : isRunning
      ? 'Minecraft is running — see you in there.'
      : launching
        ? 'Setting the world up. This is quick after the first time.'
        : isLoggedIn
          ? `The world is waiting${profileName ? `, ${profileName}` : ''}.`
          : 'Sign in with Microsoft to step into the SMP.';

  // The world's mood now lives INSIDE the scene (the atmosphere rides the
  // director's ignition ramp), so this view no longer computes a beacon state.

  // Eyebrow: world name +  when ≥2 worlds, else just the server host.
  const hasMultipleWorlds = worlds.length >= 2;
  const eyebrowText = activeWorld
    ? activeWorld.name
    : SERVER_HOST;

  // Metadata rail: render active world's config, not hardcoded values.
  // Three facts — what, on what, where. Machine tuning (RAM) lives in Setup.
  const railVersion = activeWorld?.version || '26.1.2';
  const railLoader = activeWorld
    ? activeWorld.loader === 'vanilla'
      ? 'Vanilla'
      : `${activeWorld.loader.charAt(0).toUpperCase() + activeWorld.loader.slice(1)} ${activeWorld.loaderVersion}`
    : 'Fabric 0.19.3';
  const railHost = activeWorld?.assignedServer?.ip || SERVER_HOST;

  // Switching disabled while launching or running (PROD-006 §5.6).
  const canSwitchWorlds = hasMultipleWorlds && !launching && !isRunning && !launchError;

  return (
    <div className="relative z-[1] flex h-full flex-col">
      {/* ── SideRays — the approved amber light field ──────────────────────
          Mounted INSIDE PlayView (unmounts with the view — the Intersection
          Observer starts its render loop only while visible; vendor cleanup
          kills the context on unmount). It fills the whole stage area: the
          -mx-10 cancels the stage column's px-10 so the field reaches the
          window edges with no dark gutters, and Layout's overflow-hidden
          clips it. z-0 sits below the stage/rail (z-10) and below the dock
          (z-50); vendor CSS keeps pointer-events none, so no interaction is
          blocked. The container is transparent (ogl alpha:true) — the rays
          composite over the room's ground, no rectangle seam possible. */}
      <div className="pointer-events-none absolute inset-0 z-0 -mx-10" aria-hidden>
        <SideRays
          speed={3.7}
          rayColor1="#E6A55C"
          rayColor2="#C88735"
          intensity={0.8}
          spread={0.6}
          origin="top-right"
          tilt={45}
          saturation={2}
          blend={0.75}
          falloff={4}
          opacity={0.4}
        />
      </div>

      {/* ── The stage ────────────────────────────────────────────────────
          m-auto instead of justify-center: with a plain centered flex column,
          content taller than the stage overflows BOTH ends and the top
          (the eyebrow, h1) is clipped away by main's scroll edge. m-auto
          pushes the overflow into scrollable space below instead — the
          measured failure it fixes is the crash-warning banner at 900x600. */}
      <div className="relative z-10 m-auto min-h-0 flex w-full flex-col items-center px-10 py-4">
        {/* Eyebrow — above the character, quiet, like a label on a museum card.
            With one world: just the server host (unchanged).
            With ≥2 worlds: the active world's name; a chevron surfaces on hover
            and opens the switcher. One quiet trigger, one interaction. */}
        {hasMultipleWorlds && activeWorld ? (
          <div ref={eyebrowRef} className="rise relative mb-3">
            <button
              onClick={() => canSwitchWorlds && setShowSwitcher((v) => !v)}
              disabled={!canSwitchWorlds}
              aria-haspopup="listbox"
              aria-expanded={showSwitcher}
              className="group microlabel flex cursor-pointer items-center gap-1.5 !text-faint transition-colors duration-micro hover:!text-dim disabled:cursor-default disabled:hover:!text-faint"
            >
              {eyebrowText}
              {canSwitchWorlds && (
                <svg
                  width="8" height="8" viewBox="0 0 12 12" fill="none"
                  stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
                  className={`transition-opacity duration-micro group-hover:opacity-100 ${showSwitcher ? 'opacity-100' : 'opacity-0'}`}
                >
                  <path d="M3 4.5L6 7.5L9 4.5" />
                </svg>
              )}
            </button>
            {showSwitcher && canSwitchWorlds && (
              <WorldSwitcher
                worlds={worlds}
                activeWorldId={activeWorld?.id || null}
                onSelect={(id) => {
                  if (id !== activeWorld?.id) onSetActiveWorld(id);
                  setShowSwitcher(false);
                }}
              />
            )}
          </div>
        ) : (
          /* P2-1: the top bar already carries the brand name — a one-world
             eyebrow above it only repeats it (or the server host, which the
             rail already owns). Render nothing on this screen. */
          null
        )}

        {/* ── HERO LAYER — decoupled from the document flow ────────────────────
            The flow reserves a fixed slot (HERO_SLOT = the composition's height)
            and the canvas is absolutely positioned inside it (HERO_CANVAS). The
            two are independent, so hero scale is not a layout input: growing the
            canvas moves nothing (verified live — 348 → 420 px moved none of
            h1/CTA/dock/rail).

            WHY THE SLOT CLIPS (overflow-hidden): the render frame is deliberately
            LARGER than the slot so the composition can breathe (head margin 20px,
            atmosphere 74/62 CSS clear of the edges). Before this clip the extra
            68px was PAINTED, and it was measurable: the canvas renders a flat
            room colour while the page below y≈484 CSS is warmed by the body's
            hearth gradient, so the overhang drew a 420×68px band at red 11.0 over
            a page reading 12.5–13.0 — a faint darker rectangle across the top of
            the headline's line box, ending in a +2.0 hard step at y=569.7.

            Clipping to the slot keeps the whole render (character scale 20px head
            margin, floor pool 82px clear of the bottom, atmosphere intact) and
            ends the paint exactly at the headline's box top (501.6) — where the
            canvas' content and the page ground are closest, and crucially ABOVE
            the glyphs, so no edge can ever cross the hero typography. Measured
            after: the 68px darker band is gone and the edge step drops +2.0 → −1.6.

            The wrapper is wider than the character: the light pool needs
            lateral room inside the canvas edges. Static under reduced-motion. */}
        {isLoggedIn && (
          <div className="rise relative w-[420px] min-h-[96px] overflow-hidden" style={{ height: HERO_SLOT }}>
            {/* ── MagicRings — the character's identity/aura layer (React Bits,
                vendor-pristine; see fx/MagicRings.jsx) ──────────────────────
                ONE instance, mounted as the FIRST child of the hero slot so it
                paints behind the character frame (DOM order; same stacking
                level). Its box spans the hero slot exactly (inset-0 — the slot
                is the ring field's frame): the ring field's center therefore
                coincides with the slot center by construction. The skin canvas is transparent (clear alpha 0,
                scene.background = null), so the rings show through everywhere
                the scene does not paint and the character OCCLUDES them where
                they overlap — the required behind-character order.
                alphaMode="coverage" is REQUIRED, not a tuning choice: the
                vendor default ('luminance') derives outputAlpha from the
                noise-contaminated color, painting a speckle film over the
                whole quad — the rejected grainy rectangle. Coverage mode
                makes alpha come from the ring signal itself (≈0 off-ring,
                >0 on-ring). The rectangle was finished off in the shader
                (fx/MagicRings.jsx corrective patches): the noise term is
                now gated by ring coverage — with a premultiplied-alpha
                canvas, rgb>0 @ a=0 composites ADDITIVELY, so the ungated
                noise leaked grain onto the full quad even in coverage
                mode — and output alpha dissolves to zero across a 6%
                boundary window at the canvas edge so outer ring arcs
                cannot present hard straight-edge cuts. noiseAmount stays 0.1 (dithers ring
                pixels only). Renderer is alpha:true, clear 0x000000@0.
                pointer-events-none keeps the layer ambient: the vendor's own
                mouse/hover/click listeners can never fire, matching the locked
                followMouse=false / clickBurst=false. Approved props are LOCKED
                (§2 of the integration brief) — do not tune them here. */}
            <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
              <MagicRings
                color="#C88735"
                colorTwo="#C88735"
                ringCount={3}
                speed={0.6}
                attenuation={10}
                lineThickness={2}
                baseRadius={0.35}
                radiusStep={0.1}
                scaleRate={0.1}
                opacity={1}
                blur={0}
                noiseAmount={0.1}
                rotation={0}
                ringGap={1.5}
                fadeIn={0.7}
                fadeOut={0.5}
                followMouse={false}
                mouseInfluence={0.2}
                hoverScale={1.2}
                parallax={0.05}
                clickBurst={false}
                alphaMode="coverage"
              />
            </div>
            <div className="absolute left-0 top-0 w-full" style={{ height: HERO_CANVAS }}>
              <PlayerIdentity key={playerSkinEpoch} energetic={launching} />
            </div>
          </div>
        )}

        {/* Hero word — premium state typography. The h1 is keyed on the
            state string, so each state change remounts BlurText and replays
            the word-resolve entrance; the h1 keeps the geometry (size,
            leading, balance) so nothing shifts between states. */}
        <h1
          key={hero}
          className="rise d1 max-w-[14ch] text-center font-display text-[72px] font-bold leading-[1.02] tracking-[-0.045em] text-ink [text-wrap:balance]"
        >
          <BlurText text={hero} />
        </h1>

        {/* THE ORACLE — crash warning + recovery actions. Sits between the
            hero word and the sub-line so the diagnosis is read BEFORE the
            call to action. Idle states only — an in-flight launch or a
            running game must not be interrupted by a stale-crash warning.
            Honesty red line: an unattributed crash (no modName, no OOM) shows
            the no-hope line and console evidence — never a repair button. */}
        {crashWarning && !launching && !isRunning && (
          <div className="rise mt-3 flex flex-col items-center gap-2 rounded-[10px] border border-danger/20 bg-danger/5 px-4 py-2.5">
            <div className="flex items-center justify-center gap-3">
              <span className="text-[12px] text-danger">{crashHeadline}</span>
              {recoveryNote && (
                <span className="text-[11px] text-faint">{recoveryNote}</span>
              )}
              {onOpenConsole && !recoveryActions.some((a) => a.id === 'open-console') && (
                <button
                  onClick={() => onOpenConsole(null)}
                  className="text-[11px] text-faint underline-offset-2 transition-colors duration-micro hover:text-dim hover:underline"
                >
                  console
                </button>
              )}
            </div>
            {/* Recovery actions — same visual language as the equip ritual
                (amber solid = the one primary, text = secondaries), but
                restrained: a repair moment, not a celebration. Busy state
                reuses the equip in-flight pattern: disabled + soft pulse. */}
            {recoveryActions.length > 0 && (
              <div className="flex items-center justify-center gap-2" data-testid="oracle-recovery">
                {recoveryActions.map((action) =>
                  action.id === 'open-console' ? (
                    <button
                      key={action.id}
                      data-testid={`oracle-action-${action.id}`}
                      onClick={() => handleRecovery(action)}
                      className="cursor-pointer text-[11px] text-faint underline-offset-2 transition-colors duration-micro hover:text-dim hover:underline"
                    >
                      show evidence
                    </button>
                  ) : (
                    <button
                      key={action.id}
                      data-testid={`oracle-action-${action.id}`}
                      disabled={recoveryBusy !== null}
                      onClick={() => handleRecovery(action)}
                      className={`rounded-full px-3.5 py-1 text-[12px] font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-default ${
                        recoveryBusy === action.id ? 'oracle-fix-busy' : ''
                      } ${
                        action.id === 'update-mod' || action.id === 'adjust-memory'
                          ? 'bg-ember text-[#0b0a09] hover:bg-ember-deep'
                          : 'border border-white/[0.12] text-white/70 hover:border-white/[0.24] hover:text-ink'
                      }`}
                    >
                      {action.label}
                    </button>
                  ),
                )}
              </div>
            )}
            {/* Repair feedback — one quiet line, replaces the action row. */}
            {recoveryBusy && (
              <p className="text-[11px] text-faint" data-testid="oracle-recovery-busy">working on it…</p>
            )}
            {recoveryDone && (
              <p className="text-[11px] text-ember" data-testid="oracle-recovery-done">{recoveryDone}</p>
            )}
            {recoveryError && (
              <p className="text-[11px] text-danger/90" data-testid="oracle-recovery-error">{recoveryError}</p>
            )}
          </div>
        )}

        {/* Sub-line */}
        <p
          key={sub}
          className={`rise d2 mt-3 max-w-[52ch] text-center text-[14px] leading-relaxed ${launchError ? 'text-danger/90' : 'text-dim'}`}
        >
          {sub}
        </p>

        {/* Live Server Pulse — the place's heartbeat. Hidden until the first
            probe lands so the dot never presents a state nobody measured. */}
        {serverStatus && (
          <div className="rise d3 mt-2 flex items-center justify-center gap-2 text-[12px] text-dim">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${serverStatus.online ? 'bg-ember animate-pulse' : 'bg-faint'}`} />
            {serverStatus.online ? (
              <span>{serverStatus.players?.online || 0} / {serverStatus.players?.max || 0} players online</span>
            ) : (
              <span>Your world has been waiting.</span>
            )}
          </div>
        )}

        {/* Mod Update Notifier — quiet hint between sub-line and the CTA */}
        {modUpdateCount > 0 && (
          <p className="rise mt-2 text-[12px] text-faint">
            {modUpdateCount} mod update{modUpdateCount > 1 ? 's' : ''} available
          </p>
        )}

        {/* The flame — exactly one ember element (Law 1) */}
        <div className="rise d3 mt-5 flex flex-col items-center">
          {isRunning ? (
            <div className="flex items-center gap-3">
              <span className="dot-live" />
              <span className="text-[13px] font-medium text-dim">Live</span>
            </div>
          ) : launching ? (
            <>
              <ForgeLine stages={STAGES} launchSteps={launchSteps} hasLaunchedBefore={hasLaunchedBefore} />
              {/* Escapable, never trapped. A first launch can run for minutes
                  (client download + Java provisioning); without this the only
                  exit was killing the launcher. Quiet by design — the filament
                  is the screen's one ember element, so this stays a whisper. */}
              {onCancelLaunch && (
                <button
                  onClick={onCancelLaunch}
                  className="mt-5 cursor-pointer text-[12px] text-faint transition-colors duration-micro hover:text-dim"
                >
                  Cancel
                </button>
              )}
              {onOpenConsole && (
                <button
                  onClick={() => onOpenConsole(null)}
                  className="mt-5 cursor-pointer text-[11px] text-faint transition-colors duration-micro hover:text-dim"
                >
                  console
                </button>
              )}
            </>
          ) : launchError ? (
            <button className="pill-ember" onClick={onRetry}>Try again</button>
          ) : (
            <button
              className="cta-image-btn"
              onClick={handlePlay}
              aria-label={isLoggedIn ? 'Enter the world' : 'Sign in'}
            >
              <img src={new URL('../assets/enter-world-btn.png', import.meta.url).href} alt="" />
            </button>
          )}
        </div>
      </div>

      {/* ── Metadata rail: honest, mono, quiet (Laws 3–6) ─────────────────── */}
      <div className="hairline-t rise d4 relative z-10 flex h-11 shrink-0 items-center justify-center gap-3 px-6 font-mono text-[11px] tabular-nums text-dim">
        <span>MC {railVersion}</span>
        <span aria-hidden>·</span>
        <span>{railLoader}</span>
        <span aria-hidden>·</span>
        <span>{railHost}</span>
      </div>

      {/* ── Sign-in slide-over ────────────────────────────────────────────── */}
      {showAuthPanel && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowAuthPanel(false)} />
          <div className="surface panel-in relative m-3 flex w-[360px] flex-col justify-center rounded-[18px] p-10">
            <button
              onClick={() => setShowAuthPanel(false)}
              className="absolute right-5 top-4 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
              aria-label="Close"
            >
              &times;
            </button>
            <p className="microlabel mb-4">Account</p>
            <h2 className="font-display text-[32px] font-bold tracking-[-0.03em] text-ink">Sign in.</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-dim">
              A Microsoft window will open — it&rsquo;s the same account you use for Minecraft.
              We never see your password.
            </p>
            <button
              className="pill-ember mt-8 self-start"
              onClick={async () => {
                try {
                  await window.electronAPI.startLogin();
                  const poll = setInterval(async () => {
                    const status = await window.electronAPI.getAuthStatus();
                    if (status.loggedIn && status.profile) {
                      setProfileName(status.profile.name);
                      setIsLoggedIn(true);
                      setShowAuthPanel(false);
                      clearInterval(poll);
                    }
                  }, 1000);
                } catch { /* panel stays open; user can retry */ }
              }}
            >
              Sign in with Microsoft
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PlayView;