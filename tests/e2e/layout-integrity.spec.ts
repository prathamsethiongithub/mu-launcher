/**
 * Layout integrity — the overflow law as a gate.
 *
 * User law: at ANY window size, nothing in the launcher may be hidden,
 * clipped away, or covered by another element. The dock nav lives IN FLOW
 * (Layout's bottom slot), main scrolls when a view is taller than the
 * window, and every interactive element must either be fully visible and
 * hit-testable, or reachable by scrolling inside a scrollable container.
 *
 * Sizes: 900x600 is the app's real minimum (main/index.ts minWidth 900 /
 * minHeight 600 — an 800x600 window cannot exist), 1280x720 is the common
 * laptop case, 1600x500 is the ultra-flat case (height clamps to the 600
 * minimum; the width stress-tests horizontal layouts).
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { launchTestApp } from './harness';
import { LAYOUT_AUDIT } from './layout-audit';

const SIZES = [
  { w: 900, h: 600 },
  { w: 1280, h: 720 },
  { w: 1600, h: 500 },
] as const;

/** Every dock view the audit must walk. */
const VIEWS = ['Play', 'Worlds', 'Account', 'Setup'] as const;

// ── Identity Studio seed ─────────────────────────────────────────────────
// Byte-level seed of the app-owned files (identity.json / skins.json /
// skins-library/*.png) so the E2E exercises the studio in its RICH states
// deterministically — fresh installs are always empty. No app code touched.

