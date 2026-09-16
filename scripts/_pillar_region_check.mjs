// One-off: analyze the beacon-region screenshot saved by probe-pillar.mjs.
// If the pillar renders anything, some pixels will be > background black.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const png = PNG.sync.read(readFileSync('C:/Users/fortn/mu-verify/pillar-region.png'));
const { width, height, data } = png;
console.log('region size:', width, 'x', height);

let lit8 = 0, lit32 = 0, lit96 = 0, warm = 0, total = width * height;
let maxLum = 0, sumR = 0, sumG = 0, sumB = 0, n = 0;
// Column histogram of lit pixels (>16) to see if anything is structured
const colBins = new Array(16).fill(0);
const rowBins = new Array(12).fill(0);

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    const lum = Math.max(r, g, b);
    maxLum = Math.max(maxLum, lum);
    if (lum > 8) lit8++;
    if (lum > 32) lit32++;
    if (lum > 96) lit96++;
    if (r > 24 && r > b * 1.3 && g > b) { warm++; sumR += r; sumG += g; sumB += b; n++; }
    if (lum > 16) {
      colBins[Math.min(15, Math.floor((x / width) * 16))]++;
      rowBins[Math.min(11, Math.floor((y / height) * 12))]++;
    }
  }
}

console.log('alpha[0]:', data[3], ' maxLum:', maxLum);
console.log('lit >8:', ((lit8 / total) * 100).toFixed(2) + '%', ' >32:', ((lit32 / total) * 100).toFixed(3) + '%', ' >96:', ((lit96 / total) * 100).toFixed(4) + '%');
if (n > 0) console.log('warm pixels:', warm, ' avgRGB:', (sumR / n).toFixed(1), (sumG / n).toFixed(1), (sumB / n).toFixed(1));
console.log('col bins (>16):', colBins.join(','));
console.log('row bins (>16):', rowBins.join(','));
