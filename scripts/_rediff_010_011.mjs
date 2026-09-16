// Fresh careful re-diff: 010 vs 011 full screenshots (the earlier "byte-identical"
// claim needs verification before I trust it).
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/011-lightpillar/screenshot.png'));
console.log('sizes:', a.width + 'x' + a.height, 'vs', b.width + 'x' + b.height);

const rawA = readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png');
const rawB = readFileSync('C:/Users/fortn/mu-visual-history/011-lightpillar/screenshot.png');
console.log('byte-identical files:', rawA.equals(rawB), '| bytes:', rawA.length, rawB.length);

if (a.width === b.width && a.height === b.height) {
  let changed = 0, changedLum = 0, maxDelta = 0;
  const binsX = new Array(8).fill(0);
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 0) {
      changed++;
      maxDelta = Math.max(maxDelta, d);
      if (d > 8) changedLum++;
      const px = ((i / 4) % a.width) / a.width;
      binsX[Math.min(7, Math.floor(px * 8))]++;
    }
  }
  const total = a.width * a.height;
  console.log('changed pixels:', changed, (100 * changed / total).toFixed(3) + '%', '| >8 delta:', (100 * changedLum / total).toFixed(3) + '%', '| maxDelta:', maxDelta);
  console.log('x-bins of changed:', binsX.join(','));
}
