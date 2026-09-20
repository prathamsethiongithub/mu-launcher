import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installModpackFiles } from '../src/main/modpack-installer';

/**
 * Parallel .mrpack files[] import (perf-strike). No sockets: fetch is stubbed
 * to serve real ReadableStreams (optionally paced) so the production pump in
 * downloadPackFile runs end-to-end. Archives are built in-test with the real
 * adm-zip dependency, so the [E701]/[E702]/[E703]/[E704] contract is
 * exercised against a genuine modrinth.index.json.
 */

const enc = new TextEncoder();

function streamOf(text: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(enc.encode(text));
    },
  });
}

/**
 * Paced stream: waits gapMs BEFORE every chunk, so a large gap makes that
 * item finish last — completion order becomes controllable.
 */
function pacedStream(text: string, gapMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

const cleanups: string[] = [];

async function newWorld(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mu-pack-world-'));
  cleanups.push(dir);
  return dir;
}

async function buildMrpack(index: Record<string, unknown> | null): Promise<string> {
  const AdmZipCtor = (await import('adm-zip')).default as unknown as new () => {
    addFile(name: string, data: Buffer): void;
    toBuffer(): Buffer;
  };
  const zip = new AdmZipCtor();
  if (index) {
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index), 'utf8'));
  }
  const dir = await mkdtemp(join(tmpdir(), 'mu-pack-zip-'));
  cleanups.push(dir);
  const zipPath = join(dir, 'pack.mrpack');
  await writeFile(zipPath, zip.toBuffer());
  return zipPath;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
  cleanups.length = 0;
});

describe('installModpackFiles — parallel files[] import', () => {
  it('order independence: out-of-order completion lands identical files', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack({
      files: [
        { path: 'mods/slow.jar', downloads: ['https://cdn.example/slow'], hashes: { sha1: sha1('SLOW-JAR') } },
        { path: 'mods/fast.jar', downloads: ['https://cdn.example/fast'], hashes: { sha1: sha1('FAST-JAR') } },
        { path: 'config/opts.json', downloads: ['https://cdn.example/opts'], hashes: { sha1: sha1('{"x":1}') } },
      ],
    });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/slow')) return { ok: true, body: pacedStream('SLOW-JAR', 80) };
      if (url.endsWith('/fast')) return { ok: true, body: pacedStream('FAST-JAR', 0) };
      return { ok: true, body: pacedStream('{"x":1}', 0) };
    });

    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result).toEqual({ installed: 3, skipped: 0, failed: 0, errors: [] });
    // The slow item settled last, yet every file landed byte-exact — the
    // final on-disk result is independent of completion order.
    expect(await readFile(join(worldRoot, 'mods', 'slow.jar'), 'utf8')).toBe('SLOW-JAR');
    expect(await readFile(join(worldRoot, 'mods', 'fast.jar'), 'utf8')).toBe('FAST-JAR');
    expect(await readFile(join(worldRoot, 'config', 'opts.json'), 'utf8')).toBe('{"x":1}');
  });

  it('runs files[] downloads bounded-parallel, not serial', async () => {
    const worldRoot = await newWorld();
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `mods/m${i}.jar`,
      downloads: [`https://cdn.example/m${i}`],
      hashes: { sha1: sha1(`JAR-${i}`) },
    }));
    const zipPath = await buildMrpack({ files });

    let active = 0;
    let peak = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      const idx = Number(url.slice(-1));
      return { ok: true, body: streamOf(`JAR-${idx}`) };
    });

    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result.installed).toBe(4);
    expect(peak).toBe(4); // all four in flight — provably not serial
    for (let i = 0; i < 4; i++) {
      expect(await readFile(join(worldRoot, 'mods', `m${i}.jar`), 'utf8')).toBe(`JAR-${i}`);
    }
  });

  it('env.client "unsupported" entries are skipped and counted', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack({
      files: [
        { path: 'mods/server.jar', env: { client: 'unsupported' }, downloads: ['https://cdn.example/server'] },
        { path: 'mods/client.jar', downloads: ['https://cdn.example/client'], hashes: { sha1: sha1('CLIENT-JAR') } },
      ],
    });
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return { ok: true, body: streamOf('CLIENT-JAR') };
    });

    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result).toEqual({ installed: 1, skipped: 1, failed: 0, errors: [] });
    expect(requested).toEqual(['https://cdn.example/client']); // server.jar never fetched
    expect(await readFile(join(worldRoot, 'mods', 'client.jar'), 'utf8')).toBe('CLIENT-JAR');
  });

  it('failed item keeps successful ones; error carries the path; candidates tried in order', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack({
      files: [
        { path: 'mods/good.jar', downloads: ['https://cdn.example/good'], hashes: { sha1: sha1('GOOD-JAR') } },
        { path: 'mods/dead.jar', downloads: ['https://cdn.example/dead-a', 'https://cdn.example/dead-b'] },
      ],
    });
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      if (url.endsWith('/good')) return { ok: true, body: streamOf('GOOD-JAR') };
      return { ok: false, status: 500 };
    });

    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result.installed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('dead.jar');
    expect(result.errors[0]).toContain('[E703]');
    // URL candidates of ONE item are tried in declared order, then
    // exhausted. (Cross-ITEM fetch order is scheduler-dependent under
    // parallelism and is not part of the contract.)
    expect(requested).toContain('https://cdn.example/good');
    const deadTries = requested.filter((u) => u.includes('/dead'));
    expect(deadTries).toEqual(['https://cdn.example/dead-a', 'https://cdn.example/dead-b']);
    // The successful file survived; no residue from the failed one.
    expect(await readFile(join(worldRoot, 'mods', 'good.jar'), 'utf8')).toBe('GOOD-JAR');
    expect(await readdir(join(worldRoot, 'mods'))).toEqual(['good.jar']);
  });

  it('hash mismatch is [E704], removes the tmp, and counts as failure', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack({
      files: [
        { path: 'mods/bad.jar', downloads: ['https://cdn.example/bad'], hashes: { sha1: '0'.repeat(40) } },
      ],
    });
    vi.stubGlobal('fetch', async () => ({ ok: true, body: streamOf('WRONG-BYTES') }));

    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result).toMatchObject({ installed: 0, failed: 1 });
    expect(result.errors[0]).toContain('[E704]');
    expect(result.errors[0]).toContain('bad.jar');
    expect(await readdir(join(worldRoot, 'mods'))).toEqual([]); // tmp deleted, nothing installed
  });

  it('malformed entry (missing path) is [E702]-counted; siblings still install', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack({
      files: [
        { path: 'mods/ok.jar', downloads: ['https://cdn.example/ok'], hashes: { sha1: sha1('OK-JAR') } },
        { downloads: ['https://cdn.example/x'] }, // no path field
      ],
    });
    vi.stubGlobal('fetch', async () => ({ ok: true, body: streamOf('OK-JAR') }));

    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result).toMatchObject({ installed: 1, failed: 1 });
    expect(result.errors[0]).toBe('[E702] A files[] entry is missing its "path" field.');
    expect(await readFile(join(worldRoot, 'mods', 'ok.jar'), 'utf8')).toBe('OK-JAR');
  });

  it('archive without modrinth.index.json still throws [E701]', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack(null);
    await expect(installModpackFiles(zipPath, worldRoot)).rejects.toThrow(/\[E701\]/);
  });

  it('empty files[] returns a zeroed aggregate', async () => {
    const worldRoot = await newWorld();
    const zipPath = await buildMrpack({});
    const result = await installModpackFiles(zipPath, worldRoot);
    expect(result).toEqual({ installed: 0, skipped: 0, failed: 0, errors: [] });
  });
});
