import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'path';
import { readFileSync, statSync, rmSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { is } from '@electron-toolkit/utils';
import { AuthService } from './auth-service';
import { JavaProvisioner } from './java-provisioner';
import { LaunchManager, StepChangeCallback } from './launch-service';
import { ServerInjector } from './server-injector';
import { validateExternalUrl, validatePath } from '../security/ipc-validate';
import { runPreflightCheck } from './preflight-check';
import { SkinService } from './skin-service';
import { WorldManager } from './world-manager';
import { listMods, toggleMod, deleteMod, addMod } from './mod-manager';
import { installModpackOverrides } from './modpack-installer';
import { pingMinecraftServer } from './server-pinger';
import { initTray, disposeTray } from './tray-manager';
import { diagnoseLastCrash } from './crash-diagnostic';
import { checkForUpdates, performUpdate } from './update-checker';
import { IdentityService } from './identity-service';
import type { Account, LoaderType } from '../shared/types';

// ── Process-level error shielding ───────────────────────────────────────
// MCLC's request library and the Java child process pipes can trigger
// EPIPE (broken pipe) when a socket closes mid-write — typically when a
// download connection drops or Minecraft's stdout pipe breaks on exit.
// This is a recoverable I/O condition; crashing the launcher is wrong.
process.on('uncaughtException', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    console.warn('[main] Ignored EPIPE (broken pipe) — recoverable I/O error');
    return;
  }
  console.error('[main] Uncaught exception:', error);
});

let mainWindow: BrowserWindow | null = null;
let authService: AuthService | null = null;
let launchManager: LaunchManager | null = null;
let javaProvisioner: JavaProvisioner | null = null;
let worldManager: WorldManager | null = null;
let identityService: IdentityService | null = null;
let launchInProgress = false;
// Skin file chosen via the main-process dialog. Uploads read this — the
// renderer never supplies (or sees) a filesystem path.
let pendingSkinPath: string | null = null;

// ── USER DATA ANCHOR ──────────────────────────────────────────────────
// The package rename to "ember-launcher" would otherwise move userData
// from %APPDATA%/mu-master-launcher to %APPDATA%/ember-launcher —
// orphaning every account, world and skin on first launch. Pin the path
// to the historical directory: zero migration risk, invisible to users.
app.setPath('userData', join(app.getPath('appData'), 'mu-master-launcher'));

