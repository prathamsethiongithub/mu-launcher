// Stage-canvas truth: diff the RAW WebGL canvas (character + pool + shadow,
// no page) 010 vs 013 — expect only idle-pose noise, no systematic change.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

function load(p) { const png = PNG.sync.read(readFileSync(p)); return { w: png.width, h: png.height, data: png.data }; }
const A = load('C:/Users/fortn/mu-visual-history/010-amber-key-002/stage-canvas.png');
const B = load('C:/Users/fortn/mu-visual-history/013-lightpillar-tamed/stage-canvas.png');
console.log('sizes:', A.w + 'x' + A.h, B.w + 'x' + B.h);
if (A.w !== B.w || A.h !== B.h) { console.log('SIZE MISMATCH — cannot diff'); process.exit(0); }

let changed = 0, big = 0, maxD = 0, n = A.w * A.h;
// grid heat to show WHERE noise lives (expect: character silhouette only)
const GX = 12, GY = 8;
const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
for (let y = 0; y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 4;
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
    if (d > 0) { changed++; if (d > 24) { big++; grid[Math.min(GY - 1, Math.floor(y / A.h * GY))][Math.min(GX - 1, Math.floor(x / A.w * GX))]++; } maxD = Math.max(maxD, d); }
  }
}
console.log(`changed ${(100 * changed / n).toFixed(2)}% | delta>24 ${(100 * big / n).toFixed(2)}% | max ${maxD}`);
console.log('delta>24 heat (character silhouette expected):');
for (let gy = 0; gy < GY; gy++) console.log(grid[gy].map(v => String(Math.min(99, v)).padStart(3)).join(' '));

// floor-pool + shadow band (bottom quarter of the canvas) — the pool and
// shadow live here; systematic change would be a violation.
let poolChanged = 0, poolBig = 0, pn = 0;
for (let y = Math.floor(A.h * 0.75); y < A.h; y++) {
  for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 4;
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
    pn++; if (d > 0) poolChanged++; if (d > 24) poolBig++;
  }
}
console.log(`floor band (bottom 25%): changed ${(100 * poolChanged / pn).toFixed(2)}% | delta>24 ${(100 * poolBig / pn).toFixed(2)}%`);
