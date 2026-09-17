/**
 * Mod Manager — per-world mod inventory and lifecycle.
 *
 * STANDALONE module (phase 1 of the Mod Manager backend): pure filesystem
 * operations over a world's `mods/` directory. No IPC, no UI, no coupling —
 * the renderer wiring (phase 2) will call these from IPC handlers.
 *
 * Naming model: a mod's CANONICAL filename is its enabled form (`sodium.jar`);
 * a disabled mod lives on disk as `sodium.jar.disabled`. Everywhere in this
 * module's API, `filename` means the canonical form — toggle/delete derive the
 * on-disk name from it. ModInfo.filename follows the same convention.
 *
 * Distinct from `mod-installer.ts` (which installs modpack downloads); this
 * module manages the per-mod inventory that already exists on disk.
 */

import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface ModInfo {
  /** Canonical (enabled-form) filename, e.g. "sodium.jar". */
  filename: string;
  /** Filename minus its extension(s), e.g. "sodium". */
  displayName: string;
  enabled: boolean;
  /** File size in bytes (of the file as it sits on disk). */
  size: number;
}

const MODS_DIR = 'mods';
const JAR_EXT = '.jar';
const DISABLED_SUFFIX = '.disabled';

function modsDir(worldRootPath: string): string {
  return join(worldRootPath, MODS_DIR);
}

/**
 * Every mod API takes a filename that ends up inside a path — so it must be a
 * bare name. This is the traversal guard for the whole module (phase 2 will
 * expose these operations over IPC, where the renderer supplies filenames).
 */
function assertSafeFilename(filename: string, op: string): void {
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error(`[mods] Unsafe mod filename for ${op}: "${filename}"`);
  }
}

function displayNameOf(filename: string): string {
  const canonical = filename.endsWith(DISABLED_SUFFIX)
    ? filename.slice(0, -DISABLED_SUFFIX.length)
    : filename;
  return canonical.endsWith(JAR_EXT) ? canonical.slice(0, -JAR_EXT.length) : canonical;
}

/**
 * Lists the mods in a world's `mods/` directory.
 * `.jar` files are enabled; `.jar.disabled` files are disabled.
 * A missing `mods/` directory is a normal state (fresh/imported world) and
 * yields an empty list rather than an error.
 */
export async function listMods(worldRootPath: string): Promise<ModInfo[]> {
  const dir = modsDir(worldRootPath);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`[mods] Failed to read mods directory ${dir}: ${(err as Error).message}`);
  }

  const mods: ModInfo[] = [];
  for (const name of names) {
    // Ignore anything that isn't a mod file in either state (leftovers,
    // .disabled.txt typos, OS droppings) — they would confuse toggle/delete.
    const enabled = name.endsWith(JAR_EXT);
    const disabled = name.endsWith(JAR_EXT + DISABLED_SUFFIX);
    if (!enabled && !disabled) continue;

    const canonical = disabled ? name.slice(0, -DISABLED_SUFFIX.length) : name;
    try {
      const info = await stat(join(dir, name));
      mods.push({
        filename: canonical,
        displayName: displayNameOf(name),
        enabled,
        size: info.size,
      });
    } catch (err) {
      // The file vanished between readdir and stat — skip it rather than
      // failing the whole listing for a transient race.
      console.warn(`[mods] Skipping vanished mod file "${name}":`, (err as Error).message);
    }
  }

  mods.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return mods;
}

/**
 * Enables or disables a mod by renaming it on disk.
 * Enable:  `{filename}.disabled` → `{filename}`
 * Disable: `{filename}`          → `{filename}.disabled`
 */
export async function toggleMod(
  worldRootPath: string,
  filename: string,
  enable: boolean,
): Promise<void> {
  assertSafeFilename(filename, enable ? 'enable' : 'disable');
  if (!filename.endsWith(JAR_EXT)) {
    throw new Error(`[mods] Cannot toggle "${filename}" — not a ${JAR_EXT} file.`);
  }

  const dir = modsDir(worldRootPath);
  const from = enable ? join(dir, filename + DISABLED_SUFFIX) : join(dir, filename);
  const to = enable ? join(dir, filename) : join(dir, filename + DISABLED_SUFFIX);
  const action = enable ? 'enable' : 'disable';

  try {
    await rename(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`[mods] Cannot ${action} "${filename}" — no such mod file on disk.`);
    }
    throw new Error(`[mods] Failed to ${action} "${filename}": ${(err as Error).message}`);
  }
}

/**
 * Deletes a mod permanently, whether it is currently enabled or disabled.
 * Throws if neither state of the file exists.
 */
export async function deleteMod(
  worldRootPath: string,
  filename: string,
): Promise<void> {
  assertSafeFilename(filename, 'delete');
  const dir = modsDir(worldRootPath);

  let lastErr: unknown = null;
  for (const candidate of [join(dir, filename), join(dir, filename + DISABLED_SUFFIX)]) {
    try {
      await unlink(candidate);
      return; // deleted — a mod exists in only one state
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `[mods] Failed to delete "${basename(candidate)}": ${(err as Error).message}`,
        );
      }
      lastErr = err;
    }
  }
  throw new Error(
    `[mods] Cannot delete "${filename}" — no such mod file on disk (${(lastErr as NodeJS.ErrnoException)?.code}).`,
  );
}

/**
 * Copies a mod from anywhere on disk into the world's `mods/` directory
 * (creating that directory if needed). The mod is added ENABLED — disabling
 * it afterwards is a one-click toggle.
 */
export async function addMod(
  worldRootPath: string,
  sourceFilePath: string,
): Promise<void> {
  const filename = basename(sourceFilePath);
  assertSafeFilename(filename, 'add');
  if (!filename.endsWith(JAR_EXT)) {
    throw new Error(`[mods] "${filename}" is not a ${JAR_EXT} file — mods must be jars.`);
  }

  const dir = modsDir(worldRootPath);
  try {
    await mkdir(dir, { recursive: true });
    await copyFile(sourceFilePath, join(dir, filename));
  } catch (err) {
    throw new Error(
      `[mods] Failed to add "${filename}" from ${sourceFilePath}: ${(err as Error).message}`,
    );
  }
}
