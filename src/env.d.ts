/// <reference types="vite/client" />

import type { Account, SkinProfile, World } from './shared/types';

export {};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/** One file in a world's mods/ directory, as returned by listMods. */
interface ModFileEntry {
  /** Canonical (enabled-form) filename, e.g. "sodium.jar". */
  filename: string;
  /** Filename minus its extension(s), e.g. "sodium". */
  displayName: string;
  size: number;
  enabled: boolean;
}

interface ElectronAPI {
  getAppVersion: () => Promise<string>;
  openExternalLink: (url: string) => Promise<void>;
  getPlatform: () => Promise<string>;
  onUpdateAvailable: (callback: (args: unknown) => void) => void;
  onUpdateNotAvailable: (callback: () => void) => void;
  onUpdateDownloadProgress: (callback: (args: { percent: number; bytesPerSecond: number }) => void) => void;
  onUpdateDownloaded: (callback: () => void) => void;
  removeAllUpdateListeners: () => void;

  // Auth methods (MSMC Electron Popup)
  startLogin: () => Promise<{ success: boolean; error?: string }>;
  getAuthStatus: () => Promise<{ loggedIn: boolean; profile: { uuid: string; name: string } | null }>;
  logout: () => Promise<void>;

  // Player identity (decorative skin render)
  getSkin: () => Promise<{ dataUrl: string; model: 'slim' | 'default' } | null>;

  // Auth helpers for launch
  getJavaPath: () => Promise<string>;
  /** Quick local scan for an installed Java runtime (Setup → Detect). */
  detectJava: () => Promise<{ success: boolean; path?: string; error?: string }>;

  // Java provisioning progress
  onJavaProgress: (callback: (progress: { phase: string; percent: number; message?: string }) => void) => void;
  removeJavaProgressListeners: () => void;

  // Auth/account state change broadcast (no tokens in payload)
  onAuthChanged: (
    callback: (payload: {
      loggedIn: boolean;
      profile: { uuid: string; name: string } | null;
      activeAccountId: string | null;
      accountCount: number;
    }) => void,
  ) => void;
  removeAuthChangedListeners: () => void;

  // Server injection
  injectServer: () => Promise<{ success: boolean; error?: string }>;

  // --- Launch System API ---

  /**
   * Runs all preflight checks before launch.
   * Returns detailed pass/fail results for each check.
   */
  runPreflightCheck: () => Promise<{
    pass: boolean;
    checks: { name: string; passed: boolean; message?: string }[];
  }>;

  launchGame: (javaPath: string) => Promise<{ success: boolean; error?: string }>;
  /** PoC: Launch Minecraft from an isolated root directory. */
  launchPoc: (javaPath: string, root: string) => Promise<{ success: boolean; error?: string }>;
  /** Fetch a version manifest via the main process (bypasses renderer CSP). */
  fetchVersionList: (
    kind: 'minecraft' | 'fabric' | 'quilt'
  ) => Promise<{ success: boolean; versions?: string[]; error?: string }>;

  /** Live Server Pulse: query a Minecraft server's online status. */
  pingServer: (host: string, port: number) =>
    Promise<{ online: boolean; players?: { online: number; max: number }; version?: string; motd?: string }>;

  /** Open a native folder picker; resolves to the chosen path, or null on cancel. */
  selectDirectory: () => Promise<string | null>;

  /** Resolve the absolute path of a File dropped into the renderer
   *  (Electron ≥32 removed File.path — this bridges webUtils from preload). */
  getPathForFile: (file: File) => string;

  /** Phase 1 modpack import: detect and parse a Modrinth modpack zip. */
  parseModpack: (filePath: string) =>
    Promise<{
      success: boolean;
      modpack?: { name: string; version: string; minecraft: string; loader: string };
      error?: string;
    }>;

  /** Create a new personal world. modpackNotice carries honest partial-failure details for .mrpack imports. */
  createWorld: (spec: { name: string; version: string; loader: string; loaderVersion?: string; ramAllocation?: number; settingsPath?: string; modpackPath?: string }) =>
    Promise<{ success: boolean; world?: World; error?: string; modpackNotice?: string }>;

