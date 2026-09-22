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

  const isScrollable = (el: Element) => {
    const st = getComputedStyle(el);
    const clips = st.overflowY !== 'visible' || st.overflowX !== 'visible';
    return clips && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2);
  };
  const hasScrollableAncestor = (el: Element): boolean => {
    let a: HTMLElement | null = el.parentElement;
    while (a) {
      if (isScrollable(a)) return true;
      a = a.parentElement;
    }
    return false;
  };

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

  // 3. Interactive elements: fully visible → center must hit-test to the
  //    element itself (not covered); not visible → must be reachable by
  //    scrolling inside a scrollable ancestor (main, view root, shelf...).
  for (const el of document.querySelectorAll('button, a, select, input')) {
    if (!(el as HTMLElement).offsetParent) continue; // keep-alive hidden view
    if (nav?.contains(el)) continue; // nav items checked above
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const label = ((el.getAttribute('aria-label') || el.textContent || el.tagName) + '')
      .trim().replace(/\s+/g, ' ').slice(0, 30);
    const inViewport = r.top >= -tol && r.left >= -tol && r.bottom <= vh + tol && r.right <= vw + tol;
    if (!inViewport) {
      if (!hasScrollableAncestor(el)) {
        problems.push(`clipped, not scrollable: ${label} t=${Math.round(r.top)} b=${Math.round(r.bottom)}`);
      }
      continue;
    }
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
    // Hit-test only what is actually rendered inside main's clip box: a
    // below-the-fold element inside a scrollable view is reachable content,
    // and its raw rect can legally overlap the nav band coordinates while
    // scrolled away (elementFromPoint would hit the nav, a false positive).
    if (main) {
      const mc = main.getBoundingClientRect();
      if (cx < mc.left - tol || cx > mc.right + tol || cy < mc.top - tol || cy > mc.bottom + tol) {
        continue;
      }
    }
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || (hit !== el && !el.contains(hit))) {
      problems.push(
        `covered: ${label} by ${(hit && `${hit.tagName}:${(hit.textContent || '').trim().slice(0, 15)}`) || 'nothing'}`,
      );
    }
  }

  // 4. Play view's metadata rail: fully visible and never under the nav band.
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
});
