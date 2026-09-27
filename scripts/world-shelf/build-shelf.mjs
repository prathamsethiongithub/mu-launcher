// Assemble src/renderer/public/shelf/shelf.html from the canonical ThreeUI
// CompleteShelfLandingPage source plus the audited World Shelf parts in this
// directory.
//
// The canonical renderer is copied verbatim except for the edits named in
// docs/world-shelf/PROVENANCE.md. Every edit is anchored on exact source text
// and the build fails loudly if an anchor has moved, so the output can never
// silently drift from the canonical file.
//
//   node scripts/world-shelf/build-shelf.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const SOURCE = join(projectRoot, 'docs/world-shelf/source/complete-shelf-v2.html');
const OUTPUT = join(projectRoot, 'src/renderer/public/shelf/shelf.html');

const part = (name) => readFile(join(here, name), 'utf8');

function replaceOnce(html, search, replacement, label) {
  const first = html.indexOf(search);
  if (first === -1) {
    throw new Error(`[${label}] anchor not found in the canonical source`);
  }
  if (html.indexOf(search, first + 1) !== -1) {
    throw new Error(`[${label}] anchor is not unique in the canonical source`);
  }
  return html.slice(0, first) + replacement + html.slice(first + search.length);
}

function replaceFrom(html, startMarker, endMarker, replacement, label) {
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error(`[${label}] start anchor not found`);
  const end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error(`[${label}] end anchor not found`);
  return html.slice(0, start) + replacement + html.slice(end);
}

function insertBefore(html, marker, block, label) {
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`[${label}] insert anchor not found`);
  return html.slice(0, at) + block + html.slice(at);
}

const [dataPart, cardRigPart, bridgePart, cssPart] = await Promise.all([
  part('part-data.js'),
  part('part-card-rig.js'),
  part('part-bridge.js'),
  part('part-css.css')
]);

let html = await readFile(SOURCE, 'utf8');
const canonicalLength = html.length;

// ── 1. Local-only loading ───────────────────────────────────────────────
// The canonical page pulls Inter from Google Fonts and three.js r165 from a
// CDN. The launcher is offline-first and its renderer is same-origin, so both
// become local: the fonts fall back to the stacks already declared below, and
// r165 is vendored beside this file. The importmap mechanism is unchanged.
html = replaceOnce(
  html,
  '  <meta charset="utf-8">\n',
  '  <meta charset="utf-8">\n' +
    '  <meta\n' +
    '    http-equiv="Content-Security-Policy"\n' +
    '    content="default-src \'self\' \'unsafe-inline\' data:; connect-src \'none\'; media-src \'none\'; object-src \'none\'; base-uri \'none\'"\n' +
    '  >\n',
  'csp'
);

html = replaceOnce(
  html,
  '  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '  <link\n' +
    '    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;display=swap"\n' +
    '    rel="stylesheet"\n' +
    '  >\n',
  '  <!-- No remote fonts: the launcher has to look identical offline, and it\n' +
    '       only permits same-origin assets. The stacks below already carry\n' +
    '       full local fallbacks. -->\n',
  'fonts'
);

html = replaceOnce(
  html,
  '        "three": "https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js",\n' +
    '        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"\n',
  '        "three": "./vendor/three/three.module.js",\n' +
    '        "three/addons/": "./vendor/three/examples/jsm/"\n',
  'importmap'
);

html = replaceOnce(
  html,
  '    content="Working Volumes is an original interactive Three.js library of seven tactile field guides for contemporary creative tools."',
  '    content="The World Shelf is an interactive Three.js shelf of your Minecraft worlds."',
  'description'
);
html = replaceOnce(
  html,
  '<title>Working Volumes — Seven Tools for Making</title>',
  '<title>World Shelf</title>',
  'title'
);

// ── 2. Static book data → world-derived records ─────────────────────────
{
  const start = html.indexOf('    const BOOKS = [');
  if (start === -1) throw new Error('[books] anchor not found');
  const endMarker = '\n    ];';
  const end = html.indexOf(endMarker, start);
  if (end === -1) throw new Error('[books] closing bracket not found');
  html = html.slice(0, start) + dataPart + html.slice(end + endMarker.length);
}

// ── 3. Hardcover object → world card object ─────────────────────────────
html = replaceFrom(
  html,
  '    function createBookRig(book, index) {',
  '\n    function configureResponsiveTargets() {',
  cardRigPart + '\n',
  'card-rig'
);

// ── 4. Host bridge (postMessage in, selection/play out) ─────────────────
// Inserted after every module-scope binding it touches, so its top-level
// statements run against initialised state.
html = insertBefore(html, '    async function initialize() {', bridgePart + '\n', 'bridge');

// ── 5. An empty shelf must not look broken ──────────────────────────────
// The canonical shelf always had seven books, so it announced itself
// unconditionally. Worlds now arrive over postMessage, so it has to wait.
html = replaceOnce(
  html,
  '      updateSelection(0, true);\n      resize();\n',
  '      if (BOOKS.length) updateSelection(0, true);\n      resize();\n',
  'init-selection'
);
html = replaceOnce(
  html,
  '      renderer.render(scene, camera);\n' +
    '      loading.hidden = true;\n' +
    '      experience.classList.add("webgl-ready");\n',
  '      renderer.render(scene, camera);\n' +
    '      if (BOOKS.length) {\n' +
    '        loading.hidden = true;\n' +
    '        experience.classList.add("webgl-ready");\n' +
    '      }\n',
  'init-reveal'
);

