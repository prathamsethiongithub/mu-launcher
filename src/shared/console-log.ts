/**
 * Console — pure logic layer (no Electron, no fs).
 *
 * Everything the console does that can be tested without a process lives
 * here: parsing Minecraft's log format, redacting credentials before a
 * line is ever persisted or displayed, search/filter predicates, relative
 * timestamps, the support-bundle assembly, the on-disk line format, and
 * the rotation/truncation math. The main-process service (console-service)
 * wires these into the session lifecycle; the renderer imports the same
 * predicates so search and filtering behave identically in both places.
 *
 * Security note: redaction is applied in the MAIN process (once per line,
 * before both the file write and the renderer broadcast), but the regexes
 * live here so they are testable and shared. Redaction is a security
 * requirement, not a nicety — access and session tokens must never reach
 * disk or the renderer.
 */

export type ConsoleSource = 'launcher' | 'game';
export type ConsoleLevel = 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  /** Epoch milliseconds. */
  ts: number;
  source: ConsoleSource;
  level: ConsoleLevel;
  text: string;
}

// ── Game line parsing ────────────────────────────────────────────────────────

/** Minecraft's log format: `[12:34:56] [Render thread/INFO]: message`. */
const GAME_LINE = /^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^/]+)\/([A-Za-z]+)\]:\s?(.*)$/;

/** Well-known level words → console level (case-insensitive match key). */
const LEVEL_MAP: Record<string, ConsoleLevel> = {
  INFO: 'info',
  WARN: 'warn',
  WARNING: 'warn',
  ERROR: 'error',
  FATAL: 'error',
  DEBUG: 'debug',
  TRACE: 'debug',
};

/**
 * Parse one line of the game's stdout/stderr. Lines matching Minecraft's
 * format get their level mapped; anything else (installers, stack noise,
 * binary garbage decoded to replacement chars) is kept verbatim as `info`
 * — evidence is never dropped for failing to match a format.
 */
export function parseGameLine(raw: string, fallbackTs: number): ConsoleEntry {
  const text = raw.length > 0 && raw.charCodeAt(raw.length - 1) === 13
    ? raw.slice(0, -1)
    : raw;
  const m = GAME_LINE.exec(text);
  if (m) {
    const level = LEVEL_MAP[m[3].toUpperCase()] ?? 'info';
    return { ts: fallbackTs, source: 'game', level, text: m[4] };
  }
  return { ts: fallbackTs, source: 'game', level: 'info', text };
}

// ── Redaction (security red line) ────────────────────────────────────────────

/**
 * Patterns replaced with `[redacted]` before a line is stored or shown.
 * Kept deliberately conservative — they must catch credential-shaped
 * values (labeled tokens, `--accessToken` style flags, JWTs) without
 * mangling UUIDs or ordinary prose.
 */
