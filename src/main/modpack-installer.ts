/**
 * Modpack installer — overrides extraction for Modrinth modpacks (.mrpack).
 *
 * STANDALONE module (phase 1.5 of drag-and-drop modpack import): the parse
 * step lives in the `parse-modpack` IPC handler (main/index.ts) and only
 * identifies the pack; this module performs the actual filesystem side of an
 * install — unpacking the archive's `overrides/` folder into a world's game
 * root so the user's configs and packs land where MCLC reads them.
 *
 * Contract:
 *   zip entry `overrides/config/sodium.json`  →  `{worldRootPath}/config/sodium.json`
 *   zip entry `overrides/` (the root itself)  →  skipped
 *
 * Everything is best-effort EXPLICIT: failures throw with the entry name and
 * target path in the message, so the caller can surface a real error instead
 * of a silently half-installed modpack.
 *
 * adm-zip notes (both matter here):
 *   - The archive is read into a Buffer FIRST and handed to the constructor:
 *     adm-zip's string-path constructor throws INVALID_FILENAME for any
 *     extension it doesn't recognise (.mrpack included) — observed live.
 *   - The repo's local type shim (src/types/adm-zip.d.ts) types the
 *     constructor as string-only, so the Buffer call goes through a cast;
 *     adm-zip's own constructor accepts `string | Buffer` (adm-zip.js:51).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const OVERRIDES_PREFIX = 'overrides/';

/** Minimal shape of an adm-zip entry (mirrors the local type shim). */
interface ZipEntry {
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

  const overrides = zip
    .getEntries()
    .filter((entry) => entry.entryName.startsWith(OVERRIDES_PREFIX));

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
