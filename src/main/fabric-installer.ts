import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { timedFetch } from './net';

export class FabricInstaller {
  private mcVersion: string = '26.1.2';
  private loaderVersion: string = '0.19.3';
  private versionsDir: string;

  constructor(mcVersion?: string, loaderVersion?: string, versionsDir?: string) {
    if (mcVersion !== undefined) {
      this.mcVersion = mcVersion;
    }
    if (loaderVersion !== undefined) {
      this.loaderVersion = loaderVersion;
    }
    this.versionsDir = versionsDir || path.join(app.getPath('userData'), 'minecraft', 'versions');
  }

  /**
   * Returns the versions directory where Fabric profiles are stored.
   * Same directory MCLC uses for all Minecraft version JSON files.
   */
  getFabricVersionDir(): string {
    return this.versionsDir;
  }

  /**
   * Returns the profile filename for the current Fabric version.
   */
  private getProfileFileName(): string {
    return `fabric-loader-${this.loaderVersion}-${this.mcVersion}.json`;
  }

  /**
   * Returns the profile ID string (matches what's in the version JSON).
   */
  getProfileId(): string {
    return `fabric-loader-${this.loaderVersion}-${this.mcVersion}`;
  }

  /**
   * Returns the full path to the cached Fabric profile JSON in MCLC-compatible
   * subdirectory structure: versions/<profile-id>/<profile-id>.json
   */
  private getCachedProfilePath(): string {
    return path.join(
      this.getFabricVersionDir(),
      this.getProfileId(),
      this.getProfileFileName(),
    );
  }

  /**
   * Ensures the Fabric loader profile exists (cached or downloaded).
   * Returns the path to the profile JSON.
   *
   * 1. Checks cache: if the profile JSON already exists in the versions dir, returns it.
   * 2. If not cached, fetches from the Fabric Meta API and writes to disk.
   * 3. On any failure, throws a clear error.
   */
  async ensureFabric(): Promise<string> {
    const cachedPath = this.getCachedProfilePath();

    // Step 1: Check cache — validate before trusting it. A crash mid-write
    // or disk corruption can leave an unparseable profile; returning it
    // blindly makes every future launch fail until the file is manually
    // deleted (permanent breakage for a student). Corrupt => delete + refetch.
    if (existsSync(cachedPath)) {
      try {
        const cached = JSON.parse(await fs.readFile(cachedPath, 'utf-8')) as Record<string, unknown>;
        if (cached && typeof cached === 'object' && cached.id) {
          console.log(`[fabric-installer] Found valid cached profile at ${cachedPath}`);
          return cachedPath;
        }
        throw new Error('cached profile is missing required fields');
      } catch (cacheErr) {
        console.warn(
          `[fabric-installer] Cached profile is corrupt (${(cacheErr as Error).message}) — deleting and re-fetching`,
        );
        try { await fs.unlink(cachedPath); } catch { /* ignore */ }
      }
    }

    console.log(
      `[fabric-installer] No cached profile found. Fetching Fabric loader ${this.loaderVersion} for MC ${this.mcVersion}...`,
    );

    // Step 2: Fetch from Fabric Meta API
    const url = `https://meta.fabricmc.net/v2/versions/loader/${this.mcVersion}/${this.loaderVersion}/profile/json`;

    let response: Response;
    try {
      response = await timedFetch(url);
    } catch (fetchError) {
      throw new Error(
        '[E401] Unable to contact the Fabric mod loader service. Please check your internet connection and try again.',
      );
    }

    if (!response.ok) {
      throw new Error(
        '[E402] Fabric Meta API returned an error. ' +
        'Ensure Minecraft version "' + this.mcVersion + '" and Fabric loader "' + this.loaderVersion + '" are valid and supported.',
      );
    }

    // Parse the response as JSON
    let profileJson: object;
    try {
      profileJson = await response.json();
    } catch (parseError) {
      throw new Error(
        '[E403] Unable to parse the Fabric loader profile. The response from the server was invalid. Please try again.',
      );
    }

    // Validate the profile has essential fields
    if (typeof profileJson !== 'object' || profileJson === null) {
      throw new Error('[E404] Fabric Meta API returned an empty or invalid profile. Please try again or update the Fabric loader version.');
    }

    // Ensure the profile has inheritsFrom pointing to the correct MC version
    const profile = profileJson as Record<string, unknown>;
    if (!profile.id) {
      throw new Error(
        '[E405] Fabric Meta API response is missing required fields — unexpected format. Please try again or update the Fabric loader version.',
      );
    }

    // Step 3: Write to the versions directory
    const profileDir = path.dirname(cachedPath);
    try {
      await fs.mkdir(profileDir, { recursive: true });
      // Atomic write (tmp + rename): a crash mid-write must never leave a
      // half-written profile at the cached path — that is exactly the
      // corruption the cache validation above exists to recover from.
      const tmpPath = cachedPath + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(profileJson, null, 2), 'utf-8');
      await fs.rename(tmpPath, cachedPath);
      console.log(`[fabric-installer] Written Fabric profile to ${cachedPath}`);
    } catch (writeError) {
      throw new Error(
        '[E406] Failed to save the Fabric loader profile to disk. Please check your disk space and permissions, then try again.',
      );
    }

    return cachedPath;
  }
}
