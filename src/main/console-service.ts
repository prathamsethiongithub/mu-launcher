/**
 * Console service — the passive observer.
 *
 * Captures everything a launch does (launcher pipeline events + the game's
 * stdout/stderr) into bounded in-memory sessions, persists each session as
 * human-readable plain text under {userData}/logs/, and streams incremental
 * lines to the renderer in small batches.
 *
 * Zero-intrusion law: the console only SUBSCRIBES. It never blocks, never
 * reorders, never touches the launch path's timing — the launch pipeline
 * keeps its exact shape and the MCLC events keep flowing however they did
 * before. Every capture point is an event handler that appends to a buffer
 * and schedules a batched flush.
 *
 * Redaction happens HERE, once per line, before both the file write and the
 * renderer broadcast — tokens can never reach disk or the renderer.
 */

/**
 * The directory is injected (no electron import here — the service stays
 * unit-testable); index.ts passes {userData}/logs.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type ConsoleEntry,
  type ConsoleLevel,
  type SessionMeta,
  type ConsoleLinePayload,
  type ConsoleSnapshot,
  parseGameLine,
  redactTokens,
  formatPersistedLine,
  parsePersistedLine,
  computeTruncatedContent,
  pickSessionsToDelete,
  makeSessionId,
  sessionFileName,
  MAX_SESSION_FILES,
} from '../shared/console-log';

const FLUSH_INTERVAL_MS = 100;
const FLUSH_MAX_LINES = 64;
const RENDER_BUFFER_CAP = 5000;

function toLevel(status: string): ConsoleLevel {
  if (status === 'error') return 'error';
  if (status === 'working') return 'info';
  return 'info';
}

export class ConsoleService {
  private sessionsDir: string;
  private current: SessionMeta | null = null;
  private currentEntries: ConsoleEntry[] = [];
  private launchCommand: string | null = null;
  private pending: ConsoleEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private onLines: ((payload: ConsoleLinePayload) => void) | null = null;
  private fileWriteError = false;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  /** Wire the renderer broadcast. One listener: the app-scope subscriber. */
  setBroadcast(fn: (payload: ConsoleLinePayload) => void): void {
    this.onLines = fn;
  }

  private dir(): string {
    return this.sessionsDir;
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  /** Called when a launch attempt begins (before any pipeline work). */
  beginSession(now = Date.now()): string {
    // A new session closes any previous one that never reached a terminal
    // state (launcher killed mid-game, renderer reload, …).
    if (this.current && this.current.status === 'running') {
      this.current.status = 'cancelled';
      this.current.endedAt = now;
      this.finalizeFile();
    }
    this.pending = []; // never carry another session's batch across
    const id = makeSessionId(now, () => Math.random().toString(36).slice(2, 8));
    this.current = { id, startedAt: now, status: 'running' };
    this.currentEntries = [];
    this.launchCommand = null;
    this.fileWriteError = false;
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      fs.writeFileSync(path.join(this.dir(), sessionFileName(id)), `# ember console session ${id}\n`, 'utf8');
    } catch { /* persistence failures never touch the launch path */ }
    this.emitMeta();
    return id;
  }

  /** Full JVM command line, recorded once MCLC hands it over. */
  recordLaunchCommand(argv: string[]): void {
    if (!this.current || argv.length === 0) return;
    this.launchCommand = redactTokens(argv.join(' '));
    this.pushEntry({
      ts: Date.now(),
      source: 'launcher',
      level: 'info',
      text: `launch command: ${this.launchCommand}`,
    });
  }

  /** Launcher pipeline step (from launch-step forwards). */
  addLauncherLine(step: string, status: string, progress: number): void {
    if (!this.current) return;
    const text = `step ${step}: ${status}${progress > 0 ? ` (${progress}%)` : ''}`;
    this.pushEntry({ ts: Date.now(), source: 'launcher', level: toLevel(status), text });
  }

  /** MCLC debug/diagnostic chatter (download notes, start errors). */
  addLauncherDebug(text: string): void {
    if (!this.current) return;
    const level: ConsoleLevel = /^\[MCLC\]: (Couldn't start|Failed)/i.test(text) ? 'error' : 'debug';
    this.pushEntry({ ts: Date.now(), source: 'launcher', level, text });
  }

  /** One raw line of the game's stdout/stderr. */
  addGameLine(raw: string): void {
    if (!this.current) return;
    const parsed = parseGameLine(raw, Date.now());
    parsed.text = redactTokens(parsed.text);
    this.pushEntry(parsed);
  }

  /**
   * Session terminal state. `code === 0` is a clean exit; any other code
   * (or a launch error before spawn) marks the session for the Oracle —
   * the caller may attach the diagnosis afterwards.
   */
  endSession(code: number, now = Date.now()): void {
    if (!this.current) return;
    if (this.current.status !== 'running') return;
    this.current.status = code === 0 ? 'clean exit' : 'crashed';
    this.current.exitCode = code;
    this.current.endedAt = now;
    this.pushEntry({
      ts: now,
      source: 'launcher',
      level: code === 0 ? 'info' : 'error',
      text: `game exited with code ${code}`,
    });
    this.finalizeFile();
    this.emitMeta();
    this.flush(true);
  }

  /** Launch failed before spawn (E-code path). */
  failSession(error: string, now = Date.now()): void {
    if (!this.current) return;
    if (this.current.status !== 'running') return;
    this.current.status = 'failed';
    this.current.endedAt = now;
    this.current.oracle = { reason: redactTokens(error) };
    this.pushEntry({
      ts: now,
      source: 'launcher',
      level: 'error',
      text: redactTokens(error),
    });
    this.finalizeFile();
    this.emitMeta();
    this.flush(true);
  }

  /** Cancel (user-initiated) — recorded without the crash attribution. */
  cancelSession(now = Date.now()): void {
    if (!this.current) return;
    if (this.current.status !== 'running') return;
    this.current.status = 'cancelled';
    this.current.endedAt = now;
    this.pushEntry({
      ts: now,
      source: 'launcher',
      level: 'info',
      text: 'launch cancelled by user',
    });
    this.finalizeFile();
    this.emitMeta();
    this.flush(true);
  }

  /** Attach the Oracle's attribution to the current (just-ended) session. */
  attachOracle(oracle: { modName?: string; reason?: string } | null): void {
    if (!this.current || !oracle || (!oracle.modName && !oracle.reason)) return;
    this.current.oracle = oracle;
    this.finalizeFile(); // rewrites the header with the attribution
    this.emitMeta();
  }

  getCurrentMeta(): SessionMeta | null {
    return this.current;
  }

  getLaunchCommand(): string | null {
    return this.launchCommand;
  }

  /**
   * Full snapshot for the renderer (sessions list + current session lines).
   * History sessions are read back from their files on demand by
   * loadSession(); this snapshot only carries the live buffer.
   */
  snapshot(): ConsoleSnapshot {
    return {
      sessions: this.listSessions(),
      current: this.current
        ? { meta: this.current, entries: [...this.currentEntries] }
        : null,
    };
  }

  listSessions(): SessionMeta[] {
    try {
      const files = fs.readdirSync(this.dir())
        .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
        .sort()
        .reverse();
      const metas: SessionMeta[] = [];
      for (const f of files) {
        const meta = this.readSessionHeader(path.join(this.dir(), f), f.slice(0, -4));
        if (meta) metas.push(meta);
      }
      // Live session (if any) takes the head.
      if (this.current) {
        const rest = metas.filter((m) => m.id !== this.current!.id);
        return [this.current, ...rest];
      }
      return metas;
    } catch {
      return this.current ? [this.current] : [];
    }
  }

  /** Read a historical session's entries from its file. */
  loadSession(id: string): { meta: SessionMeta | null; entries: ConsoleEntry[] } {
    // Live session serves from memory.
    if (this.current && this.current.id === id) {
      return { meta: this.current, entries: [...this.currentEntries] };
    }
    const lines = this.readSessionLines(id);
    const entries: ConsoleEntry[] = [];
    for (const line of lines) {
      const e = parsePersistedLine(line);
      if (e) entries.push(e);
    }
    const meta = this.readSessionHeader(path.join(this.dir(), sessionFileName(id)), id);
    return { meta, entries };
  }

  /** log file path for the "open log file" affordance (null = none). */
  currentFilePath(): string | null {
    if (!this.current) return null;
    try {
      const file = path.join(this.dir(), sessionFileName(this.current.id));
      return fs.existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }

  /** Startup rotation: prune beyond MAX_SESSION_FILES. The live session's
   *  file is never a deletion candidate, even if a clock jump or a
   *  manipulated filename makes it sort older than the retention window. */
  rotate(): void {
    try {
      const liveFile = this.current ? sessionFileName(this.current.id) : null;
      const files = fs.readdirSync(this.dir())
        .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
        .sort()
        .reverse();
      for (const f of pickSessionsToDelete(files)) {
        if (f === liveFile) continue;
        try { fs.unlinkSync(path.join(this.dir(), f)); } catch { /* locked file: next run */ }
      }
    } catch { /* no dir yet */ }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private pushEntry(e: ConsoleEntry): void {
    if (!this.current) return;
    // In-memory cap: newest 5000 lines (the renderer shows the same window).
    this.currentEntries.push(e);
    if (this.currentEntries.length > RENDER_BUFFER_CAP) {
      this.currentEntries.splice(0, this.currentEntries.length - RENDER_BUFFER_CAP);
    }
    // Append to the file immediately (cheap append; the launch path is never
    // awaited on this) and schedule the batched renderer flush.
    this.appendToFile(e);
    this.pending.push(e);
    if (this.pending.length >= FLUSH_MAX_LINES) {
      this.flush(false);
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush(false);
      }, FLUSH_INTERVAL_MS);
    }
  }

  private flush(ended: boolean): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0 && !ended) return;
    if (!this.current) {
      this.pending = [];
      return;
    }
    const batch = this.pending;
    this.pending = [];
    if (this.onLines) {
      try {
        this.onLines({
          sessionId: this.current.id,
          entries: batch,
          ended: ended || this.current.status !== 'running' ? true : undefined,
          meta: this.current,
        });
      } catch { /* broadcast failures never propagate */ }
    }
  }

  private appendToFile(e: ConsoleEntry): void {
    if (this.fileWriteError || !this.current) return;
    try {
      fs.appendFileSync(path.join(this.dir(), sessionFileName(this.current.id)), formatPersistedLine(e) + '\n', 'utf8');
    } catch {
      // Persistence is best-effort; once it fails we stop trying for this
      // session (memory + renderer stream still work).
      this.fileWriteError = true;
    }
  }

  /**
   * Cap the session file at 5 MB when it ends — drop the OLDEST lines and
   * leave a marker. Only runs at session end, never mid-launch.
   */
  private finalizeFile(): void {
    if (!this.current) return;
    try {
      const file = path.join(this.dir(), sessionFileName(this.current.id));
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const headerIdx = lines[0]?.startsWith('# ember console session') ? 1 : 0;
      const body = lines.slice(headerIdx);
      const capped = computeTruncatedContent(body);
      const header = `# ember console session ${this.current.id} — ${this.current.status}`
        + (this.current.oracle?.modName ? ` — ${this.current.oracle.modName}: ${this.current.oracle.reason ?? 'unknown cause'}` : '')
        + (this.current.oracle && !this.current.oracle.modName && this.current.oracle.reason ? ` — ${this.current.oracle.reason}` : '');
      if (capped === body) {
        // Under cap: rewrite only when the header needs its status/attribution.
        if (headerIdx === 1 && lines[0] !== header) {
          fs.writeFileSync(file, [header, ...body].join('\n') + '\n', 'utf8');
        }
        return;
      }
      fs.writeFileSync(file, [header, ...capped].join('\n') + '\n', 'utf8');
    } catch { /* best effort */ }
  }

  private readSessionLines(id: string): string[] {
    try {
      const raw = fs.readFileSync(path.join(this.dir(), sessionFileName(id)), 'utf8');
      return raw.split('\n').filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  private readSessionHeader(file: string, id: string): SessionMeta | null {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
      const m = /^# ember console session (\S+)(?: — (running|clean exit|crashed|cancelled|failed))?(?: — (.*))?$/.exec(first);
      if (m) {
        const status = (m[2] as SessionMeta['status']) ?? 'clean exit';
        let oracle: SessionMeta['oracle'] = null;
        if (m[3]) {
          const sep = m[3].indexOf(': ');
          oracle = sep === -1
            ? { reason: m[3] }
            : { modName: m[3].slice(0, sep), reason: m[3].slice(sep + 2) };
        }
        return { id, startedAt: Date.parse(id.replace('session-', '').replace(/-(\d{6})-(\w+)$/, 'T$1')) || 0, status, oracle };
      }
    } catch { /* unreadable header → synthetic meta */ }
    return { id, startedAt: 0, status: 'clean exit', oracle: null };
  }

  private emitMeta(): void {
    if (!this.current) return;
    this.flush(false);
    if (this.onLines) {
      try {
        this.onLines({ sessionId: this.current.id, entries: [], meta: this.current });
      } catch { /* ignore */ }
    }
  }

  /** Test seam: run pending flush timers deterministically. */
  flushForTest(): void {
    this.flush(false);
  }
}

export { MAX_SESSION_FILES };
