// Identify the row-8/9 delta pixels (010 vs 013): text-shaped? hearth-shaped?
// Sample the differing pixels' colors and positions in the rail/dock band.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const a = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/010-amber-key-002/screenshot.png'));
const b = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/013-lightpillar-tamed/screenshot.png'));
const c = PNG.sync.read(readFileSync('C:/Users/fortn/mu-visual-history/009-freebuff-stage/screenshot.png'));
const { width, height } = a;
const S = 1.25;

function harvest(p1, p2, label) {
  const pts = [];
  for (let y = Math.round(690 * S); y < Math.round(800 * S); y++) {
    for (let x = Math.round(300 * S); x < Math.round(980 * S); x++) {
      const i = (y * width + x) * 4;
      const d = Math.max(Math.abs(p1.data[i] - p2.data[i]), Math.abs(p1.data[i + 1] - p2.data[i + 1]), Math.abs(p1.data[i + 2] - p2.data[i + 2]));
      if (d > 10) pts.push({ x: Math.round(x / S), y: Math.round(y / S), d, a: [p1.data[i], p1.data[i + 1], p1.data[i + 2]], b: [p2.data[i], p2.data[i + 1], p2.data[i + 2]] });
    }
  }
  console.log(`\n${label}: ${pts.length} px, delta>24: ${pts.filter(p => p.d > 24).length}, max ${Math.max(0, ...pts.map(p => p.d))}`);
  // y histogram in 5px bins
  const yh = {};
  for (const p of pts) { const k = Math.floor(p.y / 5) * 5; yh[k] = (yh[k] || 0) + 1; }
  console.log('y-histogram (5px bins):', JSON.stringify(yh));
  // sample 8 spread samples
  const step = Math.max(1, Math.floor(pts.length / 8));
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    console.log(`  (${p.x},${p.y}) d=${p.d} 010rgb(${p.a.join(',')}) 013rgb(${p.b.join(',')})`);
  }
  return pts;
}
harvest(a, b, 'rail/dock band 010 vs 013');
harvest(a, c, 'rail/dock band 010 vs 009');
harvest(b, c, 'rail/dock band 013 vs 009');
