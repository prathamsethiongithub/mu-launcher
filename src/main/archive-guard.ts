/**
 * Archive budget guard — decompression-bomb containment for untrusted zips.
 *
 * RED-TEAM HARDENED (wave 2, B6): adm-zip's `ZipEntry.getData()` allocates a
 * buffer of the ENTRY'S DECLARED uncompressed size from the central directory
 * (`zipEntry.js`: `var data = Buffer.alloc(_centralHeader.size)`) and then
 * inflates into it. A 42 KB `.mrpack` whose central directory simply LIES —
 * declaring a 4 GB uncompressed entry — makes the main process allocate 4 GB
 * before a single byte is decompressed. No inflate limit can help, because the
 * bomb is the allocation itself. The only safe place to stop it is BEFORE
 * `getData()`: read the declared sizes, refuse the archive, never touch the
 * entry.
 *
 * This module is pure (no fs, no zip imports) so the budget policy is
 * unit-testable with plain entry-shaped objects. Callers pass anything with an
 * `entryName` and a `header.size` (adm-zip's entry shape).
 *
 * Budgets (a real Modrinth modpack lives far inside all four):
 *   - archive on disk      ≤ 512 MB
 *   - entry count          ≤ 20,000
 *   - one entry inflated   ≤ 512 MB
 *   - all entries inflated ≤ 2 GB
 */

export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_ENTRY_UNCOMPRESSED = 512 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;

/** Minimal shape of an adm-zip entry the guard needs (mirrors adm-zip). */
export interface ZipEntryLike {
  entryName: string;
  header?: { size?: number; compressedSize?: number };
}

/** The declared uncompressed size of an entry, or 0 when unknown/malformed. */
export function declaredUncompressed(entry: ZipEntryLike): number {
  const size = entry?.header?.size;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Refuse a single entry whose declared uncompressed size exceeds the
 * per-entry ceiling. Throws `[E705]` — never returns silently: the caller must
 * treat a refused entry as a hard failure, not skip it.
 */
export function assertEntryBudget(entry: ZipEntryLike, label = 'entry'): void {
  const size = declaredUncompressed(entry);
  if (size > MAX_ENTRY_UNCOMPRESSED) {
    throw new Error(
      `[E705] Refusing archive ${label} "${entry?.entryName ?? '?'}" — declares ` +
        `${size} uncompressed bytes (limit ${MAX_ENTRY_UNCOMPRESSED}); this is a ` +
        'decompression bomb, not a modpack.',
    );
  }
}

/**
 * Refuse an archive whose central directory is out of budget: too many
 * entries, or a declared uncompressed total above the ceiling. Throws `[E705]`.
 * Must be called BEFORE any `getData()` / `extractAllTo()`.
 */
export function assertArchiveBudget(entries: readonly ZipEntryLike[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `[E705] Refusing archive — ${entries.length} entries (limit ${MAX_ARCHIVE_ENTRIES}).`,
    );
  }
  let total = 0;
  for (const entry of entries) {
    total += declaredUncompressed(entry);
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error(
        `[E705] Refusing archive — declared uncompressed payload exceeds ` +
          `${MAX_TOTAL_UNCOMPRESSED} bytes (decompression bomb).`,
      );
    }
  }
}

/** Refuse an archive buffer larger than the on-disk ceiling (before parsing). */
export function assertArchiveSize(bytes: number): void {
  if (bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `[E705] Refusing archive — ${bytes} bytes on disk exceeds the ` +
        `${MAX_ARCHIVE_BYTES}-byte limit.`,
    );
  }
}
