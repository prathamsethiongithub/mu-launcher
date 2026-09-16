// Judge 014: is the wrap-around firewall visible-but-restrained, amber (not
// yellow/green/white), rectangle-free — and is everything else untouched vs
// the good baselines (010 good composition, 013 the too-tame predecessor)?
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const load = (p) => PNG.sync.read(readFileSync(`C:/Users/fortn/mu-visual-history/${p}/screenshot.png`));
const a010 = load('010-amber-key-002');
const a013 = load('013-lightpillar-tamed');
const a014 = load(process.argv[2] || '014-lightpillar-final');
const { width, height } = a010; // 1600x1000 device (dpr 1.25 of locked 1280x800)
const S = 1.25;

function regionStats(png, x0, y0, x1, y1) {
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
  return { n, warmPct: +(100 * warm / n).toFixed(2), maxL,
    warmMean: warmN ? [Math.round(sr / warmN), Math.round(sg / warmN), Math.round(sb / warmN)] : null };
}

const hsv = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d === 0) return 0;
  if (mx === r) return ((g - b) / d + 6) % 6 * 60;
  if (mx === g) return (b - r) / d * 60 + 120;
  return (r - g) / d * 60 + 240;
};

const TAG = a014 === a010 ? '010' : (process.argv[2] || '014');
console.log(`=== whole frame warm% (010 / 013 / ${TAG}) ===`);
for (const [k, png] of [['010', a010], ['013', a013], ['014', a014]])
  console.log(k, JSON.stringify(regionStats(png, 0, 0, 1280, 800)));

const REGIONS = {
  'header (top nav)': [0, 0, 1280, 48],
  'h1 Ready zone': [430, 452, 850, 530],
  'sub zone': [500, 540, 800, 575],
  'CTA zone': [430, 600, 850, 665],
  'dock/nav zone': [430, 685, 850, 745],
  'metadata rail': [0, 750, 1280, 800],
  'left of canvas': [0, 48, 430, 800],
  'right of canvas': [850, 48, 1280, 800],
  'firewall zone (wide)': [336, 76, 944, 452],
  'left glow flank': [336, 76, 430, 452],
  'right glow flank': [850, 76, 944, 452],
  'above-head band': [430, 76, 850, 180],
};
console.log('\n=== protected + firewall regions (warm% / maxL / warmMean) ===');
for (const [name, [x0, y0, x1, y1]] of Object.entries(REGIONS)) {
  const r0 = regionStats(a010, x0, y0, x1, y1);
  const r1 = regionStats(a013, x0, y0, x1, y1);
  const r2 = regionStats(a014, x0, y0, x1, y1);
  const fmt = (r) => `${String(r.warmPct).padStart(6)} ${String(r.maxL).padStart(3)} ${r.warmMean ? JSON.stringify(r.warmMean) : '-'}`;
  console.log(`${name.padEnd(20)} 010 ${fmt(r0)} | 013 ${fmt(r1)} | 014 ${fmt(r2)}`);
}

// 014 warm-pixel hue check in the firewall zone
{
  const r = regionStats(a014, 336, 76, 944, 452);
  if (r.warmMean) {
    const [R, G, B] = r.warmMean;
    console.log(`\n014 firewall warm-mean RGB(${R},${G},${B}) hue=${hsv(R, G, B).toFixed(1)}deg G/R=${(G / R).toFixed(3)} (amber ~30-35deg, G/R 0.5-0.8; yellow >0.9)`);
  } else console.log('\n014 firewall zone: NO warm pixels at all');
}

// dark box check
const darkPct = (png) => {
  let dark = 0;
  for (let i = 0; i < png.data.length; i += 4)
    if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) < 8) dark++;
  return +(100 * dark / (width * height)).toFixed(2);
};
console.log('dark<8%: 010 =', darkPct(a010), '| 013 =', darkPct(a013), '| 014 =', darkPct(a014), '(011 black-box failure was 30.99)');

// 013->014 change footprint (delta>10), 16x10 grid, css cells
const GX = 16, GY = 10;
const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
for (let y = 0; y < height; y++) {
  const gy = Math.min(GY - 1, Math.floor(y / height * GY));
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(
      Math.abs(a013.data[i] - a014.data[i]),
      Math.abs(a013.data[i + 1] - a014.data[i + 1]),
      Math.abs(a013.data[i + 2] - a014.data[i + 2]));
    if (d > 10) grid[gy][Math.min(GX - 1, Math.floor(x / width * GX))]++;
  }
}
console.log('\n013->014 delta>10 footprint (% of cell, 80px css cells):');
const cellArea = (width / GX) * (height / GY);
for (let gy = 0; gy < GY; gy++) console.log(grid[gy].map(v => String(Math.min(99, Math.round(100 * v / cellArea))).padStart(2)).join(' '));

// yellow-white hot pixels in the wide firewall region on 014
let hot = 0, green = 0;
for (let y = Math.round(60 * S); y < Math.round(460 * S); y++) {
  for (let x = Math.round(320 * S); x < Math.round(960 * S); x++) {
    const i = (y * width + x) * 4;
    const r = a014.data[i], g = a014.data[i + 1], bl = a014.data[i + 2];
    if (r > 200 && g > 170 && bl > 120) hot++;
    if (g > 60 && g > r * 1.4 && g > bl * 1.4) green++;
  }
}
console.log('014 firewall region: yellow-white hot px =', hot, '| green-dominant px =', green, '(both must be ~0)');
