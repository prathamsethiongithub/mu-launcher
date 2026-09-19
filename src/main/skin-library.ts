/**
 * Skin Library — the Identity Studio's private wardrobe (Phase A).
 *
 * A single registry file ({userData}/skins.json) + one PNG per entry under
 * {userData}/skins-library/. Every mutation of the registry is an atomic
 * tmp+rename write; the registry load validates shape and degrades to a
 * fresh registry rather than poisoning the session with corrupt state.
 *
 * Pure helpers (PNG validation, slim detection, name cleaning, sha1, version
 * comparison of the registry schema) are exported for vitest coverage.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

export interface SavedSkin {
  id: string;
  name: string;
  fileName: string;
  model: 'classic' | 'slim';
  addedAt: string;
  lastEquippedAt?: string;
  /** sha1 of the PNG bytes — the dedupe key AND the honest "active" check. */
  hash: string;
}

export interface SkinRegistry {
  schemaVersion: 1;
  skins: SavedSkin[];
}

// ── pure helpers ────────────────────────────────────────────────────────────

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Clean a user-supplied skin name: collapse whitespace, strip control
 * characters and separators that would confuse the shelf, cap at 40 chars.
 * Empty result falls back to a quiet default so a registry entry is never
 * nameless.
 */
export function sanitizeSkinName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned || 'unnamed skin';
}

export interface PngCheck {
  ok: boolean;
  reason?: string;
  width?: number;
  height?: number;
}

/** PNG magic (89 50 4E 47 0D 0A 1A 0A). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Validate a skin PNG by header: magic + IHDR dimensions. Only 64×64 (modern)
 * and 64×32 (legacy) are Minecraft-valid. Returns a human-readable reason on
 * rejection — the error the user sees, so it speaks like the rest of the app.
 */
export function checkSkinPng(buf: Buffer): PngCheck {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, reason: 'That file isn’t a PNG image.' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 64 && height === 64) return { ok: true, width, height };
  if (width === 64 && height === 32) return { ok: true, width, height };
  return {
    ok: false,
    reason: `That PNG is ${width}×${height} — skins are 64×64 (or the legacy 64×32).`,
  };
}

/**
 * Slim (Alex) detection heuristic — pure function over the raw PNG bytes.
 *
 * Source of the heuristic: Mojang's Alex geometry gives slim arms a 3px-wide
 * top face. On a 64×64 texture the right-arm region starts at x=40; the
 * classic model paints the full 4px-wide top column while slim leaves the
 * 4th column transparent. The pixels (54, 20) and (55, 20) fall in that
 * column — the same transparency criterion used by community skin tools
 * (Crafatar / Minotar model detection) since the Alex model shipped in 2014.
 *
 * Requires a decodeable RGBA/RGB 64×64 texture. Anything else (palette PNGs,
 * 64×32 legacy, undecodable data) returns 'classic' — the uncertain case
 * defaults to classic per the task spec, and the user can override.
 */
export function detectSkinModel(buf: Buffer): 'classic' | 'slim' {
  try {
    const png = parsePngPixels(buf);
    // The arm-region coordinates below are only valid on the modern 64×64
    // layout. Legacy 64×32 skins are the documented uncertain case → classic
    // (the user can override the model per entry).
    if (!png || png.width !== 64 || png.height !== 64) return 'classic';
    if (png.colorType !== 6) return 'classic'; // no alpha channel → nothing to detect
    const alphaAt = (x: number, y: number): number => png.data[(y * 64 + x) * 4 + 3];
    // Both columns transparent in the arm-top region → the slim cut.
    if (alphaAt(54, 20) === 0 && alphaAt(55, 20) === 0) return 'slim';
    return 'classic';
  } catch {
    return 'classic';
  }
}

interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  /** Unfiltered RGBA row-major bytes (64-wide rows). */
  data: Buffer;
}

/** Minimal PNG decode: IHDR + concat IDAT + inflate + unfilter, RGBA/RGB 8-bit. */
function parsePngPixels(buf: Buffer): DecodedPng | null {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) return null;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height || (colorType !== 6 && colorType !== 2)) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = Buffer.from(row);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 1: cur[x] = (cur[x] + a) & 0xff; break;
        case 2: cur[x] = (cur[x] + b) & 0xff; break;
        case 3: cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (cur[x] + pred) & 0xff;
          break;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp];
      out[o + 1] = cur[x * bpp + 1];
      out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = colorType === 6 ? cur[x * bpp + 3] : 255;
    }
    row.copy(prev);
  }
  return { width, height, colorType, data: out };
}

/**
 * Defensive registry load: any shape violation (wrong schemaVersion, missing
 * arrays, malformed entries) returns a fresh empty registry instead of
 * throwing — a corrupt skins.json must never take the studio down.
 */
export function normalizeRegistry(value: unknown): SkinRegistry {
  if (
    value &&
    typeof value === 'object' &&
    (value as SkinRegistry).schemaVersion === 1 &&
    Array.isArray((value as SkinRegistry).skins)
  ) {
    const skins = ((value as SkinRegistry).skins as unknown[]).filter(
      (s): s is SavedSkin =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as SavedSkin).id === 'string' &&
        typeof (s as SavedSkin).name === 'string' &&
        typeof (s as SavedSkin).fileName === 'string' &&
        ((s as SavedSkin).model === 'classic' || (s as SavedSkin).model === 'slim') &&
        typeof (s as SavedSkin).hash === 'string',
    );
    return { schemaVersion: 1, skins };
  }
  return { schemaVersion: 1, skins: [] };
}

// ── equip → all-views sync (Stage 1 fix) ───────────────────────────────────

