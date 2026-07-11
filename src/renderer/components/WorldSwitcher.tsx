import React from 'react';

interface WorldData {
  id: string;
  name: string;
  type: 'managed' | 'personal';
  version: string;
  loader: string;
  loaderVersion: string;
  lastPlayedAt: number | null;
  broken: boolean;
}

interface WorldSwitcherProps {
  worlds: WorldData[];
  activeWorldId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Glass popover of worlds — presentational only.
 *
 * Open/close and outside-click are owned by the parent (PlayView), whose
 * wrapper ref contains BOTH the trigger and this popover. That is the fix
 * for the switcher's flakiness: a self-owned `document` mousedown listener
 * here fired close-on-mousedown a beat before the trigger's click-toggle,
 * racing the popover open↔closed. With the parent owning it, clicking the
 * trigger reads as "inside" and toggles cleanly.
 *
 * All non-broken worlds are selectable (managed included). Selecting the
 * already-active world is handled by the parent as a clean close.
 */
const WorldSwitcher: React.FC<WorldSwitcherProps> = ({ worlds, activeWorldId, onSelect }) => {
  const sorted = [...worlds].sort((a, b) => {
    if (a.type === 'managed' && b.type !== 'managed') return -1;
    if (a.type !== 'managed' && b.type === 'managed') return 1;
    return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0);
  });

  return (
    <div
      role="listbox"
      className="glass absolute left-1/2 top-full z-50 mt-2 min-w-[224px] -translate-x-1/2 rounded-[14px] p-1.5"
    >
      {sorted.map((world) => {
        const isActive = world.id === activeWorldId;
        const clickable = !world.broken;
        return (
          <button
            key={world.id}
            role="option"
            aria-selected={isActive}
            onClick={() => clickable && onSelect(world.id)}
            disabled={!clickable}
            className={`flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left transition-colors duration-micro ${
              !clickable
                ? 'cursor-default opacity-30'
                : isActive
                  ? 'cursor-pointer bg-white/[0.05] hover:bg-white/[0.07]'
                  : 'cursor-pointer hover:bg-white/[0.04]'
            }`}
          >
            {/* Active marker — ember dot; a fixed-width slot keeps names aligned */}
            <span className="flex h-1.5 w-1.5 shrink-0 items-center justify-center">
              {isActive && <span className="h-1.5 w-1.5 rounded-full bg-ember" />}
            </span>

            <div className="flex flex-1 flex-col">
              <span className={`text-[13px] font-medium ${isActive ? 'text-ink' : 'text-dim'}`}>
                {world.name}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-faint">
                {world.loader === 'vanilla' ? 'Vanilla' : `${world.loader.charAt(0).toUpperCase() + world.loader.slice(1)} ${world.loaderVersion}`}
              </span>
            </div>

            {world.type === 'managed' && (
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                Managed
              </span>
            )}
            {world.broken && (
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-danger/60">
                Broken
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default WorldSwitcher;
