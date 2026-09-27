# 33 — The World Shelf

**Mission:** replace the Worlds page's flat card grid with an interactive 3D
shelf of world cards — the ThreeUI `CompleteShelfLandingPage` renderer, run
inside a same-origin iframe, speaking postMessage to the React host.

**Status:** implemented, unit-tested (14), E2E-tested (4). Verified locally on
branch `red-team`; not yet committed.

**Source of byte-level record:** `docs/world-shelf/PROVENANCE.md` — canonical
source hashes, every generator edit, and the divergences from the original
brief. This doc records the integration truth; that doc records the artifact
provenance. Nothing in `public/shelf/shelf.html` is hand-edited: edit the parts
under `scripts/world-shelf/` and re-run `node scripts/world-shelf/build-shelf.mjs`.

---

## 1. Architecture

```
WorldsView.tsx (React host)
  └─ WorldShelf.tsx          iframe wrapper, owns the postMessage boundary
       └─ iframe ./shelf/shelf.html          (generated, public/)
            └─ importmap → ./vendor/three/*  (three.js r165, local, no CDN)
```

- **iframe, same origin only.** The shelf is a local file served by Vite in
  dev and copied verbatim into `out/renderer/shelf/` by the build. No
  sandbox attribute: an opaque origin would break the frame's own same-origin
  module imports. The renderer CSP (`index.html`) gained `frame-src 'self'`.
- **Offline-first.** The canonical page pulled Google Fonts and three.js from
  jsDelivr; both are removed. `connect-src 'none'` in the frame's own CSP meta
  makes any fetch attempt a loud failure, not a silent outage.
- **Launch path unchanged (iron rule).** A Play click inside the shelf crosses
  the boundary as `play-requested` and lands in the exact handler the old card
  grid's Play button used (`App.tsx` → make active → switch to Play). No new
  IPC channel exists or is needed.

## 2. postMessage protocol

Host → shelf (`WorldShelf.tsx` → frame):

| Message | Payload | Effect |
| --- | --- | --- |
| `worlds` | `{ worlds: ShelfWorld[] }` | Rebuild the shelf (dispose old rigs, build cards, select first). Buffered until the renderer has booted. |
| `pause` | — | Cancel the render RAF; overlay loop idles. |
| `resume` | — | Restart the loop with a fresh clock (no delta jump). |

Shelf → host (bridge → `WorldShelf.tsx`):

| Message | Payload | Consumed by |
| --- | --- | --- |
| `shelf-ready` | — | Arms the sender; worlds are (re)sent on boot and on change. |
| `world-selected` | `{ worldId }` | `WorldsView.onSelectWorld` → `setActiveWorld` (existing IPC). |
| `play-requested` | `{ worldId }` | `WorldsView.onPlayWorld` → the same launch path as the Play CTA. |

The listener on the React side is keyed on
`event.source === frame.contentWindow` — no other frame can drive the host.
The bridge posts with target `(window.parent || window)` and swallows a
missing host, so the page stays browsable standalone.

**ShelfWorld** (the payload per world): `id, title, subtitle, coverImage:
null, accentColor, metadata{version, loader, ram, modSummary, lastPlayed,
server, deck}, serverStatus: 'online'|'offline'|'none', isActive`.
Derived in `WorldsView.tsx` (`shelfWorlds` memo) from data Ember already
holds; nothing is invented for display.

Keep-alive: `WorldShelf` receives `active` from `WorldsView` (false whenever
the view is hidden) and posts `pause`/`resume` — the same discipline PlayView
uses, so a hidden shelf costs zero frames.

## 3. The cover system

- **No screenshots.** Ember has no world-screenshot capability anywhere, so
  cards draw a deterministic **colour field**: background = the world's
  accent, with title, mod-stack note and geometry typed over it.
- **The accent is a pure function of the world id.** FNV-1a over the id →
  hue ring `[18, 34, 46, 96, 150, 188, 214, 258, 292, 330]` →
  `hsl(H 34% L)`, `L ∈ {40, 45, 50}`. The same hash is implemented twice —
  `worldAccent()` in `WorldShelf.tsx` (host side, exported) and `accentFor()`
  in `part-data.js` (shelf side) — and both must agree or a card changes
  colour mid-flight. `tests/world-shelf.test.ts` pins the host side; if a
  world arrives with an explicit `accentColor`, both sides honour it and skip
  the hash.
- **Replaceable art.** When real cover art exists later, drop it in behind
  the same record shape (`coverImage`) — no protocol change.
- **Active chip.** The worlds payload's `isActive` surfaces as
  `#card-overlay[data-active]` — a quiet warm-white chip on the selected
  card. The Play button owns the amber (DESIGN.md §1: one flame per screen).

## 4. What stays canonical

Everything in `shelf.html` not named in PROVENANCE §4 is byte-identical to
the upstream `complete-shelf-v2.html`: camera, lights, renderer setup, shelf
geometry and materials, scroll/pointer/click interaction, animation curves,
responsive breakpoints, reduced-motion handling. The retired book reading
flow (page spreads, "Open book") is neutralised, not deleted — the card's
select-and-tilt motion is the entire interaction.

## 5. Verification receipts

- `node scripts/world-shelf/build-shelf.mjs` — anchor-checked regeneration;
  extracted module script passes `node --check` (850,485 chars at last run).
- `npm run typecheck` — clean.
- `npm test` — 374 pre-existing + 14 new (`tests/world-shelf.test.ts`).
- `tests/e2e/world-shelf.spec.ts` — 4/4: renderer boots to `webgl-ready` with
  a card per world and an anchored overlay carrying the payload's
  `data-active`; a card Play click crosses the boundary (`play-requested`),
  reaches the launcher (active world switches, disk receipt) and returns the
  user to Play; the render loop parks/resumes with view visibility; reduced
  motion is honoured.

## 6. Invariants (iron rules, restated)

1. `fx/` untouched — PlayerDirector and the skin canvas are independent.
2. Existing IPC channels unchanged; the shelf reuses `setActiveWorld` /
   `launchGame` paths verbatim.
3. iframe is same-origin local files only; no external URL may appear in
   `shelf.html` (unit-tested: no `cdn.jsdelivr.net`, no Google Fonts).
4. Design system: Ember palette (`--ember #ffb224` per `index.css` /
   DESIGN.md), one flame per screen.
5. Baseline 374 only grows. Green gates before commit: typecheck + build +
   `npm test` + E2E.
