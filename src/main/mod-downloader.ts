/**
 * Mod Downloader — pull a mod straight from the Modrinth API into a world's
 * `mods/` directory.
 *
 * STANDALONE module (phase 1 of Modrinth search/install): no IPC, no UI, no
 * coupling. Phase 2 wiring will call `downloadModFromModrinth` from an IPC
 * handler after the user picks a project in the renderer.
 *
 * Uses the global `fetch` (Node 20+, available in Electron 40's main process)
 * rather than Electron's `net.fetch`: this module has no electron import at
 * all, which keeps it testable outside the app. Modrinth's API etiquette
 * requires a descriptive User-Agent, so every request carries one.
 *
 * Failure contract: NEVER throws. Any failure — bad project id, unknown
 * version, HTTP error, network failure, unsafe filename, disk write error —
 * resolves to `{ success: false, error: <message> }`.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { assertSafeModFilename } from './mod-filename';
import { join } from 'node:path';

/** Modrinth asks clients to identify themselves; bare/absent UAs get throttled. */
const USER_AGENT = 'mu-master-launcher/1.0.0 (github.com/prathamsethiongithub/mu-launcher)';

const MODRINTH_API = 'https://api.modrinth.com/v2';

interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size?: number;
}

interface ModrinthVersion {
  id: string;
  version_number?: string;
  files?: ModrinthVersionFile[];
  game_versions?: string[];
  loaders?: string[];
}

/**
 * A remote filename is still a filename — same hardened guard as mod-manager
 * (B2), plus the .jar requirement: a Modrinth download must land as a jar.
 */
function assertSafeFilename(filename: string): void {
  assertSafeModFilename(filename, { requireJar: true, op: 'download' });
}

export interface ModrinthSearchResult {
  /** Modrinth project UUID — feeds directly into downloadModFromModrinth. */
  id: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl?: string;
}

/**
 * Searches Modrinth for mods, optionally filtered by the world's game version
 * and loader so the results are installable in THIS world.
 *
 * Failure contract: never throws — any failure (network, timeout, malformed
 * response) resolves to an empty list, which the UI renders as "no results".
 *
 * Note: a `project_type:mod` facet is always applied so plugins and datapacks
 * don't pollute mod results.
 */
export async function searchModrinthMods(
  query: string,
  gameVersion?: string,
  loader?: string,
): Promise<ModrinthSearchResult[]> {
  try {
    const facets: string[][] = [['project_type:mod']];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);

    const params = new URLSearchParams({
      query: query || '',
      facets: JSON.stringify(facets),
    });
    const res = await fetch(`${MODRINTH_API}/search?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[mods] Modrinth search failed: HTTP ${res.status}`);
      return [];
    }

    const body = (await res.json()) as {
      hits?: {
        project_id?: string;
        title?: string;
        description?: string;
        author?: string;
        downloads?: number;
        icon_url?: string | null;
      }[];
    };

    return (body.hits || []).map((hit) => ({
      id: hit.project_id || '',
      title: hit.title || '',
      description: hit.description || '',
      author: hit.author || '',
      downloads: typeof hit.downloads === 'number' ? hit.downloads : 0,
      iconUrl: hit.icon_url || undefined,
    }));
  } catch (err) {
    // Timeouts (AbortSignal), network failures and JSON errors all land here:
    // search is a browse affordance, so an empty result beats a crashed dialog.
    console.error('[mods] Modrinth search failed:', err);
    return [];
  }
}

/**
 * Downloads the latest (or a specific) version of a Modrinth project's primary
 * file into `{worldRootPath}/mods/`.
 *
 * @param worldRootPath  Absolute game-root of the target world.
 * @param projectId      Modrinth project ID or slug (e.g. "AANobbMI" for Sodium).
 * @param versionId      Optional version UUID or version number; omit for latest.
 * @param filter         Optional world compatibility filter. When provided, the
 *                       newest build matching the world's game version AND
 *                       loader is selected (Sodium's latest is NeoForge-only —
 *                       a Fabric world must get the Fabric build). An explicit
 *                       versionId overrides the filter.
 * @returns `{ success: true, filename }` with the on-disk mod filename, or
 *          `{ success: false, error }` for ANY failure. Never throws.
 */
