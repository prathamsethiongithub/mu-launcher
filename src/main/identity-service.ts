import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { Auth, Xbox, Minecraft } from 'msmc';
// Static import — NEVER require() sibling modules here: the main process is
// bundled into a single out/main/index.js, so runtime require('./x') throws
// MODULE_NOT_FOUND. That silent throw was why every skin came back null.
import { SkinService } from './skin-service';
import type { Account, Session, SkinProfile, IdentityState } from '../shared/types';

const IDENTITY_FILE = 'identity.json';
const TOKENS_FILE = 'identity-tokens.bin';

/**
 * IdentityService — owns the account registry, sessions, and skin state.
 *
 * Storage:
 *  - identity.json: accounts + activeAccountId + skin profiles (no tokens)
 *  - identity-tokens.bin: encrypted session tokens (safeStorage)
 *
 * This service coexists with the existing AuthService. The existing
 * AuthService handles the MSMC OAuth flow for launches; IdentityService
 * wraps it with multi-account management, offline accounts, and skin ops.
 */
export class IdentityService {
  private state: IdentityState;
  private statePath: string;
  private tokensPath: string;
  private encryptedTokens: Map<string, Session> = new Map();
  private skinService = new SkinService();

  constructor() {
    const userData = app.getPath('userData');
    this.statePath = join(userData, IDENTITY_FILE);
    this.tokensPath = join(userData, TOKENS_FILE);
    this.state = this.loadState();
    this.loadTokens();
  }

  // ── Public API: Accounts ────────────────────────────────────────────

  getAccounts(): Account[] {
    return this.state.accounts;
  }

  getActiveAccount(): Account | null {
    if (!this.state.activeAccountId) return null;
    return this.state.accounts.find((a) => a.id === this.state.activeAccountId) ?? null;
  }

  setActiveAccount(accountId: string): { success: boolean; error?: string } {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found.' };
    account.lastUsedAt = new Date().toISOString();
    this.state.activeAccountId = accountId;
    this.saveState();
    return { success: true };
  }

  removeAccount(accountId: string): { success: boolean; error?: string } {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found.' };

    this.state.accounts = this.state.accounts.filter((a) => a.id !== accountId);
    delete this.state.sessions[accountId];
    this.encryptedTokens.delete(accountId);

    if (this.state.activeAccountId === accountId) {
      this.state.activeAccountId = this.state.accounts[0]?.id;
    }

    this.saveState();
    this.saveTokens();
    return { success: true };
  }

  /**
   * Sign out of an account: drop its session + tokens but KEEP the account
   * in the registry (unlike removeAccount). Signing back in re-attaches
   * tokens to the same entry via the duplicate-UUID path in
   * addMicrosoftAccount.
   */
  signOut(accountId: string): { success: boolean; error?: string } {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found.' };
    if (account.type === 'offline') {
      return { success: false, error: 'Offline accounts have no session to sign out of.' };
    }

    delete this.state.sessions[accountId];
    this.encryptedTokens.delete(accountId);
    this.saveState();
    this.saveTokens();

    console.log(`[identity] Signed out "${account.username}" (${accountId})`);
    return { success: true };
  }

  /**
   * Import a session from an external source — typically the legacy
   * AuthService on startup. Creates or updates the matching Identity
   * account and populates encryptedTokens so that every operation
   * (uploadSkin, validateSession, refresh, etc.) works from the same
   * canonical token store.
   *
   * This is NOT a migration. It runs on every startup and is the ONLY
   * bridge between the two session systems. Once populated, IdentityService
   * owns the session for all subsequent operations.
   */
  importSession(
    profile: { uuid: string; name: string },
    refreshToken: string,
    accessToken?: string,
  ): void {
    // 1. Find or create the Identity account matching this profile.
    let account = this.state.accounts.find(
      (a) => a.type === 'microsoft' && a.uuid === profile.uuid,
    );
    if (!account) {
      account = {
        id: randomUUID(),
        type: 'microsoft',
        username: profile.name,
        uuid: profile.uuid,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };
      this.state.accounts.push(account);
      this.state.activeAccountId = account.id;
      this.saveState();
    }

    // 2. Populate encryptedTokens if empty (idempotent — doesn't
    //    overwrite an already-populated store).
    if (this.encryptedTokens.has(account.id)) return;

    const session: Session = {
      accountId: account.id,
      authenticated: true,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      lastValidatedAt: new Date().toISOString(),
    };
    this.encryptedTokens.set(account.id, session);
    this.saveTokens();

    console.log(`[identity] Session imported for "${profile.name}" (${account.id})`);
  }

