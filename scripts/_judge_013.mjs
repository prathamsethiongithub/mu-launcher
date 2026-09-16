// Judge 013: is the firewall now a confined, subtle, amber presence behind
// the character — and nothing else changed vs the good 010 baseline?
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/013-lightpillar-tamed/screenshot.png'));
const { width, height } = a; // 1600x1000 device (dpr 1.25 of the locked 1280x800)
const total = width * height;
const S = 1.25; // css->device scale

function regionStats(png, x0, y0, x1, y1) {
  // css-px rect in, device-px sampling
  const dx0 = Math.round(x0 * S), dy0 = Math.round(y0 * S);
  const dx1 = Math.round(x1 * S), dy1 = Math.round(y1 * S);
  let warm = 0, n = 0, maxL = 0, sr = 0, sg = 0, sb = 0, warmN = 0;
  for (let y = dy0; y < dy1; y++) for (let x = dx0; x < dx1; x++) {
    const i = (y * width + x) * 4;
    const r = png.data[i], g = png.data[i + 1], bl = png.data[i + 2];
    const m = Math.max(r, g, bl); n++;
    if (m > maxL) maxL = m;
    if (r > 24 && r > bl * 1.3 && g > bl) { warm++; sr += r; sg += g; sb += bl; warmN++; }
  }
  return {
    n, warmPct: +(100 * warm / n).toFixed(2), maxL,
    warmMean: warmN ? [Math.round(sr / warmN), Math.round(sg / warmN), Math.round(sb / warmN)] : null,
  };
}

// warm% whole frame
console.log('=== whole frame warm% (010 vs 013) ===');
console.log(JSON.stringify({ '010': regionStats(a, 0, 0, 1280, 800), '013': regionStats(b, 0, 0, 1280, 800) }));

// regions that must be UNTOUCHED (compare 010 vs 013 pixel deltas)
const REGIONS = {
  'header (top nav)': [0, 0, 1280, 48],
  'h1 Ready zone': [430, 452, 850, 530],
  'sub zone': [500, 540, 800, 575],
  'CTA zone': [430, 600, 850, 665],
  'dock/nav zone': [430, 685, 850, 745],
  'metadata rail': [0, 750, 1280, 800],
  'left of canvas': [0, 48, 430, 800],
  'right of canvas': [850, 48, 1280, 800],
};
console.log('\n=== protected regions: warm% 010 -> 013 (should be ~equal) ===');
for (const [name, [x0, y0, x1, y1]] of Object.entries(REGIONS)) {
  const r0 = regionStats(a, x0, y0, x1, y1), r1 = regionStats(b, x0, y0, x1, y1);
  console.log(`${name.padEnd(18)} warm% ${String(r0.warmPct).padStart(6)} -> ${String(r1.wampPct ?? r1.warmPct).padStart(6)}  maxL ${r0.maxL} -> ${r1.maxL}`);
}

// the intended change zone: the visible band above the canvas + behind it
console.log('\n=== firewall zone (x 430..850, above canvas y 76..180) ===');
console.log('010:', JSON.stringify(regionStats(a, 430, 76, 850, 180)));
console.log('013:', JSON.stringify(regionStats(b, 430, 76, 850, 180)));

// beam color check: warm pixels in the firewall zone — amber, not yellow/white
const fz = regionStats(b, 430, 76, 850, 180);
if (fz.warmMean) {
  const [r, g, bl] = fz.warmMean;
  console.log(`firewall warm-mean RGB (${r},${g},${bl})  G/R=${(g / r).toFixed(3)} (amber ~0.55-0.75; yellow >0.80)  B/R=${(bl / r).toFixed(3)}`);
}

// dark box check
function darkPct(png) {
  let dark = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) < 8) dark++;
  }
  return +(100 * dark / total).toFixed(2);
}
console.log('\ndark<8%: 010 =', darkPct(a), '| 013 =', darkPct(b), '(011 black-box failure was 30.99)');

// stage canvas band: only idle-pose noise may differ (character untouched)
let heroChanged = 0, heroBig = 0, n = 0;
for (let y = Math.round(180 * S); y < Math.round(452 * S); y++) {
  for (let x = Math.round(430 * S); x < Math.round(850 * S); x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    n++; if (d > 0) heroChanged++; if (d > 24) heroBig++;
  }
}
console.log('stage canvas band: changed', (100 * heroChanged / n).toFixed(1) + '%', '| delta>24:', (100 * heroBig / n).toFixed(1) + '%', '(010 vs 011 was 21%/11% pure pose noise)');

// hot-core check: count near-white/near-yellow pixels in the whole frame delta zone
let hot = 0;
for (let y = Math.round(60 * S); y < Math.round(460 * S); y++) {
  for (let x = Math.round(400 * S); x < Math.round(880 * S); x++) {
    const i = (y * width + x) * 4;
    const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
    if (r > 200 && g > 170 && bl > 120) hot++; // yellow-white territory
  }
}
console.log('yellow-white hot pixels in firewall region:', hot, '(must be 0)');

// footprint map of the actual change (delta>10), 16x10 grid, css cells
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
console.log('\ndelta>10 footprint (% of cell, 80px css cells):');
const cellArea = (width / GX) * (height / GY);
for (let gy = 0; gy < GY; gy++) console.log(grid[gy].map(v => String(Math.min(99, Math.round(100 * v / cellArea))).padStart(2)).join(' '));
