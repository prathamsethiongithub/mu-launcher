/**
 * Mod Update Checker — checks installed mods against Modrinth and updates them.
 *
 * Flow: every .jar in the world's mods/ dir is opened with adm-zip; its
 * embedded fabric.mod.json yields the Modrinth project id + installed version.
 * A version-list query (loader + game-version facets) returns the newest
 * compatible release; a numeric-aware comparison decides whether it is a real
 * update. Each mod is checked independently — one unreadable jar or one dead
 * network call must never block the others.
 *
 * performUpdate downloads the new file FIRST and removes the old jar only
 * after the new bytes are fully on disk — a failed download can never leave
 * the world with neither version.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeModFilename } from './mod-filename';

const MODRINTH_API = 'https://api.modrinth.com/v2';
/** Modrinth requires a descriptive User-Agent; anonymous requests get throttled. */
const USER_AGENT = 'mu-master-launcher/1.0.0 (Masters Union SMP launcher)';

export interface ModUpdateInfo {
  /** Current file on disk (e.g. "sodium-0.6.13.jar"). */
  filename: string;
  /** Mod id from fabric.mod.json (e.g. "sodium"). */
  modId: string;
  /** Installed version string. */
  currentVersion: string;
  /** Newest compatible version string on Modrinth. */
  latestVersion: string;
  /** Modrinth project ID. */
  projectId: string;
  /** Modrinth version ID — the handle performUpdate needs. */
  versionId: string;
  /** Direct download URL of the new release's primary file. */
  downloadUrl: string;
  /** Filename Modrinth ships the new release as (the update target name). */
  newFilename: string;
}

/** Path-safe jar filename: the shared hardened guard plus a .jar requirement. */
function assertSafeJarFilename(name: string): void {
  assertSafeModFilename(name, { requireJar: true, op: 'update' });
}

/**
 * Numeric-aware version comparison: "0.6.13" > "0.6.9" numerically, not
 * lexically. Returns true only when `latest` is strictly newer than
 * `current`. Unparseable segments fall back to string inequality for that
 * position; wholly unparseable pairs fall back to plain inequality (spec
 * behaviour) so exotic version schemes still surface as updates.
 *
 * Prerelease semantics: numeric segments compare first; when the numeric
 * core is equal, a prerelease tag (-beta/-rc/…) on `latest` marks it OLDER
 * than the bare release — a stable install is never updated onto a
 * prerelease. Build metadata ('+' section) keeps the string fallback path.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  if (latest === current) return false;
  const l = latest.split(/[.+-]/);
  const c = current.split(/[.+-]/);
  const len = Math.max(l.length, c.length);
  let comparable = false;
  for (let i = 0; i < len; i++) {
    const ln = parseInt(l[i] ?? '0', 10);
    const cn = parseInt(c[i] ?? '0', 10);
    if (Number.isNaN(ln) || Number.isNaN(cn)) {
      // Non-numeric segment: fall back to string compare for this position.
      const ls = l[i] ?? '';
      const cs = c[i] ?? '';
      if (ls !== cs) {
        // `comparable` is true only when the numeric core fully matched (any
        // numeric difference returned earlier). If `current` ends here while
        // `latest` carries an extra tag, that tag came from a '-' separator
        // when it is a prerelease — and a prerelease is OLDER than the bare
        // release, never newer. Build metadata has no '-', so it keeps the
        // string fallback below ('build' > '' still reads as an update).
        if (comparable && cs === '' && hasPrereleaseTag(latest)) return false;
        return ls > cs;
      }
      continue;
    }
    comparable = true;
    if (ln !== cn) return ln > cn;
  }
  // Numerically equal but textually different (e.g. build metadata) — treat
  // as an update only when nothing numeric contradicted, per Modrinth listing
  // order (the API returns newest first).
  return comparable ? false : latest !== current;
}

/** True when the version carries a prerelease tag: a '-' in the part before
 *  any build metadata ('+' section). "1.2.3-beta" → true, "1.2.3+build.1"
 *  → false. */
function hasPrereleaseTag(version: string): boolean {
  return version.split('+')[0].includes('-');
}

