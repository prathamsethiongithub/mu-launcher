// Color of the brightest firewall pixels on 016 — must stay amber.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const png = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/016-lightpillar-final/screenshot.png'));
const { width: w, height: h } = png;
const S = 1.25;
const buckets = { gt160: [0, 0, 0, 0], gt120: [0, 0, 0, 0] };
for (let y = Math.round(76 * S); y < Math.round(452 * S); y++) {
  for (let x = Math.round(336 * S); x < Math.round(944 * S); x++) {
    const i = (y * w + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const m = Math.max(r, g, b);
    if (m > 160) { buckets.gt160[0]++; buckets.gt160[1] += r; buckets.gt160[2] += g; buckets.gt160[3] += b; }
    if (m > 120) { buckets.gt120[0]++; buckets.gt120[1] += r; buckets.gt120[2] += g; buckets.gt120[3] += b; }
  }
}
for (const [k, [n, sr, sg, sb]] of Object.entries(buckets)) {
  if (!n) { console.log(`pixels >${k.slice(2)}: 0`); continue; }
  const r = Math.round(sr / n), g = Math.round(sg / n), b = Math.round(sb / n);
  console.log(`pixels >${k.slice(2)}: ${n}  mean RGB(${r},${g},${b})  G/R=${(g / r).toFixed(2)} (amber: r>g>b, G/R 0.5-0.8)`);
}
