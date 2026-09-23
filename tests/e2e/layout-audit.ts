/**
 * The overflow law as a reusable in-page audit.
 *
 * Extracted verbatim from tests/e2e/layout-integrity.spec.ts (the CI gate)
 * so the persona suite can assert the same law on persona-sandboxed states
 * (150-card hoarder, corrupted states, potato hardware) without duplicating
 * ~150 lines of audit logic.
 *
 * Returns a list of human-readable layout violations; an empty array means
 * the screen obeys the law: nothing hidden, clipped away, or covered.
 */

export const LAYOUT_AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const tol = 1.5;
  const problems: string[] = [];

  const main = document.querySelector('main');

  // 1. main: no INTERACTIVE content may extend beyond its client box —
  //    UNLESS the overflow lives inside a user-scrollable ancestor (the
  //    shelf's overflow-x-auto rail is scroll-by-design; scrolled-away rail
  //    cards are reachable by scrolling back). Axis-aware: a horizontal
  //    spill is legalized only by a horizontally scrollable ancestor, a
  //    vertical one by a vertically scrollable one — main itself is
  //    overflow-x-hidden (SideRays bleed) so it never legalizes a horizontal
  //    clip, and a spill with NO scrollable ancestor stays flagged.
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
    const axisScrollable = (el: Element, axis: 'x' | 'y'): boolean => {
      let a: Element | null = el.parentElement;
      while (a && a !== main.parentElement) {
        const st = getComputedStyle(a);
        const overflow = axis === 'x' ? st.overflowX : st.overflowY;
        const size = axis === 'x' ? st.overflowY : st.overflowX;
        if (/(auto|scroll)/.test(overflow)) {
          const canScroll = axis === 'x'
            ? a.scrollWidth > a.clientWidth + 2
            : a.scrollHeight > a.clientHeight + 2;
          if (canScroll) return true;
        }
        void size;
        if (a === main) return false; // main is the clip boundary
        a = a.parentElement;
      }
      return false;
    };
    for (const el of main.querySelectorAll('button, a, select, input, p, h1, h2, span')) {
      if (!(el as HTMLElement).offsetParent) continue;
      if (isDecorative(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const spillsX = r.left < mRect.left - tol || r.right > mRect.right + tol;
      const spillsY = r.top < mRect.top - tol || r.bottom > mRect.bottom + tol;
      if (spillsX && !axisScrollable(el, 'x')) {
        problems.push(
          `content outside main box: ${el.tagName}:${(el.textContent || '').trim().slice(0, 20)} l=${Math.round(r.left)} r=${Math.round(r.right)}`,
        );
      } else if (spillsY && !axisScrollable(el, 'y')) {
        problems.push(
          `content outside main box (vertical): ${el.tagName}:${(el.textContent || '').trim().slice(0, 20)} t=${Math.round(r.top)} b=${Math.round(r.bottom)}`,
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
    let vis: DOMRect | null = canvas.getBoundingClientRect();
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
