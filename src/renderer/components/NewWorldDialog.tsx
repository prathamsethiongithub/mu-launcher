import React, { useState, useEffect } from 'react';

interface NewWorldDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

type LoaderChoice = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge';

// Version manifests are fetched by the MAIN process over IPC
// ('fetch-version-list') — the renderer has a restrictive CSP and the main
// process has no CORS/CSP restrictions. This is the standard launcher
// pattern (Prism does the same). Forge/NeoForge stay as curated pins.
const FORGE_VERSIONS = ['52.0.1', '47.3.0'];
const NEOFORGE_VERSIONS = ['21.1.65', '20.6.121'];

const LOADERS: { value: LoaderChoice; label: string }[] = [
  { value: 'vanilla', label: 'Vanilla' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
];

const selectClass =
  'w-full appearance-none rounded-[10px] border border-line bg-white/[0.03] px-4 py-3 text-[14px] text-ink focus:border-ember/30 focus:outline-none transition-colors duration-micro disabled:opacity-40 [&>option]:bg-neutral-900 [&>option]:text-neutral-100';

const ChevronDown: React.FC = () => (
  <svg
    className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-faint"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const NewWorldDialog: React.FC<NewWorldDialogProps> = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [loader, setLoader] = useState<LoaderChoice>('vanilla');
  const [ramAllocation, setRamAllocation] = useState(4096);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Version metadata fetched live from the official manifests.
  const [mcVersions, setMcVersions] = useState<string[]>([]);
  const [fabricVersions, setFabricVersions] = useState<string[]>([]);
  const [quiltVersions, setQuiltVersions] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [loaderVersion, setLoaderVersion] = useState('');

  // A failed manifest must surface as a retryable error, NOT an eternal
  // "Fetching versions..." — an empty list is indistinguishable from a
  // loading list otherwise, and one transient request failure (flaky
  // network, DNS hiccup) would freeze that dropdown for the dialog's life.
  const [mcFailed, setMcFailed] = useState(false);
  const [fabricFailed, setFabricFailed] = useState(false);
  const [quiltFailed, setQuiltFailed] = useState(false);

  // Optional: which instance folder to import global settings from. Null =
  // fall back to the default global .minecraft. Multi-launcher users keep
  // settings in per-instance dirs, so this lets them pick the right one.
  const [settingsPath, setSettingsPath] = useState<string | null>(null);

  const loadMc = async () => {
    setMcFailed(false);
    const result = await window.electronAPI.fetchVersionList('minecraft');
    if (result.success && result.versions) {
      setMcVersions(result.versions);
      setVersion((prev) => prev || result.versions![0] || '');
    } else {
      console.error('Mojang fetch failed:', result.error);
      setMcFailed(true);
    }
  };

  const loadFabric = async () => {
    setFabricFailed(false);
    console.log('[dialog] calling fetchVersionList fabric...');
    try {
      const result = await window.electronAPI.fetchVersionList('fabric');
      console.log('[dialog] fabric result:', JSON.stringify(result).slice(0, 200));
      if (result.success && result.versions) {
        setFabricVersions(result.versions);
        setLoaderVersion((prev) => prev || result.versions![0] || '');
      } else {
        console.error('[dialog] fabric error:', result.error);
        setFabricFailed(true);
      }
    } catch (err) {
      console.error('[dialog] fabric error:', err);
      setFabricFailed(true);
    }
  };

  const loadQuilt = async () => {
    setQuiltFailed(false);
    console.log('[dialog] calling fetchVersionList quilt...');
    try {
      const result = await window.electronAPI.fetchVersionList('quilt');
      console.log('[dialog] quilt result:', JSON.stringify(result).slice(0, 200));
      if (result.success && result.versions) {
        setQuiltVersions(result.versions);
      } else {
        console.error('[dialog] quilt error:', result.error);
        setQuiltFailed(true);
      }
    } catch (err) {
      console.error('[dialog] quilt error:', err);
      setQuiltFailed(true);
    }
  };

  // Each manifest loads independently — one slow/failing API must not
  // block the dropdowns the other two already answered.
  useEffect(() => {
    loadMc();
    loadFabric();
    loadQuilt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The loader-version list depends on the chosen loader: fetched lists for
  // Fabric/Quilt, curated pins for Forge/NeoForge, none for Vanilla.
  // Whenever the source list changes (loader switch or fetch landing),
  // re-anchor the selection to its head.
  const loaderVersions: string[] =
    loader === 'fabric' ? fabricVersions
    : loader === 'quilt' ? quiltVersions
    : loader === 'forge' ? FORGE_VERSIONS
    : loader === 'neoforge' ? NEOFORGE_VERSIONS
    : [];

  // "Fetching..." only while actually loading — a failed fetch flips to the
  // retry affordance instead of spinning forever.
  const loaderFetching =
    loader === 'fabric' ? fabricVersions.length === 0 && !fabricFailed
    : loader === 'quilt' ? quiltVersions.length === 0 && !quiltFailed
    : false;
  const loaderFailed = loader === 'fabric' ? fabricFailed : loader === 'quilt' ? quiltFailed : false;
  const retryLoader = () => (loader === 'fabric' ? loadFabric() : loadQuilt());

  useEffect(() => {
    if (loaderVersions.length > 0) {
      setLoaderVersion(loaderVersions[0]);
    }
  }, [loader, fabricVersions, quiltVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Give your world a name.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await window.electronAPI.createWorld({
        name: name.trim(),
        version,
        loader,
        loaderVersion: loader === 'vanilla' ? undefined : loaderVersion,
        ramAllocation,
        settingsPath: settingsPath || undefined,
      });
      if (!result.success) {
        setError(result.error || 'Failed to create world.');
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create world.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="surface panel-in relative m-4 w-full max-w-[420px] rounded-[18px] p-8">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-5 top-4 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
          aria-label="Close"
        >
          &times;
        </button>

        <p className="microlabel mb-3">New World</p>
        <h2 className="font-display text-[24px] font-bold tracking-[-0.03em] text-ink">
          Make a space of your own.
        </h2>

        {/* Name */}
        <div className="mt-6">
          <label className="microlabel mb-2 block">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="My Survival World"
            className="w-full rounded-[10px] border border-line bg-white/[0.03] px-4 py-3 text-[14px] text-ink placeholder:text-faint focus:border-ember/30 focus:outline-none transition-colors duration-micro"
            autoFocus
          />
        </div>

        {/* Minecraft version — live from Mojang's manifest */}
        <div className="mt-5">
          <label className="microlabel mb-2 block">Minecraft version</label>
          <div className="relative">
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={mcVersions.length === 0}
              className={selectClass}
            >
              {mcVersions.length === 0 ? (
                <option>Fetching versions...</option>
              ) : (
                mcVersions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))
              )}
            </select>
            <ChevronDown />
          </div>
          {mcFailed && (
            <p className="mt-2 text-[11px] text-danger/80">
              Couldn't load versions.{' '}
              <button onClick={loadMc} className="underline transition-colors duration-micro hover:text-ink">
                Retry
              </button>
            </p>
          )}
        </div>

        {/* Loader */}
        <div className="mt-5">
          <label className="microlabel mb-2 block">Loader</label>
          <div className="relative">
            <select
              value={loader}
              onChange={(e) => setLoader(e.target.value as LoaderChoice)}
              className={selectClass}
            >
              {LOADERS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <ChevronDown />
          </div>
        </div>

        {/* Loader version — list source depends on the chosen loader */}
        {loader !== 'vanilla' && (
          <div className="mt-5">
            <label className="microlabel mb-2 block">Loader version</label>
            <div className="relative">
              <select
                value={loaderVersion}
                onChange={(e) => setLoaderVersion(e.target.value)}
                disabled={loaderFetching}
                className={selectClass}
              >
                {loaderFetching ? (
                  <option>Fetching versions...</option>
                ) : (
                  loaderVersions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown />
            </div>
            {loaderFailed && (
              <p className="mt-2 text-[11px] text-danger/80">
                Couldn't load versions.{' '}
                <button onClick={retryLoader} className="underline transition-colors duration-micro hover:text-ink">
                  Retry
                </button>
              </p>
            )}
          </div>
        )}

        {/* Memory */}
        <div className="mt-5">
          <label className="microlabel mb-2 block">Memory</label>
          <div className="relative">
            <select
              value={ramAllocation}
              onChange={(e) => setRamAllocation(Number(e.target.value))}
              className={selectClass}
            >
              {[2048, 4096, 6144, 8192].map((mb) => (
                <option key={mb} value={mb}>
                  {mb === 4096 ? `${mb} MB (Default)` : `${mb} MB`}
                </option>
              ))}
            </select>
            <ChevronDown />
          </div>
        </div>

        {/* Import settings — optional source override */}
        <div className="mt-5">
          <label className="microlabel mb-2 block">Import Settings (Optional)</label>
          <button
            type="button"
            onClick={async () => {
              const selectedPath = await window.electronAPI.selectDirectory();
              if (selectedPath) setSettingsPath(selectedPath);
            }}
            className="w-full rounded-[10px] border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-left text-[13px] text-faint transition-colors hover:border-white/[0.12]"
          >
            {settingsPath
              ? `From: ${settingsPath.split(/[\\/]/).pop()}`
              : 'Choose an existing instance folder...'}
          </button>
          {settingsPath && (
            <button
              onClick={() => setSettingsPath(null)}
              className="mt-1 text-[11px] text-danger/60 transition-colors hover:text-danger"
            >
              Clear
            </button>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            Copies FOV, keybinds and mod config from an existing install so you
            don't set everything up again.
          </p>
        </div>

        {/* Error */}
        {error && (
          <p className="mt-4 text-[12px] text-danger/90">{error}</p>
        )}

        {/* Actions */}
        <div className="mt-7 flex items-center gap-3">
          <button
            className="pill-ghost"
            onClick={onClose}
            disabled={creating}
          >
            Cancel
          </button>
          <button
            className="pill-ember"
            onClick={handleCreate}
            disabled={creating || !name.trim() || mcVersions.length === 0}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewWorldDialog;