/** Minimal CRC32 for hand-built PNG chunks. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** A valid 64×64 RGBA skin PNG (opaque → classic model). */
const makeSkinPng = (r: number, g: number, b: number): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + 64 * 4);
  for (let x = 0; x < 64; x++) {
    row[1 + x * 4] = r;
    row[2 + x * 4] = g;
    row[3 + x * 4] = b;
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: 64 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const seedIdentityProfile = (dir: string): void => {
  const iso = new Date().toISOString();
  const libDir = path.join(dir, 'skins-library');
  fs.mkdirSync(libDir, { recursive: true });
  const pngs = [
    makeSkinPng(40, 90, 180),
    makeSkinPng(180, 90, 40),
    makeSkinPng(60, 160, 60),
    makeSkinPng(160, 60, 160),
  ];
  const hash = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');
  const skins = [
    { id: 'skin-1', name: 'classic steve', fileName: 'skin-1.png', model: 'classic', addedAt: iso, hash: hash(pngs[0]) },
    { id: 'skin-2', name: 'slim alex', fileName: 'skin-2.png', model: 'slim', addedAt: iso, hash: hash(pngs[1]) },
    { id: 'skin-3', name: 'x'.repeat(40), fileName: 'skin-3.png', model: 'classic', addedAt: iso, hash: hash(pngs[2]) }, // long-name truncation case
    { id: 'skin-4', name: 'archive one', fileName: 'skin-4.png', model: 'classic', addedAt: iso, hash: hash(pngs[3]) },
  ];
  pngs.forEach((buf, i) => fs.writeFileSync(path.join(libDir, `skin-${i + 1}.png`), buf));
  fs.writeFileSync(path.join(dir, 'skins.json'), JSON.stringify({ schemaVersion: 1, skins }, null, 2));
  fs.writeFileSync(
    path.join(dir, 'identity.json'),
    JSON.stringify(
      {
        accounts: [
          {
            id: 'acc-rich',
            type: 'offline',
            username: 'gigamegachad',
            uuid: '11111111-1111-3111-8111-111111111111',
            createdAt: iso,
            lastUsedAt: iso,
          },
          {
            // The empty-library state: second account, no skins, no session.
            id: 'acc-empty',
            type: 'offline',
            username: 'emptyone',
            uuid: '22222222-2222-3222-8222-222222222222',
            createdAt: iso,
          },
        ],
        activeAccountId: 'acc-rich',
        sessions: {
          'acc-rich': { accountId: 'acc-rich', authenticated: true, lastValidatedAt: iso },
          'acc-empty': { accountId: 'acc-empty', authenticated: true, lastValidatedAt: iso },
        },
      },
      null,
      2,
    ),
  );
};

/** Click the first shelf card (opens the preview state). */
const clickFirstShelfCard = (window: import('playwright').Page): Promise<boolean> =>
  window.evaluate(() => {
    const card = [...document.querySelectorAll('main div')].find(
      (d) =>
        typeof d.className === 'string' &&
        d.className.includes('w-[104px]') &&
        d.className.includes('cursor-pointer'),
    );
    if (!card) return false;
    (card as HTMLElement).click();
    return true;
  });

test.describe('layout integrity (overflow law)', () => {
  test('nothing hidden, clipped, or covered at 3 window sizes × 4 views', async () => {
    const ta = await launchTestApp();
    try {
      const bw = await ta.app.browserWindow(ta.window);

      for (const size of SIZES) {
        await bw.evaluate((win, [w, h]) => win.setContentSize(w, h), [size.w, size.h]);
        await ta.window.waitForTimeout(600);

        for (const view of VIEWS) {
          const clicked = await ta.window.evaluate((label) => {
            const btn = [...document.querySelectorAll('nav button')].find(
              (b) => b.textContent?.trim() === label,
            );
            if (!btn) return false;
            btn.click();
            return true;
          }, view);
          expect(clicked, `nav button "${view}" exists`).toBe(true);
          await ta.window.waitForTimeout(500);

          const res = await ta.window.evaluate(LAYOUT_AUDIT);
          expect(
            res.problems,
            `${size.w}x${size.h} ${view}`,
          ).toEqual([]);
        }
      }
    } finally {
      await ta.cleanup();
    }
  });

  // The Identity Studio in its RICH states: offline account with a seeded
  // library, the card-preview state, and the EMPTY-library state (second
  // seeded account). 900x600 = minimum, 1600x500 = ultra-flat.
  test('identity studio: rich library + preview states stay clean', async () => {
    const ta = await launchTestApp({ seed: seedIdentityProfile });
    try {
      const bw = await ta.app.browserWindow(ta.window);
      const openAccount = () =>
        ta.window.evaluate(() => {
          const btn = [...document.querySelectorAll('nav button')].find(
            (b) => b.textContent?.trim() === 'Account',
          );
          if (!btn) return false;
          btn.click();
          return true;
        });

      for (const size of [SIZES[0], SIZES[2]]) {
        await bw.evaluate((win, [w, h]) => win.setContentSize(w, h), [size.w, size.h]);
        await ta.window.waitForTimeout(600);

        // State 1: offline account + rich library (account strip, shelf,
        // "+ add" card, hero). Equip is the offline-disabled path here.
        expect(await openAccount(), 'nav Account exists').toBe(true);
        await ta.window.waitForTimeout(800);
        expect(
          (await ta.window.evaluate(LAYOUT_AUDIT)).problems,
          `${size.w}x${size.h} identity rich-library`,
        ).toEqual([]);

        // State 2: preview a card → hero swaps, equip row appears
        // (offline → the disabled "requires microsoft" affordance).
        expect(await clickFirstShelfCard(ta.window), 'shelf card exists').toBe(true);
        await ta.window.waitForTimeout(800);
        expect(
          (await ta.window.evaluate(LAYOUT_AUDIT)).problems,
          `${size.w}x${size.h} identity preview`,
        ).toEqual([]);

        // State 3: the empty-library account — no cards, no preview, the
        // offline explainer text and the shelf's lone "+ add" invitation.
        const nextAccount = await ta.window.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Next account"]');
          if (!btn) return false;
          btn.click();
          return true;
        });
        expect(nextAccount, 'next-account arrow exists (2 seeded accounts)').toBe(true);
        await ta.window.waitForTimeout(1000);
        expect(
          (await ta.window.evaluate(LAYOUT_AUDIT)).problems,
          `${size.w}x${size.h} identity empty-library`,
        ).toEqual([]);
      }
    } finally {
      await ta.cleanup();
    }
  });
});
