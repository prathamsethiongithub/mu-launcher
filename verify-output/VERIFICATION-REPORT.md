# P0/P1 Verification Audit — Final Report

**Date:** 2026-09-18
**Build:** `npm run build` — PASS (`npx tsc --noEmit` also passed earlier in the session)
**Method:** Electron launched with `--remote-debugging-port`; raw CDP (Chrome DevTools Protocol)
drives real input events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
`Input.dispatchDragEvent` with a real on-disk file) plus `CSS.forcePseudoState`
for deterministic hover/active state inspection. All screenshots in
`verify-output/`. Scripts: `verify/verify.mjs` (8 checks), `verify/final2.mjs`
(P1-2/P1-7 supplement).

## Verdict: 10 / 10 FIXED — zero regressions

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| P0-1 | CORRUPTED badge eliminated | **FIXED** | `01-p0-1-worlds.png` — no "Corrupted" text anywhere on the Worlds shelf |
| P0-2 | Setup → Play navigation | **FIXED** | `08-p0-2-setup-view.png` → `09-p0-2-back-on-play.png` — real coordinate click on "Play", nav `aria-current=Play`, CTA visible |
| P1-1 | Managed world ⋮ menu | **FIXED** | `02-p1-1-managed-menu.png` — menu contains Mod Manager / Back up / Backups; Rename/Duplicate/Delete absent |
| P1-2 | CTA hover/press states | **FIXED** | `21/22/23-p1-2-*.png` — computed: rest `none` → hover `matrix(1.05…)` + `brightness(1.15) drop-shadow(rgba(230,165,92,0.5) …)` → active `matrix(0.97…)` |
| P1-3 | Keyboard focus ring | **FIXED** | `13-p1-3-focus-ring.png` — Tab focuses nav button with `outline: solid rgba(200,135,53,…)` 2px CSS (renders 1.6px at 80% page zoom) |
| P1-4 | Non-modpack drop rejected | **FIXED** | `07-p1-4-drop-rejected.png` — real `.txt` file drag (dragEnter→dragOver→drop) shows toast "Only .mrpack or .zip modpack files are supported." |
| P1-5 | Empty-name validation | **FIXED** | `06-p1-5-name-validation.png` — "Give your world a name." error shown; Create button clickable without text (no `disabled`) |
| P1-6 | Mod delete feedback | **FIXED** | `04/05-p1-6-*.png` — MutationObserver recorded `disabled: true → false` transitions (9572ms → 9580ms) and the row was removed from the list after delete |
| P1-7 | Nav hover feedback | **FIXED** | `24/25-p1-7-*.png` — inactive tab hover: bg `transparent → rgba(255,255,255,0.03)`, color `rgb(156,149,138) → rgb(244,241,234)` |
| P1-8 | Empty state copy | **FIXED** | `03-p1-8-empty-modmanager.png` — empty world shows "Install from Modrinth or add a local `.jar`."; old copy "Add a .jar below" absent |

## Byte-level CSS proof (built bundle)

From `out/renderer/assets/index-*.css`:

```css
.cta-image-btn:hover { transform: scale(1.05); filter: brightness(1.15) drop-shadow(0 0 12px rgba(230, 165, 92, 0.5)); }
.cta-image-btn:active { transform: scale(0.97); }
button:focus-visible, a:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid rgba(200, 135, 53, 0.5); outline-offset: 2px; }
.hover\:text-ink:hover { color: var(--ink); }
.hover\:bg-white\/\[0\.03\]:hover { background-color: rgb(255 255 255 / 0.03); }
```

## Notes for future test runs

Two initial false negatives were harness artifacts, not product bugs:

1. **Transition race** — DockNav uses `transition-colors`; reading computed
   style immediately after `mouseMoved` catches mid-animation values
   (`rgba(255,255,255,0.004)` = 13% progress). Fix: inject
   `transition: none !important` before asserting, or settle ≥400ms.
2. **Stale CDP nodeIds** — `DOM.querySelector` nodeIds captured before a
   React view re-mount point to detached nodes, so `CSS.forcePseudoState`
   silently applies to a ghost. Fix: re-query the DOM immediately before each
   forced state, or use real mouse events on fresh screens.

Artifacts kept: `verify-output/results.json`, `verify-output/supplement-results.json`,
25 numbered screenshots, `not-a-modpack.txt` (drag-drop test fixture).
