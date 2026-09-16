// Pre-flight for 014: ground flatness over the NEW proposed bounds + 013 dimness/edges.
// Answers two questions before any code edit:
//   1) Is the body-gradient page ground flat enough over the NEW region so the
//      no-background wrapper stays invisible (no seam) at the user's proposed bounds?
//   2) How dim/bounded is the 013 firewall really, and what are the mask edges?
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const S = 1.25; // css->device scale (dpr locked 1.25 in captures)
function load(p) {
  const png = PNG.sync.read(readFileSync(p));
  return { w: png.width, h: png.height, data: png.data };
}
function stats(png, x0, y0, x1, y1) {
  const dx0 = Math.round(x0 * S), dy0 = Math.round(y0 * S);
  const dx1 = Math.round(x1 * S), dy1 = Math.round(y1 * S);
  let n = 0, sr = 0, sg = 0, sb = 0, maxL = 0, minL = 255;
  for (let y = dy0; y < dy1; y++) for (let x = dx0; x < dx1; x++) {
    const i = (y * png.w + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const m = Math.max(r, g, b);
    n++; sr += r; sg += g; sb += b; if (m > maxL) maxL = m; if (m < minL) minL = minL;
  }
  return { mean: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)], max: maxL, min: minL };
}

// ── 010 (good composition, no pillar) — page ground flatness at the NEW bounds ──
const A = load('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png');
console.log('=== 010 page ground (no pillar) — flatness over NEW bounds ===');
const bands = [
  ['above-canvas band, y 60..76', 400, 60, 880, 76],
  ['column top y 76..90', 400, 76, 880, 90],
  ['column mid y 200..380', 400, 200, 880, 380],
  ['column low y 380..470', 400, 380, 880, 470],
  ['column bottom y 470..500', 400, 470, 880, 500],
  ['left flank x 336..430', 336, 76, 430, 500],
  ['right flank x 850..944', 850, 76, 944, 500],
  ['below new bottom y 500..600', 400, 500, 880, 600],
];
for (const [name, ...r] of bands) {
  const s = stats(A, ...r);
  console.log(`${name.padEnd(28)} mean ${JSON.stringify(s.mean)}  max ${s.max}`);
}

// Horizontal profile across a row through the proposed mid-column (y=300):
// how much does the page brighten toward center — i.e. where would a
// background-less wrapper's edge sit relative to a detectable step?
console.log('\n=== 010 horizontal profile y=300 (css), x 300..980 step 40 ===');
let row = '';
for (let x = 300; x <= 980; x += 40) {
  const s = stats(A, x, 299, x + 8, 301);
  row += `${x}:${s.mean[0]}/${s.mean[1]}/${s.mean[2]}  `;
}
console.log(row);

// ── 013 — quantify the current failure: dimness + vertical/horizontal mask edges ──
const B = load('C:/Users/fortn/mu-visual-history/013-lightpillar-tamed/screenshot.png');
console.log('\n=== 013 current firewall dimness/extent ===');
const bands13 = [
  ['above-head band y 76..180', 430, 76, 850, 180],
  ['canvas-top band y 180..280', 430, 180, 850, 280],
  ['lower column y 280..452', 430, 280, 850, 452],
  ['left edge x 430..470', 430, 76, 470, 452],
  ['center x 560..720', 560, 76, 720, 452],
  ['right edge x 810..850', 810, 76, 850, 452],
];
for (const [name, ...r] of bands13) {
  const s = stats(B, ...r);
  console.log(`${name.padEnd(28)} mean ${JSON.stringify(s.mean)}  max ${s.max}`);
}
