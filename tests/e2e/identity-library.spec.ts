/**
 * E2E case 8 — identity-library: shelf cards render from the real userData
 * library with a correct (absent) active mark.
 *
 * USER-DATA WARNING: the app forces userData to %APPDATA%/mu-master-launcher
 * (index.ts:62 ignores --user-data-dir). This test therefore backs up the
 * real skins.json + skins-library/, runs against synthetic entries, and
 * RESTORES the originals in a finally block. No equip actions are performed.
 */

import { test, expect } from 'playwright/test';
import { _electron } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const USER_DATA = path.join(process.env.APPDATA ?? '', 'mu-master-launcher');

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

const REGISTRY_BACKUP = USER_DATA + '/skins.json.e2e-bak';
const LIB_BACKUP = USER_DATA + '/skins-library.e2e-bak';

test('identity-library: shelf renders cards from the library, active mark honest', async () => {
  // ── backup the real library ──
  const hadRegistry = fs.existsSync(USER_DATA + '/skins.json');
  if (hadRegistry) fs.renameSync(USER_DATA + '/skins.json', REGISTRY_BACKUP);
  const hadLibrary = fs.existsSync(USER_DATA + '/skins-library');
  if (hadLibrary) fs.renameSync(USER_DATA + '/skins-library', LIB_BACKUP);

  try {
    // ── write a synthetic two-skin library ──
    fs.mkdirSync(USER_DATA + '/skins-library', { recursive: true });
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
      fs.writeFileSync(path.join(USER_DATA, 'skins-library', `${s.id}.png`), pngs[i]);
    });
    fs.writeFileSync(
      USER_DATA + '/skins.json',
      JSON.stringify({ schemaVersion: 1, skins }, null, 2),
    );

    // ── boot the app fresh ──
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-e2e-lib-'));
    const app = await _electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${scratchDir}`],
      timeout: 30_000,
    });
    let window = null as null | Awaited<ReturnType<typeof app.firstWindow>>;
    const t0 = Date.now();
    while (Date.now() - t0 < 35_000 && !window) {
      for (const w of app.windows()) {
        if (/renderer[\\/]index\.html/.test(w.url())) { window = w; break; }
      }
      if (!window) await new Promise((r) => setTimeout(r, 400));
    }
    if (!window) throw new Error('main window never appeared');
    await window.waitForLoadState('domcontentloaded');

    // ── Account → shelf assertions ──
    const clicked = await window.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Account',
      );
      if (!btn) return false;
      (btn as HTMLButtonElement).click();
      return true;
    });
    expect(clicked).toBe(true);
    await window.waitForTimeout(800);

    const shelf = await window.evaluate(() => {
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

    await app.close();
    window = null;

    // ── restore the real library ──
    fs.rmSync(USER_DATA + '/skins-library', { recursive: true, force: true });
    if (hadRegistry) fs.renameSync(REGISTRY_BACKUP, USER_DATA + '/skins.json');
    if (hadLibrary) fs.renameSync(LIB_BACKUP, USER_DATA + '/skins-library');
  } catch (err) {
    // Crash-safe restore even on failure.
    fs.rmSync(USER_DATA + '/skins-library', { recursive: true, force: true });
    if (hadRegistry && fs.existsSync(REGISTRY_BACKUP)) {
      fs.renameSync(REGISTRY_BACKUP, USER_DATA + '/skins.json');
    }
    if (hadLibrary && fs.existsSync(LIB_BACKUP)) {
      fs.renameSync(LIB_BACKUP, USER_DATA + '/skins-library');
    }
    throw err;
  }
});