const REDACTION_RULES: readonly { pattern: RegExp; replacement: string }[] = [
  // Labeled credentials, tolerating JSON quoting around label and value:
  //   access_token: xyz · "accessToken":"xyz" · password = xyz · Bearer xyz
  {
    pattern: /\b((?:access|session|client)[_-]?token|secret|password|authorization|bearer)(\s*["']?\s*[:=]\s*["']?\s*|\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: '$1$2[redacted]',
  },
  // Launch-flag style: --accessToken xyz / -Dtoken=xyz
  {
    pattern: /(--(?:access[_-]?token|token|session|secret)[= ])(\S+)/gi,
    replacement: '$1[redacted]',
  },
  // JWT three-segment shape (header.payload.signature) in the wild.
  {
    pattern: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[redacted]',
  },
];

/**
 * Replace anything credential-shaped with `[redacted]`. Idempotent (the
 * literal `[redacted]` is left untouched by all rules).
 */
export function redactTokens(input: string): string {
  let out = input;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

// ── Search & filter predicates ───────────────────────────────────────────────

export interface FilterState {
  /** Substring (default) or regex source (when regexMode). */
  query: string;
  regexMode: boolean;
  /** Selected chips. Empty = all. Sources and levels combine: within a
   *  group the selection ORs, across groups it ANDs. */
  sources: readonly ConsoleSource[];
  levels: readonly ConsoleLevel[];
}

/** Invalid regex source — the input renders red instead of matching. */
export function isValidRegex(src: string): boolean {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
}

function matchesChips(entry: ConsoleEntry, f: FilterState): boolean {
  const sourceOk = f.sources.length === 0 || f.sources.includes(entry.source);
  const levelOk = f.levels.length === 0 || f.levels.includes(entry.level);
  return sourceOk && levelOk;
}

/**
 * Does the entry match the current filter? Invalid regex (checked
 * separately by the UI) makes the query match nothing rather than throw.
 */
export function matchesFilter(entry: ConsoleEntry, f: FilterState): boolean {
  if (!matchesChips(entry, f)) return false;
  const q = f.query.trim();
  if (q === '') return true;
  if (f.regexMode) {
    if (!isValidRegex(q)) return false;
    try {
      return new RegExp(q).test(entry.text);
    } catch {
      return false;
    }
  }
  return entry.text.toLowerCase().includes(q.toLowerCase());
}

/** Count of entries matching the whole filter (for the "N matches" readout). */
export function countMatches(entries: readonly ConsoleEntry[], f: FilterState): number {
  let n = 0;
  for (const e of entries) if (matchesFilter(e, f)) n++;
  return n;
}

/** Count of entries matching a single chip (for the per-chip badge). */
export function countChip(
  entries: readonly ConsoleEntry[],
  kind: 'source' | 'level',
  value: string
): number {
  let n = 0;
  for (const e of entries) {
    if (kind === 'source' ? e.source === value : e.level === value) n++;
  }
  return n;
}

// ── Relative timestamps ──────────────────────────────────────────────────────

/**
 * Compact relative display: "now", "12s ago", "3m ago", "2h ago", older
 * falls back to a short absolute (HH:MM:SS). Pure so the UI tests can pin
 * the vocabulary.
 */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 2) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Absolute millis value shown on hover — fixed-width, sortable. */
export function absoluteTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ── Persistence line format (human-readable plain text) ──────────────────────

/**
 * One console entry → one file line:
 *   [2026-09-21T12:34:56.789Z] [launcher/info] text
 * The format is the contract between persistence and session-load's
 * read-back; both directions round-trip through these two functions.
 */
export function formatPersistedLine(entry: ConsoleEntry): string {
  return `[${new Date(entry.ts).toISOString()}] [${entry.source}/${entry.level}] ${entry.text}`;
}

const PERSISTED_LINE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] \[(launcher|game)\/(info|warn|error|debug)\] ?([\s\S]*)$/;

/** Read-back parser: `#`-prefixed metadata lines yield null, not entries. */
export function parsePersistedLine(line: string): ConsoleEntry | null {
  if (line.startsWith('#') || line === '') return null;
  const m = PERSISTED_LINE.exec(line);
  if (!m) return null;
  return {
    ts: Date.parse(m[1]),
    source: m[2] as ConsoleSource,
    level: m[3] as ConsoleLevel,
    text: m[4],
  };
}

// ── Rotation & truncation ────────────────────────────────────────────────────

export const MAX_SESSION_FILES = 10;
export const MAX_SESSION_BYTES = 5 * 1024 * 1024;

/**
 * Oldest sessions first beyond the retention window. Input is a sorted
 * (newest first) list of filenames; returns the files to delete.
 */
export function pickSessionsToDelete(files: readonly string[]): string[] {
  if (files.length <= MAX_SESSION_FILES) return [];
  return files.slice(MAX_SESSION_FILES);
}

const TRUNCATE_MARKER = '# [truncated] — older lines removed (5 MB session cap)';

/**
 * Cap a session's content at MAX_SESSION_BYTES, dropping OLDEST lines
 * first and leaving a marker where they were. Lines are the persisted
 * text lines; the budget is bytes of the joined output.
 */
export function computeTruncatedContent(lines: readonly string[]): string[] {
  const total = lines.reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1, 0);
  if (total <= MAX_SESSION_BYTES) return [...lines];
  const markerBytes = Buffer.byteLength(TRUNCATE_MARKER, 'utf8') + 1;
  let budget = MAX_SESSION_BYTES - markerBytes;
  const keep: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(lines[i], 'utf8') + 1;
    if (budget - cost < 0) break;
    budget -= cost;
    keep.push(lines[i]);
  }
  keep.reverse();
  return [TRUNCATE_MARKER, ...keep];
}

