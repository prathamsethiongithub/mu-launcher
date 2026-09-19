/**
 * Crash Diagnostic — "The Oracle".
 *
 * When Minecraft crashes, the next time the user hits Play this module reads
 * the world's most recent crash report and answers three questions: did it
 * crash, what did it, and why. The result flows to the renderer through the
 * 'diagnose-world' IPC handler so the UI can name the guilty mod instead of
 * making the user trawl through a 40kB stack trace.
 *
 * Contract: this module NEVER throws. A missing directory, an unreadable
 * file, garbage content — every failure path resolves to { crashed: false }.
 * A diagnostician that crashes itself is worse than no diagnostician.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface CrashDiagnosis {
  crashed: boolean;
  modName?: string;
  reason?: string;
  crashTime?: string;
}

/** Only the head of the report is parsed — enough for the cause, and it
 *  keeps a multi-megabyte pathological report from stalling the main
 *  process on a synchronous read. */
const HEAD_LIMIT = 5000;

/** Well-known package roots that are the GAME or its standard libraries,
 *  not mods. Any stack frame outside these is a mod suspect. */
const NON_MOD_PACKAGES = new Set([
  'net.minecraft', 'com.mojang', 'net.fabricmc', 'net.minecraftforge',
  'org.spongepowered', 'org.objectweb', 'org.apache', 'org.lwjgl',
  'io.netty', 'com.google', 'java', 'javax', 'jdk', 'sun', 'oshi',
]);

/**
 * Parse the newest crash report in {worldRootPath}/crash-reports/.
 *
 * @returns { crashed: false } when there is no report directory, no .txt
 *          reports, or anything goes wrong reading/parsing. A confirmed
 *          crash with no identifiable cause yields reason 'Unknown crash'.
 */
export async function diagnoseLastCrash(worldRootPath: string): Promise<CrashDiagnosis> {
  try {
    const reportsDir = join(worldRootPath, 'crash-reports');
    const files = readdirSync(reportsDir).filter((f) => f.toLowerCase().endsWith('.txt'));
    if (files.length === 0) return { crashed: false };

    // Newest report wins — mtime, not filename (crash report names embed a
    // timestamp, but users' clocks and manual renames make mtime sturdier).
    let newestName: string | null = null;
    let newestMtime = -1;
    for (const name of files) {
      try {
        const st = statSync(join(reportsDir, name));
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs;
          newestName = name;
        }
      } catch {
        continue; // vanished between readdir and stat — skip it
      }
    }
    if (!newestName) return { crashed: false };

    const crashTime = new Date(newestMtime).toISOString();

    let head: string;
    try {
      head = readFileSync(join(reportsDir, newestName), 'utf8').slice(0, HEAD_LIMIT);
    } catch {
      // The report exists but can't be read — still a confirmed crash,
      // just an unattributed one.
      return { crashed: true, reason: 'Unknown crash', crashTime };
    }

    const modName = detectModName(head);
    const reason = detectReason(head);

    return {
      crashed: true,
      modName,
      reason: reason ?? 'Unknown crash',
      crashTime,
    };
  } catch {
    // No crash-reports dir, no world root, permissions — all just mean
    // "nothing to report".
    return { crashed: false };
  }
}

/**
 * Reason detection, in priority order:
 *   1. `Caused by:` — the JVM's own causal chain (most precise signal).
 *   2. `Mixin apply failed` — Fabric's signature for an incompatible mod.
 *   3. `java.lang.OutOfMemoryError` — not a mod at all, just RAM starvation.
 */
export function detectReason(head: string): string | null {
  const causedBy = head.match(/^[ \t]*(?:\/\/[ \t]*)?Caused by:[ \t]*(.+)$/m);
  if (causedBy) {
    const line = causedBy[1].trim();
    if (line.includes('OutOfMemoryError')) return 'Out of memory (java.lang.OutOfMemoryError)';
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  }
  if (/Mixin apply failed/.test(head)) return 'Mixin apply failed';
  if (/java\.lang\.OutOfMemoryError/.test(head)) return 'Out of memory (java.lang.OutOfMemoryError)';
  return null;
}

/**
 * Guilty-mod detection. Three independent signals, tried in order of
 * reliability:
 *   1. `<modid>.mixins.json` — mixin config files are named after their mod.
 *   2. A mod `.jar` filename mentioned near "Mod file"/"File" markers.
 *   3. A stack-trace class outside the game's own packages — its package
 *      prefix (e.g. `net.sodium` from `net.sodium.client.X`) is the mod.
 */
export function detectModName(head: string): string | undefined {
  // 1. Mixin config: "Mixin apply failed: sodium.mixins.json:client.json ..."
  const mixin = head.match(/([A-Za-z][\w-]*)\.mixins\.json/);
  if (mixin) return prettifyModId(mixin[1]);

  // 2. A mod jar in the report's environment/file listing.
  const jar = head.match(/(?:Mod file|File):[ \t]*([\w.-]+\.jar)/);
  if (jar) {
    const modId = jar[1]
      .replace(/\.jar$/i, '')
      // Strip a trailing version tail: "sodium-0.5.3" → "sodium".
      .replace(/-[\d][\w.]*$/, '');
    if (modId && !/^minecraft$/i.test(modId)) return prettifyModId(modId);
  }

  // 3. First stack frame outside vanilla/library packages.
  //    e.g. "	at net.sodium.client.render.X.render(...)" → net.sodium
  const frames = head.matchAll(/^[ \t]*at[ \t]+((?:[a-z][\w]*\.)+)[A-Z]/gm);
  for (const frame of frames) {
    const parts = frame[1].split('.').filter(Boolean);
    // Rebuild the package path two segments at a time and stop at the
    // first known non-mod root ("net.minecraft", "java", ...).
    for (let depth = 2; depth <= parts.length; depth++) {
      const pkg = parts.slice(0, depth).join('.');
      if (NON_MOD_PACKAGES.has(pkg)) break; // vanilla/library — not a mod
      if (depth === parts.length) {
        // Walked off the end without hitting a known root: the second
        // segment is the usual mod package ("net" is a tld, "sodium" the mod).
        const modSegment = parts[1] ?? parts[0];
        if (modSegment && !/^\d/.test(modSegment)) return prettifyModId(modSegment);
      }
    }
  }

  return undefined;
}

/** "sodium" → "Sodium"; "sodium-extra" → "Sodium Extra". */
export function prettifyModId(modId: string): string {
  const cleaned = modId.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return modId;
  return cleaned
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
