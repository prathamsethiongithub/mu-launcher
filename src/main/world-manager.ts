import { app } from 'electron';
import { join, sep } from 'path';
import * as os from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  readdirSync,
  rmSync,
  copyFileSync,
  cpSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { readdir as fspReaddir, stat as fspStat } from 'fs/promises';
import type {
  World,
  WorldRegistry,
  WorldType,
  LoaderType,
  WorldServer,
  WorldMod,
  WorldResourcePack,
} from '../shared/types';
import { SMP_SERVER_HOST, SMP_SERVER_PORT } from '../shared/constants';

/**
 * WorldManager — singleton that owns the world registry.
 *
 * Registry file: {userData}/worlds.json
 * Schema version: 1
 *
 * Write rules:
 *  - Every mutation calls save() immediately (no batch writes).
 *  - All writes are atomic: tmp file + rename.
 *  - No locking is required: saves are synchronous on a single thread.
 *
 * Data ownership:
 *  - Managed world mods → mod-data.ts (code-owned, not stored in registry)
 *  - Personal world mods → worlds.json (registry-owned)
 *  - Manual mod drops → filesystem (detected as provider: 'local')
 *  - Shared assets → {userData}/cache/ (MCLC)
 *  - Shared JRE → {userData}/runtime/ (JavaProvisioner)
 *  - World saves → {rootPath}/saves/ (Minecraft)
 */

const SCHEMA_VERSION = 1;
const MANAGED_WORLD_ID = 'managed-mu-smp';
const REGISTRY_FILENAME = 'worlds.json';

// Hardcoded managed world config — mirrors the current single-world behavior.
const MANAGED_WORLD_CONFIG = {
  name: "Masters' Union SMP",
  version: '26.1.2',
  loader: 'fabric' as LoaderType,
  loaderVersion: '0.19.3',
  rootPath: '{userData}/minecraft',
  ramAllocation: 4096,
  assignedServer: {
    ip: SMP_SERVER_HOST,
    port: SMP_SERVER_PORT,
    label: "Masters' Union SMP",
  } as WorldServer,
};

export class WorldManager {
  private registry: WorldRegistry;
  private registryPath: string;

  constructor() {
    this.registryPath = join(app.getPath('userData'), REGISTRY_FILENAME);
    this.registry = this.loadOrMigrate();
  }

  // ── Public API ───────────────────────────────────────────────────────

  getWorlds(): World[] {
    return this.registry.worlds;
  }

  getActiveWorld(): World | null {
    if (!this.registry.activeWorldId) return null;
    return this.registry.worlds.find((w) => w.id === this.registry.activeWorldId) ?? null;
  }

  getManagedWorld(): World | null {
    return this.registry.worlds.find((w) => w.type === 'managed') ?? null;
  }

  setActiveWorld(id: string): boolean {
    const world = this.registry.worlds.find((w) => w.id === id);
    if (!world) return false;
    if (world.broken) return false;
    this.registry.activeWorldId = id;
    this.save();
    return true;
  }

  /**
   * Update lastPlayedAt when Minecraft exits (stopped.done).
   * Records "last time the user finished playing."
   */
  updateLastPlayed(worldId: string): void {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (world) {
      world.lastPlayedAt = Date.now();
      this.save();
    }
  }

  /**
   * Mark a world as broken (root directory missing).
   */
  markBroken(worldId: string, broken: boolean): void {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (world) {
      world.broken = broken;
      this.save();
    }
  }

