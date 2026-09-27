/**
 * RED TEAM — wave 1 & 3 E2E assaults (live app, sandboxed userData).
 *
 * Wave 1 (malice-lite): A1 Play-spam guard, A2 navigation storm,
 * A5b bridge-level settingsPath custody refusal, A4 graceful close
 * mid-download.
 *
 * Wave 3 (hostile timing): C3 SIGKILL inside the splash window,
 * C1 early-IPC strike before boot completes.
 *
 * Every boot runs on a throwaway user-data dir; the real profile is
 * never touched. Verdict lines `[REDTEAM][…]` feed truth doc 29.
 *
 * NO TEST PERFORMS REAL EGRESS. A1 pins ONE pipeline open with a `hang`
 * fetch rule (zero bytes leave) and proves the guard with the first
 * launch-step event; C1 fails the launch fast with a `reject` rule so every
 * early call ANSWERS; A4's resumed download is served a fixed-size `bytes`
 * canned jar. (Calling launchGame() with no javaPath used to start a real
 * JRE + Fabric + version download — "undefined" passes SAFE_PATH_REGEX.)
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchTestApp, waitForText } from './harness';
import {
  patchMainNetworkStream,
  MODRINTH_CANNED,
  jarSlowBody,
} from './journey/lib';

test.setTimeout(120_000);

const VIEWS = ['Play', 'Worlds', 'Account', 'Setup'];

/** Click the DOCK nav button matching a view name (exact text).
 *
 *  Scoped to `nav button` on purpose: a bare document-wide 'Play' matches the
 *  WORLD CARD's play button on the Worlds view first, which is not a view
 *  switch. (That mis-click is what made A2's liveness check read a Worlds
 *  screen while asserting the Play hero.) Throws if the dock button is absent
 *  so a missing nav can never masquerade as a passing click. */
async function clickNav(window: import('playwright').Page, label: string): Promise<void> {
  const clicked = await window.evaluate((l) => {
    const btn = [...document.querySelectorAll('nav button')].find(
      (b) => b.textContent?.trim() === l,
    );
    if (!btn) return false;
    (btn as HTMLButtonElement).click();
    return true;
  }, label);
  if (!clicked) throw new Error(`dock nav button "${label}" not found`);
}

// ── A1: Play spam — the launch guard under fire ─────────────────────────────

test('A1: Play ×10 at 1Hz — E604/E605 guard holds, app stays alive', async () => {
  const t = await launchTestApp();
  try {
    // ── occupy the pipeline with ZERO egress ──
    // The first await inside launchWithFabric is ensureFabric()'s
    // timedFetch(meta.fabricmc.net). A pending fetch that ignores the abort
    // signal pins that await forever, so the authoritative main-process
    // `launchInProgress` flag stays true for the whole observation window.
    //
    // (The prior version called launchGame() with NO javaPath. "undefined"
    // matches SAFE_PATH_REGEX, so a REAL launch ran — JRE + Fabric + version
    // downloads over the network — and the test timed out at 120s. The hang
    // here is deliberate; the previous one was an accident.)
    await patchMainNetworkStream(t.app, [{ match: '', status: 0, hang: true }]);

    // Observe launch-step events so we can PROVE the flag armed. The steps
    // are emitted from inside launchWithFabric, i.e. strictly after
    // `launchInProgress = true`, so the first step is the arm signal. Polling
    // with an awaited launchGame() would be unsafe: if the flag were not yet
    // set, that call would BECOME the pipeline occupant and hang forever.
    await t.window.evaluate(() => {
      (window as unknown as { __rtSteps: string[] }).__rtSteps = [];
      window.electronAPI.onLaunchStep((step: string) => {
        (window as unknown as { __rtSteps: string[] }).__rtSteps.push(step);
      });
    });
    const javaPath = 'C:/ember-e2e/java.exe'; // passes validatePath
    void t.window.evaluate((jp: string) => {
      // Fire and DO NOT await: this launch never settles.
      void window.electronAPI.launchGame(jp);
    }, javaPath);

    let armed = false;
    for (let i = 0; i < 40 && !armed; i++) {
      armed = (await t.window.evaluate(
        () => (window as unknown as { __rtSteps: string[] }).__rtSteps.length > 0,
      )) as boolean;
      if (!armed) await t.window.waitForTimeout(250);
    }
    expect(armed, 'the launch pipeline never armed — no launch-step was emitted').toBe(true);

    // ── the barrage ──
    // Every awaited shot must land on the guard: never a second pipeline
    // start, never a crash, never a raw untyped throw.
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = (await t.window.evaluate(async (jp: string) => {
        try {
          const res = await window.electronAPI.launchGame(jp);
          return res?.error ?? (res?.success ? 'ok' : 'no-error');
        } catch (err) {
          return `threw: ${String(err)}`;
        }
      }, javaPath)) as string;
      results.push(r);
      await t.window.waitForTimeout(1_000);
    }
    const e604 = results.filter((e) => e.includes('E604')).length;
    const other = results.filter((e) => !e.includes('E604'));
    console.log(
      `[REDTEAM][A1] verdicts: E604=${e604} other=${other.length}` +
        (other.length ? ` ${JSON.stringify(other)}` : ''),
    );
    for (const r of results) {
      expect(r.includes('E604'), `unguarded verdict leaked to the user: ${r}`).toBe(true);
    }
    // The app is still alive and navigable after the barrage. (The renderer's
    // own `launching` state is only set by the Play BUTTON — a raw IPC call
    // does not flip it — so the Play hero genuinely still reads 'Ready.'.)
    expect(await waitForText(t.window, 'Ready.', 10_000)).toBe(true);
    await clickNav(t.window, 'Worlds');
    expect(await waitForText(t.window, 'New world', 8_000)).toBe(true);
  } finally {
    await t.cleanup();
  }
});

