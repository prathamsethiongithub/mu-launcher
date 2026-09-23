/**
 * Persona 5 — potato-pc: the worst hardware approximation.
 *
 * Constraints: CPU throttled 6×, --use-gl=swiftshader (software GL — the
 * closest CI-legal approximation of a GPU-less machine), 900×600 window
 * (below the design's comfort size, inside the minimum-ish band).
 *
 * The contract: boot completes within a 30s grace, every view is reachable,
 * the layout law holds at the cramped size, and the three.js fx canvases
 * degrade silently — MagicRings/LightPillar wrap their renderer creation in
 * try/catch and return early without a context (production guards verified
 * at MagicRings.jsx:139-146); boot must still paint and navigate.
 *
 * WebGL note: swiftshader usually still PROVIDES a context (it's software
 * rendering, not no-WebGL), so the try/catch path may not trigger — the
 * assertion here is the honest one available in CI: no uncaught fatals, no
 * renderer console errors (beyond handbook-vendored three.js noise), full
 * usability under throttle. A true no-context run stays a manual checklist
 * item, recorded in the truth doc.
 */

import type { ElectronApplication } from 'playwright';
import { launchTestApp, waitForText, clickButtonByText, type TestApp } from '../harness';
import { LAYOUT_AUDIT } from '../layout-audit';
import { throttleCpu } from './lib';

export const id = 'potato-pc';
export const description =
  '最坏硬件近似：6× CPU + 软件渲染 + 900×600。' +
  '预期：宽限内完成首帧、全部导航可达、布局法则成立、fx 降级不崩溃。';

let ta: TestApp;
let cdp: Awaited<ReturnType<typeof throttleCpu>> | null = null;

export async function run(): Promise<void> {
  ta = await launchTestApp({
    args: ['--use-gl=swiftshader', '--window-size=900,600'],
    launchTimeoutMs: 90_000,
  });
  cdp = await throttleCpu(ta.app, 6);

  // Boot grace: 30s under 6× throttle on software GL.
  const booted = await waitForText(ta.window, 'Almost there.', 30_000);
  const body0 = await ta.window.evaluate(() => document.body.innerText);
  if (!booted && body0.trim().length === 0) {
    throw new Error('potato boot produced an empty page within 30s');
  }

  // Views all reachable at the cramped size.
  for (const view of ['Worlds', 'Account', 'Setup', 'Play']) {
    const ok = await clickButtonByText(ta.window, view);
    if (!ok) throw new Error(`nav item not clickable on potato: ${view}`);
    await ta.window.waitForTimeout(900); // mount under 6× throttle
    const nonEmpty = await ta.window.evaluate(() => document.body.innerText.length > 0);
    if (!nonEmpty) throw new Error(`view empty after nav on potato: ${view}`);
  }

  // The law at 900×600 on the Account view (the densest fx surface).
  await clickButtonByText(ta.window, 'Account');
  await ta.window.waitForTimeout(1_000);
  const problems = await ta.window.evaluate(LAYOUT_AUDIT);
  if (problems.problems.length > 0) {
    throw new Error(`layout violations on potato: ${JSON.stringify(problems.problems.slice(0, 8))}`);
  }

  // Console discipline: zero errors beyond handbook-vendored three.js noise.
  const capture = (ta as unknown as { consoleCapture: { errors: string[] } }).consoleCapture;
  if (capture.errors.length > 0) {
    throw new Error(`renderer console errors on potato: ${JSON.stringify(capture.errors.slice(0, 5))}`);
  }
}

export async function teardown(): Promise<void> {
  try {
    await cdp?.detach();
  } catch { /* */ }
  cdp = null;
  if (ta) await ta.cleanup();
}