  /**
   * Repair a broken world by recreating its root directory.
   */
  repairWorld(worldId: string): boolean {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return false;
    const root = this.resolveRoot(world);
    try {
      mkdirSync(root, { recursive: true });
      world.broken = false;
      this.save();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new personal world.
   * Provisions the filesystem root and registers it in the registry.
   * Returns the created World object, or null on failure.
   */
  createWorld(spec: {
    name: string;
    version: string;
    loader: LoaderType;
    loaderVersion?: string;
    ramAllocation?: number;
    assignedServer?: WorldServer | null;
    /** Optional instance folder whose global settings seed this world. */
    settingsPath?: string;
  }): World | null {
    const id = randomUUID();
    const rootPath = `{userData}/worlds/${id}/minecraft`;
    const root = this.resolveRoot({ rootPath } as World);

    try {
      // Provision the filesystem root with the standard Minecraft subdirectories.
      mkdirSync(join(root, 'mods'), { recursive: true });
      mkdirSync(join(root, 'resourcepacks'), { recursive: true });
      mkdirSync(join(root, 'saves'), { recursive: true });
      mkdirSync(join(root, 'versions'), { recursive: true });
    } catch (err) {
      console.error(`[worlds] Failed to create world directory at ${root}:`, err);
      return null;
    }

    // Import the user's GLOBAL Minecraft settings (FOV, keybinds, Sodium/mod
    // config) so a fresh world starts feeling like their own install instead
    // of a blank slate. Best-effort by design: a missing global install, a
    // locked file, or a partial copy must never fail world creation — the
    // world is valid without imported settings, so this is warn-and-continue.
    // Placed AFTER the mkdir block above: `root` exists here, and options.txt /
    // config/ land directly in the world's game root where MCLC points the
    // game, exactly where a vanilla launcher would read them.
    try {
      // Source resolution. Multi-launcher users keep settings in PER-INSTANCE
      // directories, and those come in two shapes: vanilla-style dirs hold
      // options.txt at the root, while MultiMC/Prism-style instances nest the
      // game dir in `.minecraft/` or `minecraft/`. Probe in that order so a
      // picked instance root just works; fall back to the default global
      // .minecraft when the user didn't pick anything.
      const defaultGlobal =
        process.platform === 'win32'
          ? join(process.env.APPDATA || '', '.minecraft')
          : process.platform === 'darwin'
            ? join(os.homedir(), 'Library', 'Application Support', 'minecraft')
            : join(os.homedir(), '.minecraft');
      const candidates = spec.settingsPath
        ? [spec.settingsPath, join(spec.settingsPath, '.minecraft'), join(spec.settingsPath, 'minecraft')]
        : [defaultGlobal];
      const sourcePath =
        candidates.find((c) => existsSync(join(c, 'options.txt')) || existsSync(join(c, 'config'))) ||
        spec.settingsPath ||
        defaultGlobal;

      // options.txt — FOV, keybinds, video/audio settings, accessibility.
      const globalOptions = join(sourcePath, 'options.txt');
      if (existsSync(globalOptions)) {
        copyFileSync(globalOptions, join(root, 'options.txt'));
      }

      // config/ — mod configs live here (Sodium, Iris, etc.).
      const globalConfig = join(sourcePath, 'config');
      if (existsSync(globalConfig)) {
        cpSync(globalConfig, join(root, 'config'), { recursive: true });
      }
    } catch (err) {
      console.warn(`[worlds] Global settings import skipped for "${spec.name}":`, err);
    }

    const world: World = {
      id,
      name: spec.name,
      type: 'personal' as WorldType,
      version: spec.version,
      loader: spec.loader,
      loaderVersion: spec.loaderVersion || '',
      rootPath,
      assignedServer: spec.assignedServer || null,
      mods: [] as WorldMod[],
      resourcePacks: [] as WorldResourcePack[],
      ramAllocation: spec.ramAllocation || 4096,
      resolution: null,
      javaPath: null,
      iconPath: null,
      createdAt: Date.now(),
      lastPlayedAt: null,
      imported: false,
      broken: false,
    };

    this.registry.worlds.push(world);
    this.save();

    console.log(`[worlds] Created personal world "${spec.name}" (${id}) at ${root}`);
    return world;
  }

  /**
   * Rename a world. Validates name collision with other worlds.
   * Managed worlds cannot be renamed.
   */
  renameWorld(worldId: string, newName: string): { success: boolean; error?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };
    if (world.type === 'managed') return { success: false, error: 'Managed worlds cannot be renamed.' };

    const trimmed = newName.trim();
    if (!trimmed) return { success: false, error: 'Name cannot be empty.' };

    const collision = this.registry.worlds.some(
      (w) => w.id !== worldId && w.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (collision) return { success: false, error: `A world named "${trimmed}" already exists.` };

    world.name = trimmed;
    this.save();
    console.log(`[worlds] Renamed world ${worldId} → "${trimmed}"`);
    return { success: true };
  }

  /**
   * Update editable per-world settings (RAM). Validates bounds and persists.
   * Managed worlds share the machine-tuned profile — their RAM is editable
   * too (it is machine tuning, not world identity). Returns the updated
   * world so callers don't need a second round-trip.
   */
  updateWorldSettings(
    worldId: string,
    settings: { ramAllocation?: number; resolution?: string }
  ): { success: boolean; world?: World; error?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };

    if (settings.ramAllocation !== undefined) {
      // Prism-style bounds: 1 GB floor (below breaks modern MC), 16 GB
      // ceiling (user machine cap per owner environment).
      const ram = Math.round(settings.ramAllocation);
      if (!Number.isFinite(ram) || ram < 1024 || ram > 16384) {
        return { success: false, error: 'RAM must be between 1024 MB and 16384 MB.' };
      }
      world.ramAllocation = ram;
    }

    if (settings.resolution !== undefined) {
      if (settings.resolution === null) {
        world.resolution = null;
      } else if (/^\d{2,5}x\d{2,5}$/.test(settings.resolution)) {
        world.resolution = settings.resolution;
      } else {
        return { success: false, error: 'Resolution must be in "WxH" form (e.g. 1920x1080).' };
      }
    }

    this.save();
    console.log(`[worlds] Updated settings for world ${worldId}`);
    return { success: true, world };
  }

  /**
   * Delete a personal world. Removes from registry AND deletes the
   * filesystem root. Managed worlds cannot be deleted.
   * If the deleted world was active, falls back to the managed world.
   */
  deleteWorld(worldId: string): { success: boolean; error?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };
    if (world.type === 'managed') return { success: false, error: 'Managed worlds cannot be deleted.' };

    const root = this.resolveRoot(world);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (err) {
      console.error(`[worlds] Failed to delete world directory at ${root}:`, err);
      // Continue — remove from registry even if dir delete fails
    }

    this.registry.worlds = this.registry.worlds.filter((w) => w.id !== worldId);
    if (this.registry.activeWorldId === worldId) {
      this.registry.activeWorldId = MANAGED_WORLD_ID;
    }
    this.save();
    console.log(`[worlds] Deleted world "${world.name}" (${worldId})`);
    return { success: true };
  }

