import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { app } from 'electron';
import * as nbt from 'prismarine-nbt';

export type ServerInjectorStepCallback = (step: string, status: string) => void;

export class ServerInjector {
  private mcDataDir: string;
  private serverName: string = "Masters' Union SMP";
  private serverIp: string = 'mastersunion.minekeep.gg';
  private serverPort: number = 25565;
  private _onStep: ServerInjectorStepCallback | null = null;

  constructor(mcDataDir?: string) {
    this.mcDataDir = mcDataDir || path.join(app.getPath('userData'), 'minecraft');
  }

  onStepChange(callback: ServerInjectorStepCallback): void {
    this._onStep = callback;
  }

  private emitStep(step: string, status: string): void {
    if (this._onStep) {
      this._onStep(step, status);
    }
  }

  /**
   * Inject the MU SMP server into servers.dat.
   * If the server already exists, the operation is idempotent (skips without error).
   * Creates servers.dat from scratch if it doesn't exist.
   */
  async injectServer(): Promise<void> {
    this.emitStep('injecting-server', 'working');

    const serversDatPath = path.join(this.mcDataDir, 'servers.dat');
    console.log('[server-injector] servers.dat path:', serversDatPath);
    console.log('[server-injector] mcDataDir:', this.mcDataDir);
    console.log('[server-injector] server name:', this.serverName);
    console.log('[server-injector] server ip:', this.serverIp);

    try {
      // Parse the existing file if present. A corrupt servers.dat must never
      // permanently block launching: preserve the unreadable file as a
      // .corrupt-<timestamp> backup (recoverable by hand), then rebuild a
      // fresh list below as if the file did not exist.
      let parsed: any | null = null;
      if (fs.existsSync(serversDatPath)) {
        console.log('[server-injector] servers.dat exists, size:', fs.statSync(serversDatPath).size);
        try {
          ({ parsed } = await this.parseServersDat(serversDatPath));
        } catch (parseErr) {
          const backupPath = `${serversDatPath}.corrupt-${Date.now()}`;
          console.warn('[server-injector] servers.dat is corrupt — backing up to', backupPath, parseErr);
          try {
            fs.renameSync(serversDatPath, backupPath);
          } catch {
            // Rename failed (e.g. file locked) — last resort: remove it so a
            // fresh file can be written.
            try { fs.unlinkSync(serversDatPath); } catch { /* ignore */ }
          }
          parsed = null;
        }
      }

      if (parsed) {
        // Ensure servers list exists
        if (!parsed.value.servers) {
          // Create servers list in existing file
          parsed.value.servers = {
            type: 'list',
            value: {
              type: 'compound',
              value: []
            }
          };
        }

        const serversList = parsed.value.servers.value.value;

        // Check if MU SMP already exists (idempotent)
        const exists = Array.isArray(serversList) && serversList.some(
          (entry: any) => entry.ip?.value === this.serverIp
        );

        if (exists) {
          console.log('[server-injector] MU SMP already in servers.dat, skipping');
          this.emitStep('injecting-server', 'done');
          return;
        }

        // Append new server entry
        serversList.push({
          name: { type: 'string', value: this.serverName },
          ip: { type: 'string', value: this.serverIp },
          port: { type: 'int', value: this.serverPort },
          hidden: { type: 'byte', value: 0 }
        });

        await this.writeServersDat(serversDatPath, parsed);
      } else {
        // Create new servers.dat from scratch (missing OR corrupt-recovered)
        const data = {
          type: 'compound' as const,
          name: '',
          value: {
            servers: {
              type: 'list' as const,
              value: {
                type: 'compound' as const,
                value: [
                  {
                    name: { type: 'string' as const, value: this.serverName },
                    ip: { type: 'string' as const, value: this.serverIp },
                    port: { type: 'int' as const, value: this.serverPort },
                    hidden: { type: 'byte' as const, value: 0 }
                  }
                ]
              }
            }
          }
        };

        await this.writeServersDat(serversDatPath, data);
      }

      this.emitStep('injecting-server', 'done');
    } catch (error) {
      console.error('[server-injector] Failed to inject server:', error);
      this.emitStep('injecting-server', 'error');
      throw new Error('[E501] Failed to configure the Minecraft server list. The servers.dat file may be corrupted. Please restart the launcher and try again.');
    }
  }

  /**
   * Remove the MU SMP entry from servers.dat.
   * Useful for cleanup or testing.
   */
  async removeServer(): Promise<void> {
    const serversDatPath = path.join(this.mcDataDir, 'servers.dat');

    if (!fs.existsSync(serversDatPath)) {
      return;
    }

    try {
      const { parsed } = await this.parseServersDat(serversDatPath);

      if (!parsed.value.servers) {
        return;
      }

      const serversList = parsed.value.servers.value.value;

      if (!Array.isArray(serversList) || serversList.length === 0) {
        return;
      }

      const filtered = serversList.filter(
        (entry: any) => entry.ip?.value !== this.serverIp
      );

      if (filtered.length === serversList.length) {
        // No change — server not found
        return;
      }

      parsed.value.servers.value.value = filtered;
      await this.writeServersDat(serversDatPath, parsed);
    } catch (error) {
      console.error('[server-injector] Failed to remove server:', error);
      throw new Error('[E502] Failed to remove the server entry. The servers.dat file may be corrupted. Please try again.');
    }
  }

  /**
   * Parse an existing servers.dat file.
   * Returns the parsed NBT structure.
   */
  private async parseServersDat(filePath: string): Promise<{ parsed: any }> {
    const buffer = fs.readFileSync(filePath);
    const result = await nbt.parse(buffer);
    return { parsed: result.parsed };
  }

  /**
   * Write NBT data to servers.dat atomically.
   * Uses a temp file + rename to prevent corruption.
   */
  private async writeServersDat(filePath: string, data: any): Promise<void> {
    const tmpPath = filePath + '.tmp';

    // Write uncompressed NBT — Minecraft 26.1.2 expects raw NBT for servers.dat
    const nbtBuffer = nbt.writeUncompressed(data);

    // Atomic write: write to temp file, then rename
    fs.writeFileSync(tmpPath, nbtBuffer);
    fs.renameSync(tmpPath, filePath);
  }
}
