import { describe, expect, it } from 'vitest';
import {
  parseGameLine,
  redactTokens,
  isValidRegex,
  matchesFilter,
  countMatches,
  countChip,
  relativeTime,
  absoluteTime,
  formatPersistedLine,
  parsePersistedLine,
  pickSessionsToDelete,
  computeTruncatedContent,
  makeSessionId,
  sessionFileName,
  sessionSummary,
  supportWindow,
  buildSupportBundle,
  fuzzyMatchActions,
  foldConsoleLinePayload,
  isCurrentSessionPayload,
  LIVE_BUFFER_CAP,
  MAX_SESSION_BYTES,
  type ConsoleEntry,
  type ConsoleSnapshot,
  type FilterState,
  type PaletteAction,
  type SessionMeta,
} from '../src/shared/console-log';

const T = Date.UTC(2026, 8, 21, 12, 0, 0); // fixed epoch for determinism (2026-09-21T12:00:00Z)

function entry(partial: Partial<ConsoleEntry>): ConsoleEntry {
  return { ts: T, source: 'game', level: 'info', text: 'hello', ...partial };
}

const ALL: FilterState = { query: '', regexMode: false, sources: [], levels: [] };

describe('parseGameLine', () => {
  it('maps Minecraft format to levels', () => {
    expect(parseGameLine('[12:34:56] [Render thread/INFO]: Loading', T)).toEqual({
      ts: T, source: 'game', level: 'info', text: 'Loading',
    });
    expect(parseGameLine('[12:34:56] [main/WARN]: Depricated', T).level).toBe('warn');
    expect(parseGameLine('[12:34:56] [main/ERROR]: Boom', T).level).toBe('error');
    expect(parseGameLine('[12:34:56] [main/FATAL]: Boom', T).level).toBe('error');
    expect(parseGameLine('[12:34:56] [main/DEBUG]: hush', T).level).toBe('debug');
  });

  it('captures thread name and strips CR', () => {
    const e = parseGameLine('[12:34:56] [Render thread/INFO]: hi\r', T);
    expect(e.text).toBe('hi');
  });

  it('keeps non-matching lines verbatim as info (evidence is never dropped)', () => {
    expect(parseGameLine('java.lang.RuntimeException: nope', T)).toEqual({
      ts: T, source: 'game', level: 'info', text: 'java.lang.RuntimeException: nope',
    });
    // Binary garbage decoded to replacement chars survives verbatim.
    const garbage = '\uFFFD\u0000\u0001\uFFFDraw';
    expect(parseGameLine(garbage, T).text).toBe(garbage);
  });

  it('handles extremely long lines without truncation', () => {
    const long = 'x'.repeat(100_000);
    const e = parseGameLine(`[00:00:00] [main/INFO]: ${long}`, T);
    expect(e.text.length).toBe(100_000);
  });

  it('does not let a bracketed prefix elsewhere in the line match', () => {
    // The format anchors at line start — a timestamp-looking string after
    // other text is not a Minecraft log line.
    const e = parseGameLine('see [12:34:56] [main/INFO]: not a header', T);
    expect(e.level).toBe('info');
    expect(e.text).toBe('see [12:34:56] [main/INFO]: not a header');
  });
});

describe('redactTokens', () => {
  it('redacts labeled tokens', () => {
    expect(redactTokens('access_token: 8f2a1b3c4d5e6f70')).toBe('access_token: [redacted]');
    expect(redactTokens('"accessToken":"8f2a1b3c4d5e6f70"')).toBe('"accessToken":"[redacted]"');
    expect(redactTokens('Authorization: Bearer eyJhbGciOi.abc.defg')).toBe('Authorization: Bearer [redacted]');
    expect(redactTokens('password = hunter2hunter2')).toBe('password = [redacted]');
  });

  it('redacts launch flags (--accessToken xyz)', () => {
    const out = redactTokens('java --accessToken 8f2a1b3c4d5e6f70 --username Steve');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('8f2a1b3c4d5e6f70');
    expect(out).toContain('--username Steve');
  });

  it('redacts JWT-shaped strings in the wild', () => {
    expect(redactTokens('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'))
      .toContain('[redacted]');
  });

  it('leaves ordinary content alone (UUIDs, prose, paths)', () => {
    const keep = 'uuid 7c9e6679-742f-45de-a3cd-3b6d0f0a1111 C:\\Users\\me\\mods';
    expect(redactTokens(keep)).toBe(keep);
    expect(redactTokens('Game loaded with 42 mods')).toBe('Game loaded with 42 mods');
  });

  it('is idempotent over the [redacted] literal', () => {
    const once = redactTokens('access_token: 8f2a1b3c4d5e6f70');
    expect(redactTokens(once)).toBe(once);
  });
});