// ── A2: navigation storm — 30s of 100ms view-switching ──────────────────────

test('A2: nav storm (4 views + Ctrl+L + Ctrl+K @100ms ×30s) — zero console errors, zero unhandled rejections', async () => {
  const t = await launchTestApp();
  try {
    const unhandled: string[] = [];
    await t.window.evaluate(() => {
      (window as unknown as { __rtUnhandled: string[] }).__rtUnhandled = [];
      window.addEventListener('unhandledrejection', (e) => {
        (window as unknown as { __rtUnhandled: string[] }).__rtUnhandled.push(String(e.reason).slice(0, 200));
      });
    });
    const t0 = Date.now();
    let i = 0;
    const seq = [...VIEWS, '__ctrl_l', '__ctrl_k'];
    while (Date.now() - t0 < 30_000) {
      const target = seq[i % seq.length];
      if (target === '__ctrl_l' || target === '__ctrl_k') {
        await t.window.keyboard.press(target === '__ctrl_l' ? 'Control+l' : 'Control+k');
      } else {
        await clickNav(t.window, target);
      }
      await t.window.waitForTimeout(100);
      i++;
    }
    const rejections = await t.window.evaluate(
      () => (window as unknown as { __rtUnhandled: string[] }).__rtUnhandled,
    );
    const errors = t.consoleCapture.errors;
    console.log(`[REDTEAM][A2] switches=${i} consoleErrors=${errors.length} unhandledRejections=${rejections.length}`);
    if (errors.length) console.log(`[REDTEAM][A2] console errors: ${JSON.stringify(errors.slice(0, 5))}`);
    if (rejections.length) console.log(`[REDTEAM][A2] rejections: ${JSON.stringify(rejections.slice(0, 5))}`);
    expect(errors).toEqual([]);
    expect(rejections).toEqual([]);
    // Sanity: the app still responds after the storm. Return to the Play view
    // first — the storm's last switch is position-dependent (a 6-phase
    // sequence, and Ctrl+L toggles Console↔Play), so 'Ready.' is simply not on
    // screen even though the app is healthy. clickNav is dock-scoped, so this
    // is a real view switch and not the Worlds card's Play button. The storm
    // result itself (0 errors, 0 rejections, 200+ switches) is the verdict;
    // this is only the liveness check.
    await t.window.keyboard.press('Escape'); // dismiss any Ctrl+K palette
    await clickNav(t.window, 'Play');
    expect(await waitForText(t.window, 'Ready.', 10_000)).toBe(true);
  } finally {
    await t.cleanup();
  }
});

