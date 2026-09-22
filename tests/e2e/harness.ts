/**
 * E2E harness — boots the compiled Electron app in a THROWAWAY user-data dir
 * so the owner's accounts/worlds are never touched. Mirrors the mu-verify
 * tradition (scratch profile + observation), but driven by Playwright's
 * _electron launcher.
 *
 * Contract: launchTestApp() → { app, window } ; window.evaluate runs in the
 * renderer. Cleanup kills the app and wipes the scratch dir.
 */

import { _electron, type ElectronApplication, type Page } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TestApp {
  app: ElectronApplication;
  window: Page;
  scratchDir: string;
  cleanup: () => Promise<void>;
}

/** Renderer console errors collected from boot onward. */
export interface ConsoleCapture {
  errors: string[];
}

export async function launchTestApp(opts?: {
  /** Seed the throwaway user-data dir (identity.json, skins.json, ...) before
   *  the app launches — lets a test exercise rich, deterministic states. */
  seed?: (scratchDir: string) => void;
}): Promise<TestApp> {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-e2e-'));
  if (opts?.seed) opts.seed(scratchDir);
  const app = await _electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${scratchDir}`],
    timeout: 30_000,
  });
  // The app boots through a splash/intro-video window that CLOSES itself on
  // handoff — firstWindow() can return that dying window. Wait for the real
  // main window: the one whose URL is the renderer's index.html.
  let window: Page | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 35_000) {
    for (const w of app.windows()) {
      if (/renderer[\\/]index\.html/.test(w.url())) { window = w; break; }
    }
    if (window) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!window) {
    try { await app.close(); } catch { /* */ }
    throw new Error('main window (renderer/index.html) never appeared within 35s');
  }
  await window.waitForLoadState('domcontentloaded');

  const consoleCapture: ConsoleCapture = { errors: [] };
  window.on('console', (msg) => {
    if (msg.type() === 'error') {
      // Vendor noise per AGENT-HANDBOOK: three.js/WebGL warnings are known.
      const text = msg.text();
      if (/three\.js|THREE\.|WebGL|shader/i.test(text)) return;
      consoleCapture.errors.push(text.slice(0, 300));
    }
  });

  const cleanup = async () => {
    try { await app.close(); } catch { /* already gone */ }
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { app, window, scratchDir, cleanup, consoleCapture: consoleCapture } as TestApp & {
    consoleCapture: ConsoleCapture;
  };
}

/** Wait until the given text appears anywhere in the page body. */
export async function waitForText(window: Page, text: string, timeoutMs = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const body = await window.evaluate(() => document.body.innerText);
    if (body.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Click the first button whose visible text matches exactly. */
export async function clickButtonByText(window: Page, text: string): Promise<boolean> {
  return window.evaluate((needle) => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === needle,
    );
    if (!btn) return false;
    (btn as HTMLButtonElement).click();
    return true;
  }, text);
}
