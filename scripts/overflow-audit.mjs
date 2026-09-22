/**
 * Overflow audit (read-only diagnostic) — boots out/main/index.js in a
 * throwaway user-data dir, resizes the real window across a size matrix,
 * walks every view, and reports any interactive element that is:
 *   - outside the viewport (clipped),
 *   - intersecting the floating dock nav's rect,
 *   - not hit-testable at its center (covered by another element),
 *   - or text-truncated (scrollWidth > clientWidth).
 * Zero state is mutated; the scratch profile is wiped on exit.
 *
 * Usage: node scripts/overflow-audit.mjs
 */
import { _electron } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const SIZES = [
  { w: 900, h: 600 },   // the app's real minimum (minWidth 900 / minHeight 600)
  { w: 1024, h: 768 },
  { w: 1280, h: 720 },
  { w: 1600, h: 600 },  // ultra-wide / flat (min-height clamps)
  { w: 900, h: 1400 },  // portrait-ish
  { w: 1920, h: 1080 },
];

// ── Identity Studio profile seed ───────────────────────────────────────────
// The overflow law needs the Identity view exercised in its RICH states, not
// just the fresh-install empty state. We seed the same files the app owns
// (identity.json / skins.json / skins-library/*.png) into the scratch dir
// before launch — no app code touched, honest byte-level data.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A valid 64×64 RGBA skin PNG (opaque → classic model). */
const makeSkinPng = (r, g, b) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + 64 * 4);
  for (let x = 0; x < 64; x++) {
    row[1 + x * 4] = r; row[2 + x * 4] = g; row[3 + x * 4] = b; row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: 64 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const seedProfile = (dir) => {
  const iso = new Date().toISOString();
  const libDir = path.join(dir, 'skins-library');
  fs.mkdirSync(libDir, { recursive: true });
  const pngs = [
    makeSkinPng(40, 90, 180), // blue classic
    makeSkinPng(180, 90, 40), // orange slim
    makeSkinPng(60, 160, 60), // green classic
    makeSkinPng(160, 60, 160), // purple classic
  ];
  const hash = (buf) => createHash('sha1').update(buf).digest('hex');
  const skins = [
    { id: 'skin-1', name: 'classic steve', fileName: 'skin-1.png', model: 'classic', addedAt: iso, lastEquippedAt: iso, hash: hash(pngs[0]) },
    { id: 'skin-2', name: 'slim alex', fileName: 'skin-2.png', model: 'slim', addedAt: iso, hash: hash(pngs[1]) },
    { id: 'skin-3', name: 'x'.repeat(40), fileName: 'skin-3.png', model: 'classic', addedAt: iso, hash: hash(pngs[2]) }, // the long-name truncation case
    { id: 'skin-4', name: 'archive one', fileName: 'skin-4.png', model: 'classic', addedAt: iso, hash: hash(pngs[3]) },
    { id: 'skin-5', name: 'missing file', fileName: 'skin-5.png', model: 'classic', addedAt: iso, hash: 'deadbeef'.repeat(5) }, // no PNG on disk → the "missing" card
  ];
  pngs.forEach((buf, i) => fs.writeFileSync(path.join(libDir, `skin-${i + 1}.png`), buf));
  fs.writeFileSync(
    path.join(dir, 'skins.json'),
    JSON.stringify({ schemaVersion: 1, skins }, null, 2),
  );
  const session = (accountId) => ({ accountId, authenticated: true, lastValidatedAt: iso });
  fs.writeFileSync(
    path.join(dir, 'identity.json'),
    JSON.stringify(
      {
        accounts: [
          { id: 'acc-rich', type: 'offline', username: 'gigamegachad', uuid: '11111111-1111-3111-8111-111111111111', createdAt: iso, lastUsedAt: iso },
          { id: 'acc-ms', type: 'microsoft', username: 'otherplayer', uuid: '00000000-0000-3000-8000-000000000000', createdAt: iso, lastUsedAt: iso },
          { id: 'acc-empty', type: 'offline', username: 'emptyone', uuid: '22222222-2222-3222-8222-222222222222', createdAt: iso },
        ],
        activeAccountId: 'acc-rich',
        sessions: Object.fromEntries(
          ['acc-rich', 'acc-ms', 'acc-empty'].map((id) => [id, session(id)]),
        ),
      },
      null,
      2,
    ),
  );
};

const VIEWS = [
  { name: 'Play', open: null },
  { name: 'Worlds', open: 'Worlds' },
  { name: 'Account', open: 'Account' },
  { name: 'Setup', open: 'Setup' },
  { name: 'Console', open: '__ctrl_l__' },
];

/** The in-page audit. Runs in the renderer against the live DOM. */
const AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const tol = 1.5;

  const nav = document.querySelector('nav');
  const navRect = nav ? nav.getBoundingClientRect() : null;

  const overlap = (a, b) =>
    a && b && a.left < b.right - tol && b.left < a.right - tol &&
    a.top < b.bottom - tol && b.top < a.bottom - tol;

  // Intersection of two DOMRects; null when they don't overlap.
  const intersect = (a, b) => {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right - left > tol && bottom - top > tol
      ? { left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
  };

  // getBoundingClientRect ignores ancestor clipping (overflow hidden/auto
  // + scroll offsets). Walk the clip chain up to `main` and intersect to
  // get the portion actually RENDERED right now. Empty result = the
  // element is scrolled/clipped away entirely — inside a scrollable main
  // that is reachable content, not a violation of the overflow law.
  const renderedRect = (el) => {
    let vis = el.getBoundingClientRect();
    let a = el.parentElement;
    while (a) {
      const st = getComputedStyle(a);
      if (st.overflow !== 'visible' || st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        vis = intersect(vis, a.getBoundingClientRect());
        if (!vis) return null;
      }
      if (a === sc) break;
      a = a.parentElement;
    }
    return vis;
  };

  const problems = [];
  const buttons = [];

  // The nearest scrollable ancestor (main) — an element below the fold is
  // only a real problem if scrolling cannot reach it.
  const sc = document.querySelector('main');
  const scRect = sc ? sc.getBoundingClientRect() : null;
  const scrollable = !!(sc && sc.scrollHeight > sc.clientHeight + 2);

  // Not rendered now: a problem only if no scrollable ancestor can bring it
  // into view. Walk from the element up to (and including) main: any
  // scrollable container in the chain (view-root scroller, horizontal
  // shelves, main itself) counts — scrollIntoView reaches through all of them.
  // User-reachable scrolling only: auto|scroll containers can be scrolled
  // by the user (wheel/keys); overflow:hidden can be moved programmatically
  // but hides content from the user — that is a clip, not a path.
  const userScrollable = (a) => {
    const st = getComputedStyle(a);
    return /(auto|scroll)/.test(st.overflowY) || /(auto|scroll)/.test(st.overflowX);
  };
  const scrollReachable = (el) => {
    let a = el.parentElement;
    while (a) {
      if (userScrollable(a) && (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2)) return true;
      if (a === sc) return scrollable;
      a = a.parentElement;
    }
    return scrollable;
  };

  const els = [
    ...document.querySelectorAll('button, a, select, input, [role="button"]'),
  ];
  for (const el of els) {
    if (!(el).offsetParent && getComputedStyle(el).position !== 'fixed') continue; // hidden (keep-alive)
    const cs0 = getComputedStyle(el);
    if (cs0.opacity === '0' || cs0.visibility === 'hidden' || cs0.display === 'none') continue; // hover-gated or hidden affordances
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const label = (el.getAttribute('aria-label') || el.textContent || el.tagName)
      .trim().replace(/\s+/g, ' ').slice(0, 40);
    const info = {
      label,
      rect: { t: Math.round(r.top), l: Math.round(r.left), b: Math.round(r.bottom), rr: Math.round(r.right) },
    };
    buttons.push(info);

    // The dock's own buttons: the dock is now in-flow at the bottom, so its
    // buttons are checked for viewport visibility only (never "intersect
    // themselves", never covered by their own container).
    const inNav = !!navRect && nav && nav.contains(el);

    const vis = renderedRect(el);
    const visible = !!vis;
    const inViewport = visible && vis.top >= -tol && vis.left >= -tol && vis.bottom <= vh + tol && vis.right <= vw + tol;
    // Not rendered now: a problem only if no scrollable ancestor can bring
    // it into view (main itself counts — checked last in the walk).
    const reachable = visible || scrollReachable(el);
    const hitsDock = visible && !inNav && overlap(vis, navRect);
    let covered = false;
    let hit = null;
    if (visible && inViewport) {
      const cx = Math.min(Math.max(vis.left + vis.width / 2, 1), vw - 1);
      const cy = Math.min(Math.max(vis.top + vis.height / 2, 1), vh - 1);
      hit = document.elementFromPoint(cx, cy);
      covered = !inNav && !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    }
    // Inputs are exempt: a value wider than the box scrolls inside the
    // field with the caret following — standard text-input behavior, never
    // hidden content. Truncation law applies to rendered text only.
    const isEditable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    const truncated = !isEditable && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible';

    if (!inViewport && !reachable) problems.push({ kind: 'clipped-unreachable', ...info });
    if (hitsDock) problems.push({ kind: 'intersects-dock-nav', ...info });
    if (covered) problems.push({ kind: 'covered-by-other-element', ...info, hit: (hit && (hit.tagName + ':' + (hit.textContent || '').trim().slice(0, 20))) });
    if (truncated) problems.push({ kind: 'text-truncated', ...info });
  }

  // Non-interactive sentinels: brand, version, play metadata rail, and any
  // canvas hero (the Identity studio's character render) — canvases are not
  // interactive so the button loop never sees them.
  const sentinels = [];
  for (const el of [...document.querySelectorAll('header span, .hairline-t span'), ...document.querySelectorAll('main canvas')]) {
    if (!(el).offsetParent) continue;
    const isCanvas = el.tagName === 'CANVAS';
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Canvases carry no text (that made the canvas check dead code) — label
    // them by class so the Identity hero and shelf thumbnails are audited.
    const label = isCanvas
      ? `canvas:${String(el.className || '').trim().slice(0, 24) || 'hero'}`
      : (el.textContent || '').trim().slice(0, 30);
    if (!label) continue;
    const vis = renderedRect(el);
    const inViewport = !!vis && vis.top >= -tol && vis.left >= -tol && vis.bottom <= vh + tol && vis.right <= vw + tol;
    sentinels.push({ label, inViewport });
    // Chrome (header spans, metadata rail) must ALWAYS be in the viewport.
    // Canvases are content: below the fold is legal only when a user-
    // scrollable ancestor can bring them into view.
    if (!inViewport && !(isCanvas && scrollReachable(el))) {
      problems.push({
        kind: 'sentinel-clipped', label,
        rect: vis
          ? { t: Math.round(vis.top), l: Math.round(vis.left), b: Math.round(vis.bottom), rr: Math.round(vis.right) }
          : null,
      });
    }
  }

  // Scroll overflow on the visible view root + main.
  const scrollers = [];
  for (const el of [document.querySelector('main'), ...document.querySelectorAll('main > div > div')]) {
    if (!el || !(el).offsetParent) continue;
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
      scrollers.push({ cls: (el.className || '').slice(0, 60), sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth });
    }
  }

  return { vw, vh, navRect: navRect && { t: Math.round(navRect.top), b: Math.round(navRect.bottom), l: Math.round(navRect.left), rr: Math.round(navRect.right) }, buttonCount: buttons.length, problems, scrollers };
};

