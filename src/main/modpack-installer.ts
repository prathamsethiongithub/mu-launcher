/**
 * Modpack installer — overrides extraction + declarative file downloads for
 * Modrinth modpacks (.mrpack).
 *
 * STANDALONE module (phase 1.5 of drag-and-drop modpack import): the parse
 * step lives in the `parse-modpack` IPC handler (main/index.ts) and only
 * identifies the pack; this module performs the actual filesystem side of an
 * install — unpacking the archive's `overrides/` folder into a world's game
 * root, and downloading every entry of modrinth.index.json's `files[]`
 * (the pack's declarative download manifest) into the same root. Skipping
 * files[] would install configs whose mods never arrive — a silently
 * half-installed pack.
 *
 * Contracts:
 *   zip entry `overrides/config/sodium.json`  →  `{worldRootPath}/config/sodium.json`
 *   zip entry `overrides/` (the root itself)  →  skipped
 *   files[i] (env.client != "unsupported")   →  `{worldRootPath}/{files[i].path}`
 *                                                downloaded from the first
 *                                                reachable URL in downloads[],
 *                                                hash-verified (sha1/sha512)
 *
 * Overrides extraction is best-effort EXPLICIT: failures throw with the entry
 * name and target path in the message. The files[] download loop never
 * throws: each item reports success/failure individually and the aggregate
 * `{ installed, skipped, failed }` lets the caller decide how loudly to
 * complain — a single dead CDN must not lose the other 200 already-verified
 * mods.
 *
 * adm-zip notes (both matter here):
 *   - The archive is read into a Buffer FIRST and handed to the constructor:
 *     adm-zip's string-path constructor throws INVALID_FILENAME for any
 *     extension it doesn't recognise (.mrpack included) — observed live.
 *   - The repo's local type shim (src/types/adm-zip.d.ts) types the
 *     constructor as string-only, so the Buffer call goes through a cast;
 *     adm-zip's own constructor accepts `string | Buffer` (adm-zip.js:51).
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { downloadGuard, readWithStallGuard, pMap } from './net';
import {
  assertArchiveBudget,
  assertArchiveSize,
  assertEntryBudget,
  type ZipEntryLike,
} from './archive-guard';

/** Modrinth asks clients to identify themselves; bare/absent UAs get throttled. */
const USER_AGENT = 'mu-master-launcher/1.0.0 (github.com/prathamsethiongithub/mu-launcher)';

/**
 * Parallel files[] downloads. Each item is fully self-contained (own URL
 * candidates, tmp file, hash gate, final path), Modrinth's CDN is built for
 * concurrent pulls, and failures are already per-item — so bounded
 * parallelism changes nothing observable except wall-clock. 6 balances
 * throughput against CDN politeness and local disk contention.
 */
const PACK_FILE_CONCURRENCY = 6;

/**
 * One entry of modrinth.index.json's `files[]`. Only the fields the download
 * loop actually consumes are typed; extra Modrinth fields are ignored.
 */
interface MrpackFile {
  path: string;
  /** URL candidates — tried in order, first success wins. */
  downloads?: string[];
  /** File size in bytes; mismatching payloads are rejected. */
  fileSize?: number;
  /** Hash family + lowercase hex digest — the integrity contract. */
  hashes?: { sha1?: string; sha512?: string };
  /** Client/server/env applicability; client == "unsupported" skips the item. */
  env?: { client?: string; server?: string };
}

interface MrpackIndex {
  files?: MrpackFile[];
}

/**
 * Read modrinth.index.json out of an archive buffer.
 * Throws with [E701] on an unreadable archive or a malformed/unparseable
 * index — a corrupt manifest must surface, never silently install nothing.
 */
async function readModpackIndex(archive: Buffer): Promise<MrpackIndex> {
  const AdmZipCtor = (await import('adm-zip')).default as unknown as new (
    data: Buffer,
  ) => { getEntries(): ZipEntry[] };
  let indexText: string;
  try {
    // Bomb containment (B6): bound the archive on disk and the whole central
    // directory BEFORE any getData() allocates a declared-size buffer.
    assertArchiveSize(archive.length);
    const zip = new AdmZipCtor(archive);
    const allEntries = zip.getEntries();
    assertArchiveBudget(allEntries);
    const entry = allEntries
      .find((e) => e.entryName === 'modrinth.index.json' && !e.isDirectory);
    if (!entry) {
      throw new Error(
        '[E701] The modpack archive has no modrinth.index.json — not a Modrinth modpack.',
      );
    }
    assertEntryBudget(entry, 'manifest');
    indexText = entry.getData().toString('utf8');
  } catch (err) {
    if (err instanceof Error && err.message.includes('[E701]')) throw err;
    throw new Error(
      `[E701] Could not read modrinth.index.json from the modpack archive: ${
        (err as Error).message
      }`,
    );
  }
  try {
    return JSON.parse(indexText) as MrpackIndex;
  } catch (err) {
    throw new Error(
      `[E701] modrinth.index.json is not valid JSON: ${(err as Error).message}`,
    );
  }
}

