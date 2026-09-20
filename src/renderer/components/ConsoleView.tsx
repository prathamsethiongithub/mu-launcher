import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ConsoleEntry,
  type ConsoleLevel,
  type ConsoleSource,
  type FilterState,
  type PaletteAction,
  type SessionMeta,
  absoluteTime,
  buildSupportBundle,
  countChip,
  countMatches,
  fuzzyMatchActions,
  isValidRegex,
  matchesFilter,
  relativeTime,
  sessionSummary,
} from '../../shared/console-log';

/**
 * The Console — the nerd's cockpit.
 *
 * An honest evidence view of what actually happened during a play session:
 * the launcher's pipeline events and the game's own stdout/stderr, parsed,
 * redacted upstream, and laid out in a monospace stream. The Oracle gives
 * people sentences; the console gives them proof — same screen, closed loop.
 *
 * Quiet entry points (Ctrl+L, the launch screen's "console" link, the
 * crash state's link); a regular user never needs to know it exists.
 */

const SESSION_FIRST_LINE = "ember console. everything you're about to see is what actually happened.";
const EMPTY_TEXT = 'nothing here yet. launch the game.';
const BUFFER_CAP = 5000;
const TICK_MS = 1000;

interface SessionsState {
  sessions: SessionMeta[];
  current: { meta: SessionMeta; entries: ConsoleEntry[] } | null;
}

/** The chips: selection combines OR-within-group, AND-across-groups. */
type Chip = 'all' | ConsoleSource | 'warn' | 'err';

function chipsToFilter(chips: readonly Chip[]): Pick<FilterState, 'sources' | 'levels'> {
  const sources: ConsoleSource[] = [];
  const levels: ConsoleLevel[] = [];
  for (const c of chips) {
    if (c === 'all') continue;
    if (c === 'launcher' || c === 'game') sources.push(c);
    else if (c === 'warn') levels.push('warn');
    else if (c === 'err') levels.push('error');
  }
  return { sources, levels };
}

const PALETTE_ACTIONS: PaletteAction[] = [
  { id: 'copy', label: 'copy for support', hint: 'c' },
  { id: 'log', label: 'open log file', hint: '' },
  { id: 'regex', label: 'toggle regex mode', hint: '' },
  { id: 'clear', label: 'clear filter', hint: '' },
  { id: 'jump', label: 'jump to crash', hint: '' },
  { id: 'timestamps', label: 'toggle timestamps', hint: '' },
];

/** Split an ERROR row's ±context group for the inline post-mortem view. */
function errorContextIndexes(entries: readonly ConsoleEntry[], errorIdx: number): [number, number] {
  return [Math.max(0, errorIdx - 3), Math.min(entries.length - 1, errorIdx + 3)];
}

