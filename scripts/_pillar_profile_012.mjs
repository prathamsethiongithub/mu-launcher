// 012 pillar brightness judgment: vertical luminance profile of the pillar
// column (excluding the opaque canvas rect), side-band brightness vs character
// max (168), and top-of-screen glow level.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/012-lightpillar-screen/screenshot.png'));
const { width, height } = b; // 1600x1000

// Pillar column: central 4 bins from the histogram ≈ x 500..1050 device.
// Canvas rect (capture runs): x 479..1004, y ~199..539 (opaque — excluded).
// Measure lum mean/max per horizontal band of 100 device rows, OUTSIDE canvas.
const cx0 = 479, cx1 = 1004, cy0 = 199, cy1 = 539;
function bandStats(y0, y1, x0, x1) {
  let sum = 0, max = 0, n = 0, warm = 0, warmSum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = b.data[i], g = b.data[i + 1], bl = b.data[i + 2];
      const m = Math.max(r, g, bl);
      sum += m; n++; if (m > max) max = m;
      if (r > 24 && r > bl * 1.3 && g > bl) { warm++; warmSum += m; }
    }
  }
  return { mean: +(sum / n).toFixed(1), max, warmPct: +(100 * warm / n).toFixed(1), warmMean: warm ? +(warmSum / warm).toFixed(0) : 0 };
}

console.log('=== Vertical profile OUTSIDE canvas rect (x 60..1600) ===');
for (let y = 0; y < height; y += 100) {
  const y1 = Math.min(height, y + 100);
  // stitch: left of canvas + right of canvas + full rows outside canvas y-range
  let s;
  if (y1 <= cy0 || y >= cy1) {
    s = bandStats(y, y1, 60, width - 20);
  } else {
    // combine left band + right band manually
    const L = bandStats(Math.max(y, cy0), Math.min(y1, cy1), 60, cx0);
    const R = bandStats(Math.max(y, cy0), Math.min(y1, cy1), cx1, width - 20);
    const n = L.n_placeholder || 0; // not used
    s = { mean: +(((L.mean * 1 + R.mean * 1) / 2)).toFixed(1), max: Math.max(L.max, R.max), warmPct: +(((L.warmPct + R.warmPct) / 2)).toFixed(1), warmMean: Math.max(L.warmMean, R.warmMean), note: 'left+right avg' };
  }
  console.log(`y ${String(y).padStart(4)}-${String(y1).padStart(4)}: mean ${String(s.mean).padStart(6)} max ${String(s.max).padStart(3)} warm% ${String(s.warmPct).padStart(5)} warmMean ${s.warmMean}${s.note ? '  (' + s.note + ')' : ''}`);
}

console.log('\n=== Character reference (canvas rect, includes hero) ===');
console.log('canvas band max lum (010): 168');

console.log('\n=== 010 vs 012 same-band means (delta = pillar contribution) ===');
function meanBand(png, y0, y1, x0, x1) {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    sum += Math.max(png.data[i], png.data[i + 1], png.data[i + 2]); n++;
  }
  return +(sum / n).toFixed(1);
}
for (const [label, y0, y1] of [['top (0-200)', 0, 200], ['mid-above (540-780)', 540, 780], ['bottom (780-1000)', 780, 1000]]) {
  console.log(`${label}: 010 mean ${meanBand(a, y0, y1, 60, width - 20)} -> 012 mean ${meanBand(b, y0, y1, 60, width - 20)}`);
}
