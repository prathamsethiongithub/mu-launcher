// Is the row-6 / row-8-9 delta (below the pillar wrapper, which physically
// cannot paint there) intrinsic capture-to-capture variance? Compare two
// PILLAR-FREE captures (009 vs 010) with the same footprint analysis.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/009-freebuff-stage/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const { width, height } = a;

const GX = 16, GY = 10;
const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
for (let y = 0; y < height; y++) {
  const gy = Math.min(GY - 1, Math.floor(y / height * GY));
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 10) grid[gy][Math.min(GX - 1, Math.floor(x / width * GX))]++;
  }
}
console.log('PILLAR-FREE 009 vs 010, delta>10 footprint (% of cell):');
const cellArea = (width / GX) * (height / GY);
for (let gy = 0; gy < GY; gy++) console.log(grid[gy].map(v => String(Math.min(99, Math.round(100 * v / cellArea))).padStart(2)).join(' '));

// h1 band detail: 010 vs 013 — where exactly and how big?
const c = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/013-lightpillar-tamed/screenshot.png'));
function bandDetail(p1, p2, label) {
  let n = 0, big = 0, maxD = 0, xs = new Set(), ys = new Set();
  for (let y = Math.round(440 * 1.25); y < Math.round(580 * 1.25); y++) {
    for (let x = Math.round(400 * 1.25); x < Math.round(880 * 1.25); x++) {
      const i = (y * width + x) * 4;
      const d = Math.max(Math.abs(p1.data[i] - p2.data[i]), Math.abs(p1.data[i + 1] - p2.data[i + 1]), Math.abs(p1.data[i + 2] - p2.data[i + 2]));
      if (d > 10) { n++; if (d > 24) big++; maxD = Math.max(maxD, d); xs.add(Math.floor(x / 1.25 / 40)); ys.add(Math.floor(y / 1.25 / 40)); }
    }
  }
  console.log(`${label}: delta>10 px=${n} delta>24=${big} max=${maxD} y-bins=${[...ys].join(',')} x-bins=${[...xs].join(',')}`);
}
bandDetail(a, b, 'h1/sub band 009vs010 (pillar-free)');
bandDetail(b, c, 'h1/sub band 010vs013 (with pillar)');
