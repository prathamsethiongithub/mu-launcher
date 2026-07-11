import { app } from 'electron';
import { join, dirname } from 'path';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  createWriteStream,
  unlinkSync
} from 'fs';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { timedFetch, downloadGuard, readWithStallGuard } from './net';

interface JavaVersionInfo {
  component: string;
  majorVersion: number;
}

interface VersionManifestEntry {
  id: string;
  url: string;
  type: string;
  time: string;
  releaseTime: string;
}

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionManifestEntry[];
}

interface JavaRuntimeManifestEntry {
  availability: { group: number; progress: number };
  manifest: { sha1: string; size: number; url: string };
  version: { name: string; released: string };
}

interface JavaRuntimeManifest {
  [platform: string]: {
    [component: string]: JavaRuntimeManifestEntry[];
  };
}

interface FileManifestEntry {
  type: 'file' | 'directory';
  downloads?: {
    raw?: { url: string; sha1: string; size: number };
    lzma?: { url: string; sha1: string; size: number };
  };
  executable?: boolean;
}

interface FileManifest {
  files: Record<string, FileManifestEntry>;
}

export interface JavaProgressEvent {
  phase: string;
  percent: number;
  message?: string;
}

export class JavaProvisioner extends EventEmitter {
  private mcVersion: string = '26.1.2';
  private launcherDataDir: string;
  private currentJavaPath: string | null = null;

  private readonly VERSION_MANIFEST_URL =
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

  private readonly JAVA_RUNTIME_MANIFEST_URL =
    'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

  constructor(mcVersion?: string) {
    super();

    if (mcVersion) {
      this.mcVersion = mcVersion;
    }

    this.launcherDataDir =
      process.env.MU_RUNTIME_DIR || join(app.getPath('userData'), 'runtime');
  }

  /**
   * Emit a typed progress event so callers can watch provisioning status.
   */
  private emitProgress(phase: string, percent: number, message?: string): void {
    const event: JavaProgressEvent = { phase, percent };
    if (message) event.message = message;
    this.emit('java-progress', event);
  }

