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

const SIZES = [
  { w: 900, h: 600 },   // the app's real minimum (minWidth 900 / minHeight 600)
  { w: 1024, h: 768 },
  { w: 1280, h: 720 },
  { w: 1600, h: 600 },  // ultra-wide / flat (min-height clamps)
  { w: 900, h: 1400 },  // portrait-ish
];

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
  const scrollReachable = (el) => {
    let a = el.parentElement;
    while (a) {
      const st = getComputedStyle(a);
      const clips = st.overflowY !== 'visible' || st.overflowX !== 'visible';
      if (clips && (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2)) return true;
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
    const truncated = el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'visible';

    if (!inViewport && !reachable) problems.push({ kind: 'clipped-unreachable', ...info });
    if (hitsDock) problems.push({ kind: 'intersects-dock-nav', ...info });
    if (covered) problems.push({ kind: 'covered-by-other-element', ...info, hit: (hit && (hit.tagName + ':' + (hit.textContent || '').trim().slice(0, 20))) });
    if (truncated) problems.push({ kind: 'text-truncated', ...info });
  }

  // Non-interactive sentinels: brand, version, play metadata rail.
  const sentinels = [];
  for (const el of document.querySelectorAll('header span, .hairline-t span')) {
    if (!(el).offsetParent) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const label = (el.textContent || '').trim().slice(0, 30);
    if (!label) continue;
    const vis = renderedRect(el);
    const inViewport = !!vis && vis.top >= -tol && vis.left >= -tol && vis.bottom <= vh + tol && vis.right <= vw + tol;
    sentinels.push({ label, inViewport });
    if (!inViewport) {
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
