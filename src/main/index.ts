import { app, BrowserWindow, ipcMain, shell, dialog, net } from 'electron';
import { join } from 'path';
import { readFileSync, statSync } from 'fs';
import { is } from '@electron-toolkit/utils';
import { AuthService } from './auth-service';
import { JavaProvisioner } from './java-provisioner';
import { LaunchManager, StepChangeCallback } from './launch-service';
import { ServerInjector } from './server-injector';
import { validateExternalUrl, validatePath } from '../security/ipc-validate';
import { runPreflightCheck } from './preflight-check';
import { SkinService } from './skin-service';
import { WorldManager } from './world-manager';
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

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
function registerIpcHandlers(): void {
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
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
   * 'fetch-version-list' — Fetches a version manifest from the main process.
   * The main process has no CSP/CORS restrictions, so version metadata
   * (Mojang manifest, Fabric/Quilt meta) is fetched here and handed to the
   * renderer over IPC — the same pattern Prism Launcher uses. Kind selects
   * the manifest; only allowlisted URLs are ever requested, so the renderer
   * cannot redirect this into a generic network proxy.
   */
  ipcMain.handle('fetch-version-list', async (_event, kind: string) => {
    const urls: Record<string, string> = {
      minecraft: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
      fabric: 'https://meta.fabricmc.net/v2/versions/loader',
      quilt: 'https://meta.quiltmc.org/v3/versions/loader',
    };
    const url = urls[kind];
    if (!url) return { success: false, error: 'Invalid kind' };

    try {
      const res = await net.fetch(url);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const json = await res.json();

      if (kind === 'minecraft') {
        const releases = ((json as { versions?: { id: string; type: string }[] }).versions || [])
          .filter((v) => v.type === 'release')
          .map((v) => v.id);
        return { success: true, versions: releases };
      }

      // Fabric and Quilt both return [{ loader: { version: "..." } }, ...]
      const versions = (Array.isArray(json) ? json : [])
        .map((e) => (e as { loader?: { version?: string } } | null)?.loader?.version)
        .filter((v): v is string => !!v);
      return { success: true, versions };
    } catch (err) {
      console.error(`[version-list] ${kind} fetch failed:`, err);
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
      await launchManager.launchWithFabric(auth, javaPath, { maxRam, minRam: '1024' }, mcRoot);
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
app.setAppUserModelId('com.mastersunion.masterlauncher');

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
