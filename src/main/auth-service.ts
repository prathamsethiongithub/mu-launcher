import { Auth, Xbox, Minecraft } from 'msmc';
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { SkinService } from './skin-service';

export interface AuthProfile {
  uuid: string;
  name: string;
  accessToken: string;
}

export class AuthService {
  private authManager: Auth;
  private currentToken: Xbox | null = null;
  private currentProfile: AuthProfile | null = null;
  private loginPromise: Promise<AuthProfile> | null = null;

  // Saved refresh token string from disk — reconstructed on demand.
  private savedRefreshToken: string | null = null;

  constructor() {
    this.authManager = new Auth('select_account');
    this.restoreSession();
  }

  /**
   * Starts the Microsoft OAuth login flow using MSMC's Electron popup mode.
   * Opens a small BrowserWindow with the Microsoft login page.
   * Uses the default registered redirect URI (https://login.live.com/oauth20_desktop.srf)
   * to avoid the redirect_uri mismatch that occurs with setServer() + localhost.
   * Returns the auth profile once the user completes authentication.
   */
  async login(): Promise<AuthProfile> {
    // Return existing profile if already logged in
    if (this.currentProfile) {
      return this.currentProfile;
    }

    // Return existing login promise if one is in progress
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = new Promise<AuthProfile>(async (resolve, reject) => {
      try {
        // Step 1: Open Electron popup for Microsoft login
        const xboxToken: Xbox = await this.authManager.launch('electron', {
          width: 500,
          height: 650,
          resizable: false,
          title: 'Sign in with Microsoft',
        });

        // Step 2: Get Minecraft auth token from Xbox token
        const minecraft: Minecraft = await xboxToken.getMinecraft();

        // Step 3: Verify Java Edition ownership
        try {
          const mclcCheck = minecraft.mclc();
          if (!mclcCheck.uuid || mclcCheck.uuid === '00000000-0000-0000-0000-000000000000') {
            reject(
              new Error(
                '[E101] This Microsoft account does not own Minecraft Java Edition. ' +
                  'Please purchase the game at https://minecraft.net before launching.',
              ),
            );
            return;
          }
        } catch (mclcErr) {
          reject(
            new Error(
              '[E102] Unable to verify Minecraft Java Edition ownership. ' +
                'Your account may not own Java Edition or the authentication servers are temporarily unavailable. ' +
                'Please try signing in again.',
            ),
          );
          return;
        }

        // Step 4: Get MCLC-compatible auth object
        const mclc = minecraft.mclc();

        // Step 5: Store tokens and profile
        this.currentToken = xboxToken;
        this.currentProfile = {
          uuid: mclc.uuid,
          name: mclc.name || 'Player',
          accessToken: mclc.access_token,
        };

        // Step 6: Persist session to disk
        await this.persistSession();

        resolve(this.currentProfile);
      } catch (err) {
        this.loginPromise = null;
        const msg = String(err);

        // Handle user closing the popup
        if (msg.includes('error.gui.closed') || msg.includes('closed') || msg.includes('cancel')) {
          reject(new Error('[E108] Sign in was cancelled.'));
          return;
        }

        reject(
          new Error(
            '[E103] Microsoft sign in failed. Please try again. (' + msg.slice(0, 100) + ')',
          ),
        );
      }
    });

    return this.loginPromise;
  }

  /**
   * Logs out by clearing all stored tokens.
   */
  async logout(): Promise<void> {
    this.currentToken = null;
    this.currentProfile = null;
    this.loginPromise = null;
    this.savedRefreshToken = null;

    // Clear the persisted session
    this.clearSession();

    // Clear the skin cache so the next sign-in fetches a fresh skin
    try {
      new SkinService().clearAll();
    } catch { /* non-fatal */ }
  }