  // ── Microsoft Account ───────────────────────────────────────────────

  /**
   * Add a Microsoft account via MSMC Electron popup.
   * Returns a promise that resolves when the popup flow completes.
   * The caller should call this in a fire-and-forget pattern and poll
   * getAccounts() to detect when the account appears.
   */
  async addMicrosoftAccount(): Promise<{ success: boolean; account?: Account; error?: string }> {
    try {
      const authManager = new Auth('select_account');
      const xbox = await authManager.launch('electron', {
        width: 500,
        height: 650,
        resizable: false,
      });
      const minecraft = await xbox.getMinecraft();
      const profile = minecraft.profile as { id: string; name: string };

      // Check for duplicate (same UUID)
      const existing = this.state.accounts.find(
        (a) => a.uuid === profile.id && a.type === 'microsoft'
      );
      if (existing) {
        // Update tokens on existing account
        this.updateSession(existing.id, xbox, minecraft);
        this.state.activeAccountId = existing.id;
        existing.lastUsedAt = new Date().toISOString();
        this.saveState();
        this.saveTokens();
        return { success: true, account: existing };
      }

      const account: Account = {
        id: randomUUID(),
        type: 'microsoft',
        username: profile.name,
        uuid: profile.id,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      };

      this.state.accounts.push(account);
      this.state.activeAccountId = account.id;
      this.updateSession(account.id, xbox, minecraft);
      this.saveState();
      this.saveTokens();

      console.log(`[identity] Added Microsoft account "${profile.name}" (${account.id})`);
      return { success: true, account };
    } catch (err) {
      console.error('[identity] Microsoft login failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Login failed.' };
    }
  }

  // ── Offline Account ─────────────────────────────────────────────────

  addOfflineAccount(username: string): { success: boolean; account?: Account; error?: string } {
    const trimmed = username.trim();
    if (!trimmed) return { success: false, error: 'Username cannot be empty.' };
    if (trimmed.length > 16) return { success: false, error: 'Username must be 16 characters or fewer.' };

    // Generate a stable offline UUID from username
    const offlineUuid = this.generateOfflineUUID(trimmed);

    // Check for duplicate
    const existing = this.state.accounts.find(
      (a) => a.uuid === offlineUuid && a.type === 'offline'
    );
    if (existing) return { success: false, error: `Offline account "${trimmed}" already exists.` };

    const account: Account = {
      id: randomUUID(),
      type: 'offline',
      username: trimmed,
      uuid: offlineUuid,
      createdAt: new Date().toISOString(),
    };

    this.state.accounts.push(account);

    // Offline session — always "authenticated" for launch purposes
    this.state.sessions[account.id] = {
      accountId: account.id,
      authenticated: true,
      lastValidatedAt: new Date().toISOString(),
    };

    if (!this.state.activeAccountId) {
      this.state.activeAccountId = account.id;
    }

    this.saveState();
    console.log(`[identity] Added offline account "${trimmed}" (${account.id})`);
    return { success: true, account };
  }

  // ── Session Management ──────────────────────────────────────────────

  getSession(accountId: string): Session | null {
    return this.state.sessions[accountId] ?? null;
  }

  /**
   * Validate the session for an account.
   * For Microsoft accounts: checks token expiry, refreshes if needed.
   * For offline accounts: always valid.
   */
  async validateSession(accountId: string): Promise<{ valid: boolean; error?: string }> {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) return { valid: false, error: 'Account not found.' };

    if (account.type === 'offline') {
      return { valid: true };
    }

