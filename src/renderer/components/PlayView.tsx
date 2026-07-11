import React, { useState, useEffect, useRef } from 'react';
import ForgeLine, { LaunchStep } from './ForgeLine';
import WorldBeacon, { WorldState } from './fx/WorldBeacon';
import PlayerIdentity from './fx/PlayerIdentity';
import WorldSwitcher from './WorldSwitcher';

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
  activeWorld: WorldData | null;
  worlds: WorldData[];
  onSetActiveWorld: (id: string) => void;
}

const STAGES = [
  { id: 'auth', label: 'Authenticating', real: ['authenticating'] },
  { id: 'jre',  label: 'Assembling',     real: ['preparing-java'] },
  { id: 'mods', label: 'Forging',        real: ['ensuring-version', 'installing-fabric', 'installing-mods', 'injecting-server'] },
  { id: 'mc',   label: 'Launching',      real: ['launching', 'running'] },
] as const;

const SERVER_HOST = 'mastersunion.minekeep.gg';

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
  launching, launchError, launchSteps, isRunning, onPlay, onRetry,
  activeWorld, worlds, onSetActiveWorld,
}) => {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [hasLaunchedBefore] = useState(getEmberCount() > 0);
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);

  useEffect(() => { checkAuth(); }, []);

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

  // The world's presence tracks the launcher's state (DESIGN.md §8).
  const worldState: WorldState = launchError
    ? 'receding'
    : isRunning
      ? 'alive'
      : launching
        ? 'igniting'
        : isLoggedIn
          ? 'waiting'
          : 'distant';

  // Eyebrow: world name + ⌄ when ≥2 worlds, else just the server host.
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
      {/* ── The world, behind everything ─────────────────────────────────── */}
      <WorldBeacon state={worldState} />

      {/* ── The stage ──────────────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-10">
        {/* Eyebrow — above the character, quiet, like a label on a museum card.
            With one world: just the server host (unchanged).
            With ≥2 worlds: the active world's name; a chevron surfaces on hover
            and opens the switcher. One quiet trigger, one interaction. */}
        {hasMultipleWorlds ? (
          <div ref={eyebrowRef} className="rise relative mb-4">
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
          /* One world: the eyebrow names the place. The address already
             lives in the rail — never the same fact twice on one stage. */
          <p className="rise microlabel mb-4 !text-faint">{eyebrowText}</p>
        )}

        {/* The identity object — the player, standing in the world's light */}
        {isLoggedIn && (
          <div className="rise h-[clamp(180px,30vh,320px)] w-[280px] shrink-0">
            <PlayerIdentity energetic={launching} />
          </div>
        )}

        {/* Hero word */}
        <h1
          key={hero}
          className="rise d1 max-w-[14ch] text-center font-display text-[72px] font-bold leading-[1.02] tracking-[-0.045em] text-ink [text-wrap:balance]"
        >
          {hero}
        </h1>

        {/* Sub-line */}
        <p
          key={sub}
          className={`rise d2 mt-5 max-w-[52ch] text-center text-[14px] leading-relaxed ${launchError ? 'text-danger/90' : 'text-dim'}`}
        >
          {sub}
        </p>

        {/* The flame — exactly one ember element (Law 1) */}
        <div className="rise d3 mt-10 flex flex-col items-center">
          {isRunning ? (
            <div className="flex items-center gap-3">
              <span className="dot-live" />
              <span className="text-[13px] font-medium text-dim">Live</span>
            </div>
          ) : launching ? (
            <ForgeLine stages={STAGES} launchSteps={launchSteps} hasLaunchedBefore={hasLaunchedBefore} />
          ) : launchError ? (
            <button className="pill-ember" onClick={onRetry}>Try again</button>
          ) : (
            <button className="pill-ember" onClick={handlePlay}>
              {isLoggedIn ? 'Enter the world' : 'Sign in'}
            </button>
          )}
        </div>
      </div>

      {/* ── Metadata rail: honest, mono, quiet (Laws 3–6) ─────────────────── */}
      <div className="hairline-t rise d4 relative z-10 flex h-11 shrink-0 items-center justify-center gap-3 px-6 font-mono text-[11px] tabular-nums text-faint">
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