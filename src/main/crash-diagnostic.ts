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

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';

export interface CrashDiagnosis {
  crashed: boolean;
  modName?: string;
  reason?: string;
  crashTime?: string;
}

/** Only the head of the report is parsed — enough for the cause, and it
 *  keeps a multi-megabyte pathological report from stalling the main
 *  process on a synchronous read.
 *
 *  RED-TEAM HARDENED (wave 2, B3): the original read the WHOLE file into
 *  memory synchronously and only then sliced — a 100MB forged crash
 *  report froze the main process for the entire read. The head is now
 *  read with a bounded length (256KB ceiling: 5,000 chars of text lives
 *  well inside it even on CRLF/spaced reports) and sliced after.
 *
 *  RED-TEAM HONESTY CONTRACT (wave 2, B3): attribution is only DELIVERED
 *  when the accused mod actually exists in the world's mods/ directory.
 *  A forged report (or one naming an uninstalled mod) still reports the
 *  crash honestly but refuses to slander a mod that isn't there —
 *  `modName` degrades to undefined and the reason stays. */
const HEAD_LIMIT = 5000;

/** Bounded byte ceiling for the synchronous read (see RED-TEAM note). */
const READ_CEILING = 256 * 1024;

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
      // Bounded read: never pull a hostile multi-MB file into the main
      // process whole. The buffer is sliced to text after the disk work.
      const fd = openSync(join(reportsDir, newestName), 'r');
      try {
        const buf = Buffer.alloc(Math.min(READ_CEILING, statSync(join(reportsDir, newestName)).size));
        const read = readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, read).toString('utf8').slice(0, HEAD_LIMIT * 4);
      } finally {
        closeSync(fd);
      }
    } catch {
      // The report exists but can't be read — still a confirmed crash,
      // just an unattributed one.
      return { crashed: true, reason: 'Unknown crash', crashTime };
    }

    const modName = detectModName(head);
    const reason = detectReason(head);

    // Honesty gate: only accuse a mod that is ACTUALLY INSTALLED in this
    // world. The report text is attacker-writable — "Mixin apply failed:
    // innocent.mixins.json" alone must never put a name on the screen.
    const verifiedMod = verifyInstalledMod(worldRootPath, modName);

    return {
      crashed: true,
      modName: verifiedMod,
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
 *   1. The `Caused by:` chain — walked to the ROOT (the LAST entry; outer
 *      levels are wrappers like ModResolutionException). Any OOM level wins
 *      immediately: it is the one unambiguous signature.
 *   2. `Mixin apply failed` — Fabric's signature for an incompatible mod.
 *   3. `java.lang.OutOfMemoryError` outside a chain — RAM starvation.
 */
export function detectReason(head: string): string | null {
  const chain = [
    ...head.matchAll(/^[ \t]*(?:\/\/[ \t]*)?Caused by:[ \t]*(.+)$/gm),
  ].map((m) => m[1].trim());

  if (chain.length > 0) {
    // Any level naming OOM is definitive — RAM starvation, not a mod.
    if (chain.some((l) => l.includes('OutOfMemoryError'))) {
      return 'Out of memory (java.lang.OutOfMemoryError)';
    }
    // Root cause = innermost/last entry of the chain.
    const root = chain[chain.length - 1];
    return root.length > 200 ? `${root.slice(0, 200)}…` : root;
  }
  if (/Mixin apply failed/.test(head)) return 'Mixin apply failed';
  if (/java\.lang\.OutOfMemoryError/.test(head)) return 'Out of memory (java.lang.OutOfMemoryError)';
  return null;
}

/**
 * Guilty-mod detection. Four independent signals, tried in order of
 * reliability:
 *   1. `<modid>.mixins.json` — mixin config files are named after their mod.
 *   2. Fabric's pre-launch analyzer: "Error analyzing [<path>]" names the
 *      exact jar that broke mod discovery (corrupt jar / bad structure).
 *   3. A mod `.jar` filename mentioned near "Mod file"/"File" markers.
 *   4. A stack-trace class outside the game's own packages — its package
 *      prefix (e.g. `net.sodium` from `net.sodium.client.X`) is the mod.
 */
export function detectModName(head: string): string | undefined {
  // 1. Mixin config: "Mixin apply failed: sodium.mixins.json:client.json ..."
  const mixin = head.match(/([A-Za-z][\w-]*)\.mixins\.json/);
  if (mixin) return prettifyModId(mixin[1]);

  // 2. Fabric pre-launch failure: the analyzer names the offending jar in
  //    brackets. Both path separators occur (backslash on Windows reports).
  const analyzing = head.match(
    /Error analyzing \[[^\]]*[\\\\/]([\w.-]+\.jar)\]/,
  );
  if (analyzing) {
    const modId = analyzing[1]
      .replace(/\.jar$/i, '')
      .replace(/-[\d][\w.]*$/, ''); // strip version tail: "sodium-0.5.3" → "sodium"
    if (modId && !/^minecraft$/i.test(modId)) return prettifyModId(modId);
  }

  // 3. A mod jar in the report's environment/file listing.
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
    // Rebuild the package path one segment at a time and stop at the
    // first known non-mod root ("net.minecraft", "java", ...). Starting
    // at 1 checks the single-segment roots too — JDK frames like
    // java.lang.Thread.run must hit the 'java' whitelist, not fall off
    // the end and surface 'lang' as a mod name.
    for (let depth = 1; depth <= parts.length; depth++) {
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

/**
 * RED-TEAM honesty gate: confirm the accused mod is actually installed.
 * Matching is case-insensitive on the mod id appearing in a jar filename
 * (sodium.mixins.json → mods/sodium-0.5.3.jar). No mods dir / no match →
 * undefined (the crash stays, the slander goes).
 */
function verifyInstalledMod(worldRootPath: string, modName: string | undefined): string | undefined {
  if (!modName) return undefined;
  try {
    const modsDir = join(worldRootPath, 'mods');
    const jars = readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
    if (jars.length === 0) return undefined;
    const needle = modName.toLowerCase().replace(/[\s_-]+/g, '');
    if (!needle) return undefined;
    const hit = jars.some((f) => {
      const stem = f.replace(/\.jar$/i, '').replace(/-[\d][\w.]*$/, ''); // strip version tail
      return stem.toLowerCase().replace(/[\s_-]+/g, '') === needle;
    });
    return hit ? modName : undefined;
  } catch {
    // Cannot verify (no mods dir, unreadable) → refuse to accuse.
    return undefined;
  }
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