  /**
   * Adopts a session that was created OUTSIDE this service — e.g. the
   * Account tab's IdentityService sign-in — as the legacy launch session.
   * This is the reverse half of the sign-in synchronization bridge: after
   * an Account-tab sign-in, the legacy session (which Play, get-skin, and
   * launch resolution read via resolvePlayerIdentity) must name the SAME
   * account, or Play keeps showing "Almost there." until restart.
   *
   * Replaces any prior session (that session's owner already lost the
   * single legacy slot; their IdentityService record and tokens are
   * untouched and stay switchable) and persists through the existing
   * safeStorage format — no new token flows are invented. After this,
   * state mirrors a restoreSession()-style cold start: profile in memory,
   * refresh token saved, currentToken null until ensureValidAuth()
   * reconstructs the Xbox chain on the next launch.
   */
  async adoptExternalSession(
    profile: { uuid: string; name: string },
    refreshToken: string,
    accessToken?: string,
  ): Promise<void> {
    // Drop any prior session first — clearSession() removes the old
    // persisted auth-session.bin so the new persistSession() starts clean.
    this.currentToken = null;
    this.currentProfile = null;
    this.savedRefreshToken = null;
    this.clearSession();

    this.currentProfile = {
      uuid: profile.uuid,
      name: profile.name,
      accessToken: accessToken || '',
    };
    this.savedRefreshToken = refreshToken;
    await this.persistSession();
    console.log('[auth] Adopted external session for', profile.name);
  }

  /**
   * Returns the current authenticated profile.
   */
  getProfile(): AuthProfile | null {
    return this.currentProfile;
  }

  /**
   * Returns whether the user is currently logged in.
   */
  isLoggedIn(): boolean {
    return this.currentProfile !== null;
  }

  /**
   * Ensure a valid auth session exists by reconstructing and refreshing
   * the Xbox token chain from the saved refresh token if needed.
   *
   * Called before every launch to guarantee the Minecraft access token
   * is not stale. If the Xbox token is still valid, this is a no-op.
   */
  async ensureValidAuth(): Promise<void> {
    // Already have an Xbox token in memory — fast path
    if (this.currentToken) {
      // Xbox.refresh() is a no-op if the token is still valid (< 1 hour old).
      // This is safe to call every launch.
      await this.currentToken.refresh();
      return;
    }

    // No Xbox token in memory but we have a saved refresh token — reconstruct
    if (this.savedRefreshToken) {
      try {
        // Reconstruct the Xbox token from the saved refresh token
        this.currentToken = await this.authManager.refresh(this.savedRefreshToken);

        // Get a fresh Minecraft token
        const minecraft = await this.currentToken.getMinecraft();
        const mclc = minecraft.mclc();

        this.currentProfile = {
          uuid: mclc.uuid,
          name: mclc.name || 'Player',
          accessToken: mclc.access_token,
        };

        // Persist the freshly-negotiated tokens
        await this.persistSession();
        return;
      } catch {
        // Token refresh failed — likely expired. Clear session and let the
        // caller (getAuthorizationForMCLC) return null, which prompts re-login.
        this.currentToken = null;
        this.currentProfile = null;
        this.savedRefreshToken = null;
        this.clearSession();
      }
    }
  }

  /**
   * Attempts a silent token refresh if a previous token exists.
   */
  async refreshToken(): Promise<void> {
    if (!this.currentToken) {
      throw new Error('[E106] No authentication session to refresh. Please sign in first.');
    }

    try {
      // Refresh the Xbox token
      const refreshedToken = await this.currentToken.refresh();

      // Get updated Minecraft auth
      const minecraft = await refreshedToken.getMinecraft();
      const mclc = minecraft.mclc();

      this.currentToken = refreshedToken;
      this.currentProfile = {
        uuid: mclc.uuid,
        name: mclc.name || 'Player',
        accessToken: mclc.access_token,
      };
    } catch (err) {
      throw new Error(
        '[E107] Authentication token refresh failed. Your session may have expired. Please sign in again.',
      );
    }
  }

  /**
   * Returns just the MCLC-compatible auth object.
   * Used by the launch orchestrator to get auth for MCLC.
   * Calls ensureValidAuth() first to guarantee fresh tokens.
   */
  async getAuthorizationForMCLC(): Promise<{ access_token: string; uuid: string; name: string } | null> {
    await this.ensureValidAuth();

    if (!this.currentProfile) {
      return null;
    }

    return {
      access_token: this.currentProfile.accessToken,
      uuid: this.currentProfile.uuid,
      name: this.currentProfile.name,
    };
  }

