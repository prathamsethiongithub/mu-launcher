/**
 * E2E case 8 — identity-library: shelf cards render from the seeded
 * user-data library with a correct (absent) active mark.
 *
 * HISTORICAL NOTE: before the userData isolation fix, the app FORCED
 * userData to %APPDATA%/mu-master-launcher (index.ts:62 ignored
 * --user-data-dir), so this test had to back up the real skins.json +
 * skins-library/, run against synthetic entries, and restore the
 * originals. Now the harness's --user-data-dir wins, so the synthetic
 * library is seeded straight into the scratch profile — the real user
 * data is never touched by any test.
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { launchTestApp } from './harness';

// ── synthetic skin PNG builder (same geometry heuristic the app detects) ────
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
function buildSkinPng(shade: number): Buffer {
  const raw = Buffer.alloc((64 * 4 + 1) * 64);
  let p = 0;
  for (let y = 0; y < 64; y++) {
    raw[p++] = 0;
    for (let x = 0; x < 64; x++) {
      raw[p++] = (x * 2 + shade) & 0xff;
      raw[p++] = (y * 3) & 0xff;
      raw[p++] = 0x40;
      raw[p++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Seed a two-skin synthetic library into the scratch user-data dir. */
const seedTwoSkinLibrary = (dir: string): void => {
  fs.mkdirSync(path.join(dir, 'skins-library'), { recursive: true });
  const pngs = [buildSkinPng(0), buildSkinPng(120)];
  const skins = pngs.map((png, i) => ({
    id: `e2e-skin-${i}`,
    name: `e2e skin ${i === 0 ? 'one' : 'two'}`,
    fileName: `e2e-skin-${i}.png`,
    model: 'classic' as const,
    addedAt: new Date().toISOString(),
    hash: createHash('sha1').update(png).digest('hex'),
  }));
  skins.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, 'skins-library', `${s.id}.png`), pngs[i]);
  });
  fs.writeFileSync(
    path.join(dir, 'skins.json'),
    JSON.stringify({ schemaVersion: 1, skins }, null, 2),
  );
};

test('identity-library: shelf renders cards from the library, active mark honest', async () => {
  const ta = await launchTestApp({ seed: seedTwoSkinLibrary });
  try {
    // ── Account → shelf assertions ──
    const clicked = await ta.window.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Account',
      );
      if (!btn) return false;
      (btn as HTMLButtonElement).click();
      return true;
    });
    expect(clicked).toBe(true);
    await ta.window.waitForTimeout(800);

    const shelf = await ta.window.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasOne: text.includes('e2e skin one'),
        hasTwo: text.includes('e2e skin two'),
        // Count only the per-SHELF-CARD badge: a leaf element whose text is
        // exactly 'active' INSIDE a shelf card (the w-104px flex column).
        // The hero-level 'active' span (parent mt-1 hero name row) is the
        // account skin's honest mark and must NOT be counted here.
        activeBadges: [...document.querySelectorAll('div.w-\\[104px\\] span, div.w-\\[104px\\] p, div.w-\\[104px\\] div')]
          .filter((el) => el.childElementCount === 0 && el.textContent?.trim() === 'active')
          .length,
        hasAddCard: text.includes('add a skin'),
      };
    });
    expect(shelf.hasOne, 'first library card name not rendered').toBe(true);
    expect(shelf.hasTwo, 'second library card name not rendered').toBe(true);
    expect(shelf.hasAddCard, 'dashed add-a-skin card missing').toBe(true);
    // Honest active mark: synthetic hashes can never match the worn skin —
    // and on a signed-out/unknown account there is no worn hash at all.
    expect(shelf.activeBadges).toBe(0);
  } finally {
    await ta.cleanup();
  }
});
