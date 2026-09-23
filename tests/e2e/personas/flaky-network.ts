/**
 * Persona 4 — flaky-network: the coffee-shop wifi user.
 *
 * Architecture note driving the design: the main process talks network
 * through Node's global fetch (net.ts timedFetch resolves `fetch` at each
 * call site; index.ts's fetch-version-list likewise) — CDP offline does NOT
 * affect it, so the fault is injected by patching globalThis.fetch inside
 * the running main process. Pure test-side instrumentation, zero production
 * changes.
 *
 * Phase 1 (fault): every manifest fetch rejects → the New World dialog must
 *   show human copy ("Couldn't load versions." + Retry), the renderer logs
 *   the network failure, and NO uncaught exception/rejection occurs.
 * Phase 2 (recovery): re-patch fetch to answer piston-meta with a canned
 *   minimal manifest (deterministic — CI needs no real egress) → Retry must
 *   fill the version dropdown. The honest failure copy disappearing is the
 *   proof of recovery.
 */

import type { ElectronApplication } from 'playwright';
import { launchTestApp, clickButtonByText, type TestApp } from '../harness';
import { patchMainFetch } from './lib';

export const id = 'flaky-network';
export const description =
  '网络半死不活的用户：清单请求全挂，稍后恢复。' +
  '预期：人话错误出现（不白屏不崩溃）、控制台记录失败、恢复后 Retry 拉回列表。';

let ta: TestApp;
let sentinelsOn = false;

async function installSentinels(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __e2eFatal?: { uncaught: string[]; rejections: string[] };
    };
    if (g.__e2eFatal) return;
    g.__e2eFatal = { uncaught: [], rejections: [] };
    process.on('uncaughtException', (err) => {
      g.__e2eFatal!.uncaught.push(String(err?.stack ?? err).slice(0, 400));
    });
    process.on('unhandledRejection', (reason) => {
      g.__e2eFatal!.rejections.push(String(reason).slice(0, 400));
    });
  });
  sentinelsOn = true;
}

const checkFatal = async (when: string): Promise<void> => {
  if (!sentinelsOn || !ta) return;
  const fatal = await ta.app.evaluate(
    () => (globalThis as unknown as { __e2eFatal?: { uncaught: string[]; rejections: string[] } })
      .__e2eFatal,
  );
  if (fatal && (fatal.uncaught.length > 0 || fatal.rejections.length > 0)) {
    throw new Error(
      `main-process fatals ${when}: uncaught=${JSON.stringify(fatal.uncaught)} ` +
        `rejections=${JSON.stringify(fatal.rejections)}`,
    );
  }
};

export async function run(): Promise<void> {
  // ── Phase 1: the fault ──
  ta = await launchTestApp({
    onLaunched: async (app: ElectronApplication) => {
      await patchMainFetch(app, 'fail', { matchUrls: ['mojang.com', 'fabricmc.net', 'quiltmc.org'], delayMs: 120 });
      await installSentinels(app);
    },
  });

  await clickButtonByText(ta.window, 'Worlds');
  await ta.window.waitForTimeout(500);

  // Open the New World dialog (entry verified: WorldsView "New world").
  const opened = await clickButtonByText(ta.window, 'New world');
  if (!opened) throw new Error('New world dialog entry not found in Worlds view');
  await ta.window.waitForTimeout(1_200); // manifest fetch + failure surfacing

  const body1 = await ta.window.evaluate(() => document.body.innerText);
  // Human copy exists — substring match per the iron rule (copy may be tweaked).
  const humanError =
    body1.includes("Couldn't load versions.") &&
    body1.includes('Retry');
  if (!humanError) {
    throw new Error(
      `flaky network did not surface human copy. body head: ${body1.slice(0, 250)}`,
    );
  }
  // Not a white screen, not a crash: the dialog still has its other controls.
  const dialogAlive = body1.includes('Loader') || body1.toLowerCase().includes('memory');
  if (!dialogAlive) throw new Error('dialog collapsed entirely on network failure');

  // Renderer logged the failure line (NewWorldDialog console.errors on the
  // failed manifest — captured by the harness console listener).
  const capture = (ta as unknown as { consoleCapture: { errors: string[] } }).consoleCapture;
  const logged = capture.errors.some((e) => /mojang|fetch|network|failed/i.test(e));
  if (!logged) {
    throw new Error(`renderer console has no network-failure line. errors: ${JSON.stringify(capture.errors.slice(0, 5))}`);
  }

  await checkFatal('during network failure');

  // ── Phase 2: the recovery ──
  // Re-patch: canned minimal Mojang manifest (release-only entry). CI-safe.
  await patchMainFetch(ta.app, 'respond', {
    respond: [
      {
        match: 'piston-meta.mojang.com',
        status: 200,
        body: {
          latest: { release: '1.21.1', snapshot: '1.21.2' },
          versions: [{ id: '1.21.1', type: 'release' }, { id: '1.21.2', type: 'snapshot' }],
        },
      },
    ],
  });

  // Click the MC Retry (the first one after the Version label).
  const retried = await ta.window.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Retry',
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!retried) throw new Error('Retry button not found after re-patching network');

  // The dropdown fills (first option becomes the canned release) → the error
  // line disappears.
  let recovered = false;
  for (let i = 0; i < 20; i++) {
    await ta.window.waitForTimeout(400);
    const body2 = await ta.window.evaluate(() => document.body.innerText);
    if (!body2.includes("Couldn't load versions.")) { recovered = true; break; }
  }
  const optionValue = recovered
    ? await ta.window.evaluate(() => {
        const sel = [...document.querySelectorAll('select')].find((s) =>
          [...s.options].some((o) => o.value === '1.21.1'),
        );
        return sel ? sel.options[sel.selectedIndex]?.value ?? null : null;
      })
    : null;
  if (!recovered || optionValue !== '1.21.1') {
    throw new Error(`recovery failed: errorCopyGone=${recovered} selected=${optionValue}`);
  }

  await checkFatal('after recovery');
}

export async function teardown(): Promise<void> {
  if (ta) await ta.cleanup();
}