  // ── Session Exports ─────────────────────────────────────────────

  /**
   * Expose the current profile for IdentityService session import.
   * Returns null if no session is available.
   */
  getProfileForImport(): { uuid: string; name: string } | null {
    if (!this.currentProfile) return null;
    return { uuid: this.currentProfile.uuid, name: this.currentProfile.name };
  }

  /**
   * Expose the saved refresh token for IdentityService token hydration.
   * Returns null if no persisted session exists.
   */
  getRefreshToken(): string | null {
    return this.savedRefreshToken;
  }

  /**
   * Expose the current Minecraft access token.
   * Needed by IdentityService to build a complete session.
   */
  getAccessToken(): string | null {
    return this.currentProfile?.accessToken ?? null;
  }

  // ── Session Persistence ──────────────────────────────────────────

  private static readonly SESSION_FILE = 'auth-session.bin';

  private getSessionFilePath(): string {
    return join(app.getPath('userData'), AuthService.SESSION_FILE);
  }

  /**
   * Persist the current auth profile to disk so the user doesn't need
   * to re-authenticate on every launch.
   * Uses Electron safeStorage encryption when available.
   * Also saves the MS OAuth refresh token for session reconstruction.
   */
  async persistSession(): Promise<void> {
    if (!this.currentProfile) return;

    const data: Record<string, unknown> = {
      profile: this.currentProfile,
    };

    // Save the MS OAuth refresh token so we can reconstruct the Xbox
    // token chain on cold boot without forcing re-authentication.
    // Xbox.save() returns this.msToken.refresh_token (a plain string).
    if (this.currentToken) {
      data.refreshToken = this.currentToken.save();
    }

    const filePath = this.getSessionFilePath();
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const json = JSON.stringify(data);

      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(json);
        writeFileSync(filePath, encrypted);
        console.log('[auth] Session persisted (encrypted)');
      } else {
        writeFileSync(filePath, json, 'utf-8');
        console.log('[auth] Session persisted (unencrypted)');
      }
    } catch (err) {
      console.error('[auth] Failed to persist session:', err);
    }
  }

  /**
   * Restore auth profile from disk on service startup.
   * Returns true if a valid session was restored.
   * NOTE: Synchronous — called from constructor; must complete before any IPC handler fires.
   */
  restoreSession(): boolean {
    const filePath = this.getSessionFilePath();
    if (!existsSync(filePath)) return false;

    try {
      let json: string;

      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = readFileSync(filePath);
        json = safeStorage.decryptString(encrypted);
      } else {
        json = readFileSync(filePath, 'utf-8');
      }

      const data = JSON.parse(json);
      if (data.profile?.accessToken && data.profile?.uuid && data.profile?.name) {
        this.currentProfile = {
          uuid: data.profile.uuid,
          name: data.profile.name,
          accessToken: data.profile.accessToken,
        };

        // Store the refresh token for later reconstruction of the Xbox chain.
        // currentToken stays null — it will be reconstructed in ensureValidAuth()
        // the first time the user clicks Play.
        this.savedRefreshToken = data.refreshToken || null;

        console.log('[auth] Session restored for', data.profile.name);
        return true;
      }
    } catch (err) {
      console.error('[auth] Failed to restore session, clearing:', err);
      // Corrupt file — delete it
      try {
        unlinkSync(filePath);
      } catch { /* ignore */ }
    }

    return false;
  }

  /**
   * Clear persisted session (used during logout).
   */
  clearSession(): void {
    try {
      const filePath = this.getSessionFilePath();
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (err) {
      console.error('[auth] Failed to clear session:', err);
    }
  }

  /**
   * Returns true only if the legacy persisted session file still exists.
   * Used after clearSession() during account removal to verify the legacy
   * session was actually cleared — without this, a failed unlink would
   * look like success and the startup bridge would resurrect the removed
   * account on the next launch.
   */
  hasPersistedSession(): boolean {
    try {
      return existsSync(this.getSessionFilePath());
    } catch {
      return false;
    }
  }
}