export async function downloadModFromModrinth(
  worldRootPath: string,
  projectId: string,
  versionId?: string,
  filter?: { gameVersion?: string; loader?: string },
): Promise<{ success: boolean; error?: string; filename?: string }> {
  try {
    if (!projectId || typeof projectId !== 'string') {
      throw new Error('No Modrinth project ID provided.');
    }

    // ── 1. version list for this project (newest first) ──
    const versionsRes = await fetch(
      `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`,
      { headers: { 'User-Agent': USER_AGENT } },
    );
    if (!versionsRes.ok) {
      throw new Error(
        `Modrinth API returned HTTP ${versionsRes.status} for project "${projectId}"` +
          (versionsRes.status === 404 ? ' — project not found.' : '.'),
      );
    }
    const versions = (await versionsRes.json()) as ModrinthVersion[];
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error(`Modrinth project "${projectId}" has no published versions.`);
    }

    // ── 2. pick the requested version, else the newest ──
    // Match on either the version UUID or the human version number — callers
    // naturally pass the string they saw on the website. With a world filter,
    // only builds matching the world's game version AND loader qualify
    // (installing a NeoForge build into a Fabric world would never load).
    let version: ModrinthVersion | undefined;
    if (versionId) {
      version = versions.find((v) => v.id === versionId || v.version_number === versionId);
    } else if (filter?.gameVersion || filter?.loader) {
      const pool = versions.filter(
        (v) =>
          (!filter.gameVersion || (v.game_versions || []).includes(filter.gameVersion)) &&
          (!filter.loader || (v.loaders || []).includes(filter.loader)),
      );
      if (pool.length === 0) {
        throw new Error(
          `No ${filter.loader || 'Minecraft'} ${filter.gameVersion || ''} build of "${projectId}" on Modrinth.`.replace(/ {2}/g, ' '),
        );
      }
      version = pool[0];
    } else {
      version = versions[0];
    }
    if (!version) {
      const known = versions
        .slice(0, 5)
        .map((v) => v.version_number)
        .filter(Boolean)
        .join(', ');
      throw new Error(
        `Version "${versionId}" not found for project "${projectId}"` +
          (known ? ` (recent versions: ${known})` : '.'),
      );
    }

    // ── 3. primary file (fall back to the first if none is marked) ──
    const file = version.files?.find((f) => f.primary) ?? version.files?.[0];
    if (!file?.url || !file.filename) {
      throw new Error(
        `Version "${version.version_number || version.id}" has no downloadable file.`,
      );
    }
    assertSafeFilename(file.filename);

    // ── 4. download the file itself (streamed — never buffered whole) ──
    const fileRes = await fetch(file.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!fileRes.ok) {
      throw new Error(
        `Download failed: HTTP ${fileRes.status} from ${file.url} (file "${file.filename}").`,
      );
    }
    const reader = fileRes.body?.getReader();
    if (!reader) {
      throw new Error(
        `Download failed: empty response body from ${file.url} (file "${file.filename}").`,
      );
    }

    // ── 5. stream into a .tmp sibling, then atomically rename ──
    // The old path buffered the entire response via arrayBuffer() before
    // writing — peak memory equal to the full jar size. Streaming caps it at
    // one chunk. Writing to `<name>.jar.tmp` first and renaming after a clean
    // finish means a crash mid-download can never leave a truncated file
    // masquerading as a complete mod: mods/ only ever sees fully-written
    // jars, and a failed download leaves any previous jar at the destination
    // untouched. (This path never hash-verified payloads, so there is no
    // verification contract to preserve here; adding one would be a
    // functional change and is out of scope.)
    const modsDir = join(worldRootPath, 'mods');
    await mkdir(modsDir, { recursive: true });
    const dest = join(modsDir, file.filename);
    const tmp = `${dest}.tmp`;

    const writer = createWriteStream(tmp);
    const finished = new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!writer.write(value)) {
          // Respect backpressure: pause reads until the file stream drains.
          await new Promise<void>((resolve) => writer.once('drain', resolve));
        }
      }
      writer.end();
      await finished;
    } catch (err) {
      // Close the fd BEFORE unlinking: destroy() is async, and on Windows a
      // directory entry only disappears (and unlink only reliably succeeds)
      // once the handle is released. 'close' fires after the fd is released,
      // on both normal and errored closes.
      await new Promise<void>((resolve) => {
        if (writer.destroyed) {
          resolve();
          return;
        }
        writer.once('close', () => resolve());
        writer.destroy();
      });
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }

    // Atomic swap into place. An existing jar at dest (re-import) is
    // replaced — same rm-then-rename sequence as mod-installer and
    // modpack-installer (Windows rename fails while dest exists).
    await rm(dest, { force: true }).catch(() => {});
    try {
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }

    return { success: true, filename: file.filename };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
