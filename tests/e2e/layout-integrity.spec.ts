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

const SIZES = [
  { w: 900, h: 600 },
  { w: 1280, h: 720 },
  { w: 1600, h: 500 },
] as const;

const VIEWS = ['Play', 'Worlds', 'Account', 'Setup'] as const;

/** In-page audit. Returns a list of human-readable layout violations. */
const LAYOUT_AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const tol = 1.5;
  const problems: string[] = [];


  // 1. main: no INTERACTIVE content may extend beyond its client box.
  //    Decorative ambient layers (SideRays mounts at -mx-10 to bleed to the
  //    window edges, pointer-events-none + aria-hidden) legitimately overflow
  //    and are clipped by overflow-x-hidden — that is paint, not content.
  const main = document.querySelector('main');
  if (main) {
    const mRect = main.getBoundingClientRect();
    const isDecorative = (el: Element): boolean => {
      let a: Element | null = el;
      while (a && a !== main) {
        if (a.getAttribute('aria-hidden') === 'true') return true;
        if ((a as HTMLElement).offsetParent === null) return true;
        a = a.parentElement;
      }
      return false;
    };
    for (const el of main.querySelectorAll('button, a, select, input, p, h1, h2, span')) {
      if (!(el as HTMLElement).offsetParent) continue;
      if (isDecorative(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < mRect.left - tol || r.right > mRect.right + tol) {
        problems.push(
          `content outside main box: ${el.tagName}:${(el.textContent || '').trim().slice(0, 20)} l=${Math.round(r.left)} r=${Math.round(r.right)}`,
        );
      }
    }
  }

  // 2. The nav rail: four items, all inside the viewport, never truncated.
  const nav = document.querySelector('nav');
  const navLabels: string[] = [];
  if (!nav) {
    problems.push('nav rail missing');
  } else {
    const nr = nav.getBoundingClientRect();
    if (nr.top < -tol || nr.left < -tol || nr.right > vw + tol || nr.bottom > vh + tol) {
      problems.push(`nav rail outside viewport t=${Math.round(nr.top)} b=${Math.round(nr.bottom)}`);
    }
    for (const btn of nav.querySelectorAll('button')) {
      const r = btn.getBoundingClientRect();
      const label = (btn.textContent || '').trim();
      navLabels.push(label);
      if (r.width === 0 || r.height === 0) { problems.push(`nav item zero-size: ${label}`); continue; }
      if (r.top < -tol || r.left < -tol || r.right > vw + tol || r.bottom > vh + tol) {
        problems.push(`nav item clipped: ${label}`);
      }
      if (btn.scrollWidth > btn.clientWidth + 2) problems.push(`nav text truncated: ${label}`);
    }
  }
  for (const expected of ['Play', 'Worlds', 'Account', 'Setup']) {
    if (!navLabels.includes(expected)) problems.push(`nav item missing: ${expected}`);
  }

  // 3. Interactive elements: rendered → center must hit-test to the element
  //    itself (not covered); scrolled/clipped away → must be reachable by
  //    user scrolling (auto/scroll ancestors).
  const userScrollable = (a: Element): boolean => {
    const st = getComputedStyle(a);
    return /(auto|scroll)/.test(st.overflowY) || /(auto|scroll)/.test(st.overflowX);
  };
  const scrollReachable = (el: Element): boolean => {
    let a: Element | null = el.parentElement;
    while (a) {
      if (userScrollable(a) && (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2)) return true;
      if (a === main) return main ? main.scrollHeight > main.clientHeight + 2 : false;
      a = a.parentElement;
    }
    return main ? main.scrollHeight > main.clientHeight + 2 : false;
  };
  // Portion actually RENDERED right now: raw rects ignore ancestor clipping
  // (overflow auto/hidden + scroll offsets), so a below-the-fold element's
  // raw rect can straddle main's bottom edge and its center can land in the
  // nav slot band — measured false positive at 1280x720 (strip text b=668
  // vs main b=660). Intersect up the clip chain; empty = scrolled away.
  const renderedRect = (el: Element): DOMRect | null => {
    let vis = el.getBoundingClientRect();
    for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
      const st = getComputedStyle(a);
      if (st.overflow !== 'visible' || st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        const pr = a.getBoundingClientRect();
        const l = Math.max(vis.left, pr.left);
        const t = Math.max(vis.top, pr.top);
        const r2 = Math.min(vis.right, pr.right);
        const b = Math.min(vis.bottom, pr.bottom);
        if (r2 - l <= tol || b - t <= tol) return null;
        vis = { left: l, top: t, right: r2, bottom: b, width: r2 - l, height: b - t } as DOMRect;
      }
    }
    return vis;
  };
  for (const el of document.querySelectorAll('button, a, select, input')) {
    if (!(el as HTMLElement).offsetParent) continue; // keep-alive hidden view
    if (nav?.contains(el)) continue; // nav items checked above
    const raw = el.getBoundingClientRect();
    if (raw.width === 0 && raw.height === 0) continue;
    const label = ((el.getAttribute('aria-label') || el.textContent || el.tagName) + '')
      .trim().replace(/\s+/g, ' ').slice(0, 30);
    const vis = renderedRect(el);
    if (!vis) {
      if (!scrollReachable(el)) {
        problems.push(`clipped, not scrollable: ${label} t=${Math.round(raw.top)} b=${Math.round(raw.bottom)}`);
      }
      continue;
    }
    const inViewport = vis.top >= -tol && vis.left >= -tol && vis.bottom <= vh + tol && vis.right <= vw + tol;
    if (!inViewport && !scrollReachable(el)) {
      problems.push(`clipped, not scrollable: ${label} t=${Math.round(vis.top)} b=${Math.round(vis.bottom)}`);
      continue;
    }
    const cx = Math.min(Math.max(vis.left + vis.width / 2, 1), vw - 1);
    const cy = Math.min(Math.max(vis.top + vis.height / 2, 1), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (hit !== el && !el.contains(hit))) {
      problems.push(
        `covered: ${label} by ${(hit && `${hit.tagName}:${(hit.textContent || '').trim().slice(0, 15)}`) || 'nothing'}`,
      );
    }
  }

  // 4. Hero canvas (Identity Studio) — a canvas is not interactive so the
  //    button loop never sees it. Same law as buttons, adjusted for content:
  //    below the fold is legal only if a user-scrollable ancestor can reach
  //    it, and the nav-band/covered checks apply only while it is actually
  //    rendered inside main's clip box (a scrolled-away rect paints nothing).
  for (const canvas of document.querySelectorAll('main canvas')) {
    if (!(canvas as HTMLElement).offsetParent) continue;
    // Decorative ambient layers (Play's atmosphere canvases) are paint, not
    // content: pointer-events none, aria-hidden, text/CTA laid OVER them is
    // composition by design. The law applies to the Identity hero — an
    // interactive (orbit-drag) canvas.
    if (getComputedStyle(canvas).pointerEvents === 'none') continue;
    let deco = false;
    for (let p: HTMLElement | null = canvas.parentElement; p && p !== main; p = p.parentElement) {
      if (p.getAttribute('aria-hidden') === 'true') { deco = true; break; }
    }
    if (deco) continue;
    // Rendered portion: raw rects ignore ancestor clipping (measured at
    // 1600x500 — a 3px raw spill past the scroll clip flagged a false
    // nav-band hit). Clip through the ancestor chain first.
    let vis = canvas.getBoundingClientRect();
    for (let p: HTMLElement | null = canvas.parentElement; p; p = p.parentElement) {
      const pst = getComputedStyle(p);
      if (pst.overflow !== 'visible' || pst.overflowX !== 'visible' || pst.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        const l = Math.max(vis.left, pr.left);
        const t = Math.max(vis.top, pr.top);
        const rr = Math.min(vis.right, pr.right);
        const b = Math.min(vis.bottom, pr.bottom);
        if (rr - l <= tol || b - t <= tol) { vis = null; break; }
        vis = { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t } as DOMRect;
      }
    }
    if (!vis) {
      if (!scrollReachable(canvas)) problems.push('hero canvas scrolled away, unreachable');
      continue;
    }
    const inViewport = vis.top >= -tol && vis.left >= -tol && vis.bottom <= vh + tol && vis.right <= vw + tol;
    if (!inViewport && !scrollReachable(canvas)) {
      problems.push(`hero canvas outside viewport, unreachable t=${Math.round(vis.top)} b=${Math.round(vis.bottom)}`);
    }
    if (nav) {
      const nr = nav.getBoundingClientRect();
      if (vis.bottom > nr.top + tol) {
        problems.push(`hero canvas overlaps nav band (c b=${Math.round(vis.bottom)} nav t=${Math.round(nr.top)})`);
      }
    }
    const cx = Math.min(Math.max(vis.left + vis.width / 2, 1), vw - 1);
    const cy = Math.min(Math.max(vis.top + vis.height / 2, 1), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (hit !== canvas && !canvas.contains(hit) && !hit.contains(canvas))) {
      problems.push(`hero canvas covered by ${(hit && hit.tagName) || 'nothing'}`);
    }
  }

  // 5. Play view's metadata rail: fully visible and never under the nav band.
  const rail = document.querySelector('.hairline-t.h-11');
  if (rail && (rail as HTMLElement).offsetParent) {
    const rr = rail.getBoundingClientRect();
    if (rr.top < -tol || rr.bottom > vh + tol) {
      problems.push(`metadata rail clipped t=${Math.round(rr.top)} b=${Math.round(rr.bottom)}`);
    }
    if (nav) {
      const nr = nav.getBoundingClientRect();
      if (rr.bottom > nr.top + tol) {
        problems.push(`metadata rail overlaps nav band (rail b=${Math.round(rr.bottom)} nav t=${Math.round(nr.top)})`);
      }
    }
  }

  return { problems };
};

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
        ],
        activeAccountId: 'acc-rich',
        sessions: {
          'acc-rich': { accountId: 'acc-rich', authenticated: true, lastValidatedAt: iso },
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

  // The Identity Studio in its RICH states (empty state is covered above —
  // fresh installs have no library): offline account with a seeded library,
  // then the card-preview state. 900x600 = minimum, 1600x500 = ultra-flat.
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
      }
    } finally {
      await ta.cleanup();
    }
  });
});
