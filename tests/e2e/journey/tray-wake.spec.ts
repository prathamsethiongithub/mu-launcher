/**
 * Journey hunt #3 (E2E layer) — the tray path on a real app.
 *
 * Unit layer (tray-timers.test.ts) pins the timer lifecycle against an
 * 8-hour fake suspend. Here we assert the real-app survival contract: the
 * window hides to tray, the monitor's first tick runs against a black-holed
 * server socket (worst case), and the app stays healthy — the monitor
 * neither crashes nor wedges the process, and the window can come back.
 *
 * The server socket is redirected to a closed local port via Node's
 * environment-free injection (patch net.connect in the main process) so the
 * ping settles as offline FAST and deterministically — no egress, no 6s cap
 * needed.
 */

import { test, expect } from 'playwright/test';
import { launchTestApp, waitForText, type TestApp } from '../harness';

test('journey #3 e2e: close-to-tray + monitor tick against a dead server → app healthy, window returns', async () => {
  let ta: TestApp | null = null;
  ta = await launchTestApp({
    onLaunched: async (app) => {
      // Black-hole the SMP ping: net.connect to the real host is redirected
      // to a port with no listener → ECONNREFUSED → offline in milliseconds.
      // evaluate() runs in the main process's GLOBAL scope where `require`
      // does not exist — reach CJS through the real entry module instead.
      await app.evaluate(() => {
        const entryMod = process.mainModule as unknown as
          { require?: (id: string) => unknown } | undefined;
        if (!entryMod?.require) throw new Error('[e2e] process.mainModule.require unavailable');
        const net = entryMod.require('net') as typeof import('net');
        const origConnect = net.Socket.prototype.connect;
        (net.Socket.prototype as unknown as { __origConnect: typeof origConnect }).__origConnect = origConnect;
        net.Socket.prototype.connect = function (this: import('net').Socket, ...args: unknown[]) {
          // Rewrite whatever host/port pair to a guaranteed-dead local one.
          const rest = args.filter((a) => typeof a !== 'function') as unknown[];
          const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
          rest.length = 0;
          rest.push(1, '127.0.0.1'); // port 1 on loopback: nothing listens
          const full = [rest[0], rest[1], cb].filter((x) => x !== undefined) as Parameters<typeof origConnect>;
          return origConnect.apply(this, full);
        };
      });
    },
  });

  try {
    const { window } = ta;
    await waitForText(window, 'Ready.', 15_000);

    // Close-to-tray: the window hides; the process stays alive.
    // renderer window.close() is IGNORED by Chromium for non-script-opened
    // windows under sandbox:true (probe v5 evidence) — the real close event
    // must come from the main side, exactly as a user's X-button does.
    await ta.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && /renderer[\\/]index\.html/.test(w.webContents.getURL()),
      );
      if (!main) throw new Error('no main window to close');
      main.close();
    });
    await new Promise((r) => setTimeout(r, 1_500));

    // The monitor ticked at least once against the dead server by now
    // (initTray pings immediately at boot). The process must be ALIVE.
    const alive = await ta.app.evaluate(() => true);
    expect(alive, 'main process alive after tray hide + dead-server ping').toBe(true);

    // Tray click equivalent: bring the window back and prove the UI lives.
    // The window is hidden, not destroyed, so show() must work — driven from
    // the main side (same evaluate pattern as the close above).
    const windows = ta.app.windows();
    const main = windows.find((w) => /renderer[\\/]index\.html/.test(w.url()));
    expect(main, 'main window still exists (hidden, not destroyed)').toBeTruthy();
    await ta.app.evaluate(({ BrowserWindow }) => {
      const bw = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && /renderer[\\/]index\.html/.test(w.webContents.getURL()),
      );
      if (!bw) throw new Error('no main BrowserWindow to show');
      bw.show();
    });
    await waitForText(main!, 'Ready.', 15_000);
    const accounts = await main!.evaluate(async () => window.electronAPI.getAccounts());
    expect(Array.isArray(accounts)).toBe(true);
  } finally {
    await ta?.cleanup();
  }
});