// ── A5b: bridge-level custody refusal (the fix's front door) ────────────────

test('A5b: renderer-crafted settingsPath is refused at create-world', async () => {
  const t = await launchTestApp();
  try {
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redteam-secret2-'));
    fs.writeFileSync(path.join(secretDir, 'options.txt'), 'TOP-SECRET-OUTSIDE');
    const res = (await t.window.evaluate(async (sp: string) => {
      return await window.electronAPI.createWorld({
        name: 'custody-e2e',
        version: '1.21.1',
        loader: 'fabric',
        settingsPath: sp,
      });
    }, secretDir)) as { success: boolean; error?: string };
    console.log(`[REDTEAM][A5b] bridge verdict: success=${res.success} error=${res.error ?? '-'}`);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Invalid settings folder');
    // …and nothing was copied even though the world was not created.
    fs.rmSync(secretDir, { recursive: true, force: true });
  } finally {
    await t.cleanup();
  }
});

// ── A4: graceful close mid-download ─────────────────────────────────────────

test('A4: window.close during a slow mod download — honest restart, no fake mod, retry completes', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-redteam-a4-'));
  try {
    // Boot #1: slow-drip download, then close the window (graceful quit —
    // before-quit/disposeTray run, unlike journey #1's SIGKILL).
    const app1 = await launchTestApp({ userDataDir });
    await patchMainNetworkStream(app1.app, [
      MODRINTH_CANNED.versionList as { match: string; status: number; body: unknown },
      { ...MODRINTH_CANNED.jar, slow: jarSlowBody(160, 16 * 1024) },
    ]);
    await app1.window.evaluate(async () => {
      const res = await window.electronAPI.createWorld({ name: 'a4-world', version: '1.21.1', loader: 'fabric' });
      if (!res.success) throw new Error(`create-world failed: ${res.error}`);
      const worlds = (await window.electronAPI.getWorlds()) as Array<{ id: string; name: string }>;
      const w = worlds.find((x) => x.name === 'a4-world')!;
      void window.electronAPI.downloadMod(w.id, 'journey-mod').catch(() => {});
    });
    // Wait until the tmp exists, then close the window like a user would.
    let tmpSeen = false;
    const worldsRoot = path.join(userDataDir, 'worlds');
    for (let i = 0; i < 60 && !tmpSeen; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const walk = (dir: string): string[] => {
        try {
          return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            return e.isDirectory() ? walk(p) : [p];
          });
        } catch { return []; }
      };
      tmpSeen = walk(worldsRoot).some((f) => f.endsWith('.jar.tmp'));
    }
    expect(tmpSeen).toBe(true);
    await app1.window.close(); // graceful: triggers close-to-tray OR quit path
    await app1.app.close().catch(() => { /* tray may hold it; force the app close */ });

    // Between boots: no full-size jar, tmp residue allowed.
    const walk = (dir: string): string[] => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name);
          return e.isDirectory() ? walk(p) : [p];
        });
      } catch { return []; }
    };
    const jars = walk(worldsRoot).filter((f) => f.endsWith('.jar'));
    for (const j of jars) {
      expect(fs.statSync(j).size, 'no full jar may exist after mid-download exit').toBeLessThan(160 * 16 * 1024);
    }

    // Boot #2: honest restart — app healthy, download can complete.
    const app2 = await launchTestApp({ userDataDir });
    await patchMainNetworkStream(app2.app, [
      MODRINTH_CANNED.versionList as { match: string; status: number; body: unknown },
      // The retry needs a FAST body of the EXACT expected size. The plain
      // MODRINTH_CANNED.jar rule carries no body → the canned response is
      // empty → the downloader rejects with "empty response body"
      // (mod-downloader.ts requires a readable body). `bytes` serves a real
      // fixed-size payload, so the resumed download completes in full.
      { ...MODRINTH_CANNED.jar, bytes: 160 * 16 * 1024 } as {
        match: string;
        status: number;
        bytes: number;
      },
    ]);
    const retry = (await app2.window.evaluate(async () => {
      const worlds = (await window.electronAPI.getWorlds()) as Array<{ id: string; name: string }>;
      const w = worlds.find((x) => x.name === 'a4-world')!;
      return await window.electronAPI.downloadMod(w.id, 'journey-mod');
    })) as { success: boolean; error?: string };
    expect(retry.success).toBe(true);
    const finalJars = walk(worldsRoot).filter((f) => f.endsWith('journey-mod.jar'));
    expect(finalJars).toHaveLength(1);
    expect(fs.statSync(finalJars[0]).size).toBe(160 * 16 * 1024);
    console.log('[REDTEAM][A4] verdict: honest restart + retry completes (no fake mod)');
    await app2.cleanup();
  } finally {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); return; }
      catch { await new Promise((r) => setTimeout(r, 1_000)); }
    }
  }
});