  /** Returns all worlds from the registry. */
  getWorlds: () => Promise<World[]>;
  /** Returns the currently active world. */
  getActiveWorld: () => Promise<World | null>;
  /** Sets the active world by ID. */
  setActiveWorld: (worldId: string) => Promise<{ success: boolean; world?: World; error?: string }>;

  /** Rename a world. */
  renameWorld: (worldId: string, newName: string) => Promise<{ success: boolean; error?: string }>;
  /** Update editable per-world settings (RAM allocation in MB, game resolution as "WxH"). */
  updateWorldSettings: (
    worldId: string,
    settings: { ramAllocation?: number; resolution?: string }
  ) => Promise<{ success: boolean; world?: World; error?: string }>;
  /** Open the launcher's data directory in the OS file explorer. */
  openAppDataDir: () => Promise<{ success: boolean; error?: string }>;
  /** Real disk usage of the launcher data directory (bytes). */
  getAppMetrics: () => Promise<{ path: string; bytes: number }>;
  /** Clear refetchable caches only (skins/, minecraft/cache) — never user data. */
  clearCache: () => Promise<{ success: boolean; error?: string; bytesCleared: number }>;
  /** Delete a personal world. */
  deleteWorld: (worldId: string) => Promise<{ success: boolean; error?: string }>;
  /** Duplicate a world. */
  duplicateWorld: (worldId: string) => Promise<{ success: boolean; world?: World; error?: string }>;
  /** Get storage metrics. */
  getWorldMetrics: (worldId: string) => Promise<{ worldSize: number; backupSize: number }>;
  /** Check world health. */
  checkWorldHealth: (worldId: string) => Promise<'healthy' | 'warning' | 'corrupted'>;

  /** Repair a broken world by recreating its root directory. */
  repairWorld: (worldId: string) => Promise<{ success: boolean; error?: string }>;
  /** Create a backup. */
  backupWorld: (worldId: string) => Promise<{ success: boolean; error?: string; backupPath?: string }>;
  /** Get backups list. */
  getBackups: (worldId: string) => Promise<{ name: string; date: number; size: number }[]>;
  /** Restore a backup. */
  restoreWorld: (worldId: string, backupName: string) => Promise<{ success: boolean; error?: string }>;
  /** Verify a backup. */
  verifyBackup: (worldId: string, backupName: string) => Promise<{ success: boolean; verified: boolean; error?: string }>;
  /** Delete a backup. */
  deleteBackup: (worldId: string, backupName: string) => Promise<{ success: boolean; error?: string }>;

  // ── Mod Management ──
  /** List the mod files in a world's mods/ directory. */
  listMods: (worldId: string) => Promise<ModFileEntry[]>;
  /** Enable or disable a mod (renamed in place). */
  toggleMod: (worldId: string, filename: string, enable: boolean) => Promise<{ success: boolean; error?: string }>;
  /** Delete a mod file from the world's mods/ directory. */
  deleteMod: (worldId: string, filename: string) => Promise<{ success: boolean; error?: string }>;
  /** Copy a .jar from disk into the world's mods/ directory. */
  addMod: (worldId: string, sourceFilePath: string) => Promise<{ success: boolean; error?: string }>;
  /** Native file picker for a mod .jar; resolves to the path or null on cancel. */
  selectModFile: () => Promise<string | null>;

  /** THE ORACLE: read + parse the world's latest crash report. */
  diagnoseWorld: (worldId: string) =>
    Promise<{ crashed: boolean; modName?: string; reason?: string; crashTime?: string }>;

  /** Mod Update Notifier: check the world's mods for newer Modrinth releases. */
  checkModUpdates: (worldId: string) => Promise<import('./main/update-checker').ModUpdateInfo[]>;

  /** Mod Update Notifier: download the new release and remove the old jar. */
  performModUpdate: (
    worldId: string,
    oldFilename: string,
    downloadUrl: string,
    newFilename: string
  ) => Promise<{ success: boolean; error?: string }>;

