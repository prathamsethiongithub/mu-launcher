import React, { useState, useRef } from 'react';

// SetupView — per-instance configuration (memory, runtime, resolution) plus
// storage housekeeping and build info. Java "Detect" is wired to the main
// process; Open Folder / Clear Cache still log to console.
export const SetupView: React.FC<{ activeWorld: any; onWorldsChanged: () => void }> = ({
  activeWorld,
  onWorldsChanged,
}) => {
  const [ram, setRam] = useState(activeWorld?.ramAllocation || 4096);
  // Debounce handle for RAM persistence. A ref — not a plain `let` — so the
  // timer survives re-renders: a per-render `let` resets to undefined and
  // every drag tick would leak a live timer (N ticks → N IPC calls).
  const ramTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [resolution, setResolution] = useState('1920x1080');
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const [javaPath, setJavaPath] = useState('');

  return (
    <div className="relative z-[1] flex h-full flex-col items-center justify-center px-10 pt-20 pb-24 pointer-events-none">
      <div className="w-full max-w-[680px] flex flex-col gap-8 pointer-events-auto">
        {/* ── Block 1: Instance Configuration ─────────────────────────── */}
        <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-6">
          <p className="microlabel mb-5">Instance Configuration</p>

          {/* RAM slider */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-[14px] text-dim">Memory Allocation</span>
            <span className="font-mono text-[13px] text-ink">{(ram / 1024).toFixed(1)} GB</span>
          </div>
          <input
            type="range"
            min="2048"
            max="16384"
            step="512"
            value={ram}
            onChange={(e) => {
              const newRam = Number(e.target.value);
              setRam(newRam);
              // Debounced persistence: 500ms after the last drag tick, write
              // the allocation to the world registry. Without this the value
              // never left this component — launches used the stale default.
              clearTimeout(ramTimer.current ?? undefined);
              ramTimer.current = setTimeout(() => {
                ramTimer.current = null;
                if (activeWorld) {
                  window.electronAPI.updateWorldSettings(activeWorld.id, {
                    ramAllocation: newRam,
                  });
                }
              }, 500);
            }}
            className="mu-slider"
          />

          {/* Java version */}
          <div className="mt-6 flex items-center justify-between">
            <span className="text-[14px] text-dim">Java Runtime</span>
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-faint truncate max-w-[220px]" title={javaPath || undefined}>
                {javaPath ? javaPath : 'Java 21'}
              </span>
              <button
                onClick={async () => {
                  const result = await window.electronAPI.detectJava();
                  if (result.success) {
                    setJavaPath(result.path!);
                  } else {
                    setJavaPath('Not found');
                  }
                }}
                className="pill-ghost !text-[11px] !px-3 !py-1"
              >
                Detect
              </button>
            </div>
          </div>

          {/* Resolution */}
          <div className="mt-6 flex items-center justify-between">
            <span className="text-[14px] text-dim">Game Resolution</span>
            <select
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className="rounded-[8px] border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[12px] text-dim focus:border-ember/30 focus:outline-none"
            >
              <option value="1280x720">1280 x 720</option>
              <option value="1920x1080">1920 x 1080</option>
              <option value="2560x1440">2560 x 1440</option>
            </select>
          </div>
        </div>

        {/* ── Block 2: Storage & Cache ────────────────────────────────── */}
        <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-6">
          <p className="microlabel mb-5">Storage &amp; Cache</p>

          {/* Game directory */}
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <span className="text-[14px] text-dim">Game Directory</span>
              <span className="text-[11px] text-faint truncate max-w-[300px]">
                C:\Users\Player\AppData\Roaming\mu-master-launcher
              </span>
            </div>
            <button
              onClick={() => console.log('open dir')}
              className="pill-ghost !text-[11px] !px-3 !py-1"
            >
              Open Folder
            </button>
          </div>

          {/* Disk usage — the clear-cache affordance lives on this row
              (right-aligned beside the usage figure) instead of dangling on
              its own line below it. */}
          <div className="mt-6 flex items-center justify-between">
            <span className="text-[14px] text-dim">Disk Usage</span>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[12px] text-faint">2.3 GB on disk</span>
              <button
                onClick={() => {
                  if (cacheConfirm) {
                    console.log('cache cleared');
                    setCacheConfirm(false);
                  } else {
                    setCacheConfirm(true);
                  }
                }}
                className={`ml-auto text-[12px] transition-colors duration-micro ${
                  cacheConfirm ? 'text-danger' : 'text-faint hover:text-danger'
                }`}
              >
                {cacheConfirm ? 'Sure? Click again' : 'Clear Cache'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Block 3: About ──────────────────────────────────────────── */}
        <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-6">
          <p className="microlabel mb-5">About</p>

          <div className="flex items-center justify-between mt-3">
            <span className="text-[13px] text-dim">Launcher Version</span>
            <span className="font-mono text-[12px] text-faint">Ember v1.0.0</span>
          </div>
          <div className="flex items-center justify-between mt-3">
            <span className="text-[13px] text-dim">Electron Version</span>
            <span className="font-mono text-[12px] text-faint">v40.0.0</span>
          </div>
          <div className="flex items-center justify-between mt-3">
            <span className="text-[13px] text-dim">Maintained by</span>
            <span className="font-mono text-[12px] text-faint">Masters&apos; Union</span>
          </div>
        </div>
      </div>
    </div>
  );
};