/**
 * Write-through decision: the 24h skin cache is keyed by account UUID, so a
 * write-through is only possible (and only meaningful) when the account has
 * one. Empty/missing uuid → nothing to write; the broadcast is skipped with
 * it, because no view could resolve a skin for that account anyway.
 */
export function shouldWriteThroughCache(uuid: string | null | undefined): boolean {
  return typeof uuid === 'string' && uuid.length > 0;
}

export interface SkinChangedPayload {
  accountId: string;
  model: 'classic' | 'slim';
  changedAt: string;
}

/** Event payload for the 'skin-changed' broadcast (injectable clock for tests). */
export function buildSkinChangedPayload(
  accountId: string,
  model: 'classic' | 'slim',
  now: number = Date.now(),
): SkinChangedPayload {
  return { accountId, model, changedAt: new Date(now).toISOString() };
}

// ── the library itself ──────────────────────────────────────────────────────

export type ImportResult =
  | { status: 'added'; skin: SavedSkin }
  | { status: 'duplicate'; skin: SavedSkin; message: string }
  | { status: 'rejected'; reason: string };

/**
 * The wardrobe. Owns {userData}/skins.json and {userData}/skins-library/.
 * One instance per app lifetime (constructed at whenReady, used by IPC).
 */
export class SkinLibrary {
  readonly registryPath: string;
  readonly libraryDir: string;

  constructor(private userDataDir: string) {
    this.registryPath = join(userDataDir, 'skins.json');
    this.libraryDir = join(userDataDir, 'skins-library');
  }

  private ensureDirs(): void {
    mkdirSync(this.libraryDir, { recursive: true });
  }

  private loadRegistry(): SkinRegistry {
    if (!existsSync(this.registryPath)) return { schemaVersion: 1, skins: [] };
    try {
      return normalizeRegistry(JSON.parse(readFileSync(this.registryPath, 'utf8')));
    } catch {
      return { schemaVersion: 1, skins: [] }; // corrupt → fresh, never fatal
    }
  }

  /** Atomic persist: write tmp sibling, then rename over the live file. */
  private saveRegistry(registry: SkinRegistry): void {
    this.ensureDirs();
    const tmp = `${this.registryPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    renameSync(tmp, this.registryPath);
  }

  list(): SavedSkin[] {
    return this.loadRegistry().skins;
  }

  get(id: string): SavedSkin | null {
    return this.loadRegistry().skins.find((s) => s.id === id) ?? null;
  }

  /** Absolute path of a skin's PNG (the equip upload source). */
  filePath(id: string): string {
    return join(this.libraryDir, `${id}.png`);
  }

  /** True when the PNG file for the entry actually exists on disk. */
  fileExists(id: string): boolean {
    return existsSync(this.filePath(id));
  }

  /**
   * Import a skin PNG from a main-process-held path (the select-skin-file
   * custody model — the renderer never supplies paths).
   */
  importFromPath(srcPath: string, suggestedName: string): ImportResult {
    let buf: Buffer;
    try {
      buf = readFileSync(srcPath);
    } catch {
      return { status: 'rejected', reason: 'Could not read that file.' };
    }
    return this.importBuffer(buf, suggestedName);
  }

  /** Import raw PNG bytes (e.g. the account skin fetched via skin-service). */
  importBuffer(buf: Buffer, suggestedName: string): ImportResult {
    const check = checkSkinPng(buf);
    if (!check.ok) return { status: 'rejected', reason: check.reason ?? 'That file is not a valid skin.' };

    const hash = sha1Hex(buf);
    const registry = this.loadRegistry();
    const existing = registry.skins.find((s) => s.hash === hash);
    if (existing) {
      return {
        status: 'duplicate',
        skin: existing,
        message: `already in your library as '${existing.name}'`,
      };
    }

    this.ensureDirs();
    const id = randomUUID();
    const fileName = `${id}.png`;
    writeFileSync(join(this.libraryDir, fileName), buf);
    const skin: SavedSkin = {
      id,
      name: sanitizeSkinName(suggestedName),
      fileName,
      model: detectSkinModel(buf),
      addedAt: new Date().toISOString(),
      hash,
    };
    registry.skins.push(skin);
    this.saveRegistry(registry);
    return { status: 'added', skin };
  }

  rename(id: string, rawName: string): SavedSkin | null {
    const registry = this.loadRegistry();
    const skin = registry.skins.find((s) => s.id === id);
    if (!skin) return null;
    skin.name = sanitizeSkinName(rawName);
    this.saveRegistry(registry);
    return skin;
  }

  setModel(id: string, model: 'classic' | 'slim'): SavedSkin | null {
    const registry = this.loadRegistry();
    const skin = registry.skins.find((s) => s.id === id);
    if (!skin) return null;
    skin.model = model;
    this.saveRegistry(registry);
    return skin;
  }

  remove(id: string): boolean {
    const registry = this.loadRegistry();
    const before = registry.skins.length;
    registry.skins = registry.skins.filter((s) => s.id !== id);
    if (registry.skins.length === before) return false;
    this.saveRegistry(registry);
    try {
      const file = join(this.libraryDir, `${id}.png`);
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // Registry entry is gone; an orphaned PNG is cosmetic, not fatal.
    }
    return true;
  }

  markEquipped(id: string): SavedSkin | null {
    const registry = this.loadRegistry();
    const skin = registry.skins.find((s) => s.id === id);
    if (!skin) return null;
    skin.lastEquippedAt = new Date().toISOString();
    this.saveRegistry(registry);
    return skin;
  }
}

// node:fs/promises unlink is overkill for the sync-atomic style here; the
// sync unlink above matches the registry's sync-atomic discipline.
