import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_ENTRY_UNCOMPRESSED,
  MAX_TOTAL_UNCOMPRESSED,
  assertArchiveBudget,
  assertArchiveSize,
  assertEntryBudget,
  declaredUncompressed,
} from '../src/main/archive-guard';
import { assertSafeModFilename } from '../src/main/mod-filename';
import { RefreshGate } from '../src/main/refresh-gate';
import { installModpackOverrides } from '../src/main/modpack-installer';
import { redactTokens } from '../src/shared/console-log';

/**
 * RED-TEAM WAVE 2 — live-fire regression tests.
 *
 * Every payload here is synthesised in-test (no external tools, no network, no
 * writes outside a per-test mkdtemp sandbox). Attacks 2/5/6 pin the fixes made
 * in this wave; 4/7/8/9 pin the containment evidence recorded in
 * docs/project-truth/29-RED-TEAM.md.
 */

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attack 6 — .mrpack decompression bomb
// ─────────────────────────────────────────────────────────────────────────────

describe('Attack 6 — archive budget guard (B6)', () => {
  const entry = (entryName: string, size: number) => ({ entryName, header: { size } });
  const uid = () => JSON.stringify(Math.random());

  it('refuses an archive whose declared uncompressed total exceeds the ceiling', () => {
    // 5 x 512 MB = 2.5 GB: each entry is individually legal, the TOTAL is not.
    const bomb = Array.from({ length: 5 }, (_, i) => entry(`mods/bomb${i}.jar`, MAX_ENTRY_UNCOMPRESSED));
    expect(() => assertArchiveBudget(bomb)).toThrow(/\[E705\]/);
    expect(MAX_ENTRY_UNCOMPRESSED * 5).toBeGreaterThan(MAX_TOTAL_UNCOMPRESSED);
  });

  it('refuses an archive with too many entries', () => {
    const flood = Array.from({ length: MAX_ARCHIVE_ENTRIES + 1 }, (_, i) =>
      entry(`mods/f${i}.jar`, 1),
    );
    expect(() => assertArchiveBudget(flood)).toThrow(/\[E705\].*entries/);
  });

  it('accepts a realistic modpack-sized central directory', () => {
    // 400 mods x 4 MB = 1.6 GB of declared payload: a heavy-but-real pack.
    const normal = Array.from({ length: 400 }, (_, i) => entry(`mods/f${i}.jar`, 4 * 1024 * 1024));
    expect(assertArchiveBudget(normal)).toBeUndefined();
  });

  it('refuses a single entry declaring more than the per-entry ceiling', () => {
    expect(() => assertEntryBudget(entry('overrides/bomb.jar', 4 * 1024 ** 3))).toThrow(/\[E705\]/);
  });

  it('treats a malformed / absent declared size as 0 (cannot be used to smuggle a pass)', () => {
    expect(declaredUncompressed({ entryName: 'x' })).toBe(0);
    expect(declaredUncompressed({ entryName: 'x', header: {} })).toBe(0);
    expect(declaredUncompressed({ entryName: 'x', header: { size: -5 } })).toBe(0);
    expect(declaredUncompressed({ entryName: 'x', header: { size: NaN } })).toBe(0);
  });

  it('refuses an on-disk archive larger than the byte ceiling', () => {
    expect(() => assertArchiveSize(42 * 1024)).not.toThrow();
    expect(() => assertArchiveSize(MAX_ARCHIVE_BYTES + 1)).toThrow(/\[E705\]/);
  });

  /**
   * The crown-jewel live fire: a genuinely small .mrpack whose CENTRAL
   * DIRECTORY lies about the uncompressed size of one override, exactly the
   * shape adm-zip trusts (`Buffer.alloc(centralHeader.size)` before inflating).
   * Without the guard this allocates 4 GB in the main process; with it, the
   * install is refused before any entry is touched.
   */
  it('LIVE FIRE: refuses a 4 GB declared-size lie in a real .mrpack without allocating', async () => {
    const AdmZipCtor = (await import('adm-zip')).default as unknown as new () => {
      addFile(name: string, data: Buffer): void;
      toBuffer(): Buffer;
    };
    const zip = new AdmZipCtor();
    zip.addFile('modrinth.index.json', Buffer.from(uid(), 'utf8'));
    zip.addFile('overrides/bomb.jar', Buffer.from('tiny', 'utf8'));
    const buf = zip.toBuffer();

    // Patch the CENTRAL directory record for overrides/bomb.jar: uncompressed
    // size lives at +24 of the 46-byte CD header (PK\x01\x02).
    const lying = Buffer.from(buf);
    const target = Buffer.from('overrides/bomb.jar', 'utf8');
    let patched = false;
    for (let i = 0; i + 46 <= lying.length; i++) {
      if (!(lying[i] === 0x50 && lying[i + 1] === 0x4b && lying[i + 2] === 0x01 && lying[i + 3] === 0x02)) continue;
      const nameLen = lying.readUInt16LE(i + 28);
      const name = lying.subarray(i + 46, i + 46 + nameLen);
      if (name.equals(target)) {
        lying.writeUInt32LE(0xf0000000, i + 24); // 4,026,531,840 bytes
        patched = true;
        break;
      }
    }
    expect(patched, 'central directory record for the bomb entry must be found').toBe(true);

    const dir = await sandbox('mu-bomb-');
    const archivePath = join(dir, 'bomb.mrpack');
    await writeFile(archivePath, lying);
    const worldRoot = join(dir, 'world');
    await writeFile(join(dir, '.keep'), '');

    await expect(installModpackOverrides(archivePath, worldRoot)).rejects.toThrow(/\[E705\]/);
    // Nothing was written — the guard fired before extraction.
    await expect(readdir(worldRoot)).rejects.toThrow();
  });

  it('LIVE FIRE: refuses an over-entry-count .mrpack built in-test', async () => {
    const AdmZipCtor = (await import('adm-zip')).default as unknown as new () => {
      addFile(name: string, data: Buffer): void;
      toBuffer(): Buffer;
    };
    const zip = new AdmZipCtor();
    zip.addFile('modrinth.index.json', Buffer.from(uid(), 'utf8'));
    for (let i = 0; i < MAX_ARCHIVE_ENTRIES; i++) {
      zip.addFile(`overrides/f${i}.txt`, Buffer.from('x', 'utf8'));
    }

    const dir = await sandbox('mu-flood-');
    const archivePath = join(dir, 'flood.mrpack');
    await writeFile(archivePath, zip.toBuffer());

    await expect(installModpackOverrides(archivePath, join(dir, 'world'))).rejects.toThrow(/\[E705\]/);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Attack 2 — mod filename guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Attack 2 — hardened mod filename guard (B2)', () => {
  const rejects: Array<[string, string]> = [
    ['....//....//evil.jar', 'collapsed-dot traversal'],
    ['..\\..\\evil.jar', 'backslash traversal'],
    ['../evil.jar', 'plain traversal'],
    ['/etc/passwd', 'absolute posix path'],
    ['C:\\Windows\\evil.jar', 'absolute windows path'],
    ['sub/evil.jar', 'subdirectory'],
    ['evil.jar:stream', 'NTFS alternate data stream'],
    ['evil.jar::$DATA', 'NTFS default-stream shorthand'],
    ['nul.jar', 'reserved device NUL'],
    ['aux.jar', 'reserved device AUX'],
    ['con.jar', 'reserved device CON'],
    ['prn.jar', 'reserved device PRN'],
    ['com1.jar', 'reserved device COM1'],
    ['lpt1.jar', 'reserved device LPT1'],
    ['NUL.JAR', 'reserved device (case-insensitive)'],
    ['evil.jar\u0000.png', 'embedded NUL truncation'],
    ['evil\u001f.jar', 'control character'],
    ['evil.jar.', 'trailing dot (Windows strips it)'],
    ['evil.jar ', 'trailing space (Windows strips it)'],
    ['..', 'parent directory reference'],
    ['.', 'current directory reference'],
    ['', 'empty name'],
    [`${'a'.repeat(250)}.jar`, 'over-long name'],
  ];

  it.each(rejects)('rejects %s (%s)', (payload) => {
    expect(() => assertSafeModFilename(payload, { op: 'test' })).toThrow(/Unsafe mod filename/);
  });

  it('rejects non-string inputs rather than coercing them', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(() => assertSafeModFilename(bad as unknown, { op: 'test' })).toThrow(/Unsafe mod filename/);
    }
  });

  it('accepts the legitimate names the app actually stores', () => {
    const ok = [
      'sodium-0.5.3.jar',
      'sodium-0.5.3.jar.disabled',
      'Sodium-Extra-1.0.0.jar',
      'console.jar', // "console" is not the reserved "con"
      'com10.jar', // com[1-9] only — com10 is a normal name
      'essential.mod-2.1.jar',
    ];
    for (const name of ok) expect(() => assertSafeModFilename(name, { requireJar: true })).not.toThrow();
  });

  it('enforces the .jar requirement for download/update callers', () => {
    expect(() => assertSafeModFilename('payload.exe', { requireJar: true })).toThrow(/not a .jar/);
    expect(() => assertSafeModFilename('payload.exe', { requireJar: false })).not.toThrow();
  });

  /**
   * Containment invariant: for every ACCEPTED name, the joined path must stay
   * inside mods/. This is the property that actually matters — a rejection
   * matrix proves the known bad shapes, this proves the general case.
   */
  it('every accepted name stays inside mods/ when joined', () => {
    const modsDir = resolve('/srv/userData/worlds/w1/mods');
    const candidates = [
      'sodium-0.5.3.jar',
      'sodium-0.5.3.jar.disabled',
      '\uFF0Ffullwidth-solidus.jar', // unicode look-alike: accepted, but literal
      'naïve-mod-1.0.jar',
      '\u202Egnp.jar', // RTL override: accepted, but literal
      'a'.repeat(190) + '.jar',
    ];
    for (const name of candidates) {
      expect(() => assertSafeModFilename(name, { requireJar: true })).not.toThrow();
      const joined = resolve(join(modsDir, name));
      expect(
        joined === modsDir || joined.startsWith(modsDir + sep),
        `${name} escaped mods/ -> ${joined}`,
      ).toBe(true);
    }
  });

  it('is wired into all three former call sites', () => {
    for (const file of [
      'src/main/mod-manager.ts',
      'src/main/mod-downloader.ts',
      'src/main/update-checker.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must use the shared guard`).toContain('assertSafeModFilename');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Attack 5 — token refresh storm
// ─────────────────────────────────────────────────────────────────────────────

describe('Attack 5 — refresh single-flight + backoff (B5)', () => {
  /** A controllable clock so cooldown policy is tested without real waiting. */
  function fakeClock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('coalesces 20 concurrent refreshes into exactly ONE network attempt', async () => {
    const clock = fakeClock();
    const gate = new RefreshGate(30_000, clock.now);
    let calls = 0;
    const attempt = () =>
      new Promise<void>((_, reject) => {
        calls++;
        setTimeout(() => reject(new Error('invalid_grant')), 5);
      });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => gate.run('acct-1', attempt)),
    );

    expect(calls).toBe(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('short-circuits further refreshes for the cooldown window after a failure', async () => {
    const clock = fakeClock();
    const gate = new RefreshGate(30_000, clock.now);
    let calls = 0;
    const fail = () => {
      calls++;
      return Promise.reject(new Error('invalid_grant'));
    };

    await expect(gate.run('acct-1', fail)).rejects.toThrow('invalid_grant');
    expect(calls).toBe(1);

    // 19 more attempts inside the cooldown: no new network calls.
    for (let i = 0; i < 19; i++) {
      await expect(gate.run('acct-1', fail)).rejects.toThrow('invalid_grant');
    }
    expect(calls).toBe(1);
    expect(gate.cooldownRemaining('acct-1')).toBe(30_000);

    // Just inside the window — still suppressed.
    clock.advance(29_999);
    await expect(gate.run('acct-1', fail)).rejects.toThrow();
    expect(calls).toBe(1);

    // Past the window — one more attempt is allowed.
    clock.advance(2);
    await expect(gate.run('acct-1', fail)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('keys the gate per account so one bad account cannot starve another', async () => {
    const gate = new RefreshGate(30_000, () => 0);
    let a = 0;
    let b = 0;
    await expect(gate.run('a', () => (a++, Promise.reject(new Error('x'))))).rejects.toThrow();
    await expect(gate.run('b', () => (b++, Promise.resolve()))).resolves.toBeUndefined();
    expect([a, b]).toEqual([1, 1]);
  });

  it('does not back off a successful refresh, and clears the prior error', async () => {
    const clock = fakeClock();
    const gate = new RefreshGate(30_000, clock.now);
    await expect(gate.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gate.lastError('a')).toBe('boom');

    clock.advance(30_001);
    await expect(gate.run('a', () => Promise.resolve())).resolves.toBeUndefined();
    expect(gate.lastError('a')).toBeNull();
    expect(gate.cooldownRemaining('a')).toBe(0);
  });

  it('exposes in-flight state and resets on demand', async () => {
    const gate = new RefreshGate();
    let release!: () => void;
    const p = gate.run('a', () => new Promise<void>((r) => (release = r)));
    expect(gate.isInFlight('a')).toBe(true);
    release();
    await p;
    expect(gate.isInFlight('a')).toBe(false);

    await expect(gate.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow();
    expect(gate.cooldownRemaining('a')).toBeGreaterThan(0);
    gate.reset('a');
    expect(gate.cooldownRemaining('a')).toBe(0);
    expect(gate.lastError('a')).toBeNull();
  });

  it('is wired into IdentityService.validateSession and signOut', () => {
    const src = readFileSync('src/main/identity-service.ts', 'utf8');
    expect(src).toContain('new RefreshGate()');
    expect(src).toContain('this.refreshGate.run(accountId');
    expect(src).toContain('this.refreshGate.reset(accountId)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Attacks 4 / 7 / 8 / 9 — containment evidence
// ─────────────────────────────────────────────────────────────────────────────

function mainSources(): string[] {
  const dir = 'src/main';
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f}`);
  const rendererDir = 'src/renderer';
  for (const f of readdirSync(rendererDir)) {
    if (f.endsWith('.tsx') || f.endsWith('.ts')) files.push(`${rendererDir}/${f}`);
  }
  return files;
}

describe('Attack 4 — MOTD injection cannot become an XSS chain', () => {
  it('has ZERO HTML-sink primitives anywhere in the source tree', () => {
    const sinks = /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/;
    const offenders = mainSources()
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => sinks.test(readFileSync(f, 'utf8')));
    expect(offenders, 'no HTML sink may exist in the app').toEqual([]);
  });

  it('flattens MOTD chat components to plain text only (no markup pass-through)', () => {
    const src = readFileSync('src/main/server-pinger.ts', 'utf8');
    // The extractor collects `.text` strings and ignores style/format fields.
    expect(src).toContain('parts.push(obj.text)');
    expect(src).not.toMatch(/<script|<img|<div|<iframe/);
    // And the MOTD is never sent to the renderer / never rendered.
    expect(src).toMatch(/motd: extractMotd/);
  });

  it('has no render path for MOTD at all (defence in depth)', () => {
    const rendered = mainSources().filter((f) => /\bmotd\b/i.test(readFileSync(f, 'utf8')));
    expect(rendered).toEqual(['src/main/server-pinger.ts']);
  });
});

describe('Attack 7 — single instance + atomic registry writes', () => {
  it('takes the single-instance lock and quits the second process', () => {
    const src = readFileSync('src/main/index.ts', 'utf8');
    expect(src).toContain('app.requestSingleInstanceLock()');
    expect(src).toMatch(/if \(!gotTheLock\) \{\s*app\.quit\(\)/);
    expect(src).toContain("app.on('second-instance'");
  });

  it('persists the world registry atomically (tmp + rename), so a racy write cannot corrupt it', () => {
    const src = readFileSync('src/main/world-manager.ts', 'utf8');
    expect(src).toContain('const tmpPath = this.registryPath + \'.tmp\'');
    expect(src).toMatch(/writeFileSync\(tmpPath, json, 'utf-8'\);\s*renameSync\(tmpPath, this\.registryPath\)/);
  });
});

describe('Attack 8 — update source cannot be influenced locally', () => {
  it('never calls setFeedURL / reads a feed URL from disk or config', () => {
    const src = readFileSync('src/main/updater.ts', 'utf8');
    expect(src).not.toContain('setFeedURL');
    expect(src).not.toMatch(/readFileSync|existsSync|config|process\.env/);
  });

  it('uses electron-updater\'s build-time feed resolution only', () => {
    const src = readFileSync('src/main/updater.ts', 'utf8');
    expect(src).toContain("from 'electron-updater'");
    expect(src).toContain('autoUpdater.checkForUpdates()');
    // No local override hook may exist in the app either.
    const index = readFileSync('src/main/index.ts', 'utf8');
    expect(index).not.toContain('setFeedURL');
  });
});

describe('Attack 9 — main-process stdout cannot leak credentials', () => {
  it('redacts the launch command (the one argv path carrying accessToken) before capture', () => {
    const src = readFileSync('src/main/console-service.ts', 'utf8');
    expect(src).toMatch(/this\.launchCommand = redactTokens\(argv\.join\(' '\)\)/);
  });

  it('redacts captured game lines and error paths before persist/broadcast', () => {
    const src = readFileSync('src/main/console-service.ts', 'utf8');
    expect(src).toContain('parsed.text = redactTokens(parsed.text)');
    expect(src).toContain('reason: redactTokens(error)');
    expect(src).toContain('text: redactTokens(error)');
  });

  it('redactTokens scrubs the credential shapes that matter', () => {
    expect(redactTokens('--accessToken SEA_ABC123XYZ')).not.toContain('ABC123XYZ');
    expect(redactTokens('access_token: abcdef12345678')).not.toContain('abcdef12345678');
    expect(redactTokens('"accessToken":"supersecretvalue"')).not.toContain('supersecretvalue');
    expect(redactTokens('authorization: Bearer abcdefghijklmn')).not.toContain('abcdefghijklmn');
    expect(
      redactTokens('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop123456'),
    ).toBe('[redacted]');
    // Idempotent, and ordinary prose is untouched.
    expect(redactTokens('[redacted]')).toBe('[redacted]');
    expect(redactTokens('installed sodium 0.5.3')).toBe('installed sodium 0.5.3');
  });

  it('no main-process console call interpolates a token VALUE', () => {
    // Labels inside static messages are fine; a template that interpolates a
    // token-bearing expression is not.
    const risky = /\$\{[^}]*(accessToken|refreshToken|access_token|secret|password)/i;
    const offenders = mainSources()
      .filter((f) => f.startsWith('src/main/'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f, line, i: i + 1 }))
          .filter(({ line }) => /console\.(log|error|warn|info|debug)/.test(line) && risky.test(line)),
      );
    expect(offenders).toEqual([]);
  });
});