const OVERRIDES_PREFIX = 'overrides/';

/** Minimal shape of an adm-zip entry (mirrors the local type shim). */
interface ZipEntry extends ZipEntryLike {
  entryName: string;
  isDirectory: boolean;
  getData(): Buffer;
}

/**
 * Extract a Modrinth modpack's `overrides/` folder into a world's game root.
 *
 * @param zipPath        Path to the .mrpack/.zip archive on disk.
 * @param worldRootPath  Absolute game-root directory of the target world
 *                       (the folder that contains mods/, config/, saves/…).
 * @throws If the archive cannot be read/opened, contains no `overrides/`
 *         folder, carries an unsafe path, or any single file fails to write.
 */
export async function installModpackOverrides(
  zipPath: string,
  worldRootPath: string,
): Promise<void> {
  if (!zipPath) throw new Error('[modpack] No modpack archive path provided.');
  if (!worldRootPath) throw new Error('[modpack] No world root path provided.');

  // Refuse an oversized file BEFORE readFile pulls it into memory.
  try {
    assertArchiveSize((await stat(zipPath)).size);
  } catch (err) {
    if (err instanceof Error && err.message.includes('[E705]')) throw err;
    // stat failure (missing file) falls through to readFile's precise ENOENT.
  }

  // Read the archive ourselves — see the Buffer note in the header. Doing it
  // with fs/promises also turns a missing file into a precise ENOENT message
  // instead of adm-zip's generic INVALID_FILENAME.
  let archive: Buffer;
  try {
    archive = await readFile(zipPath);
  } catch (err) {
    throw new Error(
      `[modpack] Could not read modpack archive at ${zipPath}: ${(err as Error).message}`,
    );
  }

  // Bomb containment (B6): refuse oversized archives and lying central
  // directories before adm-zip can Buffer.alloc() a declared-size entry.
  assertArchiveSize(archive.length);

  // Buffer constructor via cast — see the header note about the local shim.
  const AdmZipCtor = (await import('adm-zip')).default as unknown as new (
    data: Buffer,
  ) => { getEntries(): ZipEntry[] };
  let zip: { getEntries(): ZipEntry[] };
  try {
    zip = new AdmZipCtor(archive);
  } catch (err) {
    throw new Error(
      `[modpack] Could not open ${zipPath} as a zip archive: ${(err as Error).message}`,
    );
  }

  const allEntries = zip.getEntries();
  assertArchiveBudget(allEntries);
  const overrides = allEntries.filter((entry) =>
    entry.entryName.startsWith(OVERRIDES_PREFIX),
  );

  if (overrides.length === 0) {
    throw new Error(
      `[modpack] ${zipPath} contains no overrides/ folder — nothing to install.`,
    );
  }

  for (const entry of overrides) {
    // Strip the prefix and normalise: zip entry names are POSIX-slashed, but
    // guard against backslashes anyway so nothing smuggles a separator past
    // the checks below.
    const rel = entry.entryName.slice(OVERRIDES_PREFIX.length).replace(/\\/g, '/');
    if (!rel) continue; // the overrides/ root entry itself

    const segments = rel.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    // Zip-slip guard: an override must never escape the world root. A crafted
    // archive with `overrides/../../something` would otherwise write outside
    // the launcher's data directory.
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      throw new Error(`[modpack] Refusing unsafe override path "${entry.entryName}".`);
    }

    const target = join(worldRootPath, ...segments);

    if (entry.isDirectory) {
      // Directory entries are kept so empty folders (e.g. overrides/shaderpacks/)
      // survive the extraction.
      await mkdir(target, { recursive: true });
      continue;
    }

    assertEntryBudget(entry, 'override');
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, entry.getData());
    } catch (err) {
      throw new Error(
        `[modpack] Failed to write override "${entry.entryName}" → ${target}: ${
          (err as Error).message
        }`,
      );
    }
  }
}

/**
 * Validate a files[] item's declared path: relative, inside the world root,
 * no traversal (..), no absolute paths or drive letters. Mirrors the
 * zip-slip guard above — a crafted manifest must never write outside the
 * launcher's data directory.
 */
function assertSafePackPath(relPath: string): void {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('[E702] A files[] entry is missing its "path" field.');
  }
  if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new Error(`[E702] Refusing absolute path from modpack manifest: "${relPath}".`);
  }
  if (relPath.includes('..')) {
    throw new Error(`[E702] Refusing unsafe path from modpack manifest: "${relPath}".`);
  }
}

/**
 * Download ONE files[] item: pick the first reachable URL from downloads[],
 * stream to a .tmp sibling (bounded by net.ts guard primitives), verify the
 * declared sha1/sha512 hash, then atomically rename into place. Any failure
 * removes the temp file and rethrows — a hash mismatch NEVER leaves a wrong
 * file silently in place.
 */
