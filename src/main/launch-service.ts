import { Client } from 'minecraft-launcher-core';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess } from 'child_process';
import { ServerInjector } from './server-injector';
import { FabricInstaller } from './fabric-installer';
import { ModInstaller } from './mod-installer';

export type StepChangeCallback = (step: string, status: string, progress: number) => void;

const STALL_TIMEOUT_MS = 180_000; // 3 minutes without any MCLC activity = stall

export class LaunchManager {
  private client: Client;
  private mcVersion: string = '26.1.2';
  private _onStepChange: StepChangeCallback | null = null;
  private _cancelled: boolean = false;
  private _minecraftProcess: ChildProcess | null = null;

  // Activity watchdog: any MCLC event resets this timer.
  // If no event fires for STALL_TIMEOUT_MS, we declare a stall.
  private _lastActivity: number = Date.now();
  private _stallTimer: NodeJS.Timeout | null = null;
  private _stallReject: ((reason: Error) => void) | null = null;

  constructor() {
    this.client = new Client();

    // Every MCLC event resets the stall watchdog.
    // This covers progress, download-status, download, debug, error, and data events.
    const markActivity = () => { this._lastActivity = Date.now(); };

    this.client.on('progress', (e: { type?: string; task?: number | string; subtask?: string; total?: number; current?: number }) => {
      markActivity();
      const step = e.type || 'unknown';
      // MCLC progress events carry the completed count in `task` (a numeric
      // counter, not a task name) and never set `current` — reading only
      // `current` made every MCLC progress event compute 0%, freezing the
      // renderer's download composite through the assets/classes phases.
      // Read `current` first (any other emitter shape), then `task`.
      const done = typeof e.current === 'number' ? e.current : Number(e.task) || 0;
      const progress = e.total && e.total > 0 ? Math.round((done / e.total) * 100) : 0;
      console.log(`[mclc-progress] ${step}: ${done}/${e.total ?? '?'} (${progress}%)`);
      this.emitStep(step, 'working', progress);
    });

    this.client.on('data', (e: string) => {
      markActivity();
      console.log('[mc-data]', e);
    });

    this.client.on('error', (e: Error) => {
      markActivity();
      console.error('[mclc-error]', e);
      this.emitStep('error', 'error', 0);
    });

    this.client.on('debug', (e: string) => {
      markActivity();
      console.log('[mc-debug]', e);
    });

    // MCLC's built-in events during file transfers:
    this.client.on('download-status', (status: { name?: string; type?: string; current?: number; total?: number }) => {
      markActivity();
      console.log(`[mclc-download] ${status.type || 'file'}: ${status.current}/${status.total} bytes`);
      // Single large-file transfers: the byte counter IS the real fraction.
      // Only the version jar qualifies — assets/natives/libraries stream
      // per-file byte noise that their own task/total progress events already
      // cover. Without this, the client-jar download (first launch) is a long
      // silent stretch where the filament appears frozen.
      if (status.type === 'version-jar' && status.total && status.total > 0) {
        const pct = Math.min(100, Math.round((status.current || 0) / status.total * 100));
        this.emitStep('version-jar', 'working', pct);
      }
    });

    this.client.on('download', (name: string) => {
      markActivity();
      console.log(`[mclc-download] completed: ${name}`);
    });
  }

