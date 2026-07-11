export interface MinecraftProfile {
  id: string;
  name: string;
  accessToken: string;
}

export interface LauncherConfig {
  minecraftPath: string;
  ramAllocation: number;
  javaPath: string;
}

export interface ServerStatus {
  online: boolean;
  playersOnline: number;
  maxPlayers: number;
  version: string;
  tps?: number;
}

export interface Mod {
  name: string;
  version: string;
  url: string;
  checksum: string;
}

export enum AppView {
  Auth = 'Auth',
  Play = 'Play',
  Settings = 'Settings',
  Dashboard = 'Dashboard',
}

// ── PROD-006: Worlds System ────────────────────────────────────────────

export type WorldType = 'managed' | 'personal';
export type LoaderType = 'vanilla' | 'fabric' | 'forge' | 'quilt';
export type ModProvider = 'modrinth' | 'curseforge' | 'local';
export type HashFormat = 'sha1' | 'sha512' | null;

export interface WorldServer {
  ip: string;
  port: number;
  label?: string;
}

/**
 * Mod metadata for personal worlds. Managed worlds derive their mod list
 * from mod-data.ts (code-owned), not from this registry.
 *
 * Identifiers use a Record<string, string> so each provider can use
 * whatever ID scheme they need (Modrinth: projectId+versionId,
 * CurseForge: projectId+fileId) without schema changes.
 */
export interface WorldMod {
  filename: string;
  name: string | null;
  enabled: boolean;
  source: {
    provider: ModProvider;
    identifiers: Record<string, string>;
    /** Cached download URL — fast path. If stale, fall back to API resolve. */
    url: string | null;
  };
  hash: string | null;
  hashFormat: HashFormat;
}

export interface WorldResourcePack {
  filename: string;
  name: string | null;
  enabled: boolean;
  source: {
    provider: ModProvider;
    identifiers: Record<string, string>;
    url: string | null;
  };
  hash: string | null;
  hashFormat: HashFormat;
}

export interface World {
  id: string;
  name: string;
  type: WorldType;
  version: string;
  loader: LoaderType;
  loaderVersion: string;
  /** Root template — resolved at runtime. E.g. "{userData}/minecraft" */
  rootPath: string;
  assignedServer: WorldServer | null;
  /** Personal worlds only. Managed worlds use mod-data.ts. */
  mods: WorldMod[];
  resourcePacks: WorldResourcePack[];
  ramAllocation: number;
  /** null = use global provisioned JRE */
  javaPath: string | null;
  iconPath: string | null;
  createdAt: number;
  lastPlayedAt: number | null;
  imported: boolean;
  importSource?: 'prism' | 'multimc' | 'manual';
  broken: boolean;
}

export interface WorldRegistry {
  schemaVersion: number;
  activeWorldId: string | null;
  worlds: World[];
}

// ── Identity Management ─────────────────────────────────────────────────

export interface Account {
  id: string;
  type: 'microsoft' | 'offline';
  username: string;
  uuid?: string;
  email?: string;
  avatarUrl?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface Session {
  accountId: string;
  authenticated: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  lastValidatedAt?: string;
}

export interface SkinProfile {
  accountId: string;
  skinUrl?: string;
  model: 'classic' | 'slim';
  updatedAt?: string;
}

export interface IdentityState {
  accounts: Account[];
  activeAccountId?: string;
  sessions: Record<string, Session>;
}