/** One mod's metadata from its jar, or null when it isn't a Fabric mod. */
async function readFabricModMeta(jarPath: string): Promise<{ id: string; version: string } | null> {
  // Same deferred-import pattern as mod-downloader/java-provisioner: adm-zip
  // stays off the startup path and loads on the first jar read.
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(jarPath);
  const entry = zip.getEntry('fabric.mod.json');
  if (!entry) return null;
  const meta = JSON.parse(entry.getData().toString('utf8')) as { id?: string; version?: string };
  if (!meta.id || !meta.version) return null;
  return { id: meta.id, version: meta.version };
}

/** List the enabled .jar files in a world's mods/ directory. */
function listModJars(worldRootPath: string): string[] {
  const modsDir = join(worldRootPath, 'mods');
  return readdirSync(modsDir)
    .filter((f) => f.toLowerCase().endsWith('.jar'))
    .map((f) => {
      const full = join(modsDir, f);
      statSync(full); // throws if vanished — caught by the caller
      return full;
    });
}

/**
 * Check every Fabric mod in {worldRootPath}/mods/ against Modrinth.
 * Never throws: unreadable jars, non-Fabric mods, network failures and
 * malformed responses are skipped individually.
 *
 * @param gameVersion e.g. "1.21.1" — applied as a Modrinth facet.
 * @param loader      e.g. "fabric" — applied as a Modrinth facet.
 */
export async function checkForUpdates(
  worldRootPath: string,
  gameVersion: string,
  loader: string,
): Promise<ModUpdateInfo[]> {
  let jars: string[] = [];
  try {
    jars = listModJars(worldRootPath);
  } catch {
    return []; // no mods dir / unreadable — nothing to check
  }

  const results = await Promise.all(
    jars.map(async (jarPath): Promise<ModUpdateInfo | null> => {
      try {
        const meta = await readFabricModMeta(jarPath);
        if (!meta) return null; // not a Fabric mod — skip silently

        const facetLoaders = encodeURIComponent(JSON.stringify([loader]));
        const facetVersions = encodeURIComponent(JSON.stringify([gameVersion]));
        const res = await fetch(
          `${MODRINTH_API}/project/${encodeURIComponent(meta.id)}/version?loaders=${facetLoaders}&game_versions=${facetVersions}`,
          { headers: { 'User-Agent': USER_AGENT } },
        );
        if (!res.ok) return null; // project gone, throttled, offline — skip
        const versions = (await res.json()) as {
          id: string;
          project_id?: string;
          version_number?: string;
          files?: { url: string; filename: string; primary?: boolean }[];
        }[];
        const latest = versions[0];
        const file = latest?.files?.find((f) => f.primary) ?? latest?.files?.[0];
        if (!latest?.version_number || !file?.url || !file.filename) return null;

        if (!isNewerVersion(latest.version_number, meta.version)) return null; // up to date

        const filename = jarPath.split(/[\\/]/).pop() ?? '';
        return {
          filename,
          modId: meta.id,
          projectId: latest.project_id ?? meta.id,
          currentVersion: meta.version,
          latestVersion: latest.version_number,
          versionId: latest.id,
          downloadUrl: file.url,
          newFilename: file.filename,
        };
      } catch {
        return null; // corrupt jar, bad JSON, network error — skip this mod
      }
    }),
  );

  return results.filter((r): r is ModUpdateInfo => r !== null);
}

/**
 * Download `downloadUrl` into {worldRootPath}/mods/{newFilename} and delete
 * the old jar — in that order, so a failed download never orphans the world.
 * Throws on failure; the IPC layer converts that into { success, error }.
 */
export async function performUpdate(
  worldRootPath: string,
  oldFilename: string,
  downloadUrl: string,
  newFilename: string,
): Promise<void> {
  assertSafeJarFilename(oldFilename);
  assertSafeJarFilename(newFilename);

  const res = await fetch(downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());

  const modsDir = join(worldRootPath, 'mods');
  await mkdir(modsDir, { recursive: true });
  await writeFile(join(modsDir, newFilename), bytes);

  // Old file only removed after the new one is fully on disk. Same-name
  // "update" (file replaced in place) must not unlink itself.
  if (oldFilename !== newFilename) {
    try {
      await unlink(join(modsDir, oldFilename));
    } catch {
      // Old file already gone (renamed/disabled elsewhere) — the update still
      // stands; don't fail the whole operation for a cleanup miss.
    }
  }
}
