/**
 * Tray Manager — "The Temporal Ping".
 *
 * Close-to-tray + background server monitor for the main window:
 *   1. Closing the launcher window hides it to the system tray instead of
 *      quitting the app.
 *   2. Every 60s the module pings the MU SMP server; when the player count
 *      rises (someone joined) while the window is hidden, a native Windows
 *      notification is raised.
 *
 * THE QUIT ESCAPE HATCH: Electron fires 'close' on every window during
 * app.quit() too — an unconditional preventDefault() would make the app
 * unquittable. The isQuitting flag is set by disposeTray() (wired to
 * 'before-quit' in index.ts) so the interceptor stands down during real
 * teardown.
 */

import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron';
import { pingMinecraftServer, type ServerStatus } from './server-pinger';
import { SMP_SERVER_HOST, SMP_SERVER_PORT } from '../shared/constants';

const MONITORED_HOST = SMP_SERVER_HOST;
const MONITORED_PORT = SMP_SERVER_PORT;
const PING_INTERVAL_MS = 60_000;

let tray: Tray | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let mainWindowRef: BrowserWindow | null = null;
// null = no baseline yet (first successful ping, or the server just came
// back online) — a baseline ping never notifies, it only observes.
let lastPlayerCount: number | null = null;
let isQuitting = false;

/**
 * Bring the launcher window back to the foreground from the tray.
 * A destroyed window is a no-op; a minimized one is restored first.
 */
function showMainWindow(): void {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * One tick of the monitor. pings the SMP server and diffs the player count
 * against the previous tick. Notifications fire ONLY while the launcher
 * window is hidden — the user playing with the launcher open must never be
 * interrupted by a toast about the thing they are looking at.
 */
async function checkServer(): Promise<void> {
  try {
    const status: ServerStatus = await pingMinecraftServer(MONITORED_HOST, MONITORED_PORT);
    const current = status.players?.online;

    // Server unreachable (or responded without a player count): reset the
    // baseline so the next online ping re-observes instead of comparing
    // against a stale count from before a restart — that would fire a
    // false "someone joined" for every player already on.
    if (!status.online || typeof current !== 'number') {
      lastPlayerCount = null;
      return;
    }

    if (lastPlayerCount === null) {
      // First observation after init or downtime: baseline only, no notify.
      lastPlayerCount = current;
      return;
    }

    if (
      current > lastPlayerCount &&
      mainWindowRef &&
      !mainWindowRef.isDestroyed() &&
      !mainWindowRef.isVisible()
    ) {
      if (Notification.isSupported()) {
        new Notification({
          title: "Ember",
          body: 'Someone just joined the server!',
        }).show();
      }
    }

    lastPlayerCount = current;
  } catch (err) {
    // pingMinecraftServer never throws by contract; this is belt-and-braces
    // so no future refactor of the pinger can crash the monitor loop.
    console.error('[tray] Server check failed:', err);
  }
}

/**
 * Initialize the Temporal Ping: close-to-tray behaviour, the tray icon and
 * menu, and the 60s background server monitor. Idempotent — calling it
 * twice does not create a second tray or a second interval.
 */
export function initTray(mainWindow: BrowserWindow): void {
  if (tray) return; // already initialized

  mainWindowRef = mainWindow;

  // Close-to-tray: swallow the close event while the app is alive. The
  // isQuitting flag (set by disposeTray on 'before-quit') is the escape
  // hatch that lets app.quit() tear the window down for real.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Placeholder icon: an empty image renders as a blank slot in the tray.
  // Swap for nativeImage.createFromPath(join(__dirname, '../../build/icon.ico'))
  // once path resolution across dev/packaged runs is settled.
  const icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("Ember Launcher");

  const menu = Menu.buildFromTemplate([
    { label: 'Show Launcher', click: () => showMainWindow() },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);

  // Clicking the tray icon itself also shows the window. (Windows behaviour;
  // macOS opens the context menu on click instead — fine either way.)
  tray.on('click', () => showMainWindow());

  // Baseline immediately, then every 60s — a join made 5s after the window
  // is hidden shouldn't wait out the first interval.
  void checkServer();
  pingTimer = setInterval(() => void checkServer(), PING_INTERVAL_MS);
}

/**
 * Tear down everything Temporal Ping owns. Wired to 'before-quit' in
 * index.ts; ALSO arms the isQuitting escape hatch so the close interceptor
 * stands down and app.quit() can complete.
 */
export function disposeTray(): void {
  isQuitting = true;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (tray) {
    try {
      tray.destroy();
    } catch {
      // A tray destroyed twice (or during teardown) is harmless.
    }
    tray = null;
  }
}
