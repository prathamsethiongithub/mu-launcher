// Are the stage canvas pixels themselves different between 010 and 012?
// If yes and the changed pixels are BRIGHT (skin), the pillar contaminates the
// character (reject). If they're DARK (background around the character), the
// pillar is showing through a transparent canvas background = behind character.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/stage-canvas.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/012-lightpillar-screen/stage-canvas.png'));
console.log('canvas sizes:', a.width + 'x' + a.height, 'vs', b.width + 'x' + b.height);
const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);

let changed = 0, big = 0, maxD = 0;
let brightChanged = 0, darkChanged = 0;
let aAlphaZero = 0, bAlphaZero = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (a.data[i + 3] === 0) aAlphaZero++;
    if (b.data[i + 3] === 0) bAlphaZero++;
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 0) {
      changed++;
      const la = Math.max(a.data[i], a.data[i + 1], a.data[i + 2]);
      if (la > 96) brightChanged++; else darkChanged++;
    }
    if (d > 32) { big++; maxD = Math.max(maxD, d); }
  }
}
const tot = w * h;
console.log('changed:', (100 * changed / tot).toFixed(2) + '%', '| delta>32:', (100 * big / tot).toFixed(2) + '%', '| max:', maxD);
console.log('of changed pixels — were bright(>96) in 010:', brightChanged, '| were dark(<96):', darkChanged);
console.log('alpha==0 pixels: 010 =', (100 * aAlphaZero / tot).toFixed(1) + '%', '| 012 =', (100 * bAlphaZero / tot).toFixed(1) + '%');

// Brightness comparison: character band max vs pillar-only region max
function maxLum(png) { let m = 0; for (let i = 0; i < png.data.length; i += 4) m = Math.max(m, png.data[i], png.data[i + 1], png.data[i + 2]); return m; }
console.log('canvas max lum: 010 =', maxLum(a), '| 012 =', maxLum(b));
