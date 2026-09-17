import React, { useState, useEffect, useCallback } from 'react';

interface ModManagerModalProps {
  worldId: string;
  worldName: string;
  onClose: () => void;
}

interface ModFile {
  /** Canonical (enabled-form) filename, e.g. "sodium.jar". */
  filename: string;
  /** Filename minus its extension(s), e.g. "sodium". */
  displayName: string;
  size: number;
  enabled: boolean;
}

type Busy = { kind: 'toggle' | 'delete'; filename: string } | null;

/** Bytes → a short human string (e.g. "1.4 MB"). */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Mod Manager — a modal over the active world listing every file in its
 * mods/ directory. Toggle renames the file in place; delete removes it;
 * Add copies a .jar chosen via the native picker into the world. Every
 * mutation re-pulls the list afterwards, so the view can never drift from
 * what the filesystem actually holds.
 */
const ModManagerModal: React.FC<ModManagerModalProps> = ({ worldId, worldName, onClose }) => {
  const [mods, setMods] = useState<ModFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMods = useCallback(async () => {
    setLoadFailed(false);
    try {
      const list = await window.electronAPI.listMods(worldId);
      setMods(list ?? []);
    } catch (err) {
      console.error('[mod-manager] listMods failed:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [worldId]);

  // Load on mount.
  useEffect(() => {
    loadMods();
  }, [loadMods]);

  // The one catch-all for list-failure, so empty list ≠ broken list.
  const retryLoad = () => {
    setLoading(true);
    loadMods();
  };

  const handleToggle = async (mod: ModFile) => {
    setBusy({ kind: 'toggle', filename: mod.filename });
    setError(null);
    try {
      const result = await window.electronAPI.toggleMod(worldId, mod.filename, !mod.enabled);
      if (!result.success) {
        setError(result.error || 'Failed to toggle the mod.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle the mod.');
    } finally {
      setBusy(null);
      loadMods();
    }
  };

  const handleDelete = async (mod: ModFile) => {
    setBusy({ kind: 'delete', filename: mod.filename });
    setError(null);
    try {
      const result = await window.electronAPI.deleteMod(worldId, mod.filename);
      if (!result.success) {
        setError(result.error || 'Failed to delete the mod.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the mod.');
    } finally {
      setBusy(null);
      loadMods();
    }
  };

  const handleAdd = async () => {
    setAdding(true);
    setError(null);
    try {
      const sourcePath = await window.electronAPI.selectModFile();
      // Cancelled picker — nothing to do, silently.
      if (!sourcePath) return;
      const result = await window.electronAPI.addMod(worldId, sourcePath);
      if (!result.success) {
        setError(result.error || 'Failed to add the mod.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add the mod.');
    } finally {
      setAdding(false);
      loadMods();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="surface panel-in relative m-4 flex max-h-[80vh] w-full max-w-[520px] flex-col rounded-[18px] p-8">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-5 top-4 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
          aria-label="Close"
        >
          &times;
        </button>

        <p className="microlabel mb-3">Mod Manager</p>
        <h2 className="font-display text-[24px] font-bold tracking-[-0.03em] text-ink">
          {worldName}
        </h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
          Disable a mod without uninstalling it — the file is renamed, not removed.
        </p>

        {/* List */}
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center gap-2.5 py-10">
              <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
              <p className="microlabel">Loading mods</p>
            </div>
          ) : loadFailed ? (
            <div className="py-10 text-center">
              <p className="text-[12px] text-danger/80">Couldn't load the mod list.</p>
              <button
                onClick={retryLoad}
                className="mt-2 text-[12px] font-medium text-ember transition-colors duration-micro hover:text-ember-deep"
              >
                Retry
              </button>
            </div>
          ) : mods.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-[13px] text-dim">No mods yet.</p>
              <p className="mt-1 text-[12px] text-faint">
                Add a .jar below to install your first mod.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {mods.map((mod) => (
                <li
                  key={mod.filename}
                  className="group flex items-center gap-3 rounded-[10px] border border-white/[0.06] px-4 py-3 transition-colors duration-micro hover:border-white/[0.12]"
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-[13px] font-medium transition-colors duration-micro ${
                        mod.enabled ? 'text-ink' : 'text-faint line-through'
                      }`}
                    >
                      {mod.displayName || mod.filename}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-faint">
                      {mod.filename} · {formatSize(mod.size)}
                    </p>
                  </div>

                  {/* Toggle — per-row disabled state, list-wide untouched */}
                  <button
                    role="switch"
                    aria-checked={mod.enabled}
                    aria-label={mod.enabled ? `Disable ${mod.displayName}` : `Enable ${mod.displayName}`}
                    disabled={busy !== null || adding}
                    onClick={() => handleToggle(mod)}
                    className={`relative h-[20px] w-[36px] shrink-0 rounded-full transition-colors duration-micro disabled:opacity-40 ${
                      mod.enabled ? 'bg-ember/80' : 'bg-white/[0.08]'
                    }`}
                  >
                    <span
                      className={`absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow transition-all duration-micro ${
                        mod.enabled ? 'left-[18px]' : 'left-[2px]'
                      }`}
                    />
                  </button>

                  {/* Delete */}
                  <button
                    aria-label={`Delete ${mod.displayName}`}
                    disabled={busy !== null || adding}
                    onClick={() => handleDelete(mod)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-faint transition-colors duration-micro hover:bg-danger/[0.08] hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-faint"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    >
                      <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Error */}
        {error && <p className="mt-4 text-[12px] text-danger/90">{error}</p>}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <button className="pill-ghost" onClick={onClose}>
            Done
          </button>
          <button
            className="pill-ghost !border-ember/30 !text-ember hover:!border-ember/60 hover:!text-ember"
            onClick={handleAdd}
            disabled={adding || busy !== null}
          >
            {adding ? 'Adding…' : 'Add Mod'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModManagerModal;
