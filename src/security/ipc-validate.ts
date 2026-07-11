/**
 * IPC Security Validation Layer
 *
 * Runtime validators for all IPC handler inputs.
 * Every ipcMain.handle() that accepts user-derived data MUST
 * validate it through this module before processing.
 */

// ── 1. URL allowlist ────────────────────────────────────────────────────

const ALLOWED_EXTERNAL_HOSTS = [
  'microsoft.com',
  'login.live.com',
  'account.live.com',
  'login.microsoftonline.com',
  'minecraft.net',
  'minecraftservices.com',
  'api.minecraftservices.com',
  'xboxlive.com',
  'login.xboxlive.com',
] as const;

/**
 * Validate an external URL before passing to shell.openExternal.
 * Allows https:// for external sites and http:// for localhost/127.0.0.1
 * (used by the MSMC local auth redirect server).
 * Returns the validated URL string, or throws a descriptive error.
 */
export function validateExternalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}" is not a valid URL`);
  }

  // Allow http:// for localhost (MSMC local auth redirect server)
  if (parsed.protocol === 'http:') {
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return url;
    }
    throw new Error(`Blocked URL: only https:// or http://localhost is allowed, got "${parsed.protocol}//${parsed.hostname}"`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL: only https:// is allowed, got "${parsed.protocol}"`);
  }

  const isAllowed = ALLOWED_EXTERNAL_HOSTS.some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
  );

  if (!isAllowed) {
    throw new Error(
      `Blocked URL: host "${parsed.hostname}" is not in the allowlist`
    );
  }

  return url;
}

// ── 2. Minecraft version string validation ──────────────────────────────

const VERSION_REGEX = /^\d+\.\d+(\.\d+)?$/;

/**
 * Validate a Minecraft version string like "1.21.5".
 * Returns the trimmed version string, or throws.
 */
export function validateMcVersion(version: string): string {
  const trimmed = version.trim();
  if (!VERSION_REGEX.test(trimmed)) {
    throw new Error(`Invalid Minecraft version: "${version}"`);
  }
  return trimmed;
}

// ── 3. Java path validation ─────────────────────────────────────────────

const SAFE_PATH_REGEX = /^[a-zA-Z0-9_\-:.\\/]+$/;

/**
 * Basic safety check on a filesystem path string.
 * Rejects paths with shell metacharacters or injection attempts.
 */
export function validatePath(pathStr: string): string {
  if (!SAFE_PATH_REGEX.test(pathStr)) {
    throw new Error(`Path contains potentially unsafe characters`);
  }
  return pathStr;
}

// ── 4. IPC channel name validation ──────────────────────────────────────

const CHANNEL_REGEX = /^[a-z0-9-]+$/;

/**
 * Validate an IPC channel name against injection patterns.
 */
export function validateChannel(channel: string): string {
  if (!CHANNEL_REGEX.test(channel)) {
    throw new Error(`Invalid IPC channel name: "${channel}"`);
  }
  return channel;
}