  /**
   * Duplicate a world. Creates a deep copy of the filesystem root
   * and registers a new world with "(Copy)" suffix (or "(Copy 2)" etc.)
   */
  duplicateWorld(worldId: string): { success: boolean; world?: World; error?: string } {
    const source = this.registry.worlds.find((w) => w.id === worldId);
    if (!source) return { success: false, error: 'World not found.' };

    const newId = randomUUID();
    const newRootPath = `{userData}/worlds/${newId}/minecraft`;
    const newRoot = this.resolveRoot({ rootPath: newRootPath } as World);
    const sourceRoot = this.resolveRoot(source);

    // Generate unique name
    let baseName = source.name.replace(/\s*\(Copy( \d+)?\)$/, '');
    let copyName = `${baseName} (Copy)`;
    let counter = 2;
    while (this.registry.worlds.some((w) => w.name === copyName)) {
      copyName = `${baseName} (Copy ${counter})`;
      counter++;
    }

    // Deep copy the filesystem
    try {
      mkdirSync(newRoot, { recursive: true });
      this.copyDirSync(sourceRoot, newRoot);
    } catch (err) {
      console.error(`[worlds] Failed to duplicate world directory:`, err);
      return { success: false, error: 'Failed to copy world files.' };
    }

    const newWorld: World = {
      ...source,
      id: newId,
      name: copyName,
      type: 'personal' as WorldType,
      rootPath: newRootPath,
      createdAt: Date.now(),
      lastPlayedAt: null,
      imported: false,
      broken: false,
    };

    this.registry.worlds.push(newWorld);
    this.save();
    console.log(`[worlds] Duplicated world "${source.name}" → "${copyName}" (${newId})`);
    return { success: true, world: newWorld };
  }

