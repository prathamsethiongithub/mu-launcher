/**
 * Shared mod-filename guard.
 *
 * RED-TEAM HARDENED (wave 2, B2): three modules each carried their own
 * "safe filename" check (mod-manager, mod-downloader, update-checker) and all
 * three only tested for `/`, `\` and `..`. That is a path-traversal check, not
 * a filename check, and it let four classes of hostile name through to the
 * filesystem:
 *
 *   1. Windows reserved device names — `con.jar`, `nul.jar`, `aux.jar`,
 *      `com1.jar`, `lpt1.jar`. These do not name a file in `mods/`; on Windows
 *      they resolve to the device. Writing one can hang on the console device
 *      or silently discard the payload.
 *   2. NTFS alternate data streams — `evil.jar:hidden`. The `:` opens a stream
 *      on `evil.jar`, so the "mod" is written into metadata a `.jar`-only
 *      lister never sees.
 *   3. Control characters — a NUL or `\u001f` in a name terminates the path at
 *      the syscall boundary, desynchronising the checked name from the written
 *      one.
 *   4. Trailing dot/space (Windows silently strips them), over-long names
 *      (MAX_PATH), and `.`/`..`-style dot names that slipped past a substring
 *      test.
 *
 * One guard, one policy, called by every module that turns an untrusted string
 * into a path segment. Pure — no fs — so it is unit-testable against the full
 * payload matrix.
 */

import { normalize } from 'path';

/** Conservative cap: even `BaseName-1.2.3.jar.disabled` stays well inside it. */
export const MAX_MOD_FILENAME_LENGTH = 200;

/** Windows reserved base names (compared case-insensitively, extension-free). */
const WINDOWS_RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface SafeModFilenameOptions {
  /** Require a `.jar` extension (case-insensitive, `.disabled` tolerated). */
  requireJar?: boolean;
  /** Human-readable operation, used in the error message. */
  op?: string;
}

/**
 * Throws when `filename` is not a bare, safe file name that may be joined onto
 * a directory. Returns normally otherwise.
 */
export function assertSafeModFilename(
  filename: unknown,
  opts: SafeModFilenameOptions = {},
): void {
  const { requireJar = false, op } = opts;
  const where = op ? ` for ${op}` : '';

  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error(`[mods] Unsafe mod filename${where}: not a non-empty string.`);
  }
  if (filename.length > MAX_MOD_FILENAME_LENGTH) {
    throw new Error(
      `[mods] Unsafe mod filename${where}: "${filename.slice(0, 40)}…" is ` +
        `${filename.length} chars (limit ${MAX_MOD_FILENAME_LENGTH}).`,
    );
  }
  if (/[/\\]/.test(filename)) {
    throw new Error(`[mods] Unsafe mod filename${where}: "${filename}" contains a path separator.`);
  }
  // 0x00–0x1F (incl. NUL) and 0x7F: path-terminating / non-printing bytes.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(filename)) {
    throw new Error(`[mods] Unsafe mod filename${where}: "${filename}" contains control characters.`);
  }
  if (filename.includes(':')) {
    throw new Error(
      `[mods] Unsafe mod filename${where}: "${filename}" contains ':' (alternate data stream).`,
    );
  }
  if (filename === '.' || filename === '..') {
    throw new Error(`[mods] Unsafe mod filename${where}: "${filename}" is a directory reference.`);
  }
  if (/[. ]$/.test(filename)) {
    throw new Error(
      `[mods] Unsafe mod filename${where}: "${filename}" ends with a dot or space.`,
    );
  }
  // Belt-and-braces: normalisation must not introduce a separator or a `..`
  // segment that the flat checks above missed (e.g. `a/..` spelled with a
  // Unicode separator that a platform might fold).
  const normalized = normalize(filename);
  if (normalized !== filename || /[/\\]/.test(normalized) || normalized.startsWith('..')) {
    throw new Error(`[mods] Unsafe mod filename${where}: "${filename}" does not normalise to itself.`);
  }

  // Reserved device name on the base (extension stripped). `console.jar` is
  // fine; `con.jar` is the console device.
  const base = filename.split('.')[0];
  if (WINDOWS_RESERVED_BASE.test(base)) {
    throw new Error(
      `[mods] Unsafe mod filename${where}: "${filename}" uses the reserved device name "${base}".`,
    );
  }

  if (requireJar) {
    const forExt = filename.endsWith('.disabled')
      ? filename.slice(0, -'.disabled'.length)
      : filename;
    if (!forExt.toLowerCase().endsWith('.jar')) {
      throw new Error(`[mods] Unsafe mod filename${where}: "${filename}" is not a .jar file.`);
    }
  }
}
