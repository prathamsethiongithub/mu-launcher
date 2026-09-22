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

## Pass 2 — Identity Studio (the last view owner flagged)

> "everything else is fixed except the identity studio part, but i love so much what freebuff just did"

Identity had its own measured problems, invisible to the pass-1 audit because of an audit blind spot, not a layout exception:

| Size | State | Symptom (before) |
|---|---|---|
| 900×600 | all states | root content 823px vs 492px available — hero 102px below the fold, scroll crawl to reach anything |
| 900×600 | preview | equip button spilled below its column and was covered by the shelf (elementFromPoint → shelf div) |
| audit blind spot | — | the sentinel loop skipped canvases via `if (!label) continue` (canvases have no textContent) — the canvas check was dead code, so a hero sinking below the fold never reported |

### Fix

1. **Clearance debt** — IdentityView root `pt-16 pb-24` (160px reserved for the OLD floating dock) → `py-6`; shelf `mt-8` → `mt-6`. The dock lives in Layout's slot now; Identity still reserved for a ghost.
2. **Shrink-chain semantics** — attempted `min-h-0` on the hero column and it made things WORSE: the column then shrank past its content minimum and the equip row spilled under the shelf. `min-height: auto` (content minimum) is the correct flex semantics here; the 25px remainder overflows into the root scroller, visible and reachable. Lesson recorded: **min-h-0 is for boxes that may crop into their content, not for columns that must keep it.**
3. **Hero slot stays a definite 300px** — `min-h-[96px]` was dead code (a definite height defines the content minimum), and the window floor is minHeight 600 (main/index.ts), so vh-elasticity can never engage. Identity's ~230px minimum-window scroll is structural (300 hero + 184 shelf + strip ≈ 640px of intentional composition) — handled by the root scroller, same as other tall views, not flattened into a redesign.
4. **Audit canvas check fixed** — canvases are labeled by class (they carry no textContent) and exempt from sentinel-clipped only when a user-scrollable (auto/scroll) ancestor can reach them.

### Gate after pass 2

- `scripts/overflow-audit.mjs` now seeds identity.json/skins.json/skins-library (3 accounts: rich offline, MS, empty; 5 skins incl. a 40-char name and a missing file) and walks **7 Identity states × 6 sizes** (offline-rich, preview, rename, delete-confirm, ms-preview, equip-fail, empty) alongside the 30 base screens. Result: **0 problems across 72 screens**.
- `tests/e2e/layout-integrity.spec.ts` gained: hero-canvas checks (decorative pointer-events-none/aria-hidden canvases exempt; interactive hero must be reachable, never in the nav band while rendered, never covered), rendered-rect (clip-chain) hit-testing everywhere (raw rects straddling main's bottom edge produced false nav-band hits at 1280×720), and a rich-identity test (byte-level PNG seed, no app code touched) covering offline-rich + preview at 900×600 and 1600×500. Baseline E2E count: 16 → **17**.

## Baseline (unchanged or better)

267/267 unit · typecheck ✓ · build ✓ · 17/17 E2E (incl. the layout-integrity gate with Identity Studio states).