function createWindow(): void {
  // ── THE SPLASH ─────────────────────────────────────────────────────────
  // A frameless opaque card shown BEFORE the main window builds: the
  // renderer bundle is 2MB+, and without this the user stares at nothing
  // for seconds on cold start. Load it first so it paints immediately.
  const splash = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    backgroundColor: '#0b0a09', // opaque from the first paint — transparent windows flash white on Windows before the first frame
    center: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false, // a floating card, not a "window"
    webPreferences: {
      // Grant the intro's audio track without any user gesture. The splash
      // is our own inert loading screen — the click-to-unmute chip exists
      // as the fallback for platforms that refuse this anyway.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  splash.loadFile(join(__dirname, '../renderer/splash.html'));

  // ── SPLASH VIDEO HANDOFF ─────────────────────────────────────────────
  // The splash page owns the whole flow (sound-first play() attempt, muted
  // fallback + click-to-unmute chip, ended/error → __splashDone). This
  // injection is just belt and braces: start it if the inline script never
  // ran. Idempotent — a double start is a no-op. A broken or missing video
  // must never trap the user.
  splash.webContents.on('did-finish-load', () => {
    splash.webContents
      .executeJavaScript(`
        if (typeof window.__startIntroFlow === 'function') {
          window.__startIntroFlow();
        } else {
          window.__splashDone = true;
        }
      `)
      .catch(() => {}); // splash already closing — nothing to inject into
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false, // stays invisible until ready-to-show — the splash owns the screen until then
    backgroundColor: '#0b0a09', // dark from the first paint — no white flash while React mounts
    icon: join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Handle external links clicked inside the page
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // DEV ONLY: relay renderer console output into the main process terminal so
  // diagnostic logs ([dialog]/[version-list]) are visible without opening DevTools.
  if (is.dev) {
    mainWindow.webContents.on(
      'console-message',
      // Param types deliberately `unknown`: the EventEmitter's deprecated overloads
      // win overload resolution, so we narrow the (new) details shape at runtime.
      (_event: unknown, details: unknown) => {
        const d = details as { level?: string; message?: string };
        const msg = typeof d?.message === 'string' ? d.message : String(details);
        const tag = d?.level === 'error' ? 'ERROR' : d?.level === 'warning' ? 'WARN' : 'LOG';
        console.log(`[renderer:${tag}] ${msg}`);
      }
    );
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Splash → main handoff, VIDEO-GATED: the intro reveal owns the screen.
  // The main window loads BEHIND it (the 2MB bundle compiles while the
  // video plays) and is shown only when BOTH sides are ready — the video
  // finished AND the app has rendered. Each side has its own skip path, so
  // no state combination can trap the user on the splash.
  let splashDismissed = false;
  let videoDone = false;
  let mainReady = false;
  // Assigned below; cleared at handoff so polling stops once it's done.
  let splashCheck: ReturnType<typeof setInterval> | undefined;

  const handoff = (): void => {
    if (splashDismissed) return;
    splashDismissed = true;
    if (splashCheck !== undefined) clearInterval(splashCheck);
    if (!splash.isDestroyed()) splash.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  };

  // Main side: ready-to-show alone must NOT dismiss — that was the bug
  // where the app window opened over a video that had barely started. It
  // only marks the app side; the video side decides the handoff moment.
  mainWindow.once('ready-to-show', () => {
    mainReady = true;
    if (videoDone) handoff();
  });

  // Hard caps: a wedged dev server, a video that never signals, or the
  // splash closed out from under us (user Alt+F4) — show the app anyway.
  setTimeout(handoff, 8000);
  splash.once('closed', () => {
    videoDone = true;
    handoff();
  });

  // Video side: the reveal plays, __splashDone flips, we hand off (only if
  // the app has finished loading behind the splash — otherwise the video's
  // final frame lingers until ready-to-show arrives). 100ms cadence is
  // imperceptible; .catch swallows the executeJavaScript rejection once
  // the splash window is destroyed.
  splashCheck = setInterval(() => {
    if (splashDismissed) return;
    splash.webContents
      .executeJavaScript('window.__splashDone === true')
      .then((done) => {
        if (done) {
          videoDone = true;
          if (mainReady) handoff();
        }
      })
      .catch(() => {});
  }, 100);

  mainWindow.on('closed', () => {
    mainWindow = null;
    launchManager = null;
  });

  // Initialize JavaProvisioner after window creation
  javaProvisioner = new JavaProvisioner();
}

// Initialize the singleton auth service
function getAuthService(): AuthService {
  if (!authService) {
    authService = new AuthService();
  }
  return authService;
}

/**
 * THE synchronization bridge for Microsoft sign-in. Both entry points —
 * Play ('auth-login') and Account ('add-microsoft-account') — converge here
 * after a successful MSMC flow so that AuthService (the OAuth engine, single
 * live session, auth-session.bin) and IdentityService (the account registry,
 * identity.json + identity-tokens.bin) always describe the SAME reality.
 *
 * Without this, Play sign-in updated only AuthService: the Account tab kept
 * reading an empty registry until restart, because the only import bridge
 * was the startup-only importSession() call.
 *
 * Idempotent, multi-account safe: the bridge only stamps the account whose
 * UUID matches the profile that just authenticated (dashes normalized), and
 * only when IdentityService lacks that account's tokens. Other accounts are
 * untouched. No tokens cross to the renderer.
 */
async function syncMicrosoftSignIn(profile: { uuid: string; name: string }): Promise<void> {
  try {
    if (!identityService) return;
    const account = identityService
      .getAccounts()
      .find((a) => a.type === 'microsoft' && a.uuid && a.uuid.replace(/-/g, '') === profile.uuid.replace(/-/g, ''));
    if (!account) return;
    if (!identityService.getSession(account.id)) {
      const refreshToken = getAuthService().getRefreshToken();
      const accessToken = getAuthService().getAccessToken();
      if (refreshToken) {
        identityService.importSession(profile, refreshToken, accessToken || undefined);
      }
    }
    // The person who just authenticated becomes the active account —
    // mirroring the Account tab's addMicrosoftAccount behavior.
    identityService.setActiveAccount(account.id);
  } catch (err) {
    // The sign-in itself succeeded; a sync failure must not reject the whole
    // flow. Startup reconciliation retries the import on next launch.
    console.error('[auth-sync] Microsoft sign-in sync failed:', err);
  }
}

/**
 * Broadcast auth/account state to the renderer after any main-process
 * mutation that can change it (sign-in, sign-out, removal, switch, startup
 * import). One event, one meaning: "your view may be stale — re-pull".
 * Payload carries NO tokens. Emitted AFTER the mutation and its sync bridge
 * complete, so a listener that immediately re-pulls reads final state —
 * closing the race where startup import finished after the renderer already
 * loaded an empty account list.
 */
function notifyAuthChanged(): void {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const who = resolvePlayerIdentity();
    const payload = {
      loggedIn: !!who,
      profile:
        who?.source === 'identity'
          ? { uuid: who.account.uuid || '', name: who.account.username }
          : who
            ? { uuid: who.profile.uuid, name: who.profile.name }
            : null,
      activeAccountId: identityService?.getActiveAccount()?.id ?? null,
      accountCount: identityService?.getAccounts().length ?? 0,
    };
    mainWindow.webContents.send('auth-changed', payload);
  } catch (err) {
    console.error('[auth-sync] notifyAuthChanged failed:', err);
  }
}

/**
 * THE one resolution rule for "who is the player": the identity system's
 * active account when it can actually play (offline, or Microsoft with a
 * live session), otherwise the legacy AuthService session.
 *
 * auth-status, get-skin, and both launch handlers all resolve through this —
 * that shared rule is what makes account switching real: the name on the
 * stage, the skin on the hero, and the token in the launch always belong to
 * the same person. If the active account is signed out and no legacy session
 * exists, everything coherently reads "signed out".
 */
function resolvePlayerIdentity():
  | { source: 'identity'; account: Account }
  | { source: 'legacy'; profile: { uuid: string; name: string } }
  | null {
  const active = identityService?.getActiveAccount();
  if (active && (active.type === 'offline' || identityService!.getSession(active.id))) {
    return { source: 'identity', account: active };
  }
  const auth = getAuthService();
  const profile = auth.getProfile();
  if (auth.isLoggedIn() && profile) {
    return { source: 'legacy', profile: { uuid: profile.uuid, name: profile.name } };
  }
  return null;
}

/**
 * Resolve the MCLC authorization for whoever resolvePlayerIdentity names.
 * Returns null when nobody is signed in; throws (with a human message) when
 * the active account's session exists but can't be revived — the launch
 * error UI surfaces it rather than silently launching as someone else.
 */
async function resolveLaunchAuthorization(): Promise<
  { access_token: string; uuid: string; name: string } | null
> {
  const who = resolvePlayerIdentity();
  if (!who) return null;
  if (who.source === 'identity') {
    // Validates and, if needed, refreshes the active account's tokens.
    const auth = await identityService!.ensureValidSession();
    if (auth) console.log(`[launch] Launching as "${auth.name}" (identity/${who.account.type})`);
    return auth;
  }
  const auth = await getAuthService().getAuthorizationForMCLC();
  if (auth) console.log(`[launch] Launching as "${auth.name}" (legacy session)`);
  return auth;
}

// Register IPC handlers
/**
 * Recursively sum file sizes under dirPath (bytes).
 * Async (fs/promises): the walk hops to the libuv threadpool so large data
 * directories never block the main process. Same pattern as WorldManager's
 * dirSize — a missing or unreadable path contributes 0, never a throw.
 */
async function dirSizeBytes(dirPath: string): Promise<number> {
  let st;
  try {
    st = await stat(dirPath);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    total += await dirSizeBytes(join(dirPath, entry.name));
  }
  return total;
}

function registerIpcHandlers(): void {
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // ── App Storage & Cache (Setup screen) ────────────────────────────────
  // These three handlers replace SetupView's fake controls (console.log
  // buttons + a hardcoded "2.3 GB" figure). clear-cache's scope guard is
  // deliberate and absolute: ONLY refetchable caches are ever deleted —
  // worlds/, identity.json, identity-tokens.bin, auth-session.bin and
  // worlds.json are user data and MUST never be touched here.

  ipcMain.handle('open-app-data-dir', async () => {
    try {
      // shell.openPath resolves with an error STRING on failure, '' on success.
      const err = await shell.openPath(app.getPath('userData'));
      return err ? { success: false, error: err } : { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('get-app-metrics', async () => {
    const userDataPath = app.getPath('userData');
    const bytes = await dirSizeBytes(userDataPath);
    return { path: userDataPath, bytes };
  });

  ipcMain.handle('clear-cache', async () => {
    const targets = [
      join(app.getPath('userData'), 'skins'), // SkinService 24h cache — refetched on demand
      join(app.getPath('userData'), 'minecraft', 'cache'), // MCLC download cache — re-downloaded at launch
    ];
    let bytesCleared = 0;
    try {
      for (const dir of targets) {
        bytesCleared += await dirSizeBytes(dir);
        rmSync(dir, { recursive: true, force: true });
      }
      return { success: true, bytesCleared };
    } catch (err) {
      console.error('[clear-cache] failed:', err);
      return { success: false, error: String(err), bytesCleared };
    }
  });

  ipcMain.handle('open-external-link', (_event, url: string) => {
    try {
      const validUrl = validateExternalUrl(url);
      shell.openExternal(validUrl);
    } catch (err) {
      console.warn(`[IPC-SEC] ${err instanceof Error ? err.message : err}`);
    }
  });

  ipcMain.handle('get-platform', () => {
    return process.platform;
  });

  /**
   * 'ping-server' — Live Server Pulse: asks the main process to SLP-ping a
   * Minecraft server. Hosts come from the world's assigned server or the
   * built-in SMP; validation lives in server-pinger.
   */
  ipcMain.handle('ping-server', async (_event, host: string, port: number) => {
    try {
      return await pingMinecraftServer(host, port);
    } catch (err) {
      return { online: false };
    }
  });

  /**
   * 'fetch-version-list' — Fetches a version manifest from the main process.
   * The main process has no CSP/CORS restrictions, so version metadata
   * (Mojang manifest, Fabric/Quilt meta) is fetched here and handed to the
   * renderer over IPC — the same pattern Prism Launcher uses. Kind selects
   * the manifest; only allowlisted URLs are ever requested, so the renderer
   * cannot redirect this into a generic network proxy.
   */
  ipcMain.handle('fetch-version-list', async (_event, kind: string) => {
    console.log('[version-list] handler called, kind:', kind);
    const urls: Record<string, string> = {
      minecraft: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
      fabric: 'https://meta.fabricmc.net/v2/versions/loader',
      quilt: 'https://meta.quiltmc.org/v3/versions/loader',
    };
    const url = urls[kind];
    if (!url) return { success: false, error: 'Invalid kind' };

    try {
      console.log('[version-list] fetching:', url);
      // Node 20+ global fetch (Electron 40) — `net.fetch` has proven flaky here.
      // 8s timeout so a hung request surfaces as an error instead of an eternal spinner.
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      console.log('[version-list] response status:', res.status);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const json = await res.json();

      if (kind === 'minecraft') {
        const releases = ((json as { versions?: { id: string; type: string }[] }).versions || [])
          .filter((v) => v.type === 'release')
          .map((v) => v.id);
        console.log('[version-list] parsed, count:', releases.length);
        return { success: true, versions: releases };
      }

      // Fabric (/v2) and Quilt (/v3) both return a FLAT array whose entries
      // carry the loader version at TOP level, e.g.
      //   { maven: "net.fabricmc:fabric-loader:0.19.5", version: "0.19.5", ... }
      // There is NO nested `loader` object — assuming one silently yielded 0
      // versions and left the dialog's dropdown spinning forever.
      const versions = (Array.isArray(json) ? json : [])
        .map((e) => (e as { version?: string } | null)?.version)
        .filter((v): v is string => !!v);
      console.log('[version-list] parsed, count:', versions.length);
      return { success: true, versions };
    } catch (err) {
      console.error('[version-list] ERROR:', err);
      return { success: false, error: String(err) };
    }
  });

  // --- Java Runtime Provisioning ---
  ipcMain.handle('get-java-path', async (_event, mcVersion?: string) => {
    // Create a fresh provisioner so each request uses independent state
    const provisioner = new JavaProvisioner(mcVersion);

    // Forward progress events to the renderer
    provisioner.on('java-progress', (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('java-progress', progress);
      }
    });

    try {
      const javaPath = await provisioner.ensureJava();
      return javaPath;
    } catch (error) {
      console.error('[java-provisioner-error]', error);
      throw error;
    }
  });

  /**
   * 'detect-java' — Local Java runtime detection for the Setup screen.
   * Scans the common Windows install roots (Oracle, Adoptium, Microsoft JDK)
   * plus this launcher's own provisioned runtime ({userData}/runtime) for a
   * java.exe, so "Detect" can report what's actually on the machine without
   * downloading anything. Read-only probing: permission errors and unreadable
   * directories are skipped, never thrown.
   */
  ipcMain.handle('detect-java', async () => {
    const paths: string[] = [];
    const fs = await import('fs');
    const path = await import('path');

    // Windows common install roots
    if (process.platform === 'win32') {
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env.LOCALAPPDATA || '';

      paths.push(path.join(programFiles, 'Java'));
      paths.push(path.join(programFilesX86, 'Java'));
      paths.push(path.join(programFiles, 'Eclipse Adoptium'));
      paths.push(path.join(programFiles, 'Microsoft', 'jdk'));
      if (localAppData) {
        paths.push(path.join(localAppData, 'Programs', 'Eclipse Adoptium'));
      }
      // Masters Union launcher's own provisioned runtime (userData/runtime)
      const userDataPath = app.getPath('userData');
      paths.push(path.join(userDataPath, 'runtime'));
    }

    // One level deep per root: {root}/{entry}/bin/java.exe
    for (const dir of paths) {
      try {
        if (!fs.existsSync(dir)) continue;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const javaExe = path.join(dir, entry, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) {
            return { success: true, path: javaExe };
          }
        }
      } catch {
        // Unreadable directory / permission error — keep scanning
      }
    }

    return { success: false, error: 'Java not found. Please install Java 21 or later.' };
  });

  // --- Auth IPC Handlers ---

  /**
   * 'auth-login' — Starts the Microsoft OAuth popup login flow.
   * Uses MSMC's Electron popup mode (launch("electron")) which opens a
   * small BrowserWindow with the Microsoft login page. After the user
   * completes authentication, the popup captures the auth code from
   * the redirect to oauth20_desktop.srf and exchanges it for tokens.
   * Returns immediately; the renderer should poll 'auth-status' to
   * detect when login completes.
   */
  ipcMain.handle('auth-login', async () => {
    try {
      const auth = getAuthService();

      // Start the login flow in the background — this opens a popup
      // BrowserWindow. Don't await it here; the renderer polls auth-status.
      // When it succeeds, run the SAME convergence bridge as the Account
      // tab's sign-in so the registry, active account, and every view
      // reflect the new session without waiting for a restart.
      auth.login()
        .then(async (profile) => {
          await syncMicrosoftSignIn({ uuid: profile.uuid, name: profile.name });
          notifyAuthChanged();
        })
        .catch((err) => {
          console.error('Auth login failed:', err);
        });

      // Return immediately — popup handles the UI
      return { success: true };
    } catch (err) {
      console.error('auth-login error:', err);
      return { success: false, error: String(err) };
    }
  });

  /**
   * 'auth-logout' — Logs out the current user.
   */
  ipcMain.handle('auth-logout', async () => {
    try {
      const auth = getAuthService();
      await auth.logout();
      notifyAuthChanged();
      return { success: true };
    } catch (err) {
      console.error('auth-logout error:', err);
      return { success: false, error: String(err) };
    }
  });

  /**
   * 'get-skin' — Returns the signed-in player's skin as a data URL.
   * UUID is read from the main-process auth singleton, never from the
   * renderer. Decorative: resolves to null on any failure.
   */
  ipcMain.handle('get-skin', async () => {
    try {
      // Same resolution as launch — the face on the stage is who will play.
      const who = resolvePlayerIdentity();
      if (!who) return null;
      if (who.source === 'identity') {
        // Offline accounts wear the default look — never borrow a skin.
        if (who.account.type === 'offline' || !who.account.uuid) return null;
        return await new SkinService().getSkin(who.account.uuid);
      }
      return await new SkinService().getSkin(who.profile.uuid);
    } catch (err) {
      console.warn('[ipc-get-skin] failed (non-fatal):', err);
      return null;
    }
  });

  /**
   * 'auth-status' — Returns the current auth status.
   * Resolves through the same rule as launch (identity-first, legacy
   * fallback) so the Play stage's gate and greeting always name the person
   * who will actually enter the world.
   */
  ipcMain.handle('auth-status', async () => {
    try {
      const who = resolvePlayerIdentity();
      if (who?.source === 'identity') {
        return {
          loggedIn: true,
          profile: { uuid: who.account.uuid || '', name: who.account.username },
        };
      }
      if (who?.source === 'legacy') {
        return { loggedIn: true, profile: who.profile };
      }
      return { loggedIn: false, profile: null };
    } catch (err) {
      console.error('auth-status error:', err);
      return { loggedIn: false, profile: null, error: String(err) };
    }
  });

  // --- Launch Game IPC ---

  /**
   * 'launch-game' — Launches Minecraft.
   * Fetches the auth object from the main-process AuthService singleton
   * so the access_token NEVER crosses the context-isolation boundary.
   * Reads the active world from WorldManager to determine which Minecraft
   * root to launch from (managed = {userData}/minecraft, personal = per-world).
   * Sends 'launch-step' events to the renderer for progress tracking.
   */
  ipcMain.handle('launch-game', async (_event, javaPath: string) => {
    // Arbitrary-execution guard: javaPath originates in the renderer and is
    // ultimately handed to child_process. validatePath() throws on unsafe
    // characters (shell metacharacters / injection attempts).
    try {
      validatePath(javaPath);
    } catch {
      return { success: false, error: '[E608] Invalid Java path' };
    }

    // Guard against double-launch. The renderer also hides Play during a
    // launch, but this is the authoritative backstop at the IPC layer:
    //  - launchInProgress: a launch is currently orchestrating (Play spam).
    //  - isRunning(): a Minecraft process is already live (launch again).
    if (launchInProgress) {
      return { success: false, error: '[E604] A launch is already in progress. Please wait for it to finish.' };
    }
    if (launchManager && launchManager.isRunning()) {
      return { success: false, error: '[E605] Minecraft is already running. Close the game before launching again.' };
    }

    // Resolve the active world root through WorldManager
    const activeWorld = worldManager?.getActiveWorld();
    if (!activeWorld) {
      return { success: false, error: '[E608] No active world configured. Please restart the launcher.' };
    }
    const mcRoot = worldManager!.resolveRoot(activeWorld);

    // Resolve who plays — the identity system's active account first, legacy
    // session as fallback (the same rule auth-status and get-skin use, so
    // switching accounts switches the launch identity too). The token never
    // crosses to the renderer.
    let auth: { access_token: string; uuid: string; name: string } | null;
    try {
      auth = await resolveLaunchAuthorization();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Your session has expired. Please sign in again.';
      return { success: false, error: `[E609] ${msg} (Account screen → Sign in)` };
    }
    if (!auth) {
      return { success: false, error: '[E602] Not authenticated. Please sign in first.' };
    }

    launchInProgress = true;

    // Create a fresh LaunchManager for each launch
    launchManager = new LaunchManager();

    // Wire up step change events to send to the renderer
    const onStep: StepChangeCallback = (step, status, progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-step', step, status, progress);
      }
    };
    launchManager.onStepChange(onStep);

    try {
      // Memory: the active world's own allocation (Setup → Memory), not a
      // hardcoded default. Falls back to 4096 only if the registry value is
      // somehow missing.
      const maxRam = String(activeWorld.ramAllocation || 4096);
      // Resolution: the Setup screen's persisted "WxH" value drives the
      // game window flags via MCLC's `window` option. Absent or malformed →
      // no flags, the game uses its own default size.
      let windowOption: { width: number; height: number } | undefined;
      const savedRes = activeWorld.resolution;
      if (savedRes) {
        const m = /^(\d{2,5})x(\d{2,5})$/.exec(savedRes);
        if (m) windowOption = { width: Number(m[1]), height: Number(m[2]) };
      }
      await launchManager.launchWithFabric(auth, javaPath, { maxRam, minRam: '1024', window: windowOption }, mcRoot);
      return { success: true };
    } catch (error) {
      console.error('[ipc-launch-error]', error);
      const message = error instanceof Error ? error.message : 'Launch failed';
      return { success: false, error: message };
    } finally {
      launchInProgress = false;
    }
  });

  /**
   * 'launch-poc' — PoC: Launch Minecraft from an isolated root directory.
   * Proves that the launcher can support multiple independent worlds with
   * shared assets and JRE. Takes the same args as 'launch-game' plus a
   * target root directory.
   */
  ipcMain.handle('launch-poc', async (_event, javaPath: string, root: string) => {
    if (launchInProgress) {
      return { success: false, error: '[E604] A launch is already in progress. Please wait for it to finish.' };
    }
    if (launchManager && launchManager.isRunning()) {
      return { success: false, error: '[E605] Minecraft is already running. Close the game before launching again.' };
    }

    // Same identity resolution as launch-game.
    let auth: { access_token: string; uuid: string; name: string } | null;
    try {
      auth = await resolveLaunchAuthorization();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Your session has expired. Please sign in again.';
      return { success: false, error: `[E609] ${msg} (Account screen → Sign in)` };
    }
    if (!auth) {
      return { success: false, error: '[E602] Not authenticated. Please sign in first.' };
    }

    launchInProgress = true;

    // Create a separate LaunchManager for the PoC launch.
    // The main launchManager is untouched — both can coexist.
    const pocManager = new LaunchManager();
    const onStep: StepChangeCallback = (step, status, progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-step', `[POC] ${step}`, status, progress);
      }
    };
    pocManager.onStepChange(onStep);

    try {
      await pocManager.launchWithFabric(auth, javaPath, undefined, root);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'POC launch failed';
      return { success: false, error: message };
    } finally {
      launchInProgress = false;
    }
  });

  /**
   * 'parse-modpack' — Phase 1 of drag-and-drop modpack import: read a zip from
   * disk and detect a Modrinth modpack (modrinth.index.json at its root).
   * Returns the pack's identity so the UI can confirm before any download.
   * The whole body is wrapped — a corrupt/encrypted zip must never crash the
   * main process. adm-zip is dynamically imported (same deferral pattern as
   * java-provisioner) so it stays off the startup path.
   */
  ipcMain.handle('parse-modpack', async (_event, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'No file path provided.' };
    }
    try {
      const AdmZip = (await import('adm-zip')).default;
      // Read the archive OURSELVES and hand adm-zip a Buffer: its string-path
      // constructor throws INVALID_FILENAME whenever its internal existsSync
      // disagrees (observed live with a valid .mrpack path), and it only
      // auto-loads .zip reliably — a Buffer works for any extension.
      const archive = readFileSync(filePath);
      const zip = new AdmZip(archive);
      const entry = zip.getEntry('modrinth.index.json');
      if (!entry) {
        return { success: false, error: 'Not a valid Modrinth modpack' };
      }
      const manifest = JSON.parse(entry.getData().toString('utf8')) as {
        name?: string;
        versionId?: string;
        dependencies?: Record<string, string>;
      };
      const deps = manifest.dependencies || {};
      return {
        success: true,
        modpack: {
          name: manifest.name || 'Unknown modpack',
          version: manifest.versionId || '',
          minecraft: deps.minecraft || '',
          loader: deps['fabric-loader'] || '',
        },
      };
    } catch (err) {
      // Diagnostics in the message: if the path ever arrives mangled over IPC,
      // the log shows exactly what the handler received; readFileSync's own
      // error names the real filesystem problem (ENOENT vs zip corruption).
      console.error(`[modpack] Failed to parse "${filePath}":`, err);
      return { success: false, error: 'Could not read that file as a modpack.' };
    }
  });

  /**
   * 'select-directory' — Native folder picker. Used by the New World dialog so
   * multi-launcher users can point at the instance folder whose global settings
   * (options.txt, config/) should seed the new world. Resolves to the chosen
   * absolute path, or null when cancelled.
   */
  ipcMain.handle('select-directory', async () => {
    // mainWindow can be null during teardown — fall back to the window-less
    // dialog so the picker still opens attached to nothing rather than throwing.
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  /**
   * 'create-world' — Creates a new personal world.
   * Provisions the filesystem directory and registers it in worlds.json.
   * Takes name, version, loader, and optional params.
   */
  ipcMain.handle('create-world', async (_event, spec: {
    name: string;
    version: string;
    loader: string;
    loaderVersion?: string;
    ramAllocation?: number;
    settingsPath?: string;
    /** Modrinth modpack archive whose overrides/ gets unpacked into the world. */
    modpackPath?: string;
  }) => {
    if (!worldManager) {
      return { success: false, error: 'World system not initialized.' };
    }
    if (!spec.name || !spec.version || !spec.loader) {
      return { success: false, error: 'name, version, and loader are required.' };
    }
    const supportedLoaders: readonly string[] = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
    if (!supportedLoaders.includes(spec.loader)) {
      return { success: false, error: 'Unsupported loader. Use vanilla, fabric, quilt, forge, or neoforge.' };
    }
    const world = worldManager.createWorld({
      name: spec.name,
      version: spec.version,
      loader: spec.loader as LoaderType,
      loaderVersion: spec.loaderVersion,
      ramAllocation: spec.ramAllocation,
      settingsPath: spec.settingsPath,
    });
    if (!world) {
      return { success: false, error: 'Failed to create world — filesystem error.' };
    }
    // Modpack import: unpack the archive's overrides/ into the new world root.
    // Extraction failure must NOT undo the world — log and let creation stand.
    if (spec.modpackPath && world) {
      try {
        const root = worldManager.resolveRoot(world);
        await installModpackOverrides(spec.modpackPath, root);
      } catch (err) {
        console.error('Modpack overrides extraction failed:', err);
      }
    }
    return { success: true, world };
  });

  // ── World Management IPC ─────────────────────────────────────────────

  /**
   * 'get-worlds' — Returns all worlds from the registry.
   */
  ipcMain.handle('get-worlds', () => {
    if (!worldManager) return [];
    return worldManager.getWorlds();
  });

  /**
   * 'get-active-world' — Returns the currently active world.
   */
  ipcMain.handle('get-active-world', () => {
    if (!worldManager) return null;
    return worldManager.getActiveWorld();
  });

  /**
   * 'set-active-world' — Switches the active world.
   */
  ipcMain.handle('set-active-world', async (_event, worldId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { success: false, error: `World not found.` };
    if (world.broken) return { success: false, error: `World is broken.` };
    const ok = worldManager.setActiveWorld(worldId);
    if (!ok) return { success: false, error: 'Failed to set active world.' };
    return { success: true, world };
  });

  ipcMain.handle('rename-world', async (_event, worldId: string, newName: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.renameWorld(worldId, newName);
  });

  /**
   * 'update-world-settings' — Update editable per-world settings (RAM
   * allocation). The value flows to the JVM at launch ('launch-game' reads
   * the active world's ramAllocation), so this is the real memory control.
   */
  ipcMain.handle('update-world-settings', async (_event, worldId: string, settings: {
    ramAllocation?: number;
    resolution?: string;
  }) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.updateWorldSettings(worldId, settings);
  });

  ipcMain.handle('delete-world', async (_event, worldId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.deleteWorld(worldId);
  });

  ipcMain.handle('duplicate-world', async (_event, worldId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.duplicateWorld(worldId);
  });

  ipcMain.handle('get-world-metrics', async (_event, worldId: string) => {
    if (!worldManager) return { worldSize: 0, backupSize: 0 };
    return worldManager.getWorldMetrics(worldId);
  });

  ipcMain.handle('check-world-health', async (_event, worldId: string) => {
    if (!worldManager) return 'corrupted';
    return worldManager.checkWorldHealth(worldId);
  });

  /**
   * 'diagnose-world' — THE ORACLE: read the world's most recent crash
   * report and attribute the crash (mod name + reason). The renderer sends
   * a world id only; the root resolves through WorldManager here. Never
   * throws — diagnoseLastCrash's contract and the guard below both return
   * { crashed: false } on any failure.
   */
  ipcMain.handle('diagnose-world', async (_event, worldId: string) => {
    if (!worldManager) return { crashed: false };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { crashed: false };
    try {
      return await diagnoseLastCrash(worldManager.resolveRoot(world));
    } catch (err) {
      console.error('[oracle] diagnosis failed:', err);
      return { crashed: false };
    }
  });

  /**
   * 'check-mod-updates' — Mod Update Notifier: scans the world's mods/ for
   * Fabric mods and asks Modrinth whether a newer compatible release exists.
   * Per-mod failures never throw (checkForUpdates skips them); only a bad
   * worldId/manager state short-circuits to [].
   */
  ipcMain.handle('check-mod-updates', async (_event, worldId: string) => {
    if (!worldManager) return [];
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return [];
    try {
      return await checkForUpdates(worldManager.resolveRoot(world), world.version, world.loader);
    } catch (err) {
      console.error('[mod-updates] check failed:', err);
      return [];
    }
  });

  /**
   * 'perform-mod-update' — downloads the new release into the world's mods/
   * and removes the superseded jar. Download-before-delete ordering lives in
   * performUpdate; a failure here surfaces as { success: false, error }.
   */
  ipcMain.handle(
    'perform-mod-update',
    async (_event, worldId: string, oldFilename: string, downloadUrl: string, newFilename: string) => {
      if (!worldManager) return { success: false, error: 'World system not initialized.' };
      const world = worldManager.getWorlds().find((w) => w.id === worldId);
      if (!world) return { success: false, error: 'World not found.' };
      try {
        await performUpdate(worldManager.resolveRoot(world), oldFilename, downloadUrl, newFilename);
        return { success: true };
      } catch (err) {
        console.error('[mod-updates] perform failed:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  /**
   * 'repair-world' — Recreate a broken world's root directory so it can
   * launch again. Pairs with 'check-world-health' above.
   */
  ipcMain.handle('repair-world', async (_event, worldId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    try {
      const success = worldManager.repairWorld(worldId);
      return { success, error: success ? undefined : 'Repair failed' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('backup-world', async (_event, worldId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.backupWorld(worldId);
  });

  ipcMain.handle('get-backups', async (_event, worldId: string) => {
    if (!worldManager) return [];
    return worldManager.getBackups(worldId);
  });

  ipcMain.handle('restore-world', async (_event, worldId: string, backupName: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.restoreWorld(worldId, backupName);
  });

  ipcMain.handle('verify-backup', async (_event, worldId: string, backupName: string) => {
    if (!worldManager) return { success: false, verified: false, error: 'World system not initialized.' };
    return worldManager.verifyBackup(worldId, backupName);
  });

  ipcMain.handle('delete-backup', async (_event, worldId: string, backupName: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    return worldManager.deleteBackup(worldId, backupName);
  });

  // ── Mod Management IPC ───────────────────────────────────────────────
  // Personal-world mods live in {root}/mods/. All four handlers resolve the
  // world by id through WorldManager first — the renderer only ever sends a
  // world id, never a filesystem path of its own.

  /**
   * 'mod-list' — Lists the mod files in a world's mods/ directory.
   * Returns ModFileInfo[] ({ filename, name, size, enabled }), or [] when
   * the world system isn't ready or the world doesn't exist.
   */
  ipcMain.handle('mod-list', async (_event, worldId: string) => {
    if (!worldManager) return [];
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return [];
    return await listMods(worldManager.resolveRoot(world));
  });

  /**
   * 'mod-toggle' — Enables or disables a mod (renamed in place).
   * Returns { success } or { success: false, error }.
   */
  ipcMain.handle('mod-toggle', async (_event, worldId: string, filename: string, enable: boolean) => {
    if (!worldManager) return { success: false, error: 'Not ready' };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found' };
    try {
      await toggleMod(worldManager.resolveRoot(world), filename, enable);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: String(e) };
    }
  });

  /**
   * 'mod-delete' — Deletes a mod file from the world's mods/ directory.
   * Returns { success } or { success: false, error }.
   */
  ipcMain.handle('mod-delete', async (_event, worldId: string, filename: string) => {
    if (!worldManager) return { success: false, error: 'Not ready' };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found' };
    try {
      await deleteMod(worldManager.resolveRoot(world), filename);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: String(e) };
    }
  });

  /**
   * 'mod-add' — Copies a .jar from disk into the world's mods/ directory.
   * Returns { success } or { success: false, error }.
   */
  ipcMain.handle('mod-add', async (_event, worldId: string, sourceFilePath: string) => {
    if (!worldManager) return { success: false, error: 'Not ready' };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found' };
    try {
      await addMod(worldManager.resolveRoot(world), sourceFilePath);
      return { success: true };
    } catch (e: any) {
      return { success: false, error: String(e) };
    }
  });

  /**
   * 'mod-download' — Downloads the newest compatible build of a Modrinth
   * project into a world's mods/ directory. The world's game version and
   * loader are applied as a compatibility filter (a Fabric world must get
   * the Fabric build, not NeoForge). Resolves to { success, filename } or
   * { success: false, error }.
   */
  ipcMain.handle('mod-download', async (_event, worldId: string, projectId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };
    if (!projectId) return { success: false, error: 'No Modrinth project ID provided.' };
    try {
      const { downloadModFromModrinth } = await import('./mod-downloader');
      const root = worldManager.resolveRoot(world);
      return await downloadModFromModrinth(root, projectId, undefined, {
        gameVersion: world.version,
        loader: world.loader !== 'vanilla' ? world.loader : undefined,
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * 'select-mod-file' — Native file picker for a mod .jar, used by the Mod
   * Manager's "Add Mod". Kept separate from 'select-directory' (folders) and
   * 'select-skin-file' (validated PNGs) so each picker owns its filters.
   * Resolves to the chosen absolute path, or null when cancelled.
   */
  ipcMain.handle('select-mod-file', async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Choose a mod',
          filters: [{ name: 'Minecraft mod (JAR)', extensions: ['jar'] }],
          properties: ['openFile'],
        })
      : await dialog.showOpenDialog({
          title: 'Choose a mod',
          filters: [{ name: 'Minecraft mod (JAR)', extensions: ['jar'] }],
          properties: ['openFile'],
        });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // ── Modrinth Discover IPC ────────────────────────────────────────────
  // Search and one-click install from Modrinth. Same world-id-only rule as
  // the mod handlers above: the renderer never supplies a filesystem path —
  // the world root resolves through WorldManager and the download URL comes
  // from Modrinth's own API.

  /**
   * 'modrinth-search' — Searches Modrinth for mods. The main process has no
   * CSP/CORS restrictions, so the API call happens here (same pattern as
   * 'fetch-version-list'). gameVersion/loader filter the results so every
   * hit is installable in THIS world. A 'mod' project_type facet is applied
   * by the search module itself so plugins/datapacks don't pollute results.
   */
  ipcMain.handle('modrinth-search', async (_event, query: string, gameVersion?: string, loader?: string) => {
    try {
      const { searchModrinthMods } = await import('./mod-downloader');
      return await searchModrinthMods(query, gameVersion, loader);
    } catch (err) {
      console.error('[modrinth-search] failed:', err);
      return [];
    }
  });

  /**
   * 'modrinth-download' — Installs a Modrinth project's latest compatible
   * version into a world's mods/ directory. downloadModFromModrinth has a
   * never-throw contract (resolves to { success, error }); the try/catch is
   * belt-and-braces so no IPC path can crash the main process.
   */
  ipcMain.handle('modrinth-download', async (_event, worldId: string, projectId: string) => {
    if (!worldManager) return { success: false, error: 'World system not initialized.' };
    const world = worldManager.getWorlds().find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };
    try {
      const { downloadModFromModrinth } = await import('./mod-downloader');
      return await downloadModFromModrinth(worldManager.resolveRoot(world), projectId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Identity Management IPC ──────────────────────────────────────────

  ipcMain.handle('get-accounts', () => {
    if (!identityService) return [];
    // Enrich with session presence so the Account screen can show
    // signed-in / signed-out state without a per-account round trip.
    return identityService.getAccounts().map((a) => ({
      ...a,
      hasSession: identityService!.getSession(a.id) !== null,
    }));
  });

  ipcMain.handle('get-active-account', () => {
    if (!identityService) return null;
    return identityService.getActiveAccount();
  });

  ipcMain.handle('set-active-account', async (_event, accountId: string) => {
    if (!identityService) return { success: false, error: 'Identity system not initialized.' };
    const result = identityService.setActiveAccount(accountId);
    if (result.success) notifyAuthChanged();
    return result;
  });

  ipcMain.handle('add-microsoft-account', async () => {
    if (!identityService) return { success: false, error: 'Identity system not initialized.' };
    const result = await identityService.addMicrosoftAccount();
    // Converge the legacy AuthService onto this sign-in too — the SAME
    // bridge, in reverse: Play, get-skin, and launch all resolve through
    // resolvePlayerIdentity(), which reads the legacy session when no
    // identity session exists. Without this, an Account-tab sign-in left
    // Play showing "Almost there." until a restart re-imported the session.
    // Same-UUID targeting only; other accounts untouched.
    if (result.success && result.account) {
      try {
        const refreshToken = identityService.getRefreshToken(result.account.id);
        const accessToken = identityService.getAccessToken(result.account.id);
        if (refreshToken) {
          const profile = { uuid: result.account.uuid || '', name: result.account.username };
          await getAuthService().adoptExternalSession(profile, refreshToken, accessToken || undefined);
        }
      } catch (err) {
        // The registry already holds the account; a legacy-sync failure must
        // not fail the sign-in. ensureValidAuth() retries the refresh on the
        // next launch attempt, and startup reconciliation re-runs import.
        console.error('[auth-sync] Account-tab sign-in legacy sync failed:', err);
      }
    }
    if (result.success) notifyAuthChanged();
    return result;
  });

  ipcMain.handle('add-offline-account', async (_event, username: string) => {
    if (!identityService) return { success: false, error: 'Identity system not initialized.' };
    const result = identityService.addOfflineAccount(username);
    if (result.success) notifyAuthChanged();
    return result;
  });

  /**
   * 'remove-account' — Removes an account from the IdentityService registry.
   *
   * If the removed Microsoft account corresponds to the legacy AuthService
   * session (same UUID), that legacy session is cleared FIRST and the clear
   * is VERIFIED before the identity removal is allowed to report success.
   * Ordering matters: clearing after removal would leave a window where the
   * identity account is gone but the legacy session survives a crash — and
   * the startup bridge (importSession) would then resurrect the account.
   * Never touches other accounts' state.
   */
  ipcMain.handle('remove-account', async (_event, accountId: string) => {
    if (!identityService) return { success: false, error: 'Identity system not initialized.' };

    // Match by UUID — never by position, never by assumption. Only the
    // account whose identity IS the legacy session clears it.
    const account = identityService.getAccounts().find((a) => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found.' };

    const isLegacySession =
      account.type === 'microsoft' &&
      !!account.uuid &&
      (() => {
        const legacy = getAuthService().getProfile();
        return (
          !!legacy &&
          legacy.uuid.replace(/-/g, '') === account.uuid.replace(/-/g, '')
        );
      })();

    // Clear-and-verify BEFORE removing: if the legacy session can't be
    // cleared, abort with the account intact (consistent, retryable state).
    if (isLegacySession) {
      const auth = getAuthService();
      await auth.logout();
      if (auth.hasPersistedSession()) {
        console.error('[remove-account] Legacy session file survived logout — aborting removal.');
        return {
          success: false,
          error: 'Could not clear the saved sign-in session. Please try removing the account again.',
        };
      }
    }

    const removal = identityService.removeAccount(accountId);
    if (removal.success) notifyAuthChanged();
    return removal;
  });

  ipcMain.handle('validate-session', async (_event, accountId: string) => {
    if (!identityService) return { valid: false, error: 'Identity system not initialized.' };
    return identityService.validateSession(accountId);
  });

  ipcMain.handle('get-identity-skin', async (_event, accountId: string, force?: boolean) => {
    if (!identityService) return null;
    return identityService.getSkin(accountId, { force: force === true });
  });

  /**
   * 'select-skin-file' — Opens the native file dialog for a skin PNG,
   * validates it (PNG magic + 64×64 / legacy 64×32 dimensions), and holds
   * the path IN THE MAIN PROCESS. The renderer only ever receives a preview
   * data URL — filesystem paths never cross the bridge in either direction.
   */
  ipcMain.handle('select-skin-file', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a skin',
      filters: [{ name: 'Minecraft skin (PNG)', extensions: ['png'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    try {
      if (statSync(filePath).size > 128 * 1024) {
        return { error: 'That file is too large for a skin. Skins are 64×64 PNGs.' };
      }
      const buf = readFileSync(filePath);
      // PNG magic: 89 50 4E 47 0D 0A 1A 0A; IHDR width/height at offsets 16/20.
      const isPng =
        buf.length > 24 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      if (!isPng) return { error: 'That file isn’t a PNG. Skins are 64×64 PNGs.' };
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      const validDims = width === 64 && (height === 64 || height === 32);
      if (!validDims) {
        return { error: `That image is ${width}×${height} — skins are 64×64 (or legacy 64×32).` };
      }

      pendingSkinPath = filePath;
      return {
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
        width,
        height,
      };
    } catch {
      return { error: 'Could not read the selected file.' };
    }
  });

  /**
   * 'upload-skin' — Uploads the file previously chosen via 'select-skin-file'
   * to the account's Minecraft profile. No path argument by design.
   */
  ipcMain.handle('upload-skin', async (_event, accountId: string, model: string) => {
    if (!identityService) return { success: false, error: 'Identity system not initialized.' };
    if (!pendingSkinPath) return { success: false, error: 'Choose a skin file first.' };
    if (model !== 'classic' && model !== 'slim') {
      return { success: false, error: 'Invalid model.' };
    }
    return identityService.uploadSkin(accountId, pendingSkinPath, model);
  });

  /**
   * 'identity-sign-out' — Ends an account's session but keeps the account
   * listed. If the account is also the legacy launch session (same UUID),
   * that session is ended too, so "signed out" means signed out everywhere.
   */
  ipcMain.handle('identity-sign-out', async (_event, accountId: string) => {
    if (!identityService) return { success: false, error: 'Identity system not initialized.' };
    const account = identityService.getAccounts().find((a) => a.id === accountId);
    const result = identityService.signOut(accountId);
    if (result.success && account?.type === 'microsoft' && account.uuid) {
      const legacy = getAuthService().getProfile();
      if (legacy && legacy.uuid.replace(/-/g, '') === account.uuid.replace(/-/g, '')) {
        await getAuthService().logout();
      }
    }
    if (result.success) notifyAuthChanged();
    return result;
  });

  /**
   * 'cancel-launch' — Cancels the current launch operation.
   */
  ipcMain.handle('cancel-launch', async () => {
    if (launchManager) {
      await launchManager.cancelLaunch();
      return { success: true };
    }
    return { success: false, error: '[E603] No active launch to cancel.' };
  });

  /**
   * 'get-installed-versions' — Lists installed Minecraft versions.
   */
  ipcMain.handle('get-installed-versions', () => {
    if (launchManager) {
      return launchManager.getInstalledVersions();
    }
    return [];
  });

  /**
   * 'is-game-running' — Checks if the game is currently running.
   */
  ipcMain.handle('is-game-running', () => {
    if (launchManager) {
      return launchManager.isRunning();
    }
    return false;
  });

  /**
   * 'run-preflight-check' — Runs all launch preflight checks.
   * Returns results for internet, disk space, Java, and file integrity.
   */
  ipcMain.handle('run-preflight-check', async () => {
    try {
      return await runPreflightCheck();
    } catch (error) {
      console.error('[preflight-check-error]', error);
      return {
        pass: false,
        checks: [
          {
            name: 'Preflight Runner',
            passed: false,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });

  /**
   * 'inject-server' — Injects the MU SMP server into servers.dat.
   * Useful for triggering injection outside of the launch flow (e.g. on settings page).
   */
  ipcMain.handle('inject-server', async () => {
    try {
      const serverInjector = new ServerInjector();
      await serverInjector.injectServer();
      return { success: true };
    } catch (error) {
      console.error('[ipc-inject-server-error]', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

// App lifecycle
app.setAppUserModelId('com.mastersunion.ember');

app.whenReady().then(() => {
  // Skip single-instance check in dev mode (zombie processes from rapid restarts)
  if (app.isPackaged) {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  registerIpcHandlers();
  createWindow();

  // THE TEMPORAL PING: close-to-tray + background server monitor.
  // Safe to call here — createWindow() synchronously assigned mainWindow.
  initTray(mainWindow!);

  // Initialize the WorldManager singleton — handles migration from
  // existing {userData}/minecraft/ directory and creates worlds.json
  // on first startup. No UI changes — the renderer is unaware of this.
  worldManager = new WorldManager();

  // Initialize the IdentityService singleton — manages accounts, sessions,
  // and skin state. Loads from identity.json + encrypted token store.
  identityService = new IdentityService();

  // ── Startup Session Reconciliation ─────────────────────────────────
  // If AuthService has a valid session but IdentityService lacks tokens
  // for the matching account, hydrate the IdentityService token store.
  // This is the ONLY bridge between the two session systems.
  const authProfile = getAuthService().getProfileForImport();
  const authToken = getAuthService().getRefreshToken();
  const authAccessToken = getAuthService().getAccessToken();
  if (authProfile && authToken) {
    identityService.importSession(authProfile, authToken, authAccessToken || undefined);
  }

  // Startup race guard: the window was created BEFORE IdentityService init,
  // so the renderer may have already pulled an empty account list. Emit once
  // now that reconciliation is final — late subscribers get coherent state
  // without any navigation or restart.
  notifyAuthChanged();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // Tear down the Temporal Ping tray + monitor so quit is clean and the
  // close interceptor (isQuitting flag) does not block window teardown.
  disposeTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