function ConsoleView({ initialSessionId }: { initialSessionId?: string | null }) {
  // ── Observation state (main is the source of truth; this is a mirror) ──
  const [state, setState] = useState<SessionsState>({ sessions: [], current: null });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ConsoleEntry[] | null>(null);

  // ── View state ─────────────────────────────────────────────────────────
  const [chips, setChips] = useState<Chip[]>([]);
  const [query, setQuery] = useState('');
  const [regexMode, setRegexMode] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [expandedError, setExpandedError] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showLaunchCommand, setShowLaunchCommand] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);

  const filter: FilterState = useMemo(
    () => ({ query, regexMode, ...chipsToFilter(chips) }),
    [query, regexMode, chips]
  );

  // ── Live subscription (app-scope single subscriber lives here) ─────────
  useEffect(() => {
    let mounted = true;
    window.electronAPI.consoleSnapshot().then((snap) => {
      if (!mounted) return;
      setState({ sessions: snap.sessions, current: snap.current });
    });
    const onLine = (payload: Parameters<Parameters<typeof window.electronAPI.onConsoleLine>[0]>[0]) => {
      if (!mounted) return;
      setState((prev) => {
        const sessions = payload.meta
          ? [payload.meta, ...prev.sessions.filter((s) => s.id !== payload.meta!.id)]
          : prev.sessions;
        const isCurrent = prev.current?.meta.id === payload.sessionId
          || (payload.meta && payload.entries.length >= 0 && prev.current === null && payload.meta.status === 'running');
        const current = isCurrent && prev.current
          ? { meta: payload.meta ?? prev.current.meta, entries: [...prev.current.entries, ...payload.entries].slice(-BUFFER_CAP) }
          : prev.current;
        return { sessions, current };
      });
      if (!atBottomRef.current) {
        setNewSinceScroll((n) => n + payload.entries.length);
      }
    };
    window.electronAPI.onConsoleLine(onLine);
    return () => {
      mounted = false;
      window.electronAPI.removeConsoleListeners();
    };
  }, []);

  // Relative timestamps tick once a second while the view is visible.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  // ── Which entries are on screen? ───────────────────────────────────────
  const viewingLive = selectedSessionId === null || selectedSessionId === state.current?.meta.id;
  const entries: ConsoleEntry[] = useMemo(() => {
    if (viewingLive) return state.current?.entries ?? [];
    return historyEntries ?? [];
  }, [viewingLive, state.current, historyEntries]);

  // Switching to a historical session pulls its file once.
  useEffect(() => {
    if (viewingLive) {
      setHistoryEntries(null);
      return;
    }
    if (!selectedSessionId) return;
    let cancelled = false;
    window.electronAPI.consoleSessionLoad(selectedSessionId).then(({ meta, entries: fileEntries }) => {
      if (cancelled) return;
      setHistoryEntries(fileEntries);
      if (meta) {
        setState((prev) => ({
          ...prev,
          sessions: [meta, ...prev.sessions.filter((s) => s.id !== meta.id)],
        }));
      }
    });
    return () => { cancelled = true; };
  }, [selectedSessionId, viewingLive]);

  const visible = useMemo(() => entries.filter((e) => matchesFilter(e, filter)), [entries, filter]);

  // Reset scroll state when the session or view target changes.
  useEffect(() => {
    setAtBottom(true);
    atBottomRef.current = true;
    setNewSinceScroll(0);
    setExpandedError(null);
  }, [selectedSessionId, viewingLive]);

  // Auto-follow: stick to the bottom while the user is there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [visible.length, atBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setNewSinceScroll(0);
  }, []);

  // ── Error context expansion (mini post-mortem) ─────────────────────────
  const contextRows = useMemo(() => {
    if (expandedError === null) return null;
    const [lo, hi] = errorContextIndexes(visible, expandedError);
    return { lo, hi };
  }, [expandedError, visible]);

  // ── Crash jump ─────────────────────────────────────────────────────────
  const firstErrorIdx = useMemo(() => visible.findIndex((e) => e.level === 'error'), [visible]);

  const jumpToCrash = useCallback(() => {
    if (firstErrorIdx === -1) return;
    setExpandedError(firstErrorIdx);
    const el = scrollRef.current;
    if (!el) return;
    // The context block renders below the error row; land on the row itself.
    const row = el.querySelector<HTMLElement>(`[data-row="${firstErrorIdx}"]`);
    if (row) row.scrollIntoView({ block: 'start' });
  }, [firstErrorIdx]);

  // Crash-session preload: a crashed session opened from PlayView's link
  // pins the Oracle summary and jumps straight to the evidence.
  const didPreloadRef = useRef(false);
  useEffect(() => {
    if (didPreloadRef.current) return;
    if (!initialSessionId) return;
    const meta = state.sessions.find((s) => s.id === initialSessionId) ?? state.current?.meta;
    if (meta && meta.status === 'crashed' && entries.length > 0) {
      didPreloadRef.current = true;
      jumpToCrash();
    }
  }, [initialSessionId, state.sessions, state.current, entries.length, jumpToCrash]);

  // ── Copy for support ───────────────────────────────────────────────────
  const copyForSupport = useCallback(async () => {
    try {
      const ctx = await window.electronAPI.consoleSupportContext();
      const meta = viewingLive ? state.current?.meta : state.sessions.find((s) => s.id === selectedSessionId);
      const bundle = buildSupportBundle({
        emberVersion: ctx.emberVersion,
        platform: ctx.platform,
        javaPath: ctx.javaPath,
        sessionStatus: meta ? sessionSummary(meta) : 'no session',
        oracle: meta?.oracle ?? null,
        modCount: ctx.modCount,
        lines: supportLines(entries),
      });
      await navigator.clipboard.writeText(bundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable — nothing to report */ }
  }, [entries, selectedSessionId, state.current, state.sessions, viewingLive]);

  const openLogFile = useCallback(async () => {
    try {
      const p = await window.electronAPI.consoleLogPath();
      if (p) window.electronAPI.openPath(p);
    } catch { /* no file yet */ }
  }, []);

  // ── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        setPaletteQuery('');
        setPaletteIndex(0);
        return;
      }
      if (paletteOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setPaletteOpen(false);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setPaletteIndex((i) => Math.min(i + 1, fuzzyMatchActions(paletteQuery, PALETTE_ACTIONS).length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setPaletteIndex((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const actions = fuzzyMatchActions(paletteQuery, PALETTE_ACTIONS);
          const action = actions[Math.min(paletteIndex, actions.length - 1)];
          if (action) runAction(action.id);
        }
        return;
      }
      // '/' focuses search; digits 1–6 flip chips; 'c' copies.
      if (document.activeElement === searchRef.current) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key >= '1' && e.key <= '6') {
        const order: Chip[] = ['all', 'launcher', 'game', 'warn', 'err'];
        const idx = Number(e.key) - 1;
        if (idx < order.length) toggleChip(order[idx]);
      } else if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) {
        void copyForSupport();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, paletteQuery, paletteIndex, copyForSupport, chips]);

  const runAction = useCallback((id: string) => {
    setPaletteOpen(false);
    switch (id) {
      case 'copy': void copyForSupport(); break;
      case 'log': void openLogFile(); break;
      case 'regex': setRegexMode((r) => !r); break;
      case 'clear': setQuery(''); setChips([]); break;
      case 'jump': jumpToCrash(); break;
      case 'timestamps': setShowTimestamps((s) => !s); break;
    }
  }, [copyForSupport, openLogFile, jumpToCrash]);

  const toggleChip = useCallback((chip: Chip) => {
    setChips((prev) => {
      if (chip === 'all') return [];
      const without = prev.filter((c) => c !== 'all');
      return without.includes(chip) ? without.filter((c) => c !== chip) : [...without, chip];
    });
  }, []);

  const paletteResults = useMemo(
    () => fuzzyMatchActions(paletteQuery, PALETTE_ACTIONS),
    [paletteQuery]
  );

  useEffect(() => {
    if (paletteOpen) paletteInputRef.current?.focus();
  }, [paletteOpen]);

  const invalidRegex = regexMode && query.trim() !== '' && !isValidRegex(query);
  const matchCount = visible.length;
  const currentMeta = viewingLive ? state.current?.meta : state.sessions.find((s) => s.id === selectedSessionId);
  const isCrashedSession = currentMeta?.status === 'crashed';
  const launchCommand = entries.find((e) => e.source === 'launcher' && e.text.startsWith('launch command:'))?.text.slice('launch command: '.length) ?? null;

  return (
    <div className="relative flex h-full flex-col bg-[--ground] font-mono text-[12px]">
      {/* ── Session bar ─────────────────────────────────────────────── */}
      <div className="hairline-t flex h-11 shrink-0 items-center gap-3 px-5">
        <span className="microlabel !text-[10px]">console</span>
        <select
          className="cursor-pointer rounded-[6px] border border-[--line] bg-[--elevated] px-2 py-1 text-[11px] text-dim outline-none hover:border-[--line-strong]"
          value={selectedSessionId ?? state.current?.meta.id ?? ''}
          onChange={(e) => setSelectedSessionId(e.target.value === state.current?.meta.id ? null : e.target.value)}
        >
          {state.current && (
            <option value={state.current.meta.id}>
              current — {sessionSummary(state.current.meta)}
            </option>
          )}
          {state.sessions.filter((s) => s.id !== state.current?.meta.id).map((s) => (
            <option key={s.id} value={s.id}>
              {s.id.replace('session-', '')} — {sessionSummary(s)}
            </option>
          ))}
          {state.sessions.length === 0 && !state.current && <option value="">no sessions</option>}
        </select>
        {currentMeta && (
          <span className="flex items-center gap-2 text-[11px] text-faint">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                currentMeta.status === 'running' ? 'bg-[--ok]'
                : currentMeta.status === 'crashed' ? 'bg-[--danger]'
                : currentMeta.status === 'failed' ? 'bg-[--danger]'
                : 'bg-faint'
              }`}
            />
            {sessionSummary(currentMeta)}
          </span>
        )}
        <span className="ml-auto text-[10px] text-faint">ctrl+k actions · 1-6 filters · / search</span>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <div className="hairline-t flex h-10 shrink-0 items-center gap-2 px-5">
        {(['all', 'launcher', 'game', 'warn', 'err'] as Chip[]).map((chip, i) => {
          const active = chip === 'all' ? chips.length === 0 : chips.includes(chip);
          const count = chip === 'all'
            ? entries.length
            : chip === 'warn' ? countChip(entries, 'level', 'warn')
            : chip === 'err' ? countChip(entries, 'level', 'error')
            : countChip(entries, 'source', chip);
          return (
            <button
              key={chip}
              onClick={() => toggleChip(chip)}
              className={`rounded-[6px] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] transition-colors duration-micro ${
                active ? 'bg-white/6 text-ink' : 'text-faint hover:text-dim'
              }`}
              title={`filter: ${chip} (${i + 1})`}
            >
              {chip} {count > 0 && <span className="text-dim">{count}</span>}
            </button>
          );
        })}
        <div className={`ml-2 flex h-7 flex-1 items-center rounded-[6px] border px-2 ${invalidRegex ? 'border-[--danger]' : 'border-[--line]'}`}>
          {regexMode && <span className="mr-1 text-faint">/</span>}
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === '/' && query === '' && !regexMode) {
                e.preventDefault();
                setQuery('/');
                setRegexMode(true);
              }
            }}
            placeholder="search (leading / = regex)"
            className="w-full bg-transparent text-[12px] text-ink outline-none placeholder:text-faint"
            spellCheck={false}
          />
          {query !== '' && (
            <span className="ml-2 shrink-0 text-[10px] text-faint">{matchCount} matches</span>
          )}
        </div>
      </div>

      {/* ── Oracle pin (crashed sessions) ────────────────────────────── */}
      {isCrashedSession && currentMeta?.oracle && (
        <div className="mx-5 mt-2 flex shrink-0 items-center justify-between rounded-[10px] border border-[--danger]/20 bg-[--danger]/5 px-4 py-2">
          <span className="text-[11px] text-[--danger]">
            {currentMeta.oracle.modName
              ? `${currentMeta.oracle.modName} caused this crash — ${currentMeta.oracle.reason ?? 'unknown cause'}`
              : `crashed — ${currentMeta.oracle.reason ?? 'unknown cause'}`}
          </span>
          {firstErrorIdx !== -1 && (
            <button onClick={jumpToCrash} className="text-[11px] text-faint transition-colors duration-micro hover:text-ink">
              jump to crash
            </button>
          )}
        </div>
      )}

      {/* ── Session first line (fixed) ───────────────────────────────── */}
      {entries.length > 0 && (
        <p className="shrink-0 px-5 pt-3 text-[11px] text-faint">{SESSION_FIRST_LINE}</p>
      )}

      {/* ── Launch command (collapsible) ─────────────────────────────── */}
      {launchCommand && (
        <div className="shrink-0 px-5 pt-2">
          <button
            onClick={() => setShowLaunchCommand((s) => !s)}
            className="text-[10px] uppercase tracking-[0.14em] text-faint transition-colors duration-micro hover:text-dim"
          >
            {showLaunchCommand ? '− hide launch command' : '+ launch command'}
          </button>
          {showLaunchCommand && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-[6px] border border-[--line] bg-[--elevated] p-2 text-[11px] leading-relaxed text-dim">
              {launchCommand}
            </pre>
          )}
        </div>
      )}

      {/* ── The stream ───────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="hairline-t relative min-h-0 flex-1 overflow-y-auto px-5 py-3"
      >
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-[13px] text-dim">{EMPTY_TEXT}</p>
            <button
              onClick={() => void openLogFile()}
              className="text-[11px] text-faint underline-offset-2 transition-colors duration-micro hover:text-dim hover:underline"
            >
              open log file
            </button>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {visible.map((e, i) => {
                const inContext = contextRows !== null && i >= contextRows.lo && i <= contextRows.hi && i !== expandedError;
                return (
                  <FragmentedRow
                    key={`${e.ts}-${i}`}
                    entry={e}
                    index={i}
                    showTimestamps={showTimestamps}
                    now={now}
                    expanded={expandedError === i}
                    inContext={inContext}
                    onToggle={() => setExpandedError((cur) => (cur === i ? null : e.level === 'error' ? i : cur))}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── New-lines pill (paused follow) ───────────────────────────── */}
      {!atBottom && newSinceScroll > 0 && (
        <button
          onClick={() => {
            setAtBottom(true);
            atBottomRef.current = true;
            setNewSinceScroll(0);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-14 left-1/2 -translate-x-1/2 rounded-[999px] bg-[--elevated] px-3 py-1 text-[11px] text-dim shadow-lg transition-colors duration-micro hover:text-ink"
        >
          ↓ {newSinceScroll} new lines
        </button>
      )}

      {/* ── Action bar ───────────────────────────────────────────────── */}
      <div className="hairline-t flex h-9 shrink-0 items-center gap-4 px-5 text-[11px]">
        <button onClick={() => void copyForSupport()} className="text-faint transition-colors duration-micro hover:text-ink">
          {copied ? 'copied.' : 'copy for support'}
        </button>
        <button onClick={() => void openLogFile()} className="text-faint transition-colors duration-micro hover:text-ink">
          open log file
        </button>
        <span className="ml-auto text-[10px] text-faint">
          {entries.length} lines · showing {visible.length}
        </span>
      </div>

      {/* ── Command palette (Ctrl+K) ─────────────────────────────────── */}
      {paletteOpen && (
        <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/40 pt-24" onClick={() => setPaletteOpen(false)}>
          <div
            className="surface w-[420px] overflow-hidden rounded-[10px]"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={paletteInputRef}
              value={paletteQuery}
              onChange={(e) => { setPaletteQuery(e.target.value); setPaletteIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.min(i + 1, paletteResults.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const action = paletteResults[Math.min(paletteIndex, paletteResults.length - 1)];
                  if (action) runAction(action.id);
                } else if (e.key === 'Escape') {
                  setPaletteOpen(false);
                }
              }}
              placeholder="type a command…"
              className="w-full bg-transparent px-4 py-3 text-[13px] text-ink outline-none placeholder:text-faint"
              spellCheck={false}
            />
            <div className="hairline-t max-h-64 overflow-y-auto">
              {paletteResults.map((a, i) => (
                <button
                  key={a.id}
                  onMouseEnter={() => setPaletteIndex(i)}
                  onClick={() => runAction(a.id)}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-[12px] ${
                    i === paletteIndex ? 'bg-white/6 text-ink' : 'text-dim'
                  }`}
                >
                  <span>{a.label}</span>
                  {a.hint && <span className="text-[10px] text-faint">{a.hint}</span>}
                </button>
              ))}
              {paletteResults.length === 0 && (
                <p className="px-4 py-3 text-[12px] text-faint">no matching action</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Last ~100 lines, widened around errors — the support conversation's body. */
function supportLines(entries: readonly ConsoleEntry[]): ConsoleEntry[] {
  const tail = 100;
  if (entries.length <= tail) return [...entries];
  let lo = entries.length - tail;
  for (let i = lo; i < entries.length; i++) {
    if (entries[i].level === 'error') lo = Math.min(lo, Math.max(0, i - 3));
  }
  return entries.slice(lo);
}

function FragmentedRow({
  entry,
  index,
  showTimestamps,
  now,
  expanded,
  inContext,
  onToggle,
}: {
  entry: ConsoleEntry;
  index: number;
  showTimestamps: boolean;
  now: number;
  expanded: boolean;
  inContext: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const clickable = entry.level === 'error';
  const textColor =
    entry.level === 'error' ? 'text-[--danger]'
    : entry.level === 'warn' ? 'text-[#FFB224]/90'
    : entry.source === 'launcher' ? 'text-[#9C958A]'
    : 'text-[#B8B2A6]';
  return (
    <tr
      data-row={index}
      onClick={clickable ? onToggle : undefined}
      className={`align-top ${clickable ? 'cursor-pointer' : ''} ${
        expanded || inContext ? 'bg-white/[0.04]' : ''
      } ${clickable ? 'hover:bg-white/[0.06]' : ''}`}
    >
      {showTimestamps && (
        <td className="whitespace-nowrap py-[1px] pr-3 text-right text-[10px] tabular-nums text-faint" title={absoluteTime(entry.ts)}>
          {relativeTime(entry.ts, now)}
        </td>
      )}
      <td className="whitespace-nowrap py-[1px] pr-3 text-[10px] uppercase tracking-[0.1em] text-faint">
        {entry.source === 'launcher' ? 'lnchr' : 'game'}
      </td>
      <td className={`whitespace-pre-wrap break-all py-[1px] ${textColor}`}>
        {entry.text}
        {expanded && (
          <span className="mt-1 block text-[10px] text-faint">
            context ±3 lines — the rows around this error, above and below
          </span>
        )}
      </td>
    </tr>
  );
}

export default ConsoleView;
