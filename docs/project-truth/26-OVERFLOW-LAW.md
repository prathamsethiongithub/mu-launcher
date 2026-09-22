# 26 — OVERFLOW LAW: ZERO HIDDEN, ZERO CLIPPED, ZERO COVERED

> **Owner request (verbatim):** "why is the bottom menu bar or whatever hiding buttons or something, no matter the window size i dont want anything in my launcher hiding anything"
>
> **The law:** at ANY window size, no launcher UI element may be hidden, clipped away, or covered by another element. Buttons and nav never truncate. This is now an E2E gate, not a one-off fix.

## Root cause (measured)

The dock nav was `fixed bottom-16 z-50` — a floating layer OUTSIDE layout. Every view's content could flow underneath it. Live measurements (scripts/overflow-audit.mjs, elementFromPoint hit-testing):

| Size | View | Symptom (before) |
|---|---|---|
| 900×600 | Play | `Enter the world` CTA bottom 545 vs dock top 492 — covered, hit-tested to `BUTTON:Account` |
| 1024×768 | Account | `add a skin` covered by nav band |
| 1280×720 | Play | CTA bottom 635 vs dock top 612 — intersect |
| 1600×600 | Play/Worlds | CTA + `New world` covered / intersecting |
| 900×600 | Setup | content overflowed 43px, silently clipped by overflow-hidden |
| all | z-order | dock z-50 renders after modals z-50 → dock painted over modal bottoms |

## Fix (layout, not paint)

1. **Dock in flow** — `DockNav.tsx` drops `fixed bottom-16 z-50`; `Layout.tsx` renders it in a reserved bottom slot. Nothing can intersect it at any size, structurally.
2. **main scrolls** — `Layout.tsx` main: `min-h-0 flex-1 overflow-y-auto overflow-x-hidden` (block, NOT flex — a flex main shrank the keep-alive wrappers to content width, a regression caught by the audit mid-flight).
3. **Play stage column absorbs** — `PlayView.tsx` stage column: `m-auto min-h-0` (the min-height:auto trap blocked all shrinkage — hero slot could never flex); hero slot `min-h-[96px]` shrinks first, so CTA + metadata rail always fit without scroll; CTA path is scrollable-centered, not justify-center (no both-ends clipping).
4. **Design constants untouched** — no font/color/spacing tokens changed; fx/ untouched; zero new deps.

## The gate

- `scripts/overflow-audit.mjs` — dev probe: 6 sizes (900×600, 1024×768, 1280×720, 1600×600, 900×1400, +300px tolerance probes) × 5 views (Play/Worlds/Account/Setup/Console). Clip-chain "actually rendered" logic (raw getBoundingClientRect lies across scroll clips), scroll-reachability exemption, elementFromPoint coverage, text truncation. Result after fix: **0 problems across 30 screens**.
- `tests/e2e/layout-integrity.spec.ts` — the CI version of the law: 900×600 / 1280×720 / 1600×500 × 4 views. Asserts nav complete+visible+untruncated, interactive elements visible→hit-testable or scroll-reachable, Play metadata rail never under the nav band, no non-decorative content outside main's box. **Passes.**

Audit semantics (learned the hard way): an element below the fold of a scrollable container is reachable content, not a violation — its raw rect may legally overlap the nav band coordinates while scrolled away. Decorative ambient layers (SideRays `-mx-10`, pointer-events-none + aria-hidden) legitimately bleed and are clipped by overflow-x-hidden; paint is not content.

## Baseline (unchanged or better)

267/267 unit · typecheck ✓ · build ✓ · 16/16 E2E (incl. the new layout-integrity gate).
