// What is on the 014 stage canvas? Color-region forensics vs 013.
// The capture guard said green-cyan; the page screenshot said amber.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const load = (p) => PNG.sync.read(readFileSync(`C:/Users/fortn/mu-visual-history/${p}/stage-canvas.png`));

for (const v of ['013-lightpillar-tamed', '014-lightpillar-final']) {
  const png = load(v);
  const { width: w, height: h } = png;
  const stats = {};
  const add = (k, r, g, b) => {
    const s = stats[k] ||= { n: 0, sr: 0, sg: 0, sb: 0 };
    s.n++; s.sr += r; s.sg += g; s.sb += b;
  };
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const m = Math.max(r, g, b);
    if (m < 10) add('bg dark<10', r, g, b);
    else if (r > g * 1.15 && r > b * 1.3) add('warm', r, g, b);
    else if (g > r * 1.15 && g > b * 1.05) add('green-dominant', r, g, b);
    else if (b > r * 1.15 && b > g * 1.05) add('blue-dominant', r, g, b);
    else add('neutral', r, g, b);
  }
  console.log(`\n=== ${v} (${w}x${h}) ===`);
  for (const [k, s] of Object.entries(stats)) {
    const pct = +(100 * s.n / (w * h)).toFixed(2);
    console.log(`${k.padEnd(16)} ${String(pct).padStart(6)}%  mean RGB(${Math.round(s.sr / s.n)},${Math.round(s.sg / s.n)},${Math.round(s.sb / s.n)})`);
  }
}
