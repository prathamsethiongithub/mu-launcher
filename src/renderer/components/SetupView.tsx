import React, { useState, useRef, useEffect } from 'react';

// SetupView — per-instance configuration (memory, runtime, resolution) plus
// storage housekeeping and build info. Every interactive control here performs
// a real action: RAM/resolution persist through 'update-world-settings',
// Open Folder opens the launcher's real data directory, Disk Usage reads live
// bytes from the main process, and Clear Cache deletes only refetchable
// cache directories (worlds/identity/tokens are never touched).
export const SetupView: React.FC<{ activeWorld: any; onWorldsChanged: () => void }> = ({
  activeWorld,
  onWorldsChanged,
}) => {
  const [ram, setRam] = useState(activeWorld?.ramAllocation || 4096);
  // Debounce handle for RAM persistence. A ref — not a plain `let` — so the
  // timer survives re-renders: a per-render `let` resets to undefined and
  // every drag tick would leak a live timer (N ticks → N IPC calls).
  const ramTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Resolution comes from the world registry so it survives restarts;
  // '1920x1080' is only the pre-selection shown before the user ever changes it.
  const [resolution, setResolution] = useState<string>(activeWorld?.resolution || '1920x1080');
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [javaPath, setJavaPath] = useState('');
  // Real storage metrics from the main process — replaces the old hardcoded
  // "2.3 GB on disk" figure and the fake C:\Users\Player\... path.
  const [storage, setStorage] = useState<{ path: string; bytes: number } | null>(null);

  const refreshMetrics = async () => {
    try {
      setStorage(await window.electronAPI.getAppMetrics());
    } catch (err) {
      console.error('[setup] get-app-metrics failed:', err);
    }
  };

  useEffect(() => {
    refreshMetrics();
  }, []);

  /** Human-readable byte count, e.g. 2483523584 → "2.3 GB". */
  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  const handleOpenFolder = async () => {
    const result = await window.electronAPI.openAppDataDir();
    if (!result.success) {
      console.error('[setup] open-app-data-dir failed:', result.error);
    }
  };

  const handleClearCache = async () => {
    if (cacheBusy) return;
    if (!cacheConfirm) {
      setCacheConfirm(true);
      return;
    }
    setCacheBusy(true);
    try {
      const result = await window.electronAPI.clearCache();
      if (!result.success) {
        console.error('[setup] clear-cache failed:', result.error);
      }
      // The usage figure must reflect what was just deleted.
      await refreshMetrics();
    } finally {
      setCacheBusy(false);
      setCacheConfirm(false);
    }
  };

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
              onChange={(e) => {
                const next = e.target.value;
                setResolution(next);
                // Persist through the same channel as RAM so the value
                // survives restarts and reaches MCLC's `window` option at launch.
                if (activeWorld) {
                  window.electronAPI.updateWorldSettings(activeWorld.id, { resolution: next });
                }
              }}
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
              <span className="text-[11px] text-faint truncate max-w-[300px]" title={storage?.path}>
                {storage ? storage.path : '…'}
              </span>
            </div>
            <button
              onClick={handleOpenFolder}
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
              <span className="font-mono text-[12px] text-faint">
                {storage ? `${formatBytes(storage.bytes)} on disk` : '…'}
              </span>
              <button
                onClick={handleClearCache}
                className={`ml-auto text-[12px] transition-colors duration-micro ${
                  cacheConfirm ? 'text-danger' : 'text-faint hover:text-danger'
                }`}
              >
                {cacheConfirm ? 'Sure? Click again' : cacheBusy ? 'Clearing…' : 'Clear Cache'}
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
