import { app } from 'electron';
import { join, dirname } from 'path';
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  readFileSync,
  unlinkSync,
  renameSync
} from 'fs';
import { createHash } from 'crypto';
import { MODS, RESOURCE_PACKS, ModEntry } from './mod-data';
import { downloadGuard, readWithStallGuard } from './net';

export type ModInstallStep = (step: string, message: string) => void;

export class ModInstaller {
  private mcDataDir: string;
  private _onStep: ModInstallStep | null = null;

  constructor(mcDataDir?: string) {
    this.mcDataDir = mcDataDir || join(app.getPath('userData'), 'minecraft');
  }

  onStepChange(cb: ModInstallStep): void {
    this._onStep = cb;
  }

  private emitStep(step: string, message: string): void {
    if (this._onStep) this._onStep(step, message);
  }

  /**
   * Install all hardcoded mods and resource packs.
   * Skips items already present with matching hash.
   */
  async installAll(): Promise<void> {
    await this.installMods();
    await this.installResourcePacks();
  }

  async installMods(): Promise<void> {
    const modsDir = join(this.mcDataDir, 'mods');
    mkdirSync(modsDir, { recursive: true });

    let installed = 0;
    let skipped = 0;

    for (const mod of MODS) {
      const dest = join(modsDir, mod.filename);

      if (existsSync(dest)) {
        if (await this.verifyHash(dest, mod.hash, mod.hashFormat)) {
          skipped++;
          continue;
        }
        // Hash mismatch — remove and re-download
        try { unlinkSync(dest); } catch { /* ignore */ }
      }

      this.emitStep('installing-mod', `Downloading ${mod.name}...`);
      try {
        await this.downloadWithHash(mod.url, dest, mod.hash, mod.hashFormat);
        installed++;
      } catch (err) {
        console.error(`[mod-installer] Failed to download ${mod.name}:`, (err as Error).message);
        // Non-fatal: continue with other mods
      }
    }

    this.emitStep('mods-done', `Mods: ${installed} installed, ${skipped} up-to-date`);
  }

  async installResourcePacks(): Promise<void> {
    const rpDir = join(this.mcDataDir, 'resourcepacks');
    mkdirSync(rpDir, { recursive: true });

    let installed = 0;
    let skipped = 0;

    for (const rp of RESOURCE_PACKS) {
      const dest = join(rpDir, rp.filename);

      if (existsSync(dest)) {
        if (await this.verifyHash(dest, rp.hash, rp.hashFormat)) {
          skipped++;
          continue;
        }
        try { unlinkSync(dest); } catch { /* ignore */ }
      }

      this.emitStep('installing-rp', `Downloading ${rp.name}...`);
      try {
        await this.downloadWithHash(rp.url, dest, rp.hash, rp.hashFormat);
        installed++;
      } catch (err) {
        console.error(`[mod-installer] Failed to download ${rp.name}:`, (err as Error).message);
      }
    }

    this.emitStep('rp-done', `Resource packs: ${installed} installed, ${skipped} up-to-date`);
  }

  /**
   * Download a file, verify its hash, and save it.
   */
  private async downloadWithHash(
    url: string,
    dest: string,
    expectedHash: string,
    hashFormat: string
  ): Promise<void> {
    // Connect-phase timeout; body phase is bounded per-chunk below.
    const guard = downloadGuard();
    const response = await fetch(url, { signal: guard.controller.signal });
    guard.headersReceived();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const tmp = dest + '.tmp';
    const writer = createWriteStream(tmp);
    const hash = createHash(hashFormat === 'sha1' ? 'sha1' : 'sha512');

    try {
      while (true) {
        // Stall guard: a dead connection mid-download must error out,
        // not leave reader.read() pending indefinitely.
        const { done, value } = await readWithStallGuard(reader.read(), guard.controller);
        if (done) break;
        writer.write(value);
        hash.update(value);
      }
      writer.end();
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (err) {
      writer.destroy();
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }

    // Verify hash
    const actualHash = hash.digest('hex');
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error(
        `Hash mismatch for ${dest}: expected ${expectedHash}, got ${actualHash}`
      );
    }

    // Rename temp file to final destination
    try { unlinkSync(dest); } catch { /* ignore */ }
    try {
      // Move temp to destination
      renameSync(tmp, dest);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Verify a file's hash matches the expected value.
   */
  private async verifyHash(
    filePath: string,
    expectedHash: string,
    hashFormat: string
  ): Promise<boolean> {
    try {
      const content = readFileSync(filePath);
      const hash = createHash(hashFormat === 'sha1' ? 'sha1' : 'sha512');
      hash.update(content);
      const actual = hash.digest('hex');
      return actual.toLowerCase() === expectedHash.toLowerCase();
    } catch {
      return false;
    }
  }
}
