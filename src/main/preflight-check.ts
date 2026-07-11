import { app } from 'electron';
import { existsSync, readFileSync, statfsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

export interface CheckResult {
  name: string;
  passed: boolean;
  /** Human-readable detail about the check result. */
  message?: string;
}

export interface PreflightResult {
  /** true when every check passed. */
  pass: boolean;
  /** Individual check results. */
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkInternet(): Promise<CheckResult> {
  const name = 'Internet Connectivity';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch('https://piston-meta.mojang.com/', {
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Any non-server-error response means we have connectivity
    if (resp.ok || resp.status < 500) {
      return {
        name,
        passed: true,
        message: 'Successfully reached Mojang services',
      };
    }

    return {
      name,
      passed: false,
      message: `Mojang endpoint returned HTTP ${resp.status}`,
    };
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : String(err);
    return {
      name,
      passed: false,
      message: `Could not reach Mojang services — ${detail}`,
    };
  }
}

async function checkDiskSpace(): Promise<CheckResult> {
  const name = 'Disk Space (≥1 GB)';
  const MIN_BYTES = 1_073_741_824; // 1 GiB

  try {
    const userDataPath = app.getPath('userData');

    // Determine the drive from the userData path (e.g. "C:\")
    const driveMatch = userDataPath.match(/^([A-Za-z]:\\)/);
    const drive = driveMatch ? driveMatch[1] : 'C:\\';

    // Use wmic to get free space for the userData drive
    const escapedDrive = drive.replace(/\\/g, '\\\\');
    const output = execFileSync(
      'wmic',
      [
        'logicaldisk',
        'where',
        `caption="${escapedDrive}"`,
        'get',
        'freespace',
        '/format:value',
      ],
      { encoding: 'utf-8', timeout: 5000 }
    );

    const match = output.match(/FreeSpace=(\d+)/);
    if (!match) {
      throw new Error('Could not parse wmic output');
    }

    const freeBytes = parseInt(match[1], 10);
    const freeGB = freeBytes / (1024 * 1024 * 1024);

    if (freeBytes >= MIN_BYTES) {
      return {
        name,
        passed: true,
        message: `${freeGB.toFixed(1)} GB free on ${drive.trim()}`,
      };
    }

    return {
      name,
      passed: false,
      message: `Only ${freeGB.toFixed(2)} GB free on ${drive.trim()} — need at least 1 GB`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      name,
      passed: false,
      message: `Could not check disk space — ${detail}`,
    };
  }
}

async function checkJavaAvailability(): Promise<CheckResult> {
  const name = 'Java Availability';

  // --- 1. Check for a cached JRE (already provisioned) ---
  const runtimeDir =
    process.env.MU_RUNTIME_DIR ||
    join(app.getPath('userData'), 'runtime');
  const cachePathFile = join(runtimeDir, 'current-java-path.txt');

  try {
    if (existsSync(cachePathFile)) {
      const cachedPath = readFileSync(cachePathFile, 'utf-8').trim();
      if (cachedPath && existsSync(cachedPath)) {
        return {
          name,
          passed: true,
          message: `Cached JRE ready at ${cachedPath}`,
        };
      }
    }
  } catch {
    // Corrupt or missing cache file — fall through to PATH check
  }

  // --- 2. Check for system java on PATH ---
  try {
    // java -version writes to stderr; capture both streams
    execFileSync('java', ['-version'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return {
      name,
      passed: true,
      message: 'System Java found on PATH',
    };
  } catch {
    // Not on PATH or unusable
    return {
      name,
      passed: false,
      message:
        'No cached JRE found and Java is not available on PATH. ' +
        'A JRE will be downloaded during launch.',
    };
  }
}

function checkLauncherFiles(): CheckResult {
  const name = 'Launcher File Integrity';

  // __dirname at runtime is out/main/ (compiled directory)
  const mainJs = join(__dirname, 'index.js');
  const preloadJs = join(__dirname, '..', 'preload', 'index.js');

  const missing: string[] = [];
  if (!existsSync(mainJs)) missing.push('out/main/index.js');
  if (!existsSync(preloadJs)) missing.push('out/preload/index.js');

  if (missing.length === 0) {
    return {
      name,
      passed: true,
      message: 'All launcher files present and intact',
    };
  }

  return {
    name,
    passed: false,
    message: `Missing launcher files: ${missing.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run all preflight checks in parallel and return a summary result.
 *
 * Checks performed:
 *  1. Internet connectivity  — reach Mojang's meta API
 *  2. Disk space            — ≥1 GB free on the userData drive
 *  3. Java availability     — cached JRE OR system `java` on PATH
 *  4. Launcher file integrity — built output files exist
 */
export async function runPreflightCheck(): Promise<PreflightResult> {
  const checks = await Promise.all([
    checkInternet(),
    checkDiskSpace(),
    checkJavaAvailability(),
    checkLauncherFiles(),
  ]);

  const pass = checks.every((c) => c.passed);
  return { pass, checks };
}