  /** Start the activity watchdog. Called right before client.launch(). */
  private startWatchdog(): void {
    this._lastActivity = Date.now();
    this._stallTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastActivity;
      if (elapsed > STALL_TIMEOUT_MS) {
        console.error(`[launch] Stall detected — no MCLC activity for ${STALL_TIMEOUT_MS / 1000}s`);
        // Force-reject the pending launch promise so the await in
        // launchWithFabric() settles with a clear error instead of hanging.
        if (this._stallReject) {
          this._stallReject(new Error('[E306] Launch stalled — no progress for 3 minutes. Check your internet connection and try again.'));
          this._stallReject = null;
        }
        this.cancelLaunch();
      }
    }, 10_000);
  }

  private stopWatchdog(): void {
    if (this._stallTimer) {
      clearInterval(this._stallTimer);
      this._stallTimer = null;
    }
  }

  private emitStep(step: string, status: string, progress: number): void {
    if (this._onStepChange) {
      this._onStepChange(step, status, progress);
    }
  }

  async launch(
    auth: { access_token: string; uuid: string; name: string },
    javaPath: string,
    options?: { maxRam?: string; minRam?: string },
    rootOverride?: string
  ): Promise<void> {
    this._cancelled = false;

    try {
      const mcRoot = rootOverride || path.join(app.getPath('userData'), 'minecraft');

      // Step 1: Authenticating
      this.emitStep('authenticating', 'working', 5);
      this.emitStep('authenticating', 'done', 10);

      // Step 2: Preparing Java
      this.emitStep('preparing-java', 'working', 10);
      this.emitStep('preparing-java', 'done', 20);

      // Step 3: Ensuring version — MCLC handles download
      this.emitStep('ensuring-version', 'working', 40);

      // Step 4: Injecting MU SMP server
      this.emitStep('injecting-server', 'working', 55);
      const serverInjector = new ServerInjector(mcRoot);
      await serverInjector.injectServer();
      this.emitStep('injecting-server', 'done', 60);

      // Step 5: Launching
      this.emitStep('launching', 'working', 70);

      // Start the activity watchdog before client.launch().
      // MCLC events reset the timer; 180s without any event = stall.
      this.startWatchdog();

      const result = await this.client.launch({
        authorization: {
          access_token: auth.access_token,
          client_token: auth.uuid,
          uuid: auth.uuid,
          name: auth.name,
          user_properties: {}
        },
        root: mcRoot,
        version: {
          number: this.mcVersion,
          type: 'release'
        },
        memory: {
          max: options?.maxRam || '4096',
          min: options?.minRam || '1024'
        },
        javaPath: javaPath,
        overrides: {
          detached: false,
          assetRoot: path.join(app.getPath('userData'), 'minecraft', 'assets'),
          libraryRoot: path.join(app.getPath('userData'), 'minecraft', 'libraries')
        }
      });
      this.stopWatchdog();

      // Close out 'ensuring-version' once the client download inside
      // client.launch() has resolved (see launchWithFabric note).
      this.emitStep('ensuring-version', 'done', 45);

      // Save reference to the spawned process so we can kill it later
      if (result) {
        this._minecraftProcess = result;
        result.on('exit', () => {
          this._minecraftProcess = null;
          this._cancelled = false;
          this.emitStep('stopped', 'done', 100);
        });
      }

      // Restore default detached behavior for the child process
      if (this._minecraftProcess && this._minecraftProcess.pid) {
        this.emitStep('running', 'working', 90);
      }

      if (!this._cancelled) {
        this.emitStep('running', 'done', 100);
      }
    } catch (error) {
      this.stopWatchdog();
      console.error('[launch-error]', error);
      const message = error instanceof Error ? error.message : '';
      this.emitStep('error', 'error', 0);
      throw new Error('[E301] Game launch failed. Please check your internet connection and Minecraft installation, then try again.');
    }
  }

  async launchWithFabric(
    auth: { access_token: string; uuid: string; name: string },
    javaPath: string,
    options?: { maxRam?: string; minRam?: string; window?: { width: number; height: number } },
    rootOverride?: string          // ← NEW: if set, overrides the default minecraft root
  ): Promise<void> {
    this._cancelled = false;

    try {
      // Determine the minecraft root — use override if provided
      const mcRoot = rootOverride || path.join(app.getPath('userData'), 'minecraft');
      fs.mkdirSync(mcRoot, { recursive: true });
      console.log(`[launch] Ensured minecraft root at ${mcRoot}`);

      // Step 1: Authenticating
      this.emitStep('authenticating', 'working', 5);
      this.emitStep('authenticating', 'done', 10);

      // Step 2: Preparing Java
      this.emitStep('preparing-java', 'working', 10);
      this.emitStep('preparing-java', 'done', 20);

      // Step 3: Ensuring version — MCLC handles download
      this.emitStep('ensuring-version', 'working', 40);

      // Step 4: Installing Fabric (injected via custom profile)
      this.emitStep('installing-fabric', 'working', 55);
      const fabricInstaller = new FabricInstaller(this.mcVersion, undefined, path.join(mcRoot, 'versions'));
      const fabricProfilePath = await fabricInstaller.ensureFabric();
      const fabricProfileId = fabricInstaller.getProfileId();
      this.emitStep('installing-fabric', 'done', 60);

      // Step 5: Injecting MU SMP server into servers.dat
      this.emitStep('injecting-server', 'working', 62);
      const serverInjector = new ServerInjector(mcRoot);
      await serverInjector.injectServer();
      this.emitStep('injecting-server', 'done', 65);

      // Step 6: Installing mods and resource packs
      this.emitStep('installing-mods', 'working', 66);
      const modInstaller = new ModInstaller(mcRoot);
      try {
        await modInstaller.installAll();
      } catch (err) {
        console.error('[launch] Non-fatal mod install error:', err);
      }
      this.emitStep('installing-mods', 'done', 68);

      // Step 7: Launching with Fabric profile
      this.emitStep('launching', 'working', 70);

      // Start the activity watchdog before client.launch().
      // MCLC events reset the timer; 180s without any event = stall.
      this.startWatchdog();

      const launchPromise = this.client.launch({
        authorization: {
          access_token: auth.access_token,
          client_token: auth.uuid,
          uuid: auth.uuid,
          name: auth.name,
          user_properties: {}
        },
        root: mcRoot,
        version: {
          number: this.mcVersion,
          type: 'release',
          custom: fabricProfileId
        },
        memory: {
          max: options?.maxRam || '4096',
          min: options?.minRam || '1024'
        },
        window: options?.window,
        javaPath: javaPath,
        overrides: {
          detached: false,
          assetRoot: path.join(app.getPath('userData'), 'minecraft', 'assets'),
          libraryRoot: path.join(app.getPath('userData'), 'minecraft', 'libraries')
        }
      });

      // Race against a stall-rejection promise so the watchdog can abort
      // a hung MCLC download instead of leaving the Promise pending forever.
      const stallPromise = new Promise<never>((_, reject) => {
        this._stallReject = reject;
        // The watchdog calls this._stallReject on timeout; by assigning
        // synchronously here (inside the Promise constructor, which runs
        // before the next line), TypeScript's flow analysis is satisfied.
      });

      const result = await Promise.race([launchPromise, stallPromise]);

      // client.launch() resolved — stop the watchdog and handle the process
      this.stopWatchdog();

      // The Minecraft client download (assets/classes/natives streamed by MCLC
      // under the 'launching' step) is complete. Close out 'ensuring-version'
      // so the display can advance past Forging instead of holding it forever.
      this.emitStep('ensuring-version', 'done', 69);

      if (result) {
        this._minecraftProcess = result;
        result.on('exit', () => {
          this._minecraftProcess = null;
          this._cancelled = false;
          this.emitStep('stopped', 'done', 100);
        });
      }

      if (!this._cancelled) {
        this.emitStep('running', 'done', 100);
      }
    } catch (error) {
      this.stopWatchdog();
      console.error('[launch-error]', error);
      const message = error instanceof Error ? error.message : '';
      this.emitStep('error', 'error', 0);
      throw new Error('[E303] Game launch with Fabric failed. Please check your internet connection and Minecraft installation, then try again.');
    }
  }

  onStepChange(callback: StepChangeCallback): void {
    this._onStepChange = callback;
  }

  async cancelLaunch(): Promise<void> {
    this._cancelled = true;
    this.stopWatchdog();
    // If the watchdog or a cancel race is pending, reject it now so
    // the launch await settles immediately instead of hanging.
    if (this._stallReject) {
      this._stallReject(new Error('[E307] Launch cancelled by user.'));
      this._stallReject = null;
    }
    try {
      if (this._minecraftProcess && this._minecraftProcess.pid) {
        const pid = this._minecraftProcess.pid;
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } else {
          this._minecraftProcess.kill('SIGKILL');
        }
        this._minecraftProcess = null;
      }
      // Mark the final stage FAILED, not done: a cancelled/stalled launch is
      // over, and 'done' would render the last stage dim-complete while the
      // UI reports failure ("complete before the operation completed").
      this.emitStep('launching', 'error', 0);
    } catch (error) {
      console.error('[cancel-error]', error);
    }
  }

  isRunning(): boolean {
    return this._minecraftProcess !== null &&
      this._minecraftProcess.pid !== undefined &&
      this._minecraftProcess.exitCode === null &&
      !this._minecraftProcess.killed;
  }

  getInstalledVersions(): string[] {
    const mcDir = path.join(app.getPath('userData'), 'minecraft', 'versions');
    try {
      if (fs.existsSync(mcDir)) {
        return fs.readdirSync(mcDir).filter((name) => {
          const versionDir = path.join(mcDir, name);
          return fs.statSync(versionDir).isDirectory() &&
            fs.existsSync(path.join(versionDir, `${name}.json`));
        });
      }
    } catch (error) {
      console.error('[versions-error]', error);
    }
    return [];
  }
}
