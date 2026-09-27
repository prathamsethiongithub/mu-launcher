# The World Shelf — provenance

The Worlds page is an interactive 3D shelf of world **cards**, built from the
ThreeUI `CompleteShelfLandingPage` renderer. This file records exactly where
that renderer came from, what was changed, and how to reproduce the artifact.

Nothing here is edited by hand. `src/renderer/public/shelf/shelf.html` is a
**generated** file; edit the parts under `scripts/world-shelf/` and re-run the
generator.

```
node scripts/world-shelf/build-shelf.mjs
```

The generator anchors every edit on exact source text and **fails loudly** if an
anchor moves, so the output cannot silently drift from the canonical file.

---

## 1. Sources of record

Both canonical files are preserved under `docs/world-shelf/source/`. They are
the upstream originals, unmodified.

| File | Bytes | sha256 |
| --- | --- | --- |
| `source/complete-shelf-v2.html` (canonical HTML) | 900,296 | `606f200fed8602c243f40a11c8c364f0e625c57f80e7c97dc76419da207f198e` |
| `source/complete-shelf-landing-page.json` (registered source bundle) | 92,902 | `76571ce95d5798591ca9a2042d61194640cc9df1a87602704d2e322eef5bceb5` |

Upstream URLs:

- `https://threeui.com/landing-pages/complete-shelf-v2.html`
- `https://threeui.com/source-code/complete-shelf-landing-page.json`

Both downloads succeeded, so the brief's "if ALL sources fail, STOP" branch
does not apply.

## 2. Vendored three.js r165

The canonical page loads three.js r165 from `cdn.jsdelivr.net` through an
importmap. The launcher is offline-first and its renderer is same-origin
(`default-src 'self'`), so the CDN can never work. The library is vendored
beside the generated file, and **the importmap mechanism is unchanged** — only
its targets changed.

| File | Bytes | sha256 |
| --- | --- | --- |
| `vendor/three/three.module.js` | 1,284,652 | `5916c8dfb5f4e3eede312de305345868d4a0a8105383b080c6985565d6e79b46` |
| `vendor/three/examples/jsm/controls/OrbitControls.js` | — | `f260591ef315aa04888152e7f121865214e33fb54727145cf4e4445058db1297` |
| `vendor/three/examples/jsm/environments/RoomEnvironment.js` | — | `e1b92c4dd2d89752293546790bfda9828a630a79700c66f5b736fad7a88cb7e4` |
| `vendor/three/examples/jsm/geometries/RoundedBoxGeometry.js` | — | `d20aeaf7077c459a8d952d215738d7b44fba028440bb862d84b622a34f0c80bb` |
| `vendor/three/examples/jsm/lights/RectAreaLightUniformsLib.js` | — | `08085bc942253cd54948bf936fecb66b54514a135872656e475a1cab09b55214` |

`three.module.js` reports `REVISION = '165'` — the same release the canonical
page pinned (`three@0.165.0`). The four addons are the only ones the canonical
module imports, and each imports only `'three'`.

## 3. What stays canonical

Everything not named in §4 is copied **byte-identical** from
`complete-shelf-v2.html`: the camera, lights, renderer setup, the shelf
geometry and materials, the scroll/pointer/click interaction model, the
animation curves, the responsive breakpoints, the reduced-motion handling, and
the three.js version and importmap mechanism.

## 4. Every edit (in generator order)

**1 · Local-only loading**
- Added a child-document CSP meta: `default-src 'self' 'unsafe-inline' data:;
  connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'`.
- Removed the Google Fonts preconnect/stylesheet links. The canonical stacks
  (`--serif`, `--mono`) already carry full local fallbacks, so nothing loads
  remotely.
- Repointed the importmap from the jsDelivr CDN to `./vendor/three/…`.
- Swapped `<title>` and the meta description to the World Shelf copy.

**2 · Static book data → world-derived records**
- Replaced the module-scope `const BOOKS = […]` array literal with
  `part-data.js`, which defines `let BOOKS = []` plus the world→record mapping
  (`worldToRecord`), the accent hue ring, `toRoman`, and `statusLabel`.

**3 · Hardcover object → world card object**
- Replaced the whole `createBookRig(book, index)` function body (up to
  `configureResponsiveTargets()`) with `part-card-rig.js`. `createCardRig`
  returns the **exact same rig shape** the untouched scene code consumes
  (`data, root, motion, frontPivot, frontCover, pageBlock, pagePivots,
  pageSurfaces, pageGestureSurfaces, hit, contactShadow, opacity, lastOffset,
  fadeMaterials, materials, base{width,height,depth}`), so the shelf layout,
  fade, hit-testing and selection logic need no changes. The card is a 16:10
  RoundedBox slab (`width 1.02`, `height 1.02·10/16`, `depth 0.026`) whose face
  carries a canvas-drawn colour-field cover.

**4 · Host bridge**
- Inserted `part-bridge.js` immediately before `async function initialize()` —
  after every module-scope binding it touches, so its top-level statements run
  against initialised state. It listens for `worlds` / `pause` / `resume`,
  rebuilds the shelf and its markers, and posts `world-selected` and
  `play-requested` back to the host.

