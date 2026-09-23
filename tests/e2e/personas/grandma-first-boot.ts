/**
 * Persona 1 — grandma-first-boot: the empty profile.
 *
 * Simulates the first contact every new user makes: a THROWAWAY, pristine
 * user-data dir (the harness default), CPU throttled 4× (weak first-purchase
 * laptop), long first-boot compile. The contract: nothing crashes, the
 * pre-onboarding copy is honest ("Almost there."), every view is reachable,
 * the console opens, and the main process records zero uncaught
 * exceptions/rejections during the whole walk.
 *
 * Sentinel note: the uncaughtException/unhandledRejection hook is installed
 * from the test side (patchMainFetch's evaluate channel — a bare evaluate)
 * AFTER the main process finished booting. Errors thrown during startup are
 * out of its reach; errors during the interaction walk are exactly what this
 * persona cares about. Pure test-side instrumentation.
 */

import type { ElectronApplication } from 'playwright';
import { launchTestApp, waitForText, clickButtonByText, type TestApp } from '../harness';
import { throttleCpu } from './lib';

export const id = 'grandma-first-boot';
export const description =
  '第一次接触启动器的用户：全新档案 + 4× 弱 CPU。预期痛点：引导是否诚实、' +
  '每个视图是否可达、启动过程是否零崩溃。';

let ta: TestApp;
let cdp: Awaited<ReturnType<typeof throttleCpu>> | null = null;

async function installSentinels(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __e2eFatal?: { uncaught: string[]; rejections: string[] };
    };
    g.__e2eFatal = { uncaught: [], rejections: [] };
    process.on('uncaughtException', (err) => {
      g.__e2eFatal!.uncaught.push(String(err?.stack ?? err).slice(0, 400));
    });
    process.on('unhandledRejection', (reason) => {
      g.__e2eFatal!.rejections.push(String(reason).slice(0, 400));
    });
  });
}

export async function run(): Promise<void> {
  // seed:() => {} OVERRIDES the harness's default offline-account seeding —
  // without it the "empty profile" secretly has an account and boots to
  // "Ready." instead of the honest pre-onboarding copy. (Harness history:
  // the default seed exists for the older boot-gated smoke tests.)
  ta = await launchTestApp({ seed: () => { /* truly empty — the first boot */ }, launchTimeoutMs: 60_000 });
  cdp = await throttleCpu(ta.app, 4);
  await installSentinels(ta.app);

  // Boot honesty: an empty profile says "Almost there." (pre-onboarding),
  // never the "Ready." of a seeded account.
  const boot = await waitForText(ta.window, 'Almost there.', 30_000);
  const bodyAtBoot = await ta.window.evaluate(() => document.body.innerText);
  if (!boot) {
    throw new Error(`empty profile did not show honest pre-onboarding copy. body head: ${bodyAtBoot.slice(0, 200)}`);
  }

  // Every nav item exists and switching views leaves no dead UI.
  for (const view of ['Worlds', 'Account', 'Setup', 'Play']) {
    const ok = await clickButtonByText(ta.window, view);
    if (!ok) throw new Error(`nav item not clickable: ${view}`);
    await ta.window.waitForTimeout(500); // view mount (CPU 4×)
    const visible = await ta.window.evaluate(() => document.body.innerText.length > 0);
    if (!visible) throw new Error(`view rendered empty after nav: ${view}`);
  }

  // The one extra entry: console via Ctrl+L.
  await ta.window.keyboard.press('Control+KeyL');
  const consoleOk = await waitForText(ta.window, 'no session', 8_000);
  const bodyAfterConsole = await ta.window.evaluate(() => document.body.innerText);
  if (!consoleOk && !/console/i.test(bodyAfterConsole)) {
    throw new Error(`console view did not open. body head: ${bodyAfterConsole.slice(0, 150)}`);
  }

  // Zero uncaught exceptions / rejections in the main process during the walk.
  const fatal = await ta.app.evaluate(
    () => (globalThis as unknown as { __e2eFatal?: { uncaught: string[]; rejections: string[] } })
      .__e2eFatal,
  );
  if (fatal && (fatal.uncaught.length > 0 || fatal.rejections.length > 0)) {
    throw new Error(
      `main-process fatals during first-boot walk: ` +
        `uncaught=${JSON.stringify(fatal.uncaught)} rejections=${JSON.stringify(fatal.rejections)}`,
    );
  }
}

export async function teardown(): Promise<void> {
  try {
    await cdp?.detach();
  } catch { /* */ }
  cdp = null;
  if (ta) await ta.cleanup();
}