describe('filter & search predicates', () => {
  const lines: ConsoleEntry[] = [
    entry({ source: 'launcher', level: 'info', text: 'Java ready' }),
    entry({ source: 'game', level: 'info', text: 'Loading properties' }),
    entry({ source: 'game', level: 'warn', text: 'Deprecated API' }),
    entry({ source: 'game', level: 'error', text: 'Exception in thread "main"' }),
  ];

  it('empty query matches all', () => {
    expect(countMatches(lines, ALL)).toBe(4);
  });

  it('substring search is case-insensitive', () => {
    expect(countMatches(lines, { ...ALL, query: 'EXCEPTION' })).toBe(1);
  });

  it('regex mode matches and invalid regex matches nothing', () => {
    const f: FilterState = { query: 'Exception in thread', regexMode: true, sources: [], levels: [] };
    expect(countMatches(lines, f)).toBe(1);
    const bad: FilterState = { query: '([unclosed', regexMode: true, sources: [], levels: [] };
    expect(countMatches(lines, bad)).toBe(0);
    expect(isValidRegex('([unclosed')).toBe(false);
    expect(isValidRegex('^Exception')).toBe(true);
  });

  it('source and level chips OR within a group and AND across groups', () => {
    const gameOrLauncher = matchesFilter(lines[0], { ...ALL, sources: ['game', 'launcher'] });
    expect(gameOrLauncher).toBe(true);
    const warnOnly = matchesFilter(lines[2], { ...ALL, levels: ['warn'] });
    expect(warnOnly).toBe(true);
    const warnFromLauncher = matchesFilter(lines[2], { ...ALL, sources: ['launcher'], levels: ['warn'] });
    expect(warnFromLauncher).toBe(false);
  });

  it('chip counts are per-value', () => {
    expect(countChip(lines, 'level', 'error')).toBe(1);
    expect(countChip(lines, 'source', 'launcher')).toBe(1);
    expect(countChip(lines, 'source', 'game')).toBe(3);
  });
});