**5 · An empty shelf must not look broken**
- The canonical shelf always had seven books and announced itself
  unconditionally. Worlds now arrive over `postMessage`, so the init tail's
  `updateSelection(0, true)` and the `webgl-ready` reveal are guarded with
  `if (BOOKS.length)`.

**6 · Card copy**
- `Volume ${n}` → `World ${n}`, and the associated selection/aria strings
  (`Selected volume` → `Selected world`, `Select volume` → `Select world`,
  `` `Open ${book.title}` `` → `` `Play ${book.title}` ``, `Previous volume` →
  `Previous world`, `Next volume` → `Next world`, `Volume index` →
  `World index`, `Choose a volume` → `Choose a world`), plus the editor's note.

**7 · DOM**
- Header identity `Working Volumes / Seven field guides for making` → `World
  Shelf / every world is a different fire`; the edition line becomes a live
  `#shelf-count` and the palette line becomes the server legend.
- Pointer label `Volume 01 / Codex` → `World 01 / —`.
- The bottom bar's primary button `Open` → `Play` (it launches the selected
  world; the page-spread reading flow is retired).
- Microcopy `Wheel · arrows · select` → `Scroll · arrows · select`; loading
  copy `Binding the collection` → `Setting the shelf`.
- Fallback kicker/title/footer reworded for worlds; the fallback grid becomes
  `<ul id="fallback-list">`, which the bridge fills with the same worlds.
- Added the `#card-overlay` block (selected card's title, mod-stack note,
  server dot, and Play button) just before `#live-region`. The overlay also
  carries `data-active`, driven by the worlds payload's `isActive` — the
  selected card is where the user sees which world the launcher will launch
  (styled as a quiet warm-white chip: the Play button owns the amber).

**8 · Launcher skin**
- Appended `part-css.css` to the canonical stylesheet: the launcher's palette
  overrides, the card overlay geometry and amber Play grammar, status-dot
  rules, the fallback list, and `#detail-panel { display: none }` (the book
  reading flow has no meaning for a card).

## 5. Behaviour the bridge deliberately retires

The canonical page was book-shaped (page spreads, chapters, "Open book",
"Volume 01", a reading-flow detail panel). A card has no pages, so
`openDetail`, `closeDetail`, `setReadingOpen`, `turnPage` and
`resetInspectionView` are neutralised, and the card's own select-and-tilt
motion becomes the entire interaction. The brief permitted only the card swap
plus postMessage; neutralising a reading flow that is meaningless for cards is
the minimum needed to keep the interaction coherent.

The book-only cover/paper helpers that sat before `createBookRig`
(`makeCoverTexture`, `makeSpineTexture`, `makePaperFaceTexture`, …) are left in
place but have **no remaining call sites** — they were only ever invoked from
`createBookRig`, which the card rig replaces. They are inert, so the several
`book.seed` reads inside them never execute. They are kept rather than deleted
to hold the diff to the minimum the brief allows.

## 6. Divergences from the brief, and why

- **Covers are colour fields, not Minecraft screenshots.** The brief asked for
  a full-bleed landscape per card. Ember has **no world-screenshot capability
  anywhere** and no accent-hash system, so no such image can be produced. Each
  card instead draws a deterministic colour field keyed off the world id
  (matching `worldAccent` in `WorldShelf.tsx`), with the name and mod-stack
  note on top. The fallback footer states this in-app.
- **No Instrument Serif.** The brief specified Instrument Serif for the world
  name; Ember ships no such font and the renderer cannot load one offline. The
  card overlay uses the app's own display stack.

## 7. Integration

- Host: `src/renderer/components/WorldShelf.tsx` iframes `./shelf/shelf.html`
  (no `sandbox` attribute on purpose — an opaque origin would block the
  same-origin module imports the vendored three needs). The message listener is
  keyed on `event.source === frame.contentWindow`.
- `src/renderer/index.html` gained `frame-src 'self'` so the renderer's CSP
  permits the frame.
- `eslint.config.js` ignores `src/renderer/public/**` so lint does not walk the
  1.2 MB three bundle.

## 8. Verification (last run)

- `node scripts/world-shelf/build-shelf.mjs` → `shelf.html` (895,745 bytes;
  canonical 900,296). The extracted module script passes `node --check`.
  (§7 header copy was reworded to the brief's "every world is a different fire"
  after the first build, so the current output differs by that copy.)
- `npm run typecheck` clean; `npm run build` succeeds and copies
  `out/renderer/shelf/{shelf.html,vendor/three/…}`.
- `npm test` — 374 unit tests pass.
- `tests/e2e/world-shelf.spec.ts` — 4/4: renderer boots to `webgl-ready` with a
  card per world and an anchored overlay; a card Play click crosses the
  postMessage boundary (`play-requested`), reaches the launcher (active world
  switches) and returns the user to Play; the render loop parks/resumes with
  view visibility; reduced motion is honoured.
