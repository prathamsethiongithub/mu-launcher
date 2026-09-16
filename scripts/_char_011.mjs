// What did 011 actually add? Global frame stats + spatial map of big deltas.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/011-lightpillar/screenshot.png'));
const { width, height } = a;

// Global warm/luminance stats per frame
function frameStats(png) {
  let lit = 0, warm = 0, sum = 0, maxL = 0;
  const total = width * height;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], bl = png.data[i + 2];
    const m = Math.max(r, g, bl);
    maxL = Math.max(maxL, m);
    if (m > 8) lit++;
    if (r > 24 && r > bl * 1.3 && g > bl) warm++;
    sum += m;
  }
  return { litPct: +(100 * lit / total).toFixed(2), warmPct: +(100 * warm / total).toFixed(2), meanLum: +(sum / total).toFixed(2), maxL };
}
console.log('010:', JSON.stringify(frameStats(a)));
console.log('011:', JSON.stringify(frameStats(b)));

// Spatial delta grid 8x5 — where do deltas >32 live in 011?
const GX = 8, GY = 5;
const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
const gridWarm = Array.from({ length: GY }, () => new Array(GX).fill(0));
for (let y = 0; y < height; y++) {
  const gy = Math.min(GY - 1, Math.floor(y / height * GY));
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 32) {
      grid[gy][Math.min(GX - 1, Math.floor(x / width * GX))]++;
      const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
      if (r > 24 && r > bl * 1.3) gridWarm[gy][Math.min(GX - 1, Math.floor(x / width * GX))]++;
    }
  }
}
console.log('\ndelta>32 density map (011 new content, cells as % of cell area):');
for (let gy = 0; gy < GY; gy++) {
  console.log(grid[gy].map((v, gx) => {
    const cellArea = (width / GX) * (height / GY);
    const pct = Math.round(100 * v / cellArea);
    const wpct = Math.round(100 * gridWarm[gy][gx] / cellArea);
    return String(pct).padStart(3) + '/' + String(wpct).padStart(3);
  }).join(' '));
}
console.log('(left num: any-change %, right: warm-change %)');

// 011 warm content columns: is there a vertical structure (pillar)?
const colWarm = new Array(24).fill(0);
for (let y = 0; y < height; y += 4) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
    if (r > 40 && r > bl * 1.5 && g < r * 0.75) colWarm[Math.min(23, Math.floor(x / width * 24))]++;
  }
}
console.log('\n011 deep-warm column histogram (24 bins):');
console.log(colWarm.join(','));