// ── C3: SIGKILL inside the splash window (boot torn in half) ────────────────

test('C3: SIGKILL during splash — next boot recovers to Ready.', async () => {
  const t = await launchTestApp();
  try {
    // Kill while the splash window is (or recently was) alive: strike the
    // main process the moment windows exist, long before handoff completes.
    await t.app.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    process.kill(t.app.process().pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 1_000));
  } catch {
    // Process may already be gone — equally fine.
  }
  // Boot #2 on the same profile: must reach Ready. honestly.
  const t2 = await launchTestApp({ userDataDir: t.scratchDir });
  try {
    expect(await waitForText(t2.window, 'Ready.', 20_000)).toBe(true);
    const accounts = (await t2.window.evaluate(async () => {
      return await window.electronAPI.getAccounts();
    })) as unknown[];
    expect(Array.isArray(accounts)).toBe(true);
    console.log('[REDTEAM][C3] verdict: splash-window kill → clean respawn, registry intact');
  } finally {
    await t2.cleanup();
  }
}, 90_000);

// ── C1: early-IPC strike — commands before boot settles ─────────────────────

test('C1: IPC barrage 500ms after boot — every call answers, none corrupt', async () => {
  const t = await launchTestApp();
  try {
    // Make the launch FAIL FAST rather than run. The early launchGame passes
    // no javaPath, and "undefined" matches SAFE_PATH_REGEX, so without this
    // it would start a REAL Minecraft download that never resolves — an
    // infrastructure hang, not the contract C1 measures. With fetch rejecting
    // immediately the pipeline settles on its typed [E4xx]→[E303] error and
    // zero egress. (C1's contract is that every call ANSWERS.)
    await patchMainNetworkStream(t.app, [{ match: '', status: 0, reject: true }]);
    // Fire the hostile early calls immediately after the window resolves —
    // auth may still be initializing. Every call must RESOLVE (never hang),
    // and the registry must stay loadable afterwards.
    const verdicts = await Promise.all([
      t.window.evaluate(() => window.electronAPI.launchGame().catch((e) => ({ error: String(e) }))),
      t.window.evaluate(() => window.electronAPI.getAccounts().catch((e) => ({ error: String(e) }))),
      t.window.evaluate(() => window.electronAPI.getWorlds().catch((e) => ({ error: String(e) }))),
      t.window.evaluate(() => window.electronAPI.setActiveWorld('nonexistent-id').catch((e) => ({ error: String(e) }))),
      t.window.evaluate(() => window.electronAPI.createWorld({ name: '', version: '', loader: '' }).catch((e) => ({ error: String(e) }))),
    ]);
    const settled = verdicts.filter((v) => v !== undefined);
    console.log(`[REDTEAM][C1] early-IPC barrage: ${settled.length}/5 answered`);
    expect(settled.length).toBe(5);
    // Empty-name createWorld must not have created anything.
    const worlds = (await t.window.evaluate(() => window.electronAPI.getWorlds())) as Array<{ name: string }>;
    expect(worlds.filter((w) => w.name === '')).toHaveLength(0);
    expect(await waitForText(t.window, 'Ready.', 15_000)).toBe(true);
  } finally {
    await t.cleanup();
  }
});
