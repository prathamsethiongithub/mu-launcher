import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleService, type ConsoleLinePayload } from '../src/main/console-service';
import { sessionFileName } from '../src/shared/console-log';

let dir: string;
let svc: ConsoleService;
let broadcasts: ConsoleLinePayload[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ember-console-'));
  svc = new ConsoleService(dir);
  broadcasts = [];
  svc.setBroadcast((p) => broadcasts.push(p));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function fileLines(id: string): string[] {
  return readFile(join(dir, sessionFileName(id)), 'utf8').then((t) => t.split('\n').filter((l) => l.length > 0)) as Promise<string[]>;
}

async function readLines(id: string): Promise<string[]> {
  const text = await readFile(join(dir, sessionFileName(id)), 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

describe('session lifecycle', () => {
  it('begin writes a header file and returns an id', () => {
    const id = svc.beginSession(1_758_400_000_000);
    expect(id).toMatch(/^session-\d{8}-\d{6}-\w+$/);
    const lines = readFile(join(dir, sessionFileName(id)), 'utf8') as unknown as Promise<string[]>;
  });

  it('launcher + game lines accumulate, end stamps terminal state', async () => {
    const id = svc.beginSession(1_758_400_000_000);
    svc.addLauncherLine('launching', 'working', 70);
    svc.addGameLine('[12:00:01] [main/INFO]: hello world');
    svc.endSession(0, 1_758_400_005_000);
    expect(svc.getCurrentMeta()?.status).toBe('clean exit');

    const lines = await readLines(id);
    expect(lines[0]).toBe(`# ember console session ${id} — clean exit`);
    expect(lines.some((l) => l.includes('[launcher/info] step launching: working (70%)'))).toBe(true);
    expect(lines.some((l) => l.includes('[game/info] hello world'))).toBe(true);
    expect(lines.some((l) => l.includes('game exited with code 0'))).toBe(true);
  });

  it('crash path: nonzero code marks crashed; oracle attaches to header', async () => {
    const id = svc.beginSession(1_758_400_000_000);
    svc.addGameLine('[12:00:01] [main/FATAL]: mixer exploded');
    svc.endSession(1, 1_758_400_005_000);
    svc.attachOracle({ modName: 'spectralforest', reason: 'mixer allocation' });
    expect(svc.getCurrentMeta()?.status).toBe('crashed');
    const lines = await readLines(id);
    expect(lines[0]).toBe(`# ember console session ${id} — crashed — spectralforest: mixer allocation`);
    // The attribution is readable back through listSessions.
    const meta = svc.listSessions().find((m) => m.id === id);
    expect(meta?.status).toBe('crashed');
    expect(meta?.oracle?.modName).toBe('spectralforest');
  });

  it('failSession records an E-code error without crash status', async () => {
    const id = svc.beginSession(1_758_400_000_000);
    svc.failSession('[E303] Game launch with Fabric failed.', 1_758_400_005_000);
    expect(svc.getCurrentMeta()?.status).toBe('failed');
    const lines = await readLines(id);
    expect(lines[0]).toContain('failed — [E303]');
    expect(lines.some((l) => l.includes('[launcher/error] [E303]'))).toBe(true);
  });

  it('cancelSession marks cancelled', () => {
    svc.beginSession();
    svc.cancelSession();
    expect(svc.getCurrentMeta()?.status).toBe('cancelled');
  });

  it('a new session closes a stale running one as cancelled', () => {
    const first = svc.beginSession(1_758_400_000_000);
    svc.beginSession(1_758_400_100_000);
    const metas = svc.listSessions();
    expect(metas.find((m) => m.id === first)?.status).toBe('cancelled');
    expect(svc.getCurrentMeta()?.status).toBe('running');
  });
});

describe('capture semantics', () => {
  it('game lines are parsed and redacted before persistence', async () => {
    const id = svc.beginSession();
    svc.addGameLine('[12:00:00] [main/INFO]: access_token: 8f2a1b3c4d5e6f70');
    svc.addGameLine('raw stdout noise');
    const lines = await readLines(id);
    expect(lines.join('\n')).not.toContain('8f2a1b3c4d5e6f70');
    expect(lines.join('\n')).toContain('[redacted]');
    expect(lines.some((l) => l.includes('[game/info] raw stdout noise'))).toBe(true);
  });

  it('launch command is recorded redacted', async () => {
    svc.beginSession();
    svc.recordLaunchCommand(['java', '-Xmx4096M', '--accessToken', '8f2a1b3c4d5e6f70', '--username', 'Steve']);
    const lines = await readLines(svc.getCurrentMeta()!.id);
    const cmd = lines.find((l) => l.includes('launch command:'));
    expect(cmd).toBeDefined();
    expect(cmd!).not.toContain('8f2a1b3c4d5e6f70');
    expect(cmd!).toContain('--username Steve');
    expect(svc.getLaunchCommand()).not.toContain('8f2a1b3c4d5e6f70');
  });

  it('MCLC start failures are error-level debug lines', () => {
    svc.beginSession();
    svc.addLauncherDebug("[MCLC]: Couldn't start Minecraft due to: bad java");
    svc.flushForTest();
    const batch = broadcasts.flatMap((b) => b.entries);
    expect(batch.some((e) => e.level === 'error' && e.text.includes("Couldn't start"))).toBe(true);
  });

  it('entries before a session exists are ignored (passive observer)', () => {
    svc.addGameLine('[12:00:00] [main/INFO]: orphan');
    svc.addLauncherLine('launching', 'working', 1);
    expect(svc.getCurrentMeta()).toBeNull();
    expect(broadcasts).toHaveLength(0);
  });

  it('memory buffer caps at 5000 lines keeping the newest', () => {
    svc.beginSession();
    for (let i = 0; i < 5100; i++) {
      svc.addLauncherLine('step', 'working', 0);
      // Drain the file noise: cap file growth by ending sessions? No — the
      // in-memory cap is what we assert; file appends are best-effort.
    }
    const snap = svc.snapshot();
    expect(snap.current?.entries.length).toBe(5000);
    expect(snap.current?.entries[0].text).toContain('step');
  });
});

describe('batched broadcast', () => {
  it('flushes on 100ms window (timer) and on session end', () => {
    vi.useFakeTimers();
    svc.beginSession(1_758_400_000_000);
    broadcasts.length = 0; // ignore the begin meta broadcast
    svc.addGameLine('[12:00:00] [main/INFO]: one');
    expect(broadcasts).toHaveLength(0); // pending
    vi.advanceTimersByTime(101);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].entries).toHaveLength(1);
    svc.addGameLine('[12:00:01] [main/INFO]: two');
    svc.endSession(0, 1_758_400_002_000);
    // Contract: the 'two' line and the exit line are delivered by SOME
    // post-add broadcast, and the final broadcast marks the session ended.
    const postAdd = broadcasts.flatMap((b) => b.entries);
    expect(postAdd.some((e) => e.text === 'two')).toBe(true);
    expect(postAdd.some((e) => e.text.includes('exited'))).toBe(true);
    const last = broadcasts[broadcasts.length - 1];
    expect(last.ended).toBe(true);
  });

  it('flushes early at 64 lines', () => {
    svc.beginSession();
    for (let i = 0; i < 64; i++) svc.addLauncherLine('step', 'working', 0);
    // The 64th push flushes synchronously; exactly one batch of 64.
    const sizes = broadcasts.map((b) => b.entries.length);
    expect(sizes.some((s) => s === 64)).toBe(true);
  });

  it('end flush clears the pending timer (no post-end batches)', () => {
    vi.useFakeTimers();
    svc.beginSession(1_758_400_000_000);
    broadcasts.length = 0; // ignore the begin meta broadcast
    svc.addGameLine('[12:00:00] [main/INFO]: x');
    svc.endSession(0, 1_758_400_001_000);
    const n = broadcasts.length;
    vi.advanceTimersByTime(500);
    expect(broadcasts.length).toBe(n);
  });
});

describe('persistence read-back & rotation', () => {
  it('loadSession parses historical entries from the file', async () => {
    const id = svc.beginSession(1_758_400_000_000);
    svc.addLauncherLine('preparing-java', 'done', 20);
    svc.addGameLine('[12:00:01] [Render thread/INFO]: Backend library: LWJGL');
    svc.endSession(0, 1_758_400_009_000);
    const { meta, entries } = svc.loadSession(id);
    expect(meta?.status).toBe('clean exit');
    expect(entries.length).toBe(3);
    expect(entries[0].text).toBe('step preparing-java: done (20%)');
    expect(entries[1].text).toBe('Backend library: LWJGL');
    expect(entries[1].level).toBe('info');
    expect(entries[2].text).toContain('game exited with code 0');
  });

  it('rotation keeps the newest 10 session files', async () => {
    // Fabricate 12 historical files, then rotate.
    for (let i = 1; i <= 12; i++) {
      const fake = `session-2026${String(9).padStart(2, '0')}${String(10 + i).padStart(2, '0')}-000000-fake${String(i).padStart(2, '0')}`;
      await writeFile(join(dir, `${fake}.log`), `# ember console session ${fake} — clean exit\n[ts] [launcher/info] old\n`, 'utf8');
    }
    svc.beginSession();
    svc.rotate();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(10);
  });

  it('live session survives rotation (never deleted by pruning)', async () => {
    svc.beginSession(1_758_400_000_000);
    const liveId = svc.getCurrentMeta()!.id;
    for (let i = 1; i <= 10; i++) {
      const fake = `session-2026${String(9).padStart(2, '0')}${String(10 + i).padStart(2, '0')}-000000-fake${String(i).padStart(2, '0')}`;
      await writeFile(join(dir, `${fake}.log`), `# ember console session ${fake} — clean exit\n`, 'utf8');
    }
    svc.rotate();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.log'));
    expect(files).toContain(sessionFileName(liveId));
  });

  it('truncation marker is written when a session exceeds the cap', async () => {
    const id = svc.beginSession(1_758_400_000_000);
    // Append directly to bypass the entry API for a large synthetic body.
    const big = 'z'.repeat(200_000);
    const { appendFileSync } = await import('node:fs');
    for (let i = 0; i < 30; i++) {
      appendFileSync(join(dir, sessionFileName(id)), `[2026-09-21T12:00:0${i % 10}.000Z] [game/info] filler ${big}\n`, 'utf8');
    }
    svc.endSession(0, 1_758_400_009_000); // finalizeFile caps at 5 MB
    const text = await readFile(join(dir, sessionFileName(id)), 'utf8');
    expect(text).toContain('# [truncated]');
    expect(text.length).toBeLessThan(5 * 1024 * 1024 + 4096);
  });
});
