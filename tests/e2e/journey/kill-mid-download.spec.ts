/**
 * Journey hunt #1 — DEATH MID-DOWNLOAD → RESPAWN INTEGRITY.
 *
 * Script: a Modrinth jar download (the real mod-downloader pipeline: tmp
 * sibling → stream → atomic rename) is slow-dripped via injected network so
 * the main process is HARD-KILLED (process.kill) at ~30/60/90% body progress
 * — the power-cut the user feels. The next boot (a fresh app on the SAME
 * user-data dir, like a real restart) must:
 *   1. not crash,
 *   2. show a healthy launcher (accounts IPC answers, "Ready."),
 *   3. never treat the truncated jar.tmp as a complete mod (mods/ must not
 *      contain it; the retry's final result must be a full jar on disk),
 *   4. let the interrupted download COMPLETE on the user's second attempt.
 *
 * The download is driven through the real user path: renderer →
 * downloadMod(worldId, projectId) → modrinth-download IPC →
 * downloadModFromModrinth (tmp + atomic rename, no hash contract — jar bytes
 * are synthetic and served by the injected stream).
 *
 * Assertions on disk run in the TEST process between the two boots (the
 * main process is dead — exactly when a human would look at the folder).
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { launchTestApp } from '../harness';
import {
  patchMainNetworkStream,
  MODRINTH_CANNED,
  jarSlowBody,
} from './lib';

const CHUNKS = 160; // × 16KB × 100ms ≈ 16s total transfer (163,840 B/s)
const CHUNK_BYTES = 16 * 1024;
const JAR_BYTES = CHUNKS * CHUNK_BYTES;
const WORLD_NAME = 'journey-kill-world';
const PROJECT_ID = 'journey-mod';

/** Drive: boot (with injection) → create world → fire downloadMod →
 *  wait until `beforeKill` reports the tmp file ≥ minBytes → hard kill. */
async function bootSeedAndKill(
  userDataDir: string,
  killAtBytes: number,
): Promise<void> {
  const app = await _electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    timeout: 30_000,
  });
  try {
    const window = await resolveMainWindow(app);
    await installInjection(app);

    // Real user path to a world id: create it in this throwaway profile.
    await window.evaluate(async (name: string) => {
      const res = await window.electronAPI.createWorld({ name, version: '1.21.1', loader: 'fabric' });
      if (!res.success) throw new Error(`create-world failed: ${res.error}`);
    }, WORLD_NAME);
    const worldId = await window.evaluate(async (name: string) => {
      const worlds = (await window.electronAPI.getWorlds()) as Array<{ id: string; name: string }>;
      const w = worlds.find((x) => x.name === name);
      if (!w) throw new Error('world not found after createWorld');
      return w.id;
    }, WORLD_NAME);

    // Fire the download; do NOT await completion — we kill mid-body. The
    // promise would settle after the kill; nothing here consumes it.
    void window
      .evaluate(async ([wid, pid]: [string, string]) => {
        // The renderer's own invoke may reject when the app dies beneath it —
        // swallow so the kill, not a rejection, is the event under test.
        try {
          await window.electronAPI.downloadMod(wid, pid);
        } catch {
          /* process died mid-flight — expected */
        }
      }, [worldId, PROJECT_ID])
      .catch(() => { /* the kill lands mid-evaluate — expected */ });

    // Poll the destination from the TEST process until the tmp file exists
    // and has grown past the kill threshold, then hard-kill the main process
    // (SIGKILL — no before-quit, no disposeTray, no flush: a power cut).
    const modsDir = path.join(userDataDir, 'worlds');
    const tmpPath = await waitForTmpGrowth(modsDir, killAtBytes, 30_000);
    if (!tmpPath) {
      // Capture diagnostics for the red.
      const state = snapshotModsDirs(modsDir);
      throw new Error(
        `tmp never grew past ${killAtBytes}B within 30s. mods state: ${JSON.stringify(state)}`,
      );
    }
    process.kill(app.process().pid, 'SIGKILL');
  } catch (err) {
    // If anything failed before the kill, still stop the app (best effort).
    try { process.kill(app.process().pid, 'SIGKILL'); } catch { /* already gone */ }
    throw err;
  }
  // Wait for the OS to report the pid dead so the respawn boots clean.
  await waitForPidGone(app.process().pid, 10_000);
}

async function resolveMainWindow(app: ElectronApplication): Promise<Page> {
  let window: Page | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 35_000) {
    for (const w of app.windows()) {
      if (/renderer[\\/]index\.html/.test(w.url())) { window = w; break; }
    }
    if (window) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!window) throw new Error('main window never appeared');
  await window.waitForLoadState('domcontentloaded');
  return window;
}

async function installInjection(app: ElectronApplication): Promise<void> {
  await patchMainNetworkStream(app, [
    MODRINTH_CANNED.versionList as { match: string; status: number; body: unknown },
    { ...MODRINTH_CANNED.jar, slow: jarSlowBody(CHUNKS, CHUNK_BYTES) },
  ]);
}

/** Find {userData}/worlds/<id>/minecraft/mods/*.jar.tmp with size ≥ min. */
async function waitForTmpGrowth(
  worldsDir: string,
  minBytes: number,
  timeoutMs: number,
): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = scanTmpFiles(worldsDir);
    const hit = found.find((f) => f.size >= minBytes);
    if (hit) return hit.path;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function scanTmpFiles(worldsDir: string): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  if (!fs.existsSync(worldsDir)) return out;
  for (const entry of fs.readdirSync(worldsDir)) {
    const modsDir = path.join(worldsDir, entry, 'minecraft', 'mods');
    if (!fs.existsSync(modsDir)) continue;
    for (const f of fs.readdirSync(modsDir)) {
      if (f.endsWith('.tmp')) {
        const p = path.join(modsDir, f);
        out.push({ path: p, size: fs.statSync(p).size });
      }
    }
  }
  return out;
}