  /**
   * Ensure a correct Java runtime is available for the target MC version.
   * Returns the absolute path to the java executable.
   */
  async ensureJava(): Promise<string> {
    this.emitProgress('check-cache', 0, 'Checking cached Java runtime');

    // ── 1. Fetch MC version manifest ────────────────────────────────
    // We fetch this before the cache check so we know the expected major version
    this.emitProgress('fetching-version-manifest', 5, 'Fetching Minecraft version manifest');

    let versionManifest: VersionManifest;
    try {
      const resp = await timedFetch(this.VERSION_MANIFEST_URL);
      if (!resp.ok) {
        throw new Error(
          '[E201] Unable to fetch the Minecraft version manifest. Please check your internet connection and try again.'
        );
      }
      versionManifest = await resp.json();
    } catch (err) {
      throw new Error(
        '[E202] Unable to download the Minecraft version manifest. Please check your internet connection and try again.'
      );
    }

    // ── 2. Locate the target version entry ──────────────────────────
    this.emitProgress('locating-version', 10, `Locating version ${this.mcVersion}`);

    const versionEntry = versionManifest.versions.find(
      (v) => v.id === this.mcVersion
    );
    if (!versionEntry) {
      throw new Error(
        '[E203] Minecraft version "' +
          this.mcVersion +
          '" is not available. The latest supported release is ' +
          versionManifest.latest.release +
          '.'
      );
    }

    // ── 3. Fetch version JSON to get the javaVersion field ──────────
    this.emitProgress('fetching-version-json', 15, 'Fetching version metadata');

    let versionJson: { javaVersion?: JavaVersionInfo };
    try {
      const resp = await timedFetch(versionEntry.url);
      if (!resp.ok) {
        throw new Error('[E204] Unable to fetch Minecraft version metadata. Please check your internet connection and try again.');
      }
      versionJson = await resp.json();
    } catch (err) {
      throw new Error(
        '[E205] Unable to download version metadata for Minecraft ' + this.mcVersion + '. Please check your internet connection and try again.'
      );
    }

    const javaVersionInfo = versionJson.javaVersion;
    if (!javaVersionInfo) {
      throw new Error(
        '[E206] Minecraft version ' + this.mcVersion + ' does not support automatic Java provisioning. Please install Java manually.'
      );
    }

    const { component: javaComponent, majorVersion: expectedMajorVersion } =
      javaVersionInfo;

    // ── 4. Check cache with version awareness ───────────────────────
    const cachePathFile = join(this.launcherDataDir, 'current-java-path.txt');

    if (existsSync(cachePathFile)) {
      try {
        const cachedPath = readFileSync(cachePathFile, 'utf-8').trim();
        if (cachedPath && existsSync(cachedPath)) {
          const valid = await this.smokeTest(cachedPath, expectedMajorVersion);
          if (valid) {
            this.currentJavaPath = cachedPath;
            this.emitProgress('cache-hit', 100, 'Using cached Java runtime');
            return cachedPath;
          }
        }
      } catch {
        // Cache file corrupt — ignore and re-download
      }
    }

    // ── 5. Ensure cache directory exists ────────────────────────────
    mkdirSync(this.launcherDataDir, { recursive: true });

    this.emitProgress(
      'fetching-java-manifest',
      20,
      `Fetching Java runtime manifest (component: ${javaComponent})`
    );

    // ── 6. Fetch the Java runtime product manifest ──────────────────
    let javaRuntimeManifest: JavaRuntimeManifest;
    try {
      const resp = await timedFetch(this.JAVA_RUNTIME_MANIFEST_URL);
      if (!resp.ok) {
        throw new Error(
          '[E207] Unable to fetch the Java runtime manifest from Mojang. Please check your internet connection and try again.'
        );
      }
      javaRuntimeManifest = await resp.json();
    } catch (err) {
      throw new Error(
        '[E208] Unable to download the Java runtime manifest. Please check your internet connection and try again.'
      );
    }

    // ── 7. Find the Windows-x64 entry for our component ─────────────
    const platformKey = 'windows-x64';
    const platformEntries = javaRuntimeManifest[platformKey];
    if (!platformEntries) {
      throw new Error(
        '[E209] JRE downloads are not available for your platform. ' +
          'This launcher currently only supports provisioning Java for Windows 64-bit.'
      );
    }

    const componentVersions = platformEntries[javaComponent];
    if (!componentVersions || componentVersions.length === 0) {
      throw new Error(
        '[E210] The required Java runtime component "' + javaComponent + '" is not available for download. ' +
          'This may be due to a change in the Mojang runtime manifest.'
      );
    }

    // Take the first (and typically only) version entry
    const runtimeEntry = componentVersions[0];
    const fileManifestUrl = runtimeEntry.manifest.url;

    this.emitProgress(
      'downloading-file-manifest',
      25,
      'Downloading JRE file manifest'
    );

    // ── 8. Download the detailed file manifest ──────────────────────
    let fileManifest: FileManifest;
    try {
      const resp = await timedFetch(fileManifestUrl);
      if (!resp.ok) {
        throw new Error('[E211] Unable to fetch the JRE file manifest. Please check your internet connection and try again.');
      }
      fileManifest = await resp.json();
    } catch (err) {
      throw new Error(
        '[E212] Unable to download the JRE file manifest. Please check your internet connection and try again.'
      );
    }

    // ── 9. Download all JRE files ───────────────────────────────────
    const jreDir = join(this.launcherDataDir, 'jre');
    mkdirSync(jreDir, { recursive: true });

    const files = fileManifest.files;
    const fileEntries = Object.entries(files).filter(
      ([, info]) => info.type === 'file' && info.downloads
    );

    const totalFiles = fileEntries.length;
    let completedFiles = 0;

    for (const [relativePath, fileInfo] of fileEntries) {
      const destPath = join(jreDir, relativePath);
      const destDir = dirname(destPath);
      mkdirSync(destDir, { recursive: true });

      // Prefer raw (uncompressed) download for simplicity
      const download =
        (fileInfo as FileManifestEntry).downloads!.raw ||
        (fileInfo as FileManifestEntry).downloads!.lzma;

      if (!download) {
        // Skip entries with no usable download URL
        continue;
      }

      try {
        await this.downloadFile(download.url, destPath, download.sha1);
      } catch (err) {
        throw new Error(
          '[E213] Failed to download a Java runtime file. Please check your internet connection and try again.'
        );
      }

      completedFiles++;
      // Progress: 25% -> 90% (65 percentage points for downloads)
      const pct = 25 + Math.floor((completedFiles / totalFiles) * 65);
      this.emitProgress('downloading-jre', pct, `Downloading ${relativePath}`);
    }

    // ── 10. Locate the java executable ──────────────────────────────
    this.emitProgress('locating-java', 92, 'Locating java executable');

    // The manifest entries are typically under "jre/" prefix, but the
    // file manifest uses paths relative to the JRE root (e.g., "bin/java.exe").
    let javaExe = join(jreDir, 'bin', 'java.exe');
    let javawExe = join(jreDir, 'bin', 'javaw.exe');

    // Also check with "jre/" subfolder in case the manifest was structured differently
    if (!existsSync(javaExe)) {
      javaExe = join(jreDir, 'jre', 'bin', 'java.exe');
      javawExe = join(jreDir, 'jre', 'bin', 'javaw.exe');
    }

    const finalJavaPath = existsSync(javaExe)
      ? javaExe
      : existsSync(javawExe)
        ? javawExe
        : null;

    if (!finalJavaPath) {
      throw new Error(
        '[E214] The downloaded Java runtime is missing the java executable. ' +
          'The runtime may be corrupted. Please try again and a fresh copy will be downloaded.'
      );
    }

    // ── 11. Smoke test ──────────────────────────────────────────────
    this.emitProgress('smoke-test', 95, 'Running Java smoke test');

    const smokeOk = await this.smokeTest(finalJavaPath);
    if (!smokeOk) {
      throw new Error(
        '[E215] The downloaded Java runtime failed validation. ' +
          'The executable may be corrupted or is the wrong version. Please try again.'
      );
    }

    // ── 12. Cache the path and return ───────────────────────────────
    writeFileSync(cachePathFile, finalJavaPath, 'utf-8');
    this.currentJavaPath = finalJavaPath;

    this.emitProgress('complete', 100, 'Java runtime provisioned successfully');
    return finalJavaPath;
  }

