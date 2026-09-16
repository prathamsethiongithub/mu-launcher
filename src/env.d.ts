/// <reference types="vite/client" />

import type { Account, SkinProfile, World } from './shared/types';

export {};

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
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
  /** Create a new personal world. */
  createWorld: (spec: { name: string; version: string; loader: string; loaderVersion?: string; ramAllocation?: number }) =>
    Promise<{ success: boolean; world?: World; error?: string }>;

  /** Returns all worlds from the registry. */
  getWorlds: () => Promise<World[]>;
  /** Returns the currently active world. */
  getActiveWorld: () => Promise<World | null>;
  /** Sets the active world by ID. */
  setActiveWorld: (worldId: string) => Promise<{ success: boolean; world?: World; error?: string }>;

  /** Rename a world. */
  renameWorld: (worldId: string, newName: string) => Promise<{ success: boolean; error?: string }>;
  /** Update editable per-world settings (RAM allocation in MB). */
  updateWorldSettings: (
    worldId: string,
    settings: { ramAllocation?: number }
  ) => Promise<{ success: boolean; world?: World; error?: string }>;
  /** Delete a personal world. */
  deleteWorld: (worldId: string) => Promise<{ success: boolean; error?: string }>;
  /** Duplicate a world. */
  duplicateWorld: (worldId: string) => Promise<{ success: boolean; world?: World; error?: string }>;
  /** Get storage metrics. */
  getWorldMetrics: (worldId: string) => Promise<{ worldSize: number; backupSize: number }>;
  /** Check world health. */
  checkWorldHealth: (worldId: string) => Promise<'healthy' | 'warning' | 'corrupted'>;
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

  /** Returns whether the game is currently running. */
  isGameRunning: () => Promise<boolean>;

  cancelLaunch: () => Promise<{ success: boolean; error?: string }>;
  onLaunchStep: (callback: (step: string, status: string, progress: number) => void) => void;
  removeLaunchListeners: () => void;
}