const main = async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-overflow-'));
  seedProfile(scratchDir);
  const app = await _electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${scratchDir}`],
    timeout: 30_000,
  });
  const results = [];
  let total = 0;
  try {
    // Wait for the real main window (splash closes itself on handoff).
    let window = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 35_000) {
      for (const w of app.windows()) {
        if (/renderer[\\/]index\.html/.test(w.url())) { window = w; break; }
      }
      if (window) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!window) throw new Error('main window never appeared');
    await window.waitForLoadState('domcontentloaded');
    // Boot settle: auth check + hero + server pulse.
    for (let i = 0; i < 40; i++) {
      const body = await window.evaluate(() => document.body.innerText);
      if (/Ready\.|Almost there\.|Sign in/.test(body)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await window.waitForTimeout(1200);

    const bw = await app.browserWindow(window);

    for (const size of SIZES) {
      await bw.evaluate((win, [w, h]) => win.setContentSize(w, h), [size.w, size.h]);
      await window.waitForTimeout(700);

      for (const view of VIEWS) {
        if (view.name === 'Account') {
          // ── Identity Studio multi-state walk ──────────────────────────
          // Rich seeded states, audited one by one: default shelf, preview
          // (offline → disabled equip), rename-in-place, delete-confirm,
          // MS preview (enabled equip) → equip fail msg, empty library.
          // 0. return-greeting: fake a visit 7h ago, reload the renderer so
          // IdentityView mounts fresh (a reload resets the module-level
          // mirrorShownThisSession in a new JS context), then open the
          // studio — "hey, <name>." line + GREETING wave while it shows.
          await window.evaluate(() => {
            try { localStorage.setItem('identity-studio-last-visit', String(Date.now() - 7 * 60 * 60 * 1000)); } catch { /* */ }
          });
          try { await window.evaluate(() => location.reload()); } catch { /* context destroyed by the reload */ }
          await window.waitForLoadState('domcontentloaded');
          await window.waitForTimeout(2500);

          const openAccount = await window.evaluate(() => {
            const btn = [...document.querySelectorAll('nav button')].find(
              (b) => b.textContent?.trim() === 'Account',
            );
            if (!btn) return false;
            btn.click();
            return true;
          });
          if (!openAccount) { results.push({ size: `${size.w}x${size.h}`, view: 'Account', error: 'nav button not found' }); continue; }
          await window.waitForTimeout(900);

          const clickIn = (sel) => window.evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            (el).click();
            return true;
          }, sel);
          const firstCard = () => window.evaluate(() => {
            const card = [...document.querySelectorAll('main div')]
              .find((d) => typeof d.className === 'string' && d.className.includes('w-[104px]') && d.className.includes('cursor-pointer'));
            if (!card) return false;
            (card).click();
            return true;
          });

          const snap = (state) => async () => {
            await window.waitForTimeout(500);
            const audit = await window.evaluate(AUDIT);
            results.push({ size: `${size.w}x${size.h}`, view: `Account/${state}`, ...audit });
          };

          // 1. offline + rich library (equip disabled path, active strip)
          await snap('offline-rich')();
          // 2. preview a card
          await firstCard();
          await snap('preview')();
          // 3. rename-in-place
          await clickIn('main div[class*="w-[104px]"] button[title="Rename"]');
          await snap('rename')();
          await window.keyboard.press('Escape');
          await window.waitForTimeout(300);
          // 4. delete confirm inline
          await clickIn('main div[class*="w-[104px]"] button[title="Delete skin"]');
          await snap('delete-confirm')();
          await window.evaluate(() => {
            const card = [...document.querySelectorAll('main div')].find(
              (d) => typeof d.className === 'string' && d.className.includes('w-[104px]') && d.className.includes('cursor-pointer'),
            );
            const no = card && [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'no');
            no?.click();
          });
          await window.waitForTimeout(300);
          // 5. switch to the MS account → preview → enabled equip → fail msg
          await clickIn('button[aria-label="Next account"]');
          await window.waitForTimeout(1200);
          await firstCard();
          await snap('ms-preview')();
          await window.evaluate(() => {
            const btn = [...document.querySelectorAll('main button')].find(
              (b) => b.textContent?.trim() === 'equip' && !b.disabled,
            );
            btn?.click();
          });
          await snap('equip-fail')();
          // 6. switch to the empty account
          await clickIn('button[aria-label="Next account"]');
          await window.waitForTimeout(1200);
          await snap('empty')();
          continue;
        }
        if (view.open === '__ctrl_l__') {
          await window.keyboard.press('Control+KeyL');
        } else if (view.open) {
          const ok = await window.evaluate((label) => {
            const btn = [...document.querySelectorAll('nav button')].find(
              (b) => b.textContent?.trim() === label,
            );
            if (!btn) return false;
            btn.click();
            return true;
          }, view.open);
          if (!ok) { results.push({ size: `${size.w}x${size.h}`, view: view.name, error: 'nav button not found' }); continue; }
        } else {
          // Ensure we're on Play: Ctrl+L toggles console, so press it once to leave console.
          const onConsole = await window.evaluate(() => !!document.querySelector('main')?.innerText.match(/console|session/i) && !document.body.innerText.includes('Ready.'));
          // Cheap route: click Play in nav unless already there.
          await window.evaluate(() => {
            const btn = [...document.querySelectorAll('nav button')].find((b) => b.textContent?.trim() === 'Play');
            btn?.click();
          });
        }
        await window.waitForTimeout(900);
        const audit = await window.evaluate(AUDIT);
        results.push({ size: `${size.w}x${size.h}`, view: view.name, ...audit });
      }
    }

    // Report
    try {
      for (const r of results) {
        const n = (r.problems || []).length + (r.error ? 1 : 0);
        total += n;
        const flag = n ? '  ✗' : '  ✓';
        console.log(`${flag} ${r.size} ${String(r.view).padEnd(8)} buttons=${r.buttonCount ?? '?'} navRect=${r.navRect ? `t${r.navRect.t}-b${r.navRect.b}` : 'none'} scrollers=${JSON.stringify(r.scrollers || [])}`);
        for (const p of r.problems || []) console.log(`      ${p.kind}: ${p.label} @${JSON.stringify(p.rect)}${p.hit ? ` hit=${p.hit}` : ''}`);
        if (r.error) console.log(`      error: ${JSON.stringify(r.error)}`);
      }
    } finally {
      console.log(`\nTOTAL PROBLEMS: ${total}`);
      fs.writeFileSync('overflow-audit-results.json', JSON.stringify(results, null, 2));
    }
  } finally {
    try { await app.close(); } catch { /* */ }
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* */ }
  }
  process.exit(total === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(2); });
