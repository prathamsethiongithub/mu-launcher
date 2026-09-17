import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ModrinthBrowserProps {
  worldId: string;
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

/** 1234567 → "1.2M". Compact download counts, the way stores display them. */
const formatDownloads = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

/** Per-project install lifecycle, keyed by Modrinth project id. */
interface InstallEntry {
  state: InstallState;
  error?: string;
}

const SEARCH_DEBOUNCE_MS = 500;

/**
 * Modrinth Discover — premium in-launcher mod browser. Type to search (500ms
 * debounce), install with one click. Version/loader facets are applied by the
 * main process so every result is installable in THIS world.
 *
 * Install state machine per card: idle → installing → installed | error.
 * "installed" sticks for the session (no per-mod dir polling) and parent
 * refreshes its own list via onInstalled.
 */
const ModrinthBrowser: React.FC<ModrinthBrowserProps> = ({
  worldId,
  worldVersion,
  worldLoader,
  onClose,
  onInstalled,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(true);
  const [searchFailed, setSearchFailed] = useState(false);
  const [installs, setInstalls] = useState<Record<string, InstallEntry>>({});

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
        const hits = await window.electronAPI.searchModrinth(q, worldVersion, worldLoader);
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
    [worldVersion, worldLoader],
  );

  // Debounced auto-search on query change — including initial mount with an
  // empty query: Modrinth returns relevance-sorted popular mods, a good
  // landing state for a browse-first panel.
  useEffect(() => {
    const t = setTimeout(() => {
      runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, runSearch]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="surface panel-in relative m-4 flex h-[80vh] w-full max-w-[640px] flex-col rounded-[18px] p-8">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-5 top-4 z-10 text-[18px] leading-none text-faint transition-colors duration-micro hover:text-ink"
          aria-label="Close"
        >
          &times;
        </button>

        <p className="microlabel mb-3">Discover</p>
        <h2 className="font-display text-[24px] font-bold tracking-[-0.03em] text-ink">
          Mods for {worldLoader === 'vanilla' ? 'Vanilla' : worldLoader} {worldVersion}
        </h2>

        {/* Search input */}
        <div className="relative mt-5 shrink-0">
          <svg
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Modrinth — try sodium, lithium, shaders…"
            autoFocus
            className="w-full rounded-[10px] border border-line bg-white/[0.03] py-3 pl-10 pr-4 text-[14px] text-ink placeholder:text-faint focus:border-ember/30 focus:outline-none transition-colors duration-micro"
          />
        </div>

        {/* Results */}
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
          {searching ? (
            <div className="flex items-center gap-2.5 py-12">
              <div className="dot-breathe h-[5px] w-[5px] rounded-full bg-ember" />
              <p className="microlabel">Searching</p>
            </div>
          ) : searchFailed ? (
            <div className="py-12 text-center">
              <p className="text-[12px] text-danger/80">Couldn't reach Modrinth.</p>
              <button
                onClick={() => runSearch(query)}
                className="mt-2 text-[12px] font-medium text-ember transition-colors duration-micro hover:text-ember-deep"
              >
                Retry
              </button>
            </div>
          ) : results.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-dim">No results{query ? ` for "${query}"` : ''}.</p>
              <p className="mt-1 text-[12px] text-faint">
                Try a shorter name — or check the world's version/loader filter.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {results.map((result) => {
                const entry: InstallEntry = installs[result.id] ?? { state: 'idle' };
                return (
                  <li
                    key={result.id}
                    className="flex items-start gap-3.5 rounded-[12px] border border-white/[0.06] p-4 transition-all duration-micro ease-exit hover:border-white/[0.12]"
                  >
                    {/* Icon (Modrinth CDN — allowlisted in CSP img-src) */}
                    <div className="h-[44px] w-[44px] shrink-0 overflow-hidden rounded-[9px] border border-white/[0.06] bg-white/[0.03]">
                      {result.iconUrl ? (
                        <img
                          src={result.iconUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : null}
                    </div>

                    {/* Title / author / description / downloads */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">
                          {result.title}
                        </p>
                        {result.author && (
                          <p className="shrink-0 text-[11px] text-faint">by {result.author}</p>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-faint">
                        {result.description}
                      </p>
                      <p className="mt-1.5 text-[11px] text-faint">
                        {formatDownloads(result.downloads)} downloads
                      </p>
                    </div>

                    {/* Install — the card's action */}
                    <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                      <button
                        onClick={() => handleInstall(result)}
                        disabled={entry.state === 'installing' || entry.state === 'installed'}
                        className={`rounded-full border px-4 py-1.5 text-[11px] font-semibold transition-all duration-micro ease-exit ${
                          entry.state === 'installed'
                            ? 'border-line bg-transparent text-faint'
                            : entry.state === 'installing'
                              ? 'border-ember/30 bg-ember/10 text-ember'
                              : 'border-ember/40 bg-ember/15 text-ember hover:bg-ember hover:text-[var(--ground)]'
                        } disabled:cursor-default`}
                      >
                        {entry.state === 'installing'
                          ? 'Installing…'
                          : entry.state === 'installed'
                            ? 'Installed'
                            : 'Install'}
                      </button>
                      {entry.state === 'idle' && entry.error && (
                        <p className="max-w-[150px] text-right text-[10px] leading-tight text-danger/80">
                          {entry.error}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModrinthBrowser;
