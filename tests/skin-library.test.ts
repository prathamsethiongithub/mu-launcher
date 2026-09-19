// tests/skin-library.test.ts — pure-logic coverage for the skin library:
// registry normalize/load, sha1 dedupe, name cleaning, PNG validation,
// slim-detection heuristic, hash-based "wearing" comparison, atomic writes.

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  checkSkinPng,
  detectSkinModel,
  normalizeRegistry,
  sanitizeSkinName,
  sha1Hex,
  SkinLibrary,
} from '../src/main/skin-library';

// ── PNG fixture builder (valid PNG, no deps) ────────────────────────────────

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Build a 64×64 RGBA PNG. armSlim: leave pixels (54,20)/(55,20) transparent. */
function buildSkinPng(opts: { slim?: boolean; height?: number; rgbOnly?: boolean } = {}): Buffer {
  const height = opts.height ?? 64;
  const colorType = opts.rgbOnly ? 2 : 6;
  const bpp = colorType === 6 ? 4 : 3;
  const stride = 64 * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < 64; x++) {
      const isArmCut = !!opts.slim && (x === 54 || x === 55) && y >= 16 && y < 24;
      raw[p++] = (x * 3) & 0xff;
      raw[p++] = (y * 5) & 0xff;
      raw[p++] = 0x40;
      if (colorType === 6) raw[p++] = isArmCut ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── sanitizeSkinName ────────────────────────────────────────────────────────
describe('sanitizeSkinName', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeSkinName('  My   Cool  Skin ')).toBe('My Cool Skin');
  });
  it('strips control characters', () => {
    expect(sanitizeSkinName('bad\u0000\u001fname')).toBe('badname');
  });
  it('caps at 40 characters', () => {
    expect(sanitizeSkinName('a'.repeat(80)).length).toBe(40);
  });
  it('falls back to a quiet default when empty', () => {
    expect(sanitizeSkinName('   ')).toBe('unnamed skin');
    expect(sanitizeSkinName('\u0000\u001f')).toBe('unnamed skin');
  });
});