  /**
   * Get storage metrics for a world.
   * Returns { worldSize, backupSize } in bytes.
   * Async: the directory walk runs on the libuv threadpool. A previous
   * synchronous walk blocked the main process for the entire traversal,
   * freezing every IPC handler (auth, launch, navigation) while the window
   * stayed visually responsive — a full launcher freeze triggered just by
   * opening the Worlds view.
   */
  async getWorldMetrics(worldId: string): Promise<{ worldSize: number; backupSize: number }> {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { worldSize: 0, backupSize: 0 };

    const root = this.resolveRoot(world);
    const backupDir = join(root, '..', 'backups');

    const [worldSize, backupSize] = await Promise.all([
      this.dirSize(root),
      this.dirSize(backupDir),
    ]);
    return { worldSize, backupSize };
  }

  /**
   * Check world health — lightweight validation.
   * Checks for level.dat in any save folder (if saves exist).
   * Returns 'healthy' | 'warning' | 'corrupted'.
   */
  checkWorldHealth(worldId: string): 'healthy' | 'warning' | 'corrupted' {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return 'corrupted';

    const root = this.resolveRoot(world);
    // A missing root means the world has never been launched (roots are
    // created on demand at launch time). An unlaunched world has nothing to
    // corrupt — reporting 'corrupted' here put a false CORRUPTED badge on
    // every fresh install.
    if (!existsSync(root)) return 'healthy';

    const savesDir = join(root, 'saves');
    if (!existsSync(savesDir)) return 'healthy'; // No saves = nothing to corrupt

    try {
      const saves = readdirSync(savesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      if (saves.length === 0) return 'healthy';

      // Check each save for level.dat
      let missingLevelDat = 0;
      for (const save of saves) {
        const levelDat = join(savesDir, save.name, 'level.dat');
        if (!existsSync(levelDat)) missingLevelDat++;
      }

      if (missingLevelDat === saves.length) return 'corrupted';
      if (missingLevelDat > 0) return 'warning';
      return 'healthy';
    } catch {
      return 'warning';
    }
  }

  /**
   * Create a backup of a world's saves directory.
   * Stores as {root}/../backups/{timestamp}.zip
   */
  backupWorld(worldId: string): { success: boolean; error?: string; backupPath?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };

    const root = this.resolveRoot(world);
    const savesDir = join(root, 'saves');
    const backupDir = join(root, '..', 'backups');

    if (!existsSync(savesDir) || readdirSync(savesDir).length === 0) {
      return { success: false, error: 'No saves to back up.' };
    }

    try {
      mkdirSync(backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(backupDir, `${timestamp}.zip`);

      // Use AdmZip (already in dependencies via java-provisioner)
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addLocalFolder(savesDir, 'saves');
      zip.writeZip(backupPath);

      console.log(`[worlds] Backup created for "${world.name}" at ${backupPath}`);
      return { success: true, backupPath };
    } catch (err) {
      console.error(`[worlds] Backup failed:`, err);
      return { success: false, error: 'Failed to create backup.' };
    }
  }

  /**
   * Get list of backups for a world.
   */
  getBackups(worldId: string): { name: string; date: number; size: number }[] {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return [];

    const root = this.resolveRoot(world);
    const backupDir = join(root, '..', 'backups');

    if (!existsSync(backupDir)) return [];

    try {
      return readdirSync(backupDir)
        .filter((f) => f.endsWith('.zip'))
        .map((name) => {
          const stat = statSync(join(backupDir, name));
          return { name, date: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.date - a.date);
    } catch {
      return [];
    }
  }

  // ── Filesystem helpers ──────────────────────────────────────────────

  /**
   * Restore a backup. Replaces the world's saves/ directory with the
   * contents of the backup ZIP. The current saves/ is moved to a
   * pre-restore folder first so the user can recover if the restore
   * is bad.
   */
  restoreWorld(worldId: string, backupName: string): { success: boolean; error?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };

    // Path-traversal guard: backupName comes from the renderer. Reject
    // traversal or path separators before it can escape the backups dir.
    if (backupName.includes('..') || backupName.includes('/') || backupName.includes('\\')) {
      throw new Error('Invalid backup name');
    }
    const root = this.resolveRoot(world);
    const backupDir = join(root, '..', 'backups');
    const backupPath = join(backupDir, backupName);
    const savesDir = join(root, 'saves');

    if (!existsSync(backupPath)) {
      return { success: false, error: 'Backup file not found.' };
    }

    try {
      // 1. Move current saves/ aside (pre-restore safety net)
      let preRestoreDir: string | null = null;
      if (existsSync(savesDir)) {
        preRestoreDir = join(root, 'saves.pre-restore');
        // Clean up any stale pre-restore dir from a previous failed restore
        if (existsSync(preRestoreDir)) {
          rmSync(preRestoreDir, { recursive: true, force: true });
        }
        renameSync(savesDir, preRestoreDir);
      }

      // 2. Extract backup into saves/
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(backupPath);
        mkdirSync(savesDir, { recursive: true });
        zip.extractAllTo(savesDir, true);

        // AdmZip extracts with the 'saves' folder prefix inside.
        // Move the inner saves/* up one level if needed.
        const innerSaves = join(savesDir, 'saves');
        if (existsSync(innerSaves)) {
          // Move contents of inner saves/ up to saves/
          const entries = readdirSync(innerSaves);
          for (const entry of entries) {
            renameSync(join(innerSaves, entry), join(savesDir, entry));
          }
          rmSync(innerSaves, { recursive: true, force: true });
        }

        console.log(`[worlds] Restored backup "${backupName}" for "${world.name}"`);
      } catch (extractErr) {
        // Restore failed — roll back to pre-restore state
        if (preRestoreDir && existsSync(preRestoreDir)) {
          if (existsSync(savesDir)) rmSync(savesDir, { recursive: true, force: true });
          renameSync(preRestoreDir, savesDir);
        }
        console.error('[worlds] Restore extraction failed:', extractErr);
        return { success: false, error: 'Backup is corrupted or unreadable.' };
      }

      // 3. Clean up pre-restore dir (success — no rollback needed)
      if (preRestoreDir && existsSync(preRestoreDir)) {
        rmSync(preRestoreDir, { recursive: true, force: true });
      }

      return { success: true };
    } catch (err) {
      console.error('[worlds] Restore failed:', err);
      return { success: false, error: 'Failed to restore backup.' };
    }
  }

  /**
   * Verify a backup file is valid.
   * Checks: exists, size > 0, readable as ZIP, contains level.dat.
   */
  verifyBackup(worldId: string, backupName: string): { success: boolean; verified: boolean; error?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, verified: false, error: 'World not found.' };

    const backupDir = join(this.resolveRoot(world), '..', 'backups');
    const backupPath = join(backupDir, backupName);

    // 1. File exists
    if (!existsSync(backupPath)) {
      return { success: false, verified: false, error: 'Backup file not found.' };
    }

    // 2. Size > 0
    try {
      const stat = statSync(backupPath);
      if (stat.size === 0) {
        return { success: false, verified: false, error: 'Backup file is empty.' };
      }
    } catch {
      return { success: false, verified: false, error: 'Cannot read backup file.' };
    }

    // 3. Readable as ZIP + contains level.dat
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(backupPath);
      const entries = zip.getEntries();

      // Check for level.dat anywhere in the archive
      const hasLevelDat = entries.some((e: any) =>
        e.entryName.endsWith('level.dat') && !e.isDirectory
      );

      if (!hasLevelDat) {
        return { success: true, verified: false, error: 'Backup missing level.dat — may be incomplete.' };
      }

      return { success: true, verified: true };
    } catch (err) {
      return { success: false, verified: false, error: 'Backup archive is corrupted.' };
    }
  }

  /**
   * Delete a specific backup file.
   */
  deleteBackup(worldId: string, backupName: string): { success: boolean; error?: string } {
    const world = this.registry.worlds.find((w) => w.id === worldId);
    if (!world) return { success: false, error: 'World not found.' };

    // Path-traversal guard (same rule as restoreWorld).
    if (backupName.includes('..') || backupName.includes('/') || backupName.includes('\\')) {
      throw new Error('Invalid backup name');
    }
    const backupDir = join(this.resolveRoot(world), '..', 'backups');
    const backupPath = join(backupDir, backupName);

    if (!existsSync(backupPath)) {
      return { success: false, error: 'Backup file not found.' };
    }

    try {
      unlinkSync(backupPath);
      console.log(`[worlds] Deleted backup "${backupName}" for "${world.name}"`);
      return { success: true };
    } catch (err) {
      console.error('[worlds] Failed to delete backup:', err);
      return { success: false, error: 'Failed to delete backup file.' };
    }
  }

  /**
   * Recursively copy a directory. Sync, used during duplication.
   */
  private copyDirSync(src: string, dest: string): void {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDirSync(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Recursively compute directory size in bytes.
   * Async (fs/promises): each readdir/stat hops to the libuv threadpool, so
   * large world trees never block the main process event loop.
   */
  private async dirSize(dirPath: string): Promise<number> {
    let stat;
    try {
      stat = await fspStat(dirPath);
    } catch {
      return 0; // missing/unreadable root = zero size (matches old behavior)
    }
    if (!stat.isDirectory()) return 0;

    let entries;
    try {
      entries = await fspReaddir(dirPath, { withFileTypes: true });
    } catch {
      return 0; // unreadable dir contributes nothing
    }

    let total = 0;
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await this.dirSize(full);
      } else {
        try {
          total += (await fspStat(full)).size;
        } catch { /* skip unreadable file */ }
      }
    }
    return total;
  }

  // ── Path Resolution ──────────────────────────────────────────────────

  /**
   * Resolve a world's rootPath template to an absolute filesystem path.
   * Supports {userData} placeholder.
   *
   * RED-TEAM HARDENED (wave 2, B1): rootPath is registry data — registry
   * data is attacker-controllable (a hand-edited or corrupt worlds.json
   * must never steer writes outside the user-data sandbox). Resolution is
   * therefore CONFINED: the joined path must stay inside userData. Any
   * escape (`..` segments, surrogate tricks) resolves to the managed
   * default root instead. Legal template output is byte-identical to the
   * pre-hardening join (verified by redteam + baseline suites).
   */
  resolveRoot(world: World): string {
    const base = app.getPath('userData');
    const raw = this.rawRoot(world);
    if (!raw.startsWith(base + sep)) {
      console.error(
        `[worlds] rootPath "${world.rootPath}" escapes the user-data sandbox — confining to the managed root`,
      );
      return join(base, 'minecraft');
    }
    return raw;
  }

  /** Unconfined template resolution — used ONLY to DETECT escapes (validation). */
  private rawRoot(world: World): string {
    const base = app.getPath('userData');
    const relative = world.rootPath.replace('{userData}', '');
    return join(base, relative);
  }

  // ── Registry Persistence (atomic) ────────────────────────────────

  private save(): void {
    // No lock is needed: JS runs this single-threaded and the write below is
    // synchronous, so two saves can never interleave. (The old spin-wait on
    // `this.writeLock` was decorative — a synchronous body can never observe
    // its own lock held.) Writes stay atomic via tmp+rename; a crash mid-write
    // leaves the .tmp orphaned but the real registry intact.
    try {
      const json = JSON.stringify(this.registry, null, 2);
      const tmpPath = this.registryPath + '.tmp';

      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.registryPath);
    } catch (err) {
      console.error('[worlds] Failed to save registry:', err);
    }
  }

  // ── Load + Migration + Validation ────────────────────────────────────

  private loadOrMigrate(): WorldRegistry {
    // Case 1: Registry exists — load and validate.
    if (existsSync(this.registryPath)) {
      try {
        const raw = readFileSync(this.registryPath, 'utf-8');
        const parsed = JSON.parse(raw) as WorldRegistry;

        // Schema version check — future migrations go here.
        if (parsed.schemaVersion !== SCHEMA_VERSION) {
          console.warn(`[worlds] Schema version ${parsed.schemaVersion} → ${SCHEMA_VERSION}. Migrating...`);
          return this.migrateRegistry(parsed);
        }

        // Validate: ensure managed world exists and active world is valid.
        return this.validateRegistry(parsed);
      } catch (err) {
        // Case 2: Registry corrupt — rename and re-migrate.
        console.error('[worlds] Registry corrupt, recovering:', err);
        this.backupCorruptRegistry();
        return this.migrateFromExisting();
      }
    }

    // Case 3: No registry — first launch or pre-PROD-006 user.
    return this.migrateFromExisting();
  }

  /**
   * Migrate from existing {userData}/minecraft/ directory.
   * Zero file movement — just registers the existing install as the managed world.
   */
  private migrateFromExisting(): WorldRegistry {
    const mcRoot = join(app.getPath('userData'), 'minecraft');
    const hasExistingInstall = existsSync(mcRoot);

    const managedWorld: World = {
      id: MANAGED_WORLD_ID,
      name: MANAGED_WORLD_CONFIG.name,
      type: 'managed' as WorldType,
      version: MANAGED_WORLD_CONFIG.version,
      loader: MANAGED_WORLD_CONFIG.loader,
      loaderVersion: MANAGED_WORLD_CONFIG.loaderVersion,
      rootPath: MANAGED_WORLD_CONFIG.rootPath,
      assignedServer: MANAGED_WORLD_CONFIG.assignedServer,
      // Managed world mods are code-owned (mod-data.ts) — not in registry.
      mods: [],
      resourcePacks: [],
      ramAllocation: MANAGED_WORLD_CONFIG.ramAllocation,
      resolution: null,
      javaPath: null,
      iconPath: null,
      createdAt: hasExistingInstall ? 0 : Date.now(),
      lastPlayedAt: null,
      imported: false,
      // The managed world is NEVER broken on the basis of a missing root:
      // its {userData}/minecraft directory is created on demand at launch
      // (launch-service mkdirs it recursively). Flagging it broken on a
      // fresh install silently rejected switching TO the managed world —
      // the root cause of the "managed switching is inconsistent" bug.
      broken: false,
    };

    const registry: WorldRegistry = {
      schemaVersion: SCHEMA_VERSION,
      activeWorldId: MANAGED_WORLD_ID,
      worlds: [managedWorld],
    };

    console.log(`[worlds] Migration complete — 1 managed world registered (existing install: ${hasExistingInstall})`);

    // Persist the new registry.
    this.registry = registry;
    this.save();

    return registry;
  }

  /**
   * Validate the loaded registry:
   * 1. Ensure managed world exists (create if missing).
   * 2. Ensure activeWorldId is valid (fall back to managed).
   * 3. Check personal world root paths exist (mark broken if not).
   */
  private validateRegistry(reg: WorldRegistry): WorldRegistry {
    let changed = false;

    // 1. Ensure managed world exists.
    if (!reg.worlds.some((w) => w.type === 'managed')) {
      console.warn('[worlds] Managed world missing — recreating from defaults');
      const managedWorld: World = {
        id: MANAGED_WORLD_ID,
        name: MANAGED_WORLD_CONFIG.name,
        type: 'managed' as WorldType,
        version: MANAGED_WORLD_CONFIG.version,
        loader: MANAGED_WORLD_CONFIG.loader,
        loaderVersion: MANAGED_WORLD_CONFIG.loaderVersion,
        rootPath: MANAGED_WORLD_CONFIG.rootPath,
        assignedServer: MANAGED_WORLD_CONFIG.assignedServer,
        mods: [],
        resourcePacks: [],
        ramAllocation: MANAGED_WORLD_CONFIG.ramAllocation,
      resolution: null,
        javaPath: null,
        iconPath: null,
        createdAt: 0,
        lastPlayedAt: null,
        imported: false,
        broken: false,
      };
      reg.worlds.unshift(managedWorld);
      changed = true;
    }

    // 1b. Self-heal: a managed world is never broken (root is created at
    // launch). Clears the flag on registries written by the earlier build
    // that wrongly marked the managed world broken on fresh installs.
    const managed = reg.worlds.find((w) => w.type === 'managed');
    if (managed && managed.broken) {
      console.warn('[worlds] Clearing spurious broken flag on managed world');
      managed.broken = false;
      changed = true;
    }

    // 1c. Confinement quarantine (red-team B1): a registry entry whose
    // rootPath escapes the user-data sandbox is CORRUPT data — it must
    // never become the launch root. resolveRoot confines resolution as
    // belt; this pass repairs the REGISTRY as suspenders, so the UI shows
    // the truth (broken) instead of silently redirecting.
    for (const world of reg.worlds) {
      const legal = this.rawRoot(world).startsWith(app.getPath('userData') + sep);
      if (!legal && !world.broken) {
        console.error(`[worlds] World "${world.name}" rootPath escapes the sandbox — quarantining`);
        world.broken = true;
        changed = true;
      }
    }

    // 2. Validate activeWorldId. A broken world is equally unusable — an
    // active-but-broken id would put every launch/mutation on a dead root.
    const activeWorld = reg.worlds.find((w) => w.id === reg.activeWorldId);
    if (!activeWorld || activeWorld.broken) {
      console.warn(`[worlds] Active world "${reg.activeWorldId}" unusable — falling back to managed`);
      reg.activeWorldId = MANAGED_WORLD_ID;
      changed = true;
    }

    // 3. Check personal world root paths.
    for (const world of reg.worlds) {
      if (world.type === 'personal') {
        const root = this.resolveRoot(world);
        const rootExists = existsSync(root);
        if (!rootExists && !world.broken) {
          console.warn(`[worlds] World "${world.name}" root missing — marking broken`);
          world.broken = true;
          changed = true;
        }
      }
    }

    if (changed) {
      this.registry = reg;
      this.save();
    }

    return reg;
  }

  /**
   * Future schema migrations go here.
   * Currently a no-op since we're on schema version 1.
   */
  private migrateRegistry(reg: WorldRegistry): WorldRegistry {
    // When schemaVersion 2 exists:
    // if (reg.schemaVersion === 1) { reg = migrate_v1_to_v2(reg); }
    // if (reg.schemaVersion === 2) { reg = migrate_v2_to_v3(reg); }
    // etc.
    reg.schemaVersion = SCHEMA_VERSION;
    return this.validateRegistry(reg);
  }

  /**
   * Rename corrupt registry to .corrupt-{timestamp} for manual recovery.
   */
  private backupCorruptRegistry(): void {
    try {
      const backupPath = `${this.registryPath}.corrupt-${Date.now()}`;
      renameSync(this.registryPath, backupPath);
      console.warn(`[worlds] Corrupt registry backed up to ${backupPath}`);
    } catch {
      // If rename fails (file locked), try unlink.
      try { unlinkSync(this.registryPath); } catch { /* ignore */ }
    }
  }
}