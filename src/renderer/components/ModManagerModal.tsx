import React, { useState, useEffect, useCallback } from 'react';
import ModrinthBrowser from './ModrinthBrowser';
import type { ModUpdateInfo } from '../../main/update-checker';

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
  // Mod Update Notifier
  const [updates, setUpdates] = useState<ModUpdateInfo[]>([]);
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [updateComplete, setUpdateComplete] = useState(false);
  // Modrinth browser state + the world's version/loader (the browser filters
  // search results and downloads by both).
  const [modrinthOpen, setModrinthOpen] = useState(false);
  const [worldInfo, setWorldInfo] = useState<{ version: string; loader: string } | null>(null);

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
    // Update check rides the same refresh — a failed check just leaves the
    // banner quiet (checkForUpdates itself skips per-mod failures).
    try {
      const found = await window.electronAPI.checkModUpdates(worldId);
      setUpdates(Array.isArray(found) ? found : []);
    } catch {
      setUpdates([]);
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

  // ── Mod Update Notifier ─────────────────────────────────────────────
  const handleUpdateOne = async (update: ModUpdateInfo) => {
    setUpdating((prev) => new Set(prev).add(update.filename));
    try {
      const result = await window.electronAPI.performModUpdate(
        worldId, update.filename, update.downloadUrl, update.newFilename,
      );
      if (result.success) {
        setUpdates((prev) => prev.filter((u) => u.filename !== update.filename));
        await loadMods();
      } else {
        setError('Update failed: ' + (result.error || 'unknown error'));
      }
    } catch (err) {
      setError('Update failed: ' + String(err));
    } finally {
      setUpdating((prev) => {
        const s = new Set(prev);
        s.delete(update.filename);
        return s;
      });
    }
  };

  const handleUpdateAll = async () => {
    for (const update of updates) {
      await handleUpdateOne(update);
    }
    setUpdateComplete(true);
    setTimeout(() => setUpdateComplete(false), 3000);
  };

  // Opens the Modrinth browser: resolves the world's version/loader once so
  // the search facets target THIS world's MC version and loader.
  const openModrinth = async (): Promise<void> => {
    setModrinthOpen(true);
    if (worldInfo) return;
    try {
      const worlds = await window.electronAPI.getWorlds();
      const world = (worlds || []).find((w) => w.id === worldId);
      if (world) setWorldInfo({ version: world.version, loader: world.loader });
    } catch {
      // The browser still opens — the search just runs unfiltered.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="surface panel-in relative m-4 flex max-h-[85vh] w-full max-w-[520px] flex-col rounded-[18px] p-8">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-5 top-4 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
          aria-label="Close"
        >
          &times;
        </button>

        {/* Header */}
        <p className="microlabel mb-3">Mod Manager</p>
        <h2 className="font-display text-[22px] font-bold tracking-[-0.03em] text-ink">
          {worldName}
        </h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-faint">
          Disable a mod without uninstalling it — the file is renamed, not removed.
        </p>

        {/* Mod Update Notifier — banner above the list */}
        {updates.length > 0 && (
          <div className="mb-4 flex items-center justify-between rounded-[10px] border border-ember/20 bg-ember/[0.03] px-4 py-3">
            <span className="text-[13px] text-ember">
              {updates.length} mod update{updates.length > 1 ? 's' : ''} available
            </span>
            <button
              onClick={handleUpdateAll}
              disabled={updating.size > 0}
              className="rounded-[7px] border border-ember/40 bg-ember/10 px-3 py-1.5 text-[12px] font-medium text-ember transition-all duration-150 hover:bg-ember/20 disabled:opacity-40"
            >
              Update All
            </button>
          </div>
        )}
        {updateComplete && (
          <div className="mb-4 rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-4 py-3">
            <span className="text-[13px] text-dim">All mods are up to date.</span>
          </div>
        )}

        {/* List */}
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2.5 py-10">
              <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
              <p className="microlabel">Loading mods</p>
            </div>
          ) : loadFailed ? (
            <div className="py-10 text-center">
              <p className="text-[13px] text-faint">Couldn&apos;t load the mod list.</p>
              <button
                onClick={retryLoad}
                className="mt-2 text-[12px] font-medium text-ember transition-colors duration-micro hover:text-ember-deep"
              >
                Retry
              </button>
            </div>
          ) : mods.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-[13px] text-faint">No mods yet.</p>
              <p className="mt-1 text-[12px] text-faint">
                Install from Modrinth or add a local <code className="font-mono">.jar</code>.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {mods.map((mod) => (
                <li
                  key={mod.filename}
                  className="group flex items-center gap-4 rounded-[10px] border border-white/[0.06] bg-white/[0.015] px-4 py-3 transition-all duration-micro ease-exit hover:border-white/[0.10]"
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-[14px] font-medium transition-colors duration-micro ${
                        mod.enabled ? 'text-ink' : 'text-faint line-through'
                      }`}
                    >
                      {mod.displayName || mod.filename}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-faint">
                      {formatSize(mod.size)}
                    </p>
                  </div>

                  {/* Mod Update Notifier — version delta + one-click update */}
                  {(() => {
                    const modUpdate = updates.find((u) => u.filename === mod.filename);
                    if (!modUpdate) return null;
                    if (updating.has(mod.filename)) {
                      return <span className="shrink-0 text-[11px] text-faint">Updating…</span>;
                    }
                    return (
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[11px] text-faint tabular-nums">
                          {modUpdate.currentVersion} → <span className="text-ember">{modUpdate.latestVersion}</span>
                        </span>
                        <button
                          onClick={() => handleUpdateOne(modUpdate)}
                          className="rounded-[7px] border border-ember/30 px-3 py-1 text-[11px] text-ember transition-all duration-150 hover:bg-ember/10"
                        >
                          Update
                        </button>
                      </div>
                    );
                  })()}

                  {/* Toggle — the shared switch spec: bordered track, ember
                      when on, per-row busy disable, cubic-bezier knob glide. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={mod.enabled}
                    aria-label={mod.enabled ? `Disable ${mod.displayName}` : `Enable ${mod.displayName}`}
                    disabled={busy?.filename === mod.filename}
                    onClick={() => handleToggle(mod)}
                    className={`relative flex h-[22px] w-[38px] shrink-0 items-center rounded-full border transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#C88735]/70 disabled:opacity-40 ${
                      mod.enabled
                        ? 'border-[#C88735]/70 bg-[#C88735]/90'
                        : 'border-white/[0.10] bg-white/[0.06] hover:border-white/[0.16] hover:bg-white/[0.08]'
                    }`}
                  >
                    <span
                      className={`absolute top-[3px] size-4 rounded-full bg-white shadow-none transition-transform duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                        mod.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
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
          <div className="flex items-center gap-3">
            <button
              className="rounded-[7px] border border-white/[0.08] px-3 h-8 text-[12px] text-white/60 transition-colors duration-micro hover:border-[#C88735]/60 hover:bg-[#C88735]/10 hover:text-[#C88735]"
              onClick={openModrinth}
            >
              Browse Modrinth
            </button>
            <button
              className="rounded-[7px] border border-white/[0.08] px-3 h-8 text-[12px] text-white/60 transition-colors duration-micro hover:border-[#C88735]/60 hover:bg-[#C88735]/10 hover:text-[#C88735] disabled:opacity-40 disabled:hover:border-white/[0.08] disabled:hover:bg-transparent disabled:hover:text-white/60"
              onClick={handleAdd}
              disabled={adding || busy !== null}
            >
              {adding ? 'Adding…' : 'Add Mod'}
            </button>
          </div>
        </div>

        {/* Modrinth browser — overlays the whole manager (fixed root): installs
            land in the same world the manager targets, and onInstalled re-pulls
            the list so the manager reflects the install immediately. */}
        {modrinthOpen && worldInfo && (
          <ModrinthBrowser
            worldId={worldId}
            worldName={worldName}
            worldVersion={worldInfo.version}
            worldLoader={worldInfo.loader}
            onClose={() => setModrinthOpen(false)}
            onInstalled={loadMods}
          />
        )}
      </div>
    </div>
  );
};

export default ModManagerModal;