// ── Session identity & metadata ──────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** clean exit | crashed | cancelled | failed (launch error before spawn) */
  status: 'running' | 'clean exit' | 'crashed' | 'cancelled' | 'failed';
  exitCode?: number;
  oracle?: { modName?: string; reason?: string } | null;
}

export function makeSessionId(now: number, rand: () => string): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand()}`;
}

/** Filename for a session id (ids are filesystem-safe by construction). */
export function sessionFileName(id: string): string {
  return `${id}.log`;
}

/** Summary line for the session bar / crashed-entry pin. */
export function sessionSummary(meta: SessionMeta): string {
  switch (meta.status) {
    case 'running':
      return 'running';
    case 'clean exit':
      return 'clean exit';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return `failed${meta.oracle?.reason ? ` — ${meta.oracle.reason}` : ''}`;
    case 'crashed':
      return meta.oracle?.modName
        ? `crashed — ${meta.oracle.modName}: ${meta.oracle.reason ?? 'unknown cause'}`
        : `crashed${meta.oracle?.reason ? ` — ${meta.oracle.reason}` : ''}`;
  }
}

// ── Support bundle (copy for support) ────────────────────────────────────────

export interface SupportContext {
  emberVersion: string;
  platform: string;
  javaPath: string;
  sessionStatus: string;
  oracle: { modName?: string; reason?: string } | null;
  modCount: number;
  lines: readonly ConsoleEntry[];
}

/**
 * Fixed ~100-line tail budget, widened around ERROR lines: scan backwards
 * from the end of the budget until the first error, include ±3 context rows
 * (bounded by the budget itself), and take the tail behind that context.
 */
export function supportWindow(
  entries: readonly ConsoleEntry[],
  tail = 100
): ConsoleEntry[] {
  const n = entries.length;
  if (n <= tail) return [...entries];
  const start = n - tail; // first index of the default tail
  // Find the last error inside the tail; widen ±3 around it (budget-clamped).
  let lo = start;
  for (let i = start; i < n; i++) {
    if (entries[i].level === 'error') {
      lo = Math.min(lo, Math.max(0, i - 3));
    }
  }
  return entries.slice(lo, n);
}

/**
 * Discord-friendly fenced block. Everything the support conversation
 * needs, nothing that isn't measured, and already redacted upstream.
 */
export function buildSupportBundle(ctx: SupportContext): string {
  const lines: string[] = [];
  lines.push('```');
  lines.push(`ember ${ctx.emberVersion} · ${ctx.platform} · java ${ctx.javaPath}`);
  lines.push(`session ${ctx.sessionStatus}${ctx.oracle?.modName ? ` — ${ctx.oracle.modName}: ${ctx.oracle.reason ?? 'unknown cause'}` : ''}`);
  lines.push(`mods ${ctx.modCount}`);
  lines.push('');
  for (const e of ctx.lines) {
    lines.push(`[${e.source}/${e.level}] ${e.text}`);
  }
  lines.push('```');
  return lines.join('\n');
}

// ── Command palette (fuzzy action match) ─────────────────────────────────────

export interface PaletteAction {
  id: string;
  label: string;
  hint: string;
}

/**
 * Subsequence fuzzy match with a light score: consecutive runs and
 * word-start hits rank higher. Empty query matches everything in order.
 */
export function fuzzyMatchActions(
  query: string,
  actions: readonly PaletteAction[]
): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...actions];
  const scored: { a: PaletteAction; score: number }[] = [];
  for (const a of actions) {
    const label = a.label.toLowerCase();
    let qi = 0;
    let score = 0;
    let lastHit = -2;
    for (let i = 0; i < label.length && qi < q.length; i++) {
      if (label[i] === q[qi]) {
        score += i === lastHit + 1 ? 3 : 1;
        if (i === 0 || label[i - 1] === ' ') score += 2;
        lastHit = i;
        qi++;
      }
    }
    if (qi === q.length) scored.push({ a, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.a);
}