// ── sha1Hex ─────────────────────────────────────────────────────────────────
describe('sha1Hex', () => {
  it('matches the known sha1 of the empty buffer', () => {
    expect(sha1Hex(Buffer.alloc(0))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
  it('is stable across identical bytes and differs on any change', () => {
    const a = Buffer.from([1, 2, 3]);
    expect(sha1Hex(a)).toBe(sha1Hex(Buffer.from([1, 2, 3])));
    expect(sha1Hex(a)).not.toBe(sha1Hex(Buffer.from([1, 2, 4])));
  });
});

// ── checkSkinPng ────────────────────────────────────────────────────────────
describe('checkSkinPng', () => {
  it('accepts a 64×64 skin', () => {
    const r = checkSkinPng(buildSkinPng());
    expect(r.ok).toBe(true);
    expect(r.width).toBe(64);
    expect(r.height).toBe(64);
  });
  it('accepts the legacy 64×32 format', () => {
    expect(checkSkinPng(buildSkinPng({ height: 32 })).ok).toBe(true);
  });
  it('rejects other sizes with a human reason naming the dimensions', () => {
    const r = checkSkinPng(buildSkinPng({ height: 48 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('64×48');
  });
  it('rejects non-PNG bytes', () => {
    expect(checkSkinPng(Buffer.from('hello, not a png')).ok).toBe(false);
  });
  it('rejects truncated PNGs', () => {
    expect(checkSkinPng(buildSkinPng().subarray(0, 12)).ok).toBe(false);
  });
});

// ── detectSkinModel ─────────────────────────────────────────────────────────
describe('detectSkinModel', () => {
  it('returns classic for the 4px-arm classic texture', () => {
    expect(detectSkinModel(buildSkinPng({ slim: false }))).toBe('classic');
  });
  it('returns slim when the arm-cut columns are transparent', () => {
    expect(detectSkinModel(buildSkinPng({ slim: true }))).toBe('slim');
  });
  it('defaults to classic for RGB-only textures (no alpha to inspect)', () => {
    expect(detectSkinModel(buildSkinPng({ rgbOnly: true }))).toBe('classic');
  });
  it('defaults to classic for legacy 64×32 (uncertain case)', () => {
    expect(detectSkinModel(buildSkinPng({ height: 32, slim: true }))).toBe('classic');
  });
  it('defaults to classic on garbage input instead of throwing', () => {
    expect(detectSkinModel(Buffer.from('garbage'))).toBe('classic');
  });
});

// ── normalizeRegistry ───────────────────────────────────────────────────────
describe('normalizeRegistry', () => {
  it('accepts a valid v1 registry and drops malformed entries', () => {
    const reg = normalizeRegistry({
      schemaVersion: 1,
      skins: [
        { id: 'a', name: 'A', fileName: 'a.png', model: 'slim', addedAt: 't', hash: 'h1' },
        { id: 42 },
        null,
        { id: 'b', name: 'B', fileName: 'b.png', model: 'nope', addedAt: 't', hash: 'h2' },
      ],
    });
    expect(reg.schemaVersion).toBe(1);
    expect(reg.skins).toHaveLength(1);
    expect(reg.skins[0].id).toBe('a');
  });
  it('returns a fresh registry for corrupt/wrong-version input', () => {
    expect(normalizeRegistry(null).skins).toEqual([]);
    expect(normalizeRegistry('garbage').skins).toEqual([]);
    expect(normalizeRegistry({ schemaVersion: 2, skins: [] }).skins).toEqual([]);
  });
});

// ── SkinLibrary (fs round-trips, real tmp dirs) ─────────────────────────────
describe('SkinLibrary', () => {
  it('imports, dedupes by content hash, renames, re-models, removes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skinlib-'));
    try {
      const lib = new SkinLibrary(dir);
      expect(lib.list()).toEqual([]);

      const srcPng = buildSkinPng({ slim: true });
      const srcPath = path.join(dir, 'alex-classic-slim.png');
      fs.writeFileSync(srcPath, srcPng);

      const added = lib.importFromPath(srcPath, '  My   Alex ');
      expect(added.status).toBe('added');
      if (added.status !== 'added') return;
      expect(added.skin.name).toBe('My Alex');
      expect(added.skin.model).toBe('slim'); // heuristic applied at import
      expect(existsSync(path.join(lib.libraryDir, added.skin.fileName))).toBe(true);

      // Duplicate content → same entry, human message, no second file.
      const dup = lib.importBuffer(srcPng, 'another name');
      expect(dup.status).toBe('duplicate');
      if (dup.status === 'duplicate') {
        expect(dup.skin.id).toBe(added.skin.id);
        expect(dup.message).toContain("already in your library as 'My Alex'");
      }

      // Different bytes → separate entry.
      const other = lib.importBuffer(buildSkinPng({ slim: false }), 'Steve-ish');
      expect(other.status).toBe('added');

      // Rename + re-model persist across reload.
      expect(lib.rename(added.skin.id, 'renamed  skin')?.name).toBe('renamed skin');
      expect(lib.setModel(added.skin.id, 'classic')?.model).toBe('classic');
      const reloaded = new SkinLibrary(dir);
      expect(reloaded.get(added.skin.id)?.name).toBe('renamed skin');
      expect(reloaded.get(added.skin.id)?.model).toBe('classic');

      // markEquipped persists.
      reloaded.markEquipped(added.skin.id);
      expect(new SkinLibrary(dir).get(added.skin.id)?.lastEquippedAt).toBeTruthy();

      // Remove: registry entry AND file disappear.
      expect(reloaded.remove(added.skin.id)).toBe(true);
      expect(reloaded.get(added.skin.id)).toBeNull();
      expect(existsSync(path.join(reloaded.libraryDir, added.skin.fileName))).toBe(false);
      expect(reloaded.remove(added.skin.id)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid PNGs without touching the registry', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skinlib3-'));
    try {
      const lib = new SkinLibrary(dir);
      const bad = path.join(dir, 'bad.png');
      fs.writeFileSync(bad, Buffer.from('not a png'));
      const r = lib.importFromPath(bad, 'bad');
      expect(r.status).toBe('rejected');
      expect(lib.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a corrupt registry file (degrades to fresh, never throws)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skinlib4-'));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'skins.json'), '{corrupt!!');
      const lib = new SkinLibrary(dir);
      expect(lib.list()).toEqual([]);
      // And the next save overwrites the corruption.
      const srcPng = path.join(dir, 's.png');
      fs.writeFileSync(srcPng, buildSkinPng());
      expect(lib.importFromPath(srcPng, 'ok').status).toBe('added');
      expect(JSON.parse(readFileSync(path.join(dir, 'skins.json'), 'utf8')).schemaVersion).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomic write leaves no tmp file behind', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'skinlib5-'));
    try {
      const lib = new SkinLibrary(dir);
      const srcPng = path.join(dir, 's.png');
      fs.writeFileSync(srcPng, buildSkinPng());
      lib.importFromPath(srcPng, 'atomic');
      expect(existsSync(path.join(dir, 'skins.json.tmp'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
