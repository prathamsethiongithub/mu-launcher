// Where is the teal/blue on the 014 stage canvas, and does this state match
// any earlier capture? Spatial map + cross-version nearest-match by palette.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const load = (p, f = 'stage-canvas.png') => PNG.sync.read(readFileSync(`C:/Users/fortn/mu-visual-history/${p}/${f}`));
const versions = [
  '010-amber-key-002', '011-lightpillar', '012-lightpillar-screen',
  '013-lightpillar-tamed', '014-lightpillar-final',
];

function classify(png) {
  const { width: w, height: h } = png;
  let green = 0, blue = 0, warm = 0, dark = 0, other = 0;
  // 12x12 spatial grid of green+blue density
  const GX = 12, GY = 12;
  const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const m = Math.max(r, g, b);
    if (m < 10) dark++;
    else if (g > r * 1.15 && g > b * 0.8 && g > 40) { green++; grid[Math.floor(y / h * GY)][Math.floor(x / w * GX)]++; }
    else if (b > r * 1.15 && b > g * 1.1 && b > 40) { blue++; grid[Math.floor(y / h * GY)][Math.floor(x / w * GX)]++; }
    else if (r > g * 1.1 && r > b * 1.2) warm++;
    else other++;
  }
  const total = w * h;
  return { green: +(100 * green / total).toFixed(2), blue: +(100 * blue / total).toFixed(2),
    warm: +(100 * warm / total).toFixed(2), dark: +(100 * dark / total).toFixed(2), grid };
}

console.log('=== per-version canvas palette (% of pixels) ===');
const results = {};
for (const v of versions) {
  const r = classify(load(v));
  results[v] = r;
  console.log(v.padEnd(24), `warm ${String(r.warm).padStart(6)}  dark ${String(r.dark).padStart(6)}  GREEN ${String(r.green).padStart(5)}  BLUE ${String(r.blue).padStart(5)}`);
}

// spatial map for the two versions with green
for (const v of versions) {
  if (results[v].green < 0.5) continue;
  console.log(`\n=== ${v}: green+blue density map (12x12, % of cell, >10 shown) ===`);
  for (const row of results[v].grid)
    console.log(row.map(c => String(c > 10 ? Math.min(99, Math.round(100 * c / (525 * 340 / 144))) : '.').padStart(2)).join(' '));
}