// ── 6. Card copy in the chrome the renderer still owns ──────────────────
const copyEdits = [
  ['Volume ${pad(index + 1)}', 'World ${pad(index + 1)}'],
  [
    'Selected volume ${selectedIndex + 1} of ${BOOKS.length}',
    'Selected world ${selectedIndex + 1} of ${BOOKS.length}'
  ],
  ['Select volume ${index + 1}: ${book.title}', 'Select world ${index + 1}: ${book.title}'],
  ['`Open ${book.title}`', '`Play ${book.title}`'],
  ['aria-label="Previous volume"', 'aria-label="Previous world"'],
  ['aria-label="Next volume"', 'aria-label="Next world"'],
  ['aria-label="Volume index"', 'aria-label="World index"'],
  ['aria-label="Choose a volume"', 'aria-label="Choose a world"'],
  [
    'Conceived as an original editorial study for Working Volumes.',
    'A record of this world, held by the launcher.'
  ]
];
copyEdits.forEach(([search, replacement]) => {
  html = replaceOnce(html, search, replacement, `copy:${search.slice(0, 22)}`);
});

// ── 7. DOM: header, selected-card overlay, fallback list ────────────────
const domEdits = [
  [
    '      <div class="editorial-identity">\n' +
      '        <strong>Working Volumes</strong>\n' +
      '        <span>Seven field guides for making</span>\n' +
      '      </div>\n' +
      '      <div class="editorial-index">\n' +
      '        <span>Edition 02 · 2026</span>\n' +
      '        <span id="palette-label">Ultramarine · bone · copper</span>\n' +
      '      </div>\n',
    '      <div class="editorial-identity">\n' +
      '        <strong>World Shelf</strong>\n' +
      '        <span>every world is a different fire</span>\n' +
      '      </div>\n' +
      '      <div class="editorial-index">\n' +
      '        <span id="shelf-count">Loading worlds…</span>\n' +
      '        <span id="palette-label">No server</span>\n' +
      '      </div>\n'
  ],
  [
    '      <span id="pointer-label-index">Volume 01</span>\n' +
      '      <strong id="pointer-label-title">Codex</strong>\n',
    '      <span id="pointer-label-index">World 01</span>\n' +
      '      <strong id="pointer-label-title">—</strong>\n'
  ],
  [
    '<button class="text-button" id="inspect" type="button">Open</button>',
    '<button class="text-button" id="inspect" type="button">Play</button>'
  ],
  [
    '<p class="microcopy">Wheel · arrows · select</p>',
    '<p class="microcopy">Scroll · arrows · select</p>'
  ],
  ['<p>Binding the collection</p>', '<p>Setting the shelf</p>'],
  [
    '<p class="fallback__kicker">Working Volumes · Static catalog</p>',
    '<p class="fallback__kicker">World Shelf · Static view</p>'
  ],
  [
    '<h2 id="fallback-title">Seven tools for making.</h2>',
    '<h2 id="fallback-title">Your worlds, listed.</h2>'
  ],
  [
    '        <span>All bindings, motifs, descriptions, geometry, and cover artworks are original to this conceptual study.</span>\n' +
      '        <span>Product names are used editorially and remain the property of their respective owners.</span>\n',
    '        <span>Card colours are derived from each world id, so they stay stable across launches.</span>\n' +
      '        <span>Cover art is a colour field: Ember does not capture world screenshots.</span>\n'
  ],
  [
    '    <div class="sr-only" id="live-region" aria-live="polite"></div>\n',
    '    <div class="card-overlay" id="card-overlay" data-visible="false" data-server="none" data-active="false">\n' +
      '      <div class="card-overlay__copy">\n' +
      '        <strong id="card-overlay-title">—</strong>\n' +
      '        <span id="card-overlay-subtitle"></span>\n' +
      '        <span class="card-overlay__status">\n' +
      '          <span class="card-overlay__dot" aria-hidden="true"></span>\n' +
      '          <span id="card-overlay-status">No server</span>\n' +
      '        </span>\n' +
      '        <span class="card-overlay__active" aria-hidden="true">Active</span>\n' +
      '      </div>\n' +
      '      <button class="text-button" id="card-overlay-play" type="button">Play</button>\n' +
      '    </div>\n' +
      '\n' +
      '    <div class="sr-only" id="live-region" aria-live="polite"></div>\n'
  ]
];
domEdits.forEach(([search, replacement], index) => {
  html = replaceOnce(html, search, replacement, `dom-${index}`);
});

// The static fallback was a fake hardcover catalog; it becomes a plain list
// of the same worlds, which the bridge fills in.
html = replaceFrom(
  html,
  '      <div class="fallback__grid"',
  '      <div class="fallback__footer">',
  '      <ul class="fallback__list" id="fallback-list" aria-label="Your worlds"></ul>\n' +
    '      ',
  'fallback-grid'
);

// ── 8. Launcher skin appended to the canonical stylesheet ───────────────
html = replaceOnce(html, '  </style>\n', '\n' + cssPart + '  </style>\n', 'css-append');

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`shelf.html written: ${kb(html.length)} (canonical ${kb(canonicalLength)})`);
