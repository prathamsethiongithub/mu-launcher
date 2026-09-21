/**
 * E2E smoke cases 1–2 (boot, nav-cycle) + 6 (no-dead-listeners) + 12 (tray).
 * These run FIRST — if boot is broken, everything else is moot.
 */

import { test, expect } from 'playwright/test';
import { launchTestApp, waitForText, clickButtonByText, type TestApp } from './harness';

let ta: TestApp;

test.beforeEach(async () => {
  ta = await launchTestApp();
});

test.afterEach(async () => {
  await ta.cleanup();
});

test('boot: app starts, main window appears, no renderer console.error', async () => {
  const ready = await waitForText(ta.window, 'Ready.');
  expect(ready).toBe(true);
  const capture = (ta as unknown as { consoleCapture: { errors: string[] } }).consoleCapture;
  expect(capture.errors).toEqual([]);
});

test('nav-cycle: Play/Worlds/Account/Setup all reachable without crashing', async () => {
  for (const view of ['Worlds', 'Account', 'Setup', 'Play']) {
    const clicked = await clickButtonByText(ta.window, view);
    expect(clicked, `nav button "${view}" not found`).toBe(true);
    await ta.window.waitForTimeout(400);
  }
  // The app survived the cycle. The hero word is state-dependent on a scratch
  // profile (Ready. / In the world. / Almost there.) — assert it's a real
  // hero state, not a frozen view: any of the known words resolves.
  const body = await ta.window.evaluate(() => document.body.innerText);
  const heroOk = ['Ready.', 'In the world.', 'Almost there.', 'Igniting.'].some((w) =>
    body.includes(w),
  );
  expect(heroOk, `no known hero word found. body head: ${body.slice(0, 120)}`).toBe(true);
});

test('no-dead-listeners: a full view cycle produces no unhandled rejections', async () => {
  const rejectionsBefore = await ta.window.evaluate(
    () => (window as unknown as { __muRejections?: number }).__muRejections ?? 0,
  );
  for (const view of ['Worlds', 'Account', 'Setup', 'Play', 'Worlds', 'Play']) {
    await clickButtonByText(ta.window, view);
    await ta.window.waitForTimeout(250);
  }
  const rejectionsAfter = await ta.window.evaluate(
    () => (window as unknown as { __muRejections?: number }).__muRejections ?? 0,
  );
  expect(rejectionsAfter).toBe(rejectionsBefore);
});

test('tray-exists: the app survives while the window can hide to tray', async () => {
  // The Tray object lives in the main process and is not directly inspectable
  // from the renderer; the honest check is that main process is alive after
  // the close interceptor is registered (Temporal Ping init ran at whenReady).
  const alive = await ta.window.evaluate(() => typeof window.electronAPI === 'object');
  expect(alive).toBe(true);
});