describe('relative & absolute time', () => {
  it('renders the compact vocabulary', () => {
    expect(relativeTime(T, T)).toBe('now');
    expect(relativeTime(T - 12_000, T)).toBe('12s ago');
    expect(relativeTime(T - 5 * 60_000, T)).toBe('5m ago');
    expect(relativeTime(T - 3 * 3_600_000, T)).toBe('3h ago');
  });

  it('absolute hover value is fixed-width', () => {
    const s = absoluteTime(T);
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe('persistence round-trip', () => {
  it('round-trips launcher and game entries', () => {
    const e1 = entry({ source: 'launcher', level: 'info', text: 'launch started' });
    const e2 = entry({ source: 'game', level: 'error', text: 'boom [x]: y' });
    for (const e of [e1, e2]) {
      expect(parsePersistedLine(formatPersistedLine(e))).toEqual(e);
    }
  });

  it('metadata and blank lines yield null', () => {
    expect(parsePersistedLine('# [truncated] — older lines removed')).toBeNull();
    expect(parsePersistedLine('')).toBeNull();
  });

  it('malformed lines never throw', () => {
    expect(parsePersistedLine('random junk')).toBeNull();
    expect(parsePersistedLine('[not-a-date] [game/info] x')).toBeNull();
  });

  it('text with newlines round-trips through the tail field', () => {
    const e = entry({ text: 'line one\nline two' });
    const back = parsePersistedLine(formatPersistedLine(e));
    expect(back?.text).toBe('line one\nline two');
  });
});

describe('rotation & truncation', () => {
  it('keeps the newest 10 sessions and deletes older ones', () => {
    const files = Array.from({ length: 13 }, (_, i) => `session-${String(13 - i).padStart(4, '0')}.log`);
    expect(pickSessionsToDelete(files)).toEqual(['session-0003.log', 'session-0002.log', 'session-0001.log']);
    expect(pickSessionsToDelete(files.slice(0, 10))).toEqual([]);
  });

  it('content under the cap passes through untouched', () => {
    const lines = ['# session 2026-09-21', '[ts] [game/info] hello'];
    expect(computeTruncatedContent(lines)).toEqual(lines);
  });

  it('caps at 5 MB dropping the OLDEST lines with a marker', () => {
    const big = 'y'.repeat(300_000);
    const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, '0')} ${big}`);
    const out = computeTruncatedContent(lines);
    const bytes = out.reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1, 0);
    expect(bytes).toBeLessThanOrEqual(MAX_SESSION_BYTES);
    expect(out[0]).toMatch(/^# \[truncated\]/);
    expect(out.join('\n')).not.toContain('line-00 ');
    expect(out.join('\n')).toContain('line-29 ');
  });
});

describe('session identity & summary', () => {
  it('builds filesystem-safe ids and filenames', () => {
    const id = makeSessionId(T, () => 'abc123');
    // Id encodes LOCAL time; compute the expectation from the same fields so
    // the assertion holds in any timezone.
    const d = new Date(T);
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    expect(id).toBe(`session-${stamp}-abc123`);
    expect(sessionFileName(id)).toBe(`${id}.log`);
    expect(id).not.toMatch(/[/\\:*?"<>|]/);
  });

  it('summaries carry the oracle attribution for crashes', () => {
    expect(sessionSummary({ id: 's', startedAt: T, status: 'running' })).toBe('running');
    expect(sessionSummary({ id: 's', startedAt: T, status: 'clean exit' })).toBe('clean exit');
    expect(sessionSummary({ id: 's', startedAt: T, status: 'crashed', oracle: { modName: 'spectralforest', reason: 'mixer allocation' } }))
      .toBe('crashed — spectralforest: mixer allocation');
    expect(sessionSummary({ id: 's', startedAt: T, status: 'crashed' })).toBe('crashed');
    expect(sessionSummary({ id: 's', startedAt: T, status: 'failed', oracle: { reason: 'Java missing' } }))
      .toBe('failed — Java missing');
  });
});

describe('support bundle', () => {
  it('includes version, platform, java, status, mods and a fenced body', () => {
    const lines: ConsoleEntry[] = [
      entry({ source: 'launcher', text: 'launching' }),
      entry({ level: 'error', text: 'crash line' }),
    ];
    const bundle = buildSupportBundle({
      emberVersion: '1.4.0', platform: 'win32', javaPath: 'C:\\jre\\bin\\java.exe',
      sessionStatus: 'crashed', oracle: { modName: 'spectralforest', reason: 'mixer allocation' },
      modCount: 23, lines,
    });
    expect(bundle.startsWith('```')).toBe(true);
    expect(bundle).toContain('ember 1.4.0 · win32 · java C:\\jre\\bin\\java.exe');
    expect(bundle).toContain('session crashed — spectralforest: mixer allocation');
    expect(bundle).toContain('mods 23');
    expect(bundle).toContain('[game/error] crash line');
  });

  it('window widens around errors and caps at the budget', () => {
    const lines: ConsoleEntry[] = Array.from({ length: 250 }, (_, i) =>
      entry({ text: `filler ${i}` })
    );
    lines[200] = entry({ level: 'error', text: 'boom' });
    const w = supportWindow(lines, 100);
    expect(w.length).toBeLessThanOrEqual(100);
    expect(w.some((e) => e.text === 'boom')).toBe(true);
    // Context before the error is included.
    expect(w.some((e) => e.text === 'filler 197')).toBe(true);
    // Newest line is always included.
    expect(w[w.length - 1].text).toBe('filler 249');
  });
});

describe('command palette fuzzy match', () => {
  const actions: PaletteAction[] = [
    { id: 'copy', label: 'copy for support', hint: 'c' },
    { id: 'log', label: 'open log file', hint: '' },
    { id: 'regex', label: 'toggle regex mode', hint: '' },
    { id: 'clear', label: 'clear filter', hint: '' },
    { id: 'jump', label: 'jump to crash', hint: '' },
    { id: 'ts', label: 'toggle timestamps', hint: '' },
  ];

  it('empty query returns all in order', () => {
    expect(fuzzyMatchActions('', actions).map((a) => a.id)).toEqual(actions.map((a) => a.id));
  });

  it('subsequence matches rank word starts higher', () => {
    const out = fuzzyMatchActions('copy', actions);
    expect(out[0].id).toBe('copy');
    const out2 = fuzzyMatchActions('jump', actions);
    expect(out2[0].id).toBe('jump');
  });

  it('no match yields empty list', () => {
    expect(fuzzyMatchActions('zzzqqq', actions)).toEqual([]);
  });
});

describe('live-session reduction (foldConsoleLinePayload)', () => {
  const meta: SessionMeta = { id: 'session-1', startedAt: T, status: 'running' };
  const empty: ConsoleSnapshot = { sessions: [], current: null };

  it('materializes the session from null on a meta-only payload', () => {
    // The real-machine fault: the first flush after beginSession carries
    // meta + zero entries. Before the fix this could not create a session.
    const next = foldConsoleLinePayload(empty, { sessionId: meta.id, entries: [], meta });
    expect(next.current).not.toBeNull();
    expect(next.current!.meta.id).toBe(meta.id);
    expect(next.current!.entries).toEqual([]);
  });

  it('appends later batches to the materialized session', () => {
    const a = entry({ text: 'first' });
    const b = entry({ text: 'second' });
    const materialized = foldConsoleLinePayload(empty, { sessionId: meta.id, entries: [a], meta });
    const next = foldConsoleLinePayload(materialized, { sessionId: meta.id, entries: [b] });
    expect(next.current!.entries.map((e) => e.text)).toEqual(['first', 'second']);
    expect(next.sessions.map((s) => s.id)).toEqual([meta.id]);
  });

  it('accepts a payload whose session is already followed, even without meta', () => {
    const followed: ConsoleSnapshot = { sessions: [meta], current: { meta, entries: [entry({ text: 'x' })] } };
    const next = foldConsoleLinePayload(followed, { sessionId: meta.id, entries: [entry({ text: 'y' })] });
    expect(next.current!.entries.map((e) => e.text)).toEqual(['x', 'y']);
    // The followed session's meta is preserved when the payload omits it.
    expect(next.current!.meta).toBe(meta);
  });

  it('ignores payloads from a non-current session', () => {
    const other: SessionMeta = { id: 'session-2', startedAt: T, status: 'crashed' };
    const followed: ConsoleSnapshot = { sessions: [meta], current: { meta, entries: [entry({ text: 'keep' })] } };
    const next = foldConsoleLinePayload(followed, { sessionId: other.id, entries: [entry({ text: 'drop' })], meta: other });
    // Live buffer untouched…
    expect(next.current!.entries.map((e) => e.text)).toEqual(['keep']);
    // …but the sessions list learned the other session.
    expect(next.sessions.map((s) => s.id)).toEqual([other.id, meta.id]);
  });

  it('ignores a running meta when a different session is already materialized', () => {
    const followed: ConsoleSnapshot = { sessions: [meta], current: { meta, entries: [entry({ text: 'live' })] } };
    const rogue: SessionMeta = { id: 'session-rogue', startedAt: T, status: 'running' };
    expect(isCurrentSessionPayload(followed, { sessionId: rogue.id, entries: [], meta: rogue })).toBe(false);
    const next = foldConsoleLinePayload(followed, { sessionId: rogue.id, entries: [], meta: rogue });
    expect(next.current!.meta.id).toBe(meta.id);
  });

  it('keeps only the newest LIVE_BUFFER_CAP entries', () => {
    let snap: ConsoleSnapshot = { sessions: [], current: null };
    snap = foldConsoleLinePayload(snap, { sessionId: meta.id, entries: [], meta });
    const burst = Array.from({ length: LIVE_BUFFER_CAP + 25 }, (_, i) => entry({ text: `line ${i}` }));
    snap = foldConsoleLinePayload(snap, { sessionId: meta.id, entries: burst });
    expect(snap.current!.entries.length).toBe(LIVE_BUFFER_CAP);
    // Newest kept, oldest dropped.
    expect(snap.current!.entries[0].text).toBe('line 25');
    expect(snap.current!.entries.at(-1)!.text).toBe(`line ${LIVE_BUFFER_CAP + 24}`);
  });

  it('does not follow a terminal meta from null — it lands in the sessions list', () => {
    const done: SessionMeta = { id: meta.id, startedAt: T, endedAt: T + 1000, status: 'clean exit', exitCode: 0 };
    const next = foldConsoleLinePayload(empty, { sessionId: done.id, entries: [], meta: done });
    // Materialization from null is a live-follow gesture: only a running
    // session claims the live pane. A session that ended before the
    // renderer ever saw it stays a history entry.
    expect(next.current).toBeNull();
    expect(next.sessions[0].status).toBe('clean exit');
  });
});
