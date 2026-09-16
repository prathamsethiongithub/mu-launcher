// Teal-aware check on the FULL-PAGE screenshots. Teal = g≈b, both >> r
// (e.g. RGB(2,82,74)); the earlier green test (g > b*1.4) structurally
// misses teal. Also dump a small character-region patch to eyeball.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const load = (p) => PNG.sync.read(readFileSync(`C:/Users/fortn/mu-visual-history/${p}/screenshot.png`));

for (const v of ['010-amber-key-002', '013-lightpillar-tamed', '014-lightpillar-final', '015-lightpillar-final']) {
  const png = load(v);
  const { width: w, height: h } = png;
  const S = 1.25;
  // character region on the page (canvas span x 430..850, y 180..452)
  let teal = 0, n = 0, tealSum = [0, 0, 0];
  for (let y = Math.round(180 * S); y < Math.round(452 * S); y++) {
    for (let x = Math.round(430 * S); x < Math.round(850 * S); x++) {
      const i = (y * w + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      n++;
      if (g > 35 && g > r * 1.6 && Math.abs(g - b) < 0.45 * g) {
        teal++; tealSum[0] += r; tealSum[1] += g; tealSum[2] += b;
      }
    }
  }
  const m = teal ? tealSum.map(v => Math.round(v / teal)) : null;
  console.log(`${v.padEnd(24)} teal px in character region: ${String(teal).padStart(6)} / ${n}  (${(100 * teal / n).toFixed(2)}%)  mean ${m ? `RGB(${m.join(',')})` : '-'}`);
}