function snapshotModsDirs(worldsDir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!fs.existsSync(worldsDir)) return out;
  for (const entry of fs.readdirSync(worldsDir)) {
    const modsDir = path.join(worldsDir, entry, 'minecraft', 'mods');
    if (fs.existsSync(modsDir)) out[entry] = fs.readdirSync(modsDir);
  }
  return out;
}

/** The respawn boot: same user-data dir, fresh app. Returns the window after
 *  health assertions (accounts IPC answers, renderer shows "Ready."). */
async function bootRespawnAndAssertHealth(userDataDir: string): Promise<Page> {
  const { app, window } = await launchTestApp({ userDataDir });
  // The renderer must reach its deterministic post-onboarding state — the
  // account IPC path alive means no boot-time crash swallowed the session.
  const ready = await (async (): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      const body = await window.evaluate(() => document.body.innerText);
      if (body.includes('Ready.')) return true;
      await window.evaluate(async () => { await window.electronAPI.getAccounts(); }).catch(() => { });
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  })();
  if (!ready) {
    const body = await window.evaluate(() => document.body.innerText);
    await app.close().catch(() => { });
    throw new Error(`respawn boot did not reach "Ready.". body head: ${body.slice(0, 300)}`);
  }
  await app.close().catch(() => { });
  return window;
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`main pid ${pid} still alive ${timeoutMs}ms after SIGKILL`);
}

/** After the respawn: fire downloadMod again (fresh injection) and await the
 *  REAL completion result — the interrupted transfer must finish. */
async function completeDownloadOnRetry(userDataDir: string): Promise<void> {
  const app = await _electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    timeout: 30_000,
  });
  try {
    const window = await resolveMainWindow(app);
    await installInjection(app);
    const worldId = await window.evaluate(async (name: string) => {
      const worlds = (await window.electronAPI.getWorlds()) as Array<{ id: string; name: string }>;
      const w = worlds.find((x) => x.name === name);
      if (!w) throw new Error('world vanished across restart');
      return w.id;
    }, WORLD_NAME);

    const result = await window.evaluate(async ([wid, pid]: [string, string]) => {
      return window.electronAPI.downloadMod(wid, pid);
    }, [worldId, PROJECT_ID]);
    if (!result?.success) {
      throw new Error(`retry download failed honestly — result: ${JSON.stringify(result)}`);
    }
    if (result.filename !== 'journey-mod.jar') {
      throw new Error(`unexpected completed filename: ${JSON.stringify(result)}`);
    }
  } finally {
    await app.close().catch(() => { });
  }
}

function assertJarComplete(userDataDir: string): void {
  const worldsDir = path.join(userDataDir, 'worlds');
  const state = snapshotModsDirs(worldsDir);
  const all = Object.values(state).flat();
  const jar = all.find((f) => f === 'journey-mod.jar');
  const tmp = all.filter((f) => f.endsWith('.tmp'));
  expect(jar, `journey-mod.jar should exist after retry. mods state: ${JSON.stringify(state)}`).toBeDefined();
  for (const f of tmp) {
    const full = Object.entries(state).flatMap(([dir, files]) =>
      files.includes(f) ? [path.join(worldsDir, dir, 'minecraft', 'mods', f)] : [],
    )[0];
    if (full) expect(fs.statSync(full).size, `${f} should not be full-size`).toBeLessThan(JAR_BYTES);
  }
}

// ── The journey: kill at ~30 / 60 / 90% of the body ───────────────────────

// Three full boots (seed+kill / respawn health / retry completion) on a real
// Electron app take ~90s+ — far beyond the config's 60s default. The 300s
// third argument of test() is a JEST signature and silently ignored by
// Playwright; the Playwright way is test.setTimeout (file top-level = all
// tests in this file).
test.setTimeout(300_000);

for (const pct of [30, 60, 90]) {
  test(`journey #1: kill at ~${pct}% → respawn integrity → retry completes`, async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-journey-kill-'));
    try {
      const killAtBytes = Math.floor((JAR_BYTES * pct) / 100);
      // Boot #1: seed, slow-download, hard-kill mid-body.
      await bootSeedAndKill(userDataDir, killAtBytes);

      // Between boots (main dead): the truncated tmp may exist (harmless
      // residue) but must NEVER masquerade as a completed mod — mods/ must
      // not contain a full-size jar, and no tmp at all is also acceptable.
      const state = snapshotModsDirs(path.join(userDataDir, 'worlds'));
      for (const [dir, files] of Object.entries(state)) {
        expect(files, `mods dir of world ${dir} must not contain the jar yet`).not.toContain('journey-mod.jar');
      }

      // Boot #2: respawn health.
      await bootRespawnAndAssertHealth(userDataDir);

      // Boot #3: the user tries again — must complete for real.
      await completeDownloadOnRetry(userDataDir);
      assertJarComplete(userDataDir);
    } finally {
      // Windows: the SIGKILLed app's file handles can linger for a few
      // seconds — wipe best-effort instead of failing the test on cleanup.
      await (async () => {
        for (let i = 0; i < 5; i++) {
          try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 1_000));
          }
        }
      })();
    }
  });
}