  // ── Modrinth Discover ──
  /** Search Modrinth for mods (game-version/loader facets applied in main). */
  searchModrinth: (
    query: string,
    gameVersion?: string,
    loader?: string
  ) => Promise<{ id: string; title: string; description: string; author: string; downloads: number; iconUrl?: string }[]>;
  /** Install a Modrinth project's latest version into a world's mods/ directory. */
  downloadMod: (worldId: string, projectId: string) =>
    Promise<{ success: boolean; error?: string; filename?: string }>;

  // ── Identity Management ──
  getAccounts: () => Promise<(Account & { hasSession: boolean })[]>;
  getActiveAccount: () => Promise<Account | null>;
  setActiveAccount: (accountId: string) => Promise<{ success: boolean; error?: string }>;
  addMicrosoftAccount: () => Promise<{ success: boolean; account?: Account; error?: string }>;
  addOfflineAccount: (username: string) => Promise<{ success: boolean; account?: Account; error?: string }>;
  removeAccount: (accountId: string) => Promise<{ success: boolean; error?: string }>;
  validateSession: (accountId: string) => Promise<{ valid: boolean; error?: string }>;
  /** Sign out of an account — session ends, the account stays listed. */
  signOutAccount: (accountId: string) => Promise<{ success: boolean; error?: string }>;
  /** Get skin for an account; force=true bypasses the 24h cache. */
  getIdentitySkin: (accountId: string, force?: boolean) => Promise<SkinProfile | null>;
  /** Native dialog → validated skin PNG preview. Path stays in main. */
  selectSkinFile: () => Promise<{ dataUrl: string; width: number; height: number } | { error: string } | null>;
  /** Upload the previously selected skin file for an account. */
  uploadSkin: (accountId: string, model: string) => Promise<{ success: boolean; error?: string; skin?: SkinProfile }>;

  // ── Skin sync (equip → all views) ──────────────────────────────────────
  onSkinChanged: (callback: (payload: { accountId: string; model: 'classic' | 'slim'; changedAt: string }) => void) => void;
  removeSkinChangedListeners: () => void;

  // ── Skin Library (Identity Studio) ─────────────────────────────────────
  /** Saved skin entry; dataUrl = its PNG (null → the file is missing). */
  skinsList: () => Promise<{
    skins: {
      id: string; name: string; fileName: string; model: 'classic' | 'slim';
      addedAt: string; lastEquippedAt?: string; hash: string; dataUrl: string | null;
    }[];
  }>;
  skinsImport: () => Promise<{
    success: boolean; duplicate?: boolean; message?: string; error?: string;
    skin?: { id: string; name: string; fileName: string; model: 'classic' | 'slim'; addedAt: string; lastEquippedAt?: string; hash: string };
  }>;
  skinsSaveCurrent: (accountId: string) => Promise<{
    success: boolean; duplicate?: boolean; message?: string; error?: string;
    skin?: { id: string; name: string; fileName: string; model: 'classic' | 'slim'; addedAt: string; lastEquippedAt?: string; hash: string };
  }>;
  skinsDelete: (skinId: string) => Promise<{ success: boolean }>;
  skinsRename: (skinId: string, name: string) => Promise<{ success: boolean; error?: string }>;
  skinsSetModel: (skinId: string, model: 'classic' | 'slim') => Promise<{ success: boolean; error?: string }>;
  skinsEquip: (skinId: string) => Promise<{ success: boolean; code?: string; error?: string; skin?: SkinProfile }>;
  skinsReveal: (skinId: string) => Promise<{ success: boolean; error?: string }>;
  /** sha1 of the skin the active account is actually wearing (null = unknown). */
  skinsWearingHash: (accountId: string) => Promise<{ hash: string | null }>;

  /** Returns whether the game is currently running. */
  isGameRunning: () => Promise<boolean>;

  cancelLaunch: () => Promise<{ success: boolean; error?: string }>;
  onLaunchStep: (callback: (step: string, status: string, progress: number) => void) => void;
  removeLaunchListeners: () => void;
}