async function downloadPackFile(item: MrpackFile, worldRootPath: string): Promise<void> {
  assertSafePackPath(item.path);

  const urls = (item.downloads || []).filter((u) => typeof u === 'string' && u.length > 0);
  if (urls.length === 0) {
    throw new Error(
      `[E703] "${item.path}" lists no download URL in the modpack manifest.`,
    );
  }

  const hashFormat = item.hashes?.sha512 ? 'sha512' : 'sha1';
  const expectedHash = item.hashes?.sha512 || item.hashes?.sha1;

  const dest = join(worldRootPath, ...item.path.replace(/\\/g, '/').split('/').filter(Boolean));
  const tmp = `${dest}.tmp`;

  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      // Same guard pattern as mod-installer's downloadWithHash: a connect
      // timeout for the headers, a per-chunk stall guard for the body.
      const guard = downloadGuard();
      const response = await fetch(url, {
        signal: guard.controller.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
      guard.headersReceived();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const writer = createWriteStream(tmp);
      const hash = createHash(hashFormat);
      try {
        while (true) {
          const { done, value } = await readWithStallGuard(reader.read(), guard.controller);
          if (done) break;
          writer.write(value);
          hash.update(value);
        }
        writer.end();
        await new Promise<void>((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      } catch (err) {
        // Bounded read guards and write errors all funnel here.
        writer.destroy();
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }

      // Integrity gates BEFORE the atomic rename — a wrong payload never
      // lands at the destination path.
      if (item.fileSize !== undefined) {
        const actualSize = (await stat(tmp)).size;
        if (actualSize !== item.fileSize) {
          await rm(tmp, { force: true }).catch(() => {});
          throw new Error(
            `[E704] "${item.path}" failed integrity check: expected ${item.fileSize} bytes, got ${actualSize}.`,
          );
        }
      }
      const actualHash = hash.digest('hex');
      if (expectedHash && actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        await rm(tmp, { force: true }).catch(() => {});
        throw new Error(
          `[E704] "${item.path}" failed integrity check: expected ${expectedHash}, got ${actualHash}. The file was deleted.`,
        );
      }

      // Atomically move the verified temp file into place. An existing file
      // at dest (e.g. a re-import) is replaced; on Windows rename fails if
      // dest exists, so remove it first — same sequence as mod-installer.
      await rm(dest, { force: true }).catch(() => {});
      try {
        await rename(tmp, dest);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Clean any partial temp file before trying the next URL candidate.
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  throw new Error(
    `[E703] Failed to download "${item.path}" from all ${urls.length} URL(s). ` +
      `Last error: ${lastErr?.message || 'unknown'}`,
  );
}

/**
 * Download every entry of modrinth.index.json's `files[]` into the world
 * root. Items with env.client === "unsupported" are skipped (client-irrelevant
 * files such as server-side-only jars). Downloads run bounded-parallel at
 * PACK_FILE_CONCURRENCY; each item is hash-verified before its atomic
 * rename. Every item owns its own URL candidates, tmp file, hash gate, and
 * final path — nothing is shared between items, so completion order cannot
 * affect the on-disk result, and a failed item never poisons a successful
 * one.
 *
 * Never throws. Returns the aggregate so the caller can surface an honest
 * partial-success message instead of pretending the pack is complete.
 */
export async function installModpackFiles(
  zipPath: string,
  worldRootPath: string,
): Promise<{ installed: number; skipped: number; failed: number; errors: string[] }> {
  try {
    assertArchiveSize((await stat(zipPath)).size);
  } catch (err) {
    if (err instanceof Error && err.message.includes('[E705]')) throw err;
  }
  let archive: Buffer;
  try {
    archive = await readFile(zipPath);
  } catch (err) {
    throw new Error(
      `[E701] Could not read modpack archive at ${zipPath}: ${(err as Error).message}`,
    );
  }
  assertArchiveSize(archive.length);
  const index = await readModpackIndex(archive);
  const items = Array.isArray(index.files) ? index.files : [];

  let installed = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  // Bounded-parallel downloads (PACK_FILE_CONCURRENCY). Each item's guards
  // and error paths are self-contained (see downloadPackFile): per-item URL
  // candidates tried in order, per-item tmp+rename atomicity, per-item E-code
  // errors carrying the item path. downloadPackFile never throws for a
  // VALID item shape, so the mapper below never rejects; malformed entries
  // (missing path) are counted exactly as the serial loop did. Counters are
  // plain JS numbers mutated from a single thread — no races.
  await pMap(
    items,
    async (item) => {
      if (item?.env?.client === 'unsupported') {
        skipped++;
        return;
      }
      if (!item || typeof item.path !== 'string') {
        failed++;
        errors.push('[E702] A files[] entry is missing its "path" field.');
        return;
      }
      try {
        await mkdir(
          dirname(join(worldRootPath, ...item.path.replace(/\\/g, '/').split('/').filter(Boolean))),
          { recursive: true },
        );
        await downloadPackFile(item, worldRootPath);
        installed++;
      } catch (err) {
        failed++;
        errors.push((err as Error).message);
        console.error('[modpack] files[] item failed:', (err as Error).message);
      }
    },
    { concurrency: PACK_FILE_CONCURRENCY },
  );

  return { installed, skipped, failed, errors };
}
