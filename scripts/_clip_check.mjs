// Analyze pillar-probe clips: warm-lit stats + side-by-side comparison against
// the same regions cropped from 010's full screenshot (pre-pillar baseline).
// If pillar renders, clips should show MORE warm lit pixels than 010's crops.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const clips = ['below-canvas', 'right-of-canvas', 'left-of-canvas'];
const rects = {
  'below-canvas': { x: 383, y: 415, w: 470, h: 300 },
  'right-of-canvas': { x: 810, y: 160, w: 300, h: 400 },
  'left-of-canvas': { x: 60, y: 160, w: 300, h: 400 },
};
// Full screenshots are at deviceScaleFactor 1.25 -> 1600x1000 for a 1280x800 viewport.
const BASE010 = 'C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png';
const DS = 1.25;

function stats(png, rx, ry, rw, rh) {
  const { width, height, data } = png;
  const x0 = Math.max(0, Math.round(rx * DS)), y0 = Math.max(0, Math.round(ry * DS));
  const x1 = Math.min(width, Math.round((rx + rw) * DS)), y1 = Math.min(height, Math.round((ry + rh) * DS));
  let lit = 0, warm = 0, maxLum = 0, sumR = 0, sumG = 0, sumB = 0, n = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const m = Math.max(r, g, b);
      maxLum = Math.max(maxLum, m);
      if (m > 8) lit++;
      if (r > 24 && r > b * 1.3 && g > b) { warm++; sumR += r; sumG += g; sumB += b; n++; }
      total++;
    }
  }
  return {
    litPct: +(100 * lit / total).toFixed(2),
    warmPct: +(100 * warm / total).toFixed(2),
    maxLum,
    avgWarmRGB: n ? [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)] : null,
  };
}

const base = PNG.sync.read(readFileSync(BASE010));
console.log('base full size:', base.width, 'x', base.height);
for (const c of clips) {
  const clip = PNG.sync.read(readFileSync(`C:/Users/fortn/mu-verify/clip-${c}.png`));
  const r = rects[c];
  console.log(`\n${c} (${r.w}x${r.h} @1x):`);
  console.log('  clip(new):', JSON.stringify(stats(clip, 0, 0, r.w, r.h)));
  console.log('  010(old) :', JSON.stringify(stats(base, r.x, r.y, r.w, r.h)));
}
