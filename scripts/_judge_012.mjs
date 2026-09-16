// Judge 012: (a) is the 011 black-box failure gone (dark-region % back to
// 010's)? (b) what exactly did the pillar add (delta map)? (c) is the added
// content a restrained warm presence, not a wash?
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/012-lightpillar-screen/screenshot.png'));
const c = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/011-lightpillar/screenshot.png'));
const { width, height } = a;
const total = width * height;

function darkPct(png) {
  let dark = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const m = Math.max(png.data[i], png.data[i + 1], png.data[i + 2]);
    if (m < 8) dark++;
  }
  return +(100 * dark / total).toFixed(2);
}
function warmPct(png) {
  let warm = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], bl = png.data[i + 2];
    if (r > 24 && r > bl * 1.3 && g > bl) warm++;
  }
  return +(100 * warm / total).toFixed(2);
}
console.log('dark<8%  : 010 =', darkPct(a), '| 011(fail) =', darkPct(c), '| 012 =', darkPct(b));
console.log('warm%    : 010 =', warmPct(a), '| 011(fail) =', warmPct(c), '| 012 =', warmPct(b));

// Delta map 010 -> 012
const GX = 8, GY = 5;
const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
const gridWarm = Array.from({ length: GY }, () => new Array(GX).fill(0));
let changed = 0, bigChanged = 0, maxDelta = 0;
for (let y = 0; y < height; y++) {
  const gy = Math.min(GY - 1, Math.floor(y / height * GY));
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 0) changed++;
    if (d > 32) {
      bigChanged++;
      maxDelta = Math.max(maxDelta, d);
      grid[gy][Math.min(GX - 1, Math.floor(x / width * GX))]++;
      const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
      if (r > 24 && r > bl * 1.3) gridWarm[gy][Math.min(GX - 1, Math.floor(x / width * GX))]++;
    }
  }
}
console.log('\nchanged:', (100 * changed / total).toFixed(2) + '%', '| delta>32:', (100 * bigChanged / total).toFixed(2) + '%', '| maxDelta:', maxDelta);
console.log('delta>32 map (% of cell, any/warm):');
const cellArea = (width / GX) * (height / GY);
for (let gy = 0; gy < GY; gy++) {
  console.log(grid[gy].map((v, gx) =>
    String(Math.round(100 * v / cellArea)).padStart(3) + '/' + String(Math.round(100 * gridWarm[gy][gx] / cellArea)).padStart(3)
  ).join(' '));
}

// Character canvas band (420x251 @1x centered, x 383..803 y 159..410): compare
// 010 vs 012 there — the hero must be visually untouched (delta should be ~0
// except where pillar light peeks at band edges).
let heroChanged = 0, heroBig = 0, heroMax = 0;
const hx0 = Math.round(383 * 1.25), hy0 = Math.round(159 * 1.25);
const hx1 = Math.round(803 * 1.25), hy1 = Math.round(410 * 1.25);
for (let y = hy0; y < hy1; y++) {
  for (let x = hx0; x < hx1; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 0) { heroChanged++; heroMax = Math.max(heroMax, d); }
    if (d > 16) heroBig++;
  }
}
const heroArea = (hx1 - hx0) * (hy1 - hy0);
console.log('\nhero canvas band: changed', (100 * heroChanged / heroArea).toFixed(2) + '%', '| delta>16:', (100 * heroBig / heroArea).toFixed(2) + '%', '| maxDelta:', heroMax);

// 012 deep-warm column histogram: vertical pillar structure?
const colWarm = new Array(24).fill(0);
for (let y = 0; y < height; y += 4) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
    if (r > 40 && r > bl * 1.5 && g < r * 0.75) colWarm[Math.min(23, Math.floor(x / width * 24))]++;
  }
}
console.log('\n012 deep-warm column histogram (24 bins):');
console.log(colWarm.join(','));