  /**
   * Spawn java -version and verify the output contains the expected
   * major version (from javaVersion.majorVersion).
   */
  private async smokeTest(javaPath: string, expectedMajorVersion?: number): Promise<boolean> {
    return new Promise<boolean>((resolvePromise) => {
      let stderr = '';
      let stdout = '';

      const proc = spawn(javaPath, ['-version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        windowsHide: true
      });

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      }

      proc.on('error', () => {
        // ENOENT or permission error — binary is unusable
        resolvePromise(false);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          resolvePromise(false);
          return;
        }

        // Java prints its version to stderr
        const output = stderr || stdout;
        const versionMatch = output.match(
          /(?:openjdk|java|jre)\s+version\s+"(\d+)/
        );

        if (!versionMatch) {
          resolvePromise(false);
          return;
        }

        const major = parseInt(versionMatch[1], 10);
        // Baseline: every modern Minecraft needs Java >= 17.
        if (major < 17) {
          resolvePromise(false);
          return;
        }
        // When a specific runtime is expected (cache validation for the target
        // MC version), require an exact major-version match so a stale cached
        // Java of the wrong version is rejected and re-provisioned instead of
        // silently launching the game with the wrong runtime.
        if (expectedMajorVersion !== undefined && major !== expectedMajorVersion) {
          resolvePromise(false);
          return;
        }
        resolvePromise(true);
      });
    });
  }

  /**
   * Download a file from `url` and write it to `dest` using streaming.
   */
  private async downloadFile(url: string, dest: string, expectedSha1?: string): Promise<void> {
    // Connect-phase timeout; the body phase is bounded per-chunk below.
    const guard = downloadGuard();
    const response = await fetch(url, { signal: guard.controller.signal });
    guard.headersReceived();
    if (!response.ok) {
      throw new Error('[E216] File download failed. Please check your internet connection and try again.');
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('[E217] Unable to process the downloaded file. The server returned an empty response. Please try again.');
    }

    const writer = createWriteStream(dest);
    const pump = new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Stream chunks and compute SHA1 in parallel
    const hash = createHash('sha1');

    try {
      // Stream chunks from the fetch response to the file
      const pumpLoop = async (): Promise<void> => {
        while (true) {
          // Stall guard: a dead connection mid-download must error out,
          // not leave reader.read() pending indefinitely.
          const { done, value } = await readWithStallGuard(reader.read(), guard.controller);
          if (done) break;
          writer.write(value);
          hash.update(value);
        }
        writer.end();
      };
      await pumpLoop();
      await pump;
    } catch (err) {
      writer.destroy();
      // Clean up partial file on error
      try { unlinkSync(dest); } catch { /* ignore */ }
      throw err;
    }

    // Verify integrity against expected SHA1 (from Mojang manifest)
    if (expectedSha1) {
      const actualSha1 = hash.digest('hex');
      if (actualSha1 !== expectedSha1) {
        // Delete corrupted file
        try { unlinkSync(dest); } catch { /* ignore */ }
        throw new Error(
          '[E218] Downloaded file failed integrity check. The file may be corrupted. Please try again.'
        );
      }
    }
  }

  /**
   * Extract a ZIP archive to the destination directory using adm-zip.
   * Used by the orchestrator when the JRE is delivered as a zip.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    // Dynamic import so adm-zip is only loaded when needed
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
  }

  /** Return the cached Java path, or null if not yet provisioned. */
  getJavaPath(): string | null {
    return this.currentJavaPath;
  }

  /** Return the runtime cache directory path. */
  getCacheDir(): string {
    return this.launcherDataDir;
  }
}
