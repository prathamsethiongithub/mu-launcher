import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Account, SkinProfile } from '../shared/types';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  openExternalLink: (url: string) => {
    ipcRenderer.invoke('open-external-link', url);
  },

  getPlatform: () => ipcRenderer.invoke('get-platform'),

  onUpdateAvailable: (callback: (args: unknown) => void) => {
    ipcRenderer.on('update-available', (_event, args) => callback(args));
  },

  onUpdateNotAvailable: (callback: () => void) => {
    ipcRenderer.on('update-not-available', () => callback());
  },

  onUpdateDownloadProgress: (callback: (args: { percent: number; bytesPerSecond: number }) => void) => {
    ipcRenderer.on('update-download-progress', (_event, args) => callback(args));
  },

  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on('update-downloaded', () => callback());
  },

  removeAllUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.removeAllListeners('update-not-available');
    ipcRenderer.removeAllListeners('update-download-progress');
    ipcRenderer.removeAllListeners('update-downloaded');
  },

  // --- Auth Methods ---

  /**
   * Starts the Microsoft OAuth login flow via MSMC Electron popup.
   * Opens a small BrowserWindow for the user to sign in.
   * Returns { success: boolean } — the renderer should poll auth-status
   * to detect when login completes.
   */
  startLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('auth-login');
  },

  /**
   * Returns the current authentication status.
   */
  getAuthStatus: (): Promise<{
    loggedIn: boolean;
    profile: { uuid: string; name: string } | null;
  }> => {
    return ipcRenderer.invoke('auth-status');
  },

  /**
   * Logs out the current user.
   */
  logout: (): Promise<void> => {
    return ipcRenderer.invoke('auth-logout');
  },

  /**
   * Returns the signed-in player's skin as a data URL (+ arm model),
   * or null if unavailable. Decorative — callers must handle null.
   */
  getSkin: (): Promise<{ dataUrl: string; model: 'slim' | 'default' } | null> => {
    return ipcRenderer.invoke('get-skin');
  },

  /**
   * Returns the path to a provisioned Java runtime.
   * Falls back to 'java' if not available.
   */
  getJavaPath: (): Promise<string> => {
    return ipcRenderer.invoke('get-java-path');
  },

  /**
   * Registers a listener for Java provisioning progress events.
   * Callback receives { phase: string, percent: number, message?: string }.
   */
  /**
   * Quick local scan for an installed Java runtime (Setup screen "Detect").
   * Pure filesystem probing in the main process — never launches anything.
   */
  detectJava: (): Promise<{ success: boolean; path?: string; error?: string }> => {
    return ipcRenderer.invoke('detect-java');
  },

  onJavaProgress: (callback: (progress: { phase: string; percent: number; message?: string }) => void) => {
    ipcRenderer.on('java-progress', (_event, progress) => callback(progress));
  },

  /** Removes all java-progress listeners (teardown counterpart to onJavaProgress). */
  removeJavaProgressListeners: () => ipcRenderer.removeAllListeners('java-progress'),

  /**
   * Auth/account state changed (sign-in, sign-out, remove, switch, import).
   * Payload carries NO tokens — just the same shape as getAuthStatus plus
   * the resolved active identity. Listeners re-pull full state via the
   * normal IPC calls; this event only says "your view may be stale".
   */
  onAuthChanged: (
    callback: (payload: {
      loggedIn: boolean;
      profile: { uuid: string; name: string } | null;
      activeAccountId: string | null;
      accountCount: number;
    }) => void,
  ) => {
    ipcRenderer.on('auth-changed', (_event, payload) => callback(payload));
  },

  /** Removes all auth-changed listeners (teardown counterpart to onAuthChanged). */
  removeAuthChangedListeners: () => ipcRenderer.removeAllListeners('auth-changed'),

  /**
   * Runs launch preflight checks (internet, disk space, Java, files).
   * Returns { pass, checks } from the main process.
   */
  runPreflightCheck: (): Promise<{
    pass: boolean;
    checks: { name: string; passed: boolean; message?: string }[];
  }> => ipcRenderer.invoke('run-preflight-check'),

  /**
   * Injects the MU SMP server into the Minecraft servers.dat file.
   * Can be called independently or triggered automatically during launch.
   */
  injectServer: () => ipcRenderer.invoke('inject-server'),

  // --- Launch System API ---

  /**
   * Launches Minecraft with the given auth and java path.
   * Returns { success: true } or { success: false, error: string }.
   */
  launchGame: (javaPath: string) =>
    ipcRenderer.invoke('launch-game', javaPath),

  /**
   * Cancels the current launch operation.
   */
  cancelLaunch: () => ipcRenderer.invoke('cancel-launch'),

  /** Returns whether a Minecraft process is currently running. */
  isGameRunning: () => ipcRenderer.invoke('is-game-running'),

  /** PoC: Launch Minecraft from an isolated root directory. */
  launchPoc: (javaPath: string, root: string) => ipcRenderer.invoke('launch-poc', javaPath, root),

  /**
   * Fetch a version manifest via the main process (no CSP/CORS there).
   * kind: 'minecraft' → Mojang release ids; 'fabric'/'quilt' → loader versions.
   */
  fetchVersionList: (kind: 'minecraft' | 'fabric' | 'quilt') =>
    ipcRenderer.invoke('fetch-version-list', kind) as Promise<{
      success: boolean;
      versions?: string[];
      error?: string;
    }>,

  /** Live Server Pulse: query a Minecraft server's online status. */
  pingServer: (host: string, port: number) =>
    ipcRenderer.invoke('ping-server', host, port),

  /** Create a new personal world. */
  selectDirectory: () => ipcRenderer.invoke('select-directory') as Promise<string | null>,

  /** Resolve the absolute path of a File dropped into the renderer.
   *  Electron ≥32 removed File.path — webUtils is the official replacement,
   *  and it is only callable from the preload side. */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  /** Phase 1 modpack import: detect and parse a Modrinth modpack zip. */
  parseModpack: (filePath: string) =>
    ipcRenderer.invoke('parse-modpack', filePath) as Promise<{
      success: boolean;
      modpack?: { name: string; version: string; minecraft: string; loader: string };
      error?: string;
    }>,
  createWorld: (spec: { name: string; version: string; loader: string; loaderVersion?: string; ramAllocation?: number; settingsPath?: string; modpackPath?: string }) =>
    ipcRenderer.invoke('create-world', spec) as Promise<{ success: boolean; world?: unknown; error?: string; modpackNotice?: string }>,

  /** Returns all worlds from the registry. */
  getWorlds: () => ipcRenderer.invoke('get-worlds'),

  /** Returns the currently active world. */
  getActiveWorld: () => ipcRenderer.invoke('get-active-world'),

  /** Sets the active world by ID. */
  setActiveWorld: (worldId: string) => ipcRenderer.invoke('set-active-world', worldId),

  /** Rename a world. */
  renameWorld: (worldId: string, newName: string) =>
    ipcRenderer.invoke('rename-world', worldId, newName),

  /** Update editable per-world settings (RAM allocation, game resolution). */
  updateWorldSettings: (worldId: string, settings: { ramAllocation?: number; resolution?: string }) =>
    ipcRenderer.invoke('update-world-settings', worldId, settings),

  /** Open the launcher's data directory in the OS file explorer (Setup screen). */
  openAppDataDir: () =>
    ipcRenderer.invoke('open-app-data-dir') as Promise<{ success: boolean; error?: string }>,

  /** Real disk usage of the launcher data directory (Setup screen). */
  getAppMetrics: () =>
    ipcRenderer.invoke('get-app-metrics') as Promise<{ path: string; bytes: number }>,

  /** Clear refetchable caches only (skins/, minecraft/cache) — never user data. */
  clearCache: () =>
    ipcRenderer.invoke('clear-cache') as Promise<{ success: boolean; error?: string; bytesCleared: number }>,

  /** Delete a personal world. */
  deleteWorld: (worldId: string) =>
    ipcRenderer.invoke('delete-world', worldId),

  /** Duplicate a world. */
  duplicateWorld: (worldId: string) =>
    ipcRenderer.invoke('duplicate-world', worldId),

  /** Get storage metrics for a world. */
  getWorldMetrics: (worldId: string) =>
    ipcRenderer.invoke('get-world-metrics', worldId) as Promise<{ worldSize: number; backupSize: number }>,

  /** Check world health. */
  checkWorldHealth: (worldId: string) =>
    ipcRenderer.invoke('check-world-health', worldId) as Promise<'healthy' | 'warning' | 'corrupted'>,

  /** Repair a broken world by recreating its root directory. */
  repairWorld: (worldId: string) =>
    ipcRenderer.invoke('repair-world', worldId),

  /** Create a backup of a world's saves. */
  backupWorld: (worldId: string) =>
    ipcRenderer.invoke('backup-world', worldId),

  /** Get list of backups for a world. */
  getBackups: (worldId: string) =>
    ipcRenderer.invoke('get-backups', worldId),

  /** Restore a backup into a world. */
  restoreWorld: (worldId: string, backupName: string) =>
    ipcRenderer.invoke('restore-world', worldId, backupName),

  /** Verify a backup file. */
  verifyBackup: (worldId: string, backupName: string) =>
    ipcRenderer.invoke('verify-backup', worldId, backupName) as Promise<{ success: boolean; verified: boolean; error?: string }>,

  /** Delete a backup file. */
  deleteBackup: (worldId: string, backupName: string) =>
    ipcRenderer.invoke('delete-backup', worldId, backupName),

  // ── Mod Management ───────────────────────────────────────────────────

  /** List the mod files in a world's mods/ directory. */
  listMods: (worldId: string) =>
    ipcRenderer.invoke('mod-list', worldId) as Promise<
      { filename: string; displayName: string; size: number; enabled: boolean }[]
    >,

  /** Enable or disable a mod (renamed in place). */
  toggleMod: (worldId: string, filename: string, enable: boolean) =>
    ipcRenderer.invoke('mod-toggle', worldId, filename, enable) as Promise<{
      success: boolean;
      error?: string;
    }>,

  /** Delete a mod file from the world's mods/ directory. */
  deleteMod: (worldId: string, filename: string) =>
    ipcRenderer.invoke('mod-delete', worldId, filename) as Promise<{
      success: boolean;
      error?: string;
    }>,

  /** Copy a .jar from disk into the world's mods/ directory. */
  addMod: (worldId: string, sourceFilePath: string) =>
    ipcRenderer.invoke('mod-add', worldId, sourceFilePath) as Promise<{
      success: boolean;
      error?: string;
    }>,

  /** Native file picker for a mod .jar; resolves to the path or null on cancel. */
  selectModFile: () => ipcRenderer.invoke('select-mod-file') as Promise<string | null>,

  /** THE ORACLE: diagnose the world's most recent crash report. */
  diagnoseWorld: (worldId: string) =>
    ipcRenderer.invoke('diagnose-world', worldId) as Promise<{
      crashed: boolean;
      modName?: string;
      reason?: string;
      crashTime?: string;
    }>,

  /** Mod Update Notifier: check the world's mods for newer Modrinth releases. */
  checkModUpdates: (worldId: string) =>
    ipcRenderer.invoke('check-mod-updates', worldId) as Promise<
      import('../main/update-checker').ModUpdateInfo[]
    >,

  /** Mod Update Notifier: download the new release and remove the old jar. */
  performModUpdate: (worldId: string, oldFilename: string, downloadUrl: string, newFilename: string) =>
    ipcRenderer.invoke('perform-mod-update', worldId, oldFilename, downloadUrl, newFilename) as Promise<{
      success: boolean;
      error?: string;
    }>,

  // ── Modrinth Discover ──────────────────────────────────────────────── ──

  /** Search Modrinth for mods (game-version/loader facets applied in main). */
  searchModrinth: (query: string, gameVersion?: string, loader?: string) =>
    ipcRenderer.invoke('modrinth-search', query, gameVersion, loader) as Promise<
      { id: string; title: string; description: string; author: string; downloads: number; iconUrl?: string }[]
    >,

  /** Install a Modrinth project's latest version into a world's mods/ directory. */
  downloadMod: (worldId: string, projectId: string) =>
    ipcRenderer.invoke('modrinth-download', worldId, projectId) as Promise<{
      success: boolean;
      error?: string;
      filename?: string;
    }>,

  // ── Identity Management ──────────────────────────────────────────────

  /** Returns all accounts (with session presence). */
  getAccounts: () =>
    ipcRenderer.invoke('get-accounts') as Promise<(Account & { hasSession: boolean })[]>,

  /** Returns the active account. */
  getActiveAccount: () =>
    ipcRenderer.invoke('get-active-account') as Promise<Account | null>,

  /** Set the active account. */
  setActiveAccount: (accountId: string) =>
    ipcRenderer.invoke('set-active-account', accountId) as Promise<{ success: boolean; error?: string }>,

  /** Add a Microsoft account (opens popup). */
  addMicrosoftAccount: () =>
    ipcRenderer.invoke('add-microsoft-account') as Promise<{ success: boolean; account?: Account; error?: string }>,

  /** Add an offline account. */
  addOfflineAccount: (username: string) =>
    ipcRenderer.invoke('add-offline-account', username) as Promise<{ success: boolean; account?: Account; error?: string }>,

  /** Remove an account. */
  removeAccount: (accountId: string) =>
    ipcRenderer.invoke('remove-account', accountId) as Promise<{ success: boolean; error?: string }>,

  /** Validate a session. */
  validateSession: (accountId: string) =>
    ipcRenderer.invoke('validate-session', accountId) as Promise<{ valid: boolean; error?: string }>,

  /** Sign out of an account (keeps it listed; drops its session). */
  signOutAccount: (accountId: string) =>
    ipcRenderer.invoke('identity-sign-out', accountId) as Promise<{ success: boolean; error?: string }>,

  /** Get skin for an account. Pass force=true to bypass the skin cache. */
  getIdentitySkin: (accountId: string, force?: boolean) =>
    ipcRenderer.invoke('get-identity-skin', accountId, force) as Promise<SkinProfile | null>,

  /**
   * Open the native file dialog for a skin PNG. Main validates the file and
   * keeps the path; only a preview data URL (or an error) comes back.
   */
  selectSkinFile: () =>
    ipcRenderer.invoke('select-skin-file') as Promise<
      { dataUrl: string; width: number; height: number } | { error: string } | null
    >,

  /** Upload the previously selected skin file. No path crosses the bridge. */
  uploadSkin: (accountId: string, model: string) =>
    ipcRenderer.invoke('upload-skin', accountId, model) as Promise<{ success: boolean; error?: string; skin?: SkinProfile }>,

  // ── Skin sync (equip → all views) ──────────────────────────────────────
  /** Fires after a successful equip so every view can re-pull its skin. */
  onSkinChanged: (callback: (payload: { accountId: string; model: 'classic' | 'slim'; changedAt: string }) => void) => {
    ipcRenderer.on('skin-changed', (_event, payload) => callback(payload));
  },
  removeSkinChangedListeners: () => {
    ipcRenderer.removeAllListeners('skin-changed');
  },

  // ── Skin Library (Identity Studio) ─────────────────────────────────────
  /** Every saved skin; dataUrl = its PNG (null → the file is missing). */
  skinsList: () =>
    ipcRenderer.invoke('skins-list') as Promise<{
      skins: {
        id: string; name: string; fileName: string; model: 'classic' | 'slim';
        addedAt: string; lastEquippedAt?: string; hash: string; dataUrl: string | null;
      }[];
    }>,
  /** Imports the file chosen via selectSkinFile (main-process custody). */
  skinsImport: () =>
    ipcRenderer.invoke('skins-import') as Promise<{
      success: boolean; duplicate?: boolean; message?: string; error?: string;
      skin?: { id: string; name: string; fileName: string; model: 'classic' | 'slim'; addedAt: string; lastEquippedAt?: string; hash: string };
    }>,
  /** Saves the account's currently worn skin into the library. */
  skinsSaveCurrent: (accountId: string) =>
    ipcRenderer.invoke('skins-save-current', accountId) as Promise<{
      success: boolean; duplicate?: boolean; message?: string; error?: string;
      skin?: { id: string; name: string; fileName: string; model: 'classic' | 'slim'; addedAt: string; lastEquippedAt?: string; hash: string };
    }>,
  skinsDelete: (skinId: string) =>
    ipcRenderer.invoke('skins-delete', skinId) as Promise<{ success: boolean }>,
  skinsRename: (skinId: string, name: string) =>
    ipcRenderer.invoke('skins-rename', skinId, name) as Promise<{ success: boolean; error?: string }>,
  skinsSetModel: (skinId: string, model: 'classic' | 'slim') =>
    ipcRenderer.invoke('skins-set-model', skinId, model) as Promise<{ success: boolean; error?: string }>,
  skinsEquip: (skinId: string) =>
    ipcRenderer.invoke('skins-equip', skinId) as Promise<{ success: boolean; code?: string; error?: string; skin?: SkinProfile }>,
  skinsReveal: (skinId: string) =>
    ipcRenderer.invoke('skins-reveal', skinId) as Promise<{ success: boolean; error?: string }>,
  /** sha1 of the skin the active account is actually wearing (null = unknown). */
  skinsWearingHash: (accountId: string) =>
    ipcRenderer.invoke('skins-wearing-hash', accountId) as Promise<{ hash: string | null }>,

  /**
   * Registers a listener for launch step events.
   * Callback receives (step, status, progress).
   * Steps: authenticating, preparing-java, ensuring-version, installing-fabric, injecting-server, launching, running
   */
  onLaunchStep: (callback: (step: string, status: string, progress: number) => void) => {
    ipcRenderer.on('launch-step', (_event, step, status, progress) => callback(step, status, progress));
  },

  /**
   * Removes all launch step listeners.
   */
  removeLaunchListeners: () => ipcRenderer.removeAllListeners('launch-step'),
});
