import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ModrinthBrowserProps {
  worldId: string;
  worldName: string;
  worldVersion: string;
  worldLoader: string;
  onClose: () => void;
  /** Called after ANY successful install — parent refreshes its mod list. */
  onInstalled: () => void;
}

interface SearchResult {
  id: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl?: string;
}

type InstallState = 'idle' | 'installing' | 'installed';

/** Download counts in store shorthand: 1234567 → "1.2M", 12345 → "12K". */
const formatDownloads = (n: number): string => {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)}M downloads`;
  if (n > 1_000) return `${(n / 1_000).toFixed(0)}K downloads`;
  return `${n} downloads`;
};

/** Per-project install lifecycle, keyed by Modrinth project id. */
interface InstallEntry {
  state: InstallState;
  error?: string;
}

const SEARCH_DEBOUNCE_MS = 500;

/** "vanilla" → "Vanilla" — loader names are stored lowercase. */
const formatLoader = (loader: string): string =>
  loader.charAt(0).toUpperCase() + loader.slice(1);

/**
 * Modrinth Discover — premium in-launcher mod browser. Opens on Modrinth's
 * popular list (an empty query is downloads-sorted), type to search (500ms
 * debounce), install with one click. Version/loader facets are applied by the
 * main process so every result is installable in THIS world.
 *
 * Install state machine per card: idle → installing → installed | error.
 * "installed" sticks for the session (no per-mod dir polling) and parent
 * refreshes its own list via onInstalled.
 */
const ModrinthBrowser: React.FC<ModrinthBrowserProps> = ({
  worldId,
  worldName,
  worldVersion,
  worldLoader,
  onClose,
  onInstalled,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [installs, setInstalls] = useState<Record<string, InstallEntry>>({});

  // Version override for search. Custom/private worlds may pin versions that
  // don't exist on Modrinth (e.g. the SMP's "26.3"), which would filter every
  // result to zero — so the user can pick a real one, or "Any Version".
  // The world's own version is ALWAYS offered first (Modrinth may support it);
  // the initial selection stays empty (= no version facet) unless it's a known
  // Modrinth release, since exotic pins like "26.3" still zero out results.
  const SEARCH_VERSIONS = ['1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5'];
  const versions = [...new Set([worldVersion, ...SEARCH_VERSIONS])].filter(Boolean);
  const [searchVersion, setSearchVersion] = useState(
    SEARCH_VERSIONS.includes(worldVersion) ? worldVersion : '',
  );

  // Latest-effect-wins: each search bumps a sequence number; responses from
  // stale sequences (e.g. a slow reply landing after a new keystroke) are
  // dropped instead of clobbering the newer results.
  const searchSeq = useRef(0);

  const runSearch = useCallback(
    async (q: string) => {
      searchSeq.current += 1;
      const seq = searchSeq.current;
      setSearching(true);
      setSearchFailed(false);
      try {
        // Vanilla has no Modrinth category, so no loader facet for it.
        const loaderFacet = worldLoader === 'vanilla' ? undefined : worldLoader;
        const versionFacet = searchVersion || undefined;
        const hits = await window.electronAPI.searchModrinth(q, versionFacet, loaderFacet);
        if (seq !== searchSeq.current) return; // superseded — drop it
        setResults(hits);
      } catch (err) {
        console.error('[modrinth-browser] search failed:', err);
        if (seq !== searchSeq.current) return;
        setResults([]);
        setSearchFailed(true);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [searchVersion, worldLoader],
  );

  // Search on query change: an empty query fires immediately (no debounce)
  // and fetches the popular/recommended list — that's also what runs on mount,
  // so the panel opens on recommendations instead of a blank prompt. Typed
  // queries go through the debounce. runSearch is a dep, so changing the
  // version dropdown re-runs the active search with the new facet as well.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearchFailed(false);
      runSearch('');
      return;
    }
    const t = setTimeout(() => {
      runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const handleInstall = async (result: SearchResult) => {
    const current = installs[result.id];
    if (current && (current.state === 'installing' || current.state === 'installed')) return;
    setInstalls((prev) => ({ ...prev, [result.id]: { state: 'installing' } }));
    try {
      const res = await window.electronAPI.downloadMod(worldId, result.id);
      if (res.success) {
        setInstalls((prev) => ({ ...prev, [result.id]: { state: 'installed' } }));
        onInstalled();
      } else {
        setInstalls((prev) => ({
          ...prev,
          [result.id]: { state: 'idle', error: res.error || 'Install failed.' },
        }));
      }
    } catch (err) {
      setInstalls((prev) => ({
        ...prev,
        [result.id]: {
          state: 'idle',
          error: err instanceof Error ? err.message : 'Install failed.',
        },
      }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="surface panel-in relative m-4 flex max-h-[85vh] w-full max-w-[720px] flex-col rounded-[18px] p-8">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-5 top-4 z-10 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
          aria-label="Close"
        >
          &times;
        </button>

        {/* Header */}
        <p className="microlabel mb-3">Browse Mods</p>
        <h2 className="font-display text-[22px] font-bold tracking-[-0.03em] text-ink">
          {worldName}
        </h2>
        <p className="mt-1 text-[12px] text-faint">
          Minecraft {worldVersion} &middot; {formatLoader(worldLoader)}
        </p>

        {/* Search + version override — single control row. Search grows,
            filter stays fixed. Focus pulls the icon into the ember accent. */}
        <div className="mt-5 flex w-full items-center gap-2">
          {/* Search */}
          <div className="group relative flex-1">
            <svg className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-white/30 transition-colors group-focus-within:text-[#C88735]/80" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mods on Modrinth…"
              autoFocus
              className="h-11 w-full rounded-[9px] border border-white/[0.06] bg-white/[0.02] pl-10 pr-4 text-[13px] text-white/90 placeholder:text-white/25 outline-none transition-all duration-150 hover:border-white/[0.09] focus:border-[#C88735]/40 focus:bg-white/[0.025] focus:ring-1 focus:ring-[#C88735]/15 [&::-webkit-search-cancel-button]:appearance-none"
            />
          </div>

          {/* Version filter */}
          <div className="relative shrink-0">
            <select
              value={searchVersion}
              onChange={(e) => setSearchVersion(e.target.value)}
              className="h-11 min-w-[150px] appearance-none rounded-[9px] border border-white/[0.06] bg-white/[0.02] pl-3.5 pr-10 text-[13px] font-medium text-white/65 outline-none transition-all duration-150 hover:border-white/[0.09] focus:border-[#C88735]/40 focus:ring-1 focus:ring-[#C88735]/15"
              aria-label="Filter by version"
            >
              <option value="" className="bg-[#0b0a09] text-white">Any Version</option>
              {versions.map((v) => (
                <option key={v} value={v} className="bg-[#0b0a09] text-white">
                  {v}
                </option>
              ))}
            </select>
            <svg className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-white/30" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
        </div>

        {/* Results */}
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
          {searching ? (
            <div className="flex items-center justify-center gap-2.5 py-12">
              <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
              <p className="microlabel">
                {query.trim() ? 'Searching Modrinth...' : 'Loading popular mods...'}
              </p>
            </div>
          ) : searchFailed ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-faint">Couldn&apos;t reach Modrinth.</p>
              <button
                onClick={() => runSearch(query)}
                className="mt-2 text-[12px] font-medium text-ember transition-colors duration-micro hover:text-ember-deep"
              >
                Retry
              </button>
            </div>
          ) : results.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-faint">
                {query.trim() ? 'No mods found. Try a different search.' : 'No popular mods found.'}
              </p>
            </div>
          ) : (
            <div>
              {results.map((mod) => {
                const entry: InstallEntry = installs[mod.id] ?? { state: 'idle' };
                return (
                  <div
                    key={mod.id}
                    className="group flex items-center gap-4 rounded-[10px] border border-white/[0.06] bg-white/[0.015] px-4 py-3 transition-all duration-micro ease-exit hover:border-white/[0.10]"
                  >
                    {/* Mod icon */}
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-white/[0.06] bg-white/[0.03]">
                      {mod.iconUrl ? (
                        <img
                          src={mod.iconUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.5}
                          className="text-faint"
                        >
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                          <path d="M4 10h16" />
                        </svg>
                      )}
                    </div>

                    {/* Mod info */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium text-ink">{mod.title}</p>
                      {mod.author && (
                        <p className="truncate text-[12px] text-faint">by {mod.author}</p>
                      )}
                      <p className="mt-1 truncate text-[11px] text-faint">
                        {formatDownloads(mod.downloads)}
                      </p>
                    </div>

                    {/* Install */}
                    <button
                      disabled={entry.state === 'installing' || entry.state === 'installed'}
                      onClick={() => handleInstall(mod)}
                      className={`shrink-0 rounded-[8px] border px-4 py-2 text-[12px] font-medium transition-all duration-micro ${
                        entry.state === 'installed'
                          ? 'border-white/[0.06] text-faint'
                          : entry.state === 'installing'
                            ? 'border-white/[0.06] text-faint'
                            : 'border-white/[0.08] text-dim hover:border-ember/30 hover:bg-ember/10 hover:text-ember'
                      } disabled:cursor-default`}
                    >
                      {entry.state === 'installed'
                        ? 'Installed'
                        : entry.state === 'installing'
                          ? 'Installing...'
                          : 'Install'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModrinthBrowser;
