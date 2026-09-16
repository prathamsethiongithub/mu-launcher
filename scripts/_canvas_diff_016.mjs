// 010 vs 016 character-stage-canvas diff — must be idle-pose noise only.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const load = (p) => PNG.sync.read(readFileSync(`C:/Users/fortn/mu-visual-history/${p}/stage-canvas.png`));
const a = load('010-amber-key-002');
const b = load('016-lightpillar-final');
let n = 0, big = 0, changed = 0, maxD = 0;
for (let i = 0; i < a.data.length; i += 4) {
  const d = Math.max(
    Math.abs(a.data[i] - b.data[i]),
    Math.abs(a.data[i + 1] - b.data[i + 1]),
    Math.abs(a.data[i + 2] - b.data[i + 2]));
  n++; if (d > 0) changed++; if (d > 24) big++; if (d > maxD) maxD = d;
}
console.log('010 vs 016 stage canvas: changed', (100 * changed / n).toFixed(2) + '%',
  '| delta>24:', (100 * big / n).toFixed(2) + '%', '| maxD', maxD,
  '(reference pose-noise floor, 010 vs 013: 9.11% / 2.53% / 136)');
