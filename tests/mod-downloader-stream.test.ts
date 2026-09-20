import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadModFromModrinth } from '../src/main/mod-downloader';

/**
 * Streaming jar download (perf-strike): the response body must be piped to a
 * .tmp sibling chunk-by-chunk (never buffered whole via arrayBuffer) and
 * atomically renamed into mods/ only after a clean finish.
 *
 * No sockets: fetch is stubbed to return plain objects whose `body` is a real
 * ReadableStream, so getReader()/read() run the actual production pump. The
 * streaming proof is behavioral — the source paces its second chunk and the
 * .tmp file is observed growing BETWEEN chunks, which is impossible if the
 * body were being buffered whole first.
 */

const VERSIONS_OK = {
  ok: true,
  json: async () => [
    {
      id: 'ver-1',
      version_number: '1.0.0',
      files: [{ url: 'https://cdn.example/sodium.jar', filename: 'sodium.jar', primary: true }],
    },
  ],
};

function pacedStream(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(enc.encode(chunks[i]));
      i++;
    },
  });

}

function failingStream(firstChunk: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let emitted = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        controller.enqueue(enc.encode(firstChunk));
        return;
      }
      controller.error(new Error('socket exploded mid-jar'));
    },
  });
}

let worldRoot: string;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (worldRoot) {
    await rm(worldRoot, { recursive: true, force: true });
    worldRoot = '';
  }
});

describe('downloadModFromModrinth — streaming write path', () => {
  it('writes chunks to the .tmp AS THEY ARRIVE (no whole-body buffering)', async () => {
    worldRoot = await mkdtemp(join(tmpdir(), 'mu-stream-'));
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/version')) return VERSIONS_OK;
      return { ok: true, body: pacedStream(['AAAA', 'BBBB', 'CCCC'], 60) };
    });

    const pending = downloadModFromModrinth(worldRoot, 'AANobbMI');
    // While the source is still pacing chunk 2, chunk 1 must already be on
    // disk inside the .tmp — proof that chunks are consumed as they arrive.
    await new Promise((r) => setTimeout(r, 25));
    const tmpPath = join(worldRoot, 'mods', 'sodium.jar.tmp');
    const partial = await stat(tmpPath);
    expect(partial.size).toBe(4); // only chunk 1 so far — no full buffer

    const result = await pending;
    expect(result).toEqual({ success: true, filename: 'sodium.jar' });

    // Final content is the exact concatenation; the .tmp is gone.
    const jar = await readFile(join(worldRoot, 'mods', 'sodium.jar'), 'utf8');
    expect(jar).toBe('AAAABBBBCCCC');
    expect(await readdir(join(worldRoot, 'mods'))).toEqual(['sodium.jar']);
  });

  it('replaces an existing jar atomically (rm-then-rename, no .tmp residue)', async () => {
    worldRoot = await mkdtemp(join(tmpdir(), 'mu-stream-'));
    const modsDir = join(worldRoot, 'mods');
    await mkdir(modsDir, { recursive: true });
    await writeFile(join(modsDir, 'sodium.jar'), 'OLD-JAR');
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/version')) return VERSIONS_OK;
      return { ok: true, body: pacedStream(['NEW'], 0) };
    });

    const result = await downloadModFromModrinth(worldRoot, 'AANobbMI');
    expect(result.success).toBe(true);
    expect(await readFile(join(modsDir, 'sodium.jar'), 'utf8')).toBe('NEW');
    expect(await readdir(modsDir)).toEqual(['sodium.jar']);
  });

  it('on mid-stream failure: removes the .tmp, keeps the previous jar intact', async () => {
    worldRoot = await mkdtemp(join(tmpdir(), 'mu-stream-'));
    const modsDir = join(worldRoot, 'mods');
    await mkdir(modsDir, { recursive: true });
    await writeFile(join(modsDir, 'sodium.jar'), 'PREVIOUS-GOOD-JAR');

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/version')) return VERSIONS_OK;
      return { ok: true, body: failingStream('AAAA') };
    });

    const result = await downloadModFromModrinth(worldRoot, 'AANobbMI');
    expect(result.success).toBe(false);
    expect(result.error).toContain('socket exploded mid-jar');
    // Atomicity: the old jar survives untouched, no partial file masquerades
    // as complete, no .tmp residue.
    expect(await readFile(join(modsDir, 'sodium.jar'), 'utf8')).toBe('PREVIOUS-GOOD-JAR');
    expect(await readdir(modsDir)).toEqual(['sodium.jar']);
  });

  it('on first-install failure: no dest, no .tmp residue at all', async () => {
    worldRoot = await mkdtemp(join(tmpdir(), 'mu-stream-'));
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/version')) return VERSIONS_OK;
      return { ok: true, body: failingStream('AAAA') };
    });

    const result = await downloadModFromModrinth(worldRoot, 'AANobbMI');
    expect(result.success).toBe(false);
    expect(await readdir(join(worldRoot, 'mods'))).toEqual([]);
  });

  it('HTTP error path message is unchanged', async () => {
    worldRoot = await mkdtemp(join(tmpdir(), 'mu-stream-'));
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/version')) return VERSIONS_OK;
      return { ok: false, status: 500 };
    });

    const result = await downloadModFromModrinth(worldRoot, 'AANobbMI');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Download failed: HTTP 500');
  });

  it('null body still fails cleanly with the empty-response message', async () => {
    worldRoot = await mkdtemp(join(tmpdir(), 'mu-stream-'));
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/version')) return VERSIONS_OK;
      return { ok: true, body: null };
    });

    const result = await downloadModFromModrinth(worldRoot, 'AANobbMI');
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty response body');
  });
});
