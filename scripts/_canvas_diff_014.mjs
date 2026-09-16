// Diff the raw character stage canvas (WebGL only) between 010/013/014.
// If 013 vs 014 differs only by idle-pose noise, the character/stage is
// untouched and the capture guard's green-cyan reading is a sampling fluke.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const load = (p) => PNG.sync.read(readFileSync(`C:/Users/fortn/mu-visual-history/${p}/stage-canvas.png`));
const a = load('013-lightpillar-tamed');
const b = load('014-lightpillar-final');
const c = load('010-amber-key-002');

function stats(x, y) {
  if (x.width !== y.width || x.height !== y.height) return { mismatch: `${x.width}x${x.height} vs ${y.width}x${y.height}` };
  let n = 0, big = 0, changed = 0, maxD = 0, sumD = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]));
    n++; sumD += d; if (d > 0) changed++; if (d > 24) big++; if (d > maxD) maxD = d;
  }
  return { px: n, changedPct: +(100 * changed / n).toFixed(2), bigPct: +(100 * big / n).toFixed(2), maxD, meanD: +(sumD / n).toFixed(2) };
}

console.log('013 vs 014 stage canvas:', JSON.stringify(stats(a, b)));
console.log('010 vs 014 stage canvas:', JSON.stringify(stats(c, b)));
console.log('010 vs 013 stage canvas (reference noise floor):', JSON.stringify(stats(c, a)));