    const session = this.encryptedTokens.get(accountId);
    if (!session || !session.refreshToken) {
      return { valid: false, error: 'No session tokens. Please sign in again.' };
    }

    // Check expiry
    if (session.expiresAt) {
      const expires = new Date(session.expiresAt).getTime();
      if (Date.now() >= expires) {
        // Try refresh
        try {
          await this.refreshMicrosoftSession(accountId);
          return { valid: true };
        } catch (err) {
          return { valid: false, error: 'Session expired. Please sign in again.' };
        }
      }
    }

    // Update lastValidatedAt
    if (session) {
      session.lastValidatedAt = new Date().toISOString();
      this.encryptedTokens.set(accountId, session);
      this.saveTokens();
    }

    return { valid: true };
  }

  /**
   * Ensure the active account has a valid session before launch.
   * Returns the MCLC auth object or throws.
   */
  async ensureValidSession(): Promise<{ access_token: string; uuid: string; name: string } | null> {
    const account = this.getActiveAccount();
    if (!account) return null;

    if (account.type === 'offline') {
      // Offline accounts use a dummy token — MCLC accepts this for offline mode
      return {
        access_token: 'offline',
        uuid: account.uuid || '',
        name: account.username,
      };
    }

    const validation = await this.validateSession(account.id);
    if (!validation.valid) {
      throw new Error(validation.error || 'Session invalid.');
    }

    const session = this.encryptedTokens.get(account.id);
    if (!session || !session.accessToken) {
      return null;
    }

    return {
      access_token: session.accessToken,
      uuid: account.uuid || '',
      name: account.username,
    };
  }

  // ── Skin Management ─────────────────────────────────────────────────

  /**
   * Get the current skin for an account.
   * Uses the existing SkinService for Microsoft accounts (Mojang → Crafatar).
   * For offline accounts, returns null (no skin).
   * `force` bypasses the 24h skin cache (Refresh in the Identity Studio).
   */
  async getSkin(accountId: string, opts?: { force?: boolean }): Promise<SkinProfile | null> {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account || account.type === 'offline' || !account.uuid) return null;

    try {
      const result = await this.skinService.getSkin(account.uuid, opts);
      if (!result) return null;

      return {
        accountId,
        skinUrl: result.dataUrl,
        model: result.model === 'slim' ? 'slim' : 'classic',
        updatedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Upload a skin PNG to the player's Minecraft profile.
   *
   * The path must come from the main process's own file dialog (see the
   * 'select-skin-file' IPC) — the renderer never supplies filesystem paths.
   * Uses the current Minecraft services API with native FormData/Blob
   * (no form-data package). On success the uploaded PNG is written straight
   * into the skin cache so the launcher reflects it immediately instead of
   * waiting on Mojang CDN propagation. Retries once through a token refresh
   * if the session has gone stale.
   */
  async uploadSkin(
    accountId: string,
    skinPath: string,
    model: 'classic' | 'slim'
  ): Promise<{ success: boolean; error?: string; skin?: SkinProfile }> {
    const account = this.state.accounts.find((a) => a.id === accountId);
    if (!account) return { success: false, error: 'Account not found.' };
    if (account.type === 'offline') {
      return { success: false, error: 'Offline accounts can’t change skins — skins live on your Microsoft account.' };
    }

    let skinData: Buffer;
    try {
      skinData = readFileSync(skinPath);
    } catch {
      return { success: false, error: 'Could not read the selected file.' };
    }

    const postSkin = async (token: string): Promise<Response> => {
      const form = new FormData();
      form.append('variant', model);
      form.append('file', new Blob([new Uint8Array(skinData)], { type: 'image/png' }), 'skin.png');
      return fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    };

    try {
      const session = this.encryptedTokens.get(accountId);
      if (!session?.accessToken) {
        return { success: false, error: 'No active session. Please sign in again.' };
      }

      let response = await postSkin(session.accessToken);

      // Stale token → refresh once and retry.
      if (response.status === 401) {
        try {
          await this.refreshMicrosoftSession(accountId);
        } catch {
          return { success: false, error: 'Session expired. Please sign in again.' };
        }
        const fresh = this.encryptedTokens.get(accountId);
        if (!fresh?.accessToken) {
          return { success: false, error: 'Session expired. Please sign in again.' };
        }
        response = await postSkin(fresh.accessToken);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('[identity] Skin upload failed:', response.status, text);
        return { success: false, error: `Upload failed (${response.status}). Mojang may be rate-limiting — try again in a minute.` };
      }

      // The uploaded file IS the new skin — cache it locally so every view
      // (hero, studio) shows it instantly.
      const skinModel = model === 'slim' ? 'slim' : 'default';
      const cached = account.uuid
        ? this.skinService.putCache(account.uuid, skinData, skinModel)
        : null;

      console.log(`[identity] Skin uploaded for "${account.username}"`);
      return {
        success: true,
        skin: {
          accountId,
          skinUrl: cached?.dataUrl ?? `data:image/png;base64,${skinData.toString('base64')}`,
          model,
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      console.error('[identity] Skin upload error:', err);
      return { success: false, error: 'Failed to upload skin. Check your connection and try again.' };
    }
  }

  // ── Internal: Session Token Management ──────────────────────────────

  private updateSession(accountId: string, xbox: Xbox, minecraft: Minecraft): void {
    const refreshToken = xbox.save();
    const mcToken = minecraft.mclc().access_token;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const session: Session = {
      accountId,
      authenticated: true,
      accessToken: mcToken,
      refreshToken,
      expiresAt,
      lastValidatedAt: new Date().toISOString(),
    };

    this.state.sessions[accountId] = {
      accountId,
      authenticated: true,
      expiresAt,
      lastValidatedAt: session.lastValidatedAt,
    };

    this.encryptedTokens.set(accountId, session);
  }

  private async refreshMicrosoftSession(accountId: string): Promise<void> {
    const session = this.encryptedTokens.get(accountId);
    if (!session || !session.refreshToken) {
      throw new Error('No refresh token.');
    }

    const authManager = new Auth('select_account');
    const xbox = await authManager.refresh(session.refreshToken);
    const minecraft = await xbox.getMinecraft();

    this.updateSession(accountId, xbox, minecraft);
    this.saveTokens();
  }

  private generateOfflineUUID(username: string): string {
    // Minecraft's offline UUID: UUID v3 with "OfflinePlayer:" + username
    const hash = createHash('md5').update('OfflinePlayer:' + username).digest();
    // Set version 3 and variant
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadState(): IdentityState {
    if (existsSync(this.statePath)) {
      try {
        const raw = readFileSync(this.statePath, 'utf-8');
        return JSON.parse(raw) as IdentityState;
      } catch {
        // Corrupt — start fresh
      }
    }
    return { accounts: [], sessions: {} };
  }

  private saveState(): void {
    try {
      // Don't persist tokens in the state file — only metadata
      const safeState: IdentityState = {
        accounts: this.state.accounts,
        activeAccountId: this.state.activeAccountId,
        sessions: this.state.sessions,
      };
      const tmp = this.statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(safeState, null, 2), 'utf-8');
      renameSync(tmp, this.statePath);
    } catch (err) {
      console.error('[identity] Failed to save state:', err);
    }
  }

  private loadTokens(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[identity] safeStorage not available — tokens will not persist');
      return;
    }
    if (!existsSync(this.tokensPath)) return;
    try {
      const encrypted = readFileSync(this.tokensPath);
      const decrypted = safeStorage.decryptString(encrypted);
      const tokens = JSON.parse(decrypted) as Record<string, Session>;
      for (const [id, session] of Object.entries(tokens)) {
        this.encryptedTokens.set(id, session);
      }
    } catch (err) {
      console.error('[identity] Failed to load tokens:', err);
    }
  }

  private saveTokens(): void {
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      const tokens: Record<string, Session> = {};
      this.encryptedTokens.forEach((session, id) => {
        tokens[id] = session;
      });
      const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
      writeFileSync(this.tokensPath, encrypted);
    } catch (err) {
      console.error('[identity] Failed to save tokens:', err);
    }
  }
}