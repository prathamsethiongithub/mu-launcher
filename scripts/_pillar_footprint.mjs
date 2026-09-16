// One-off: diff 010-amber-key-002 vs 011-lightpillar (full screenshot + stage
// canvas) to isolate the firewall's footprint and confirm the stage canvas
// changed only by idle-pose noise.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

function load(p) {
  const png = PNG.sync.read(readFileSync(p));
  return { w: png.width, h: png.height, data: png.data };
}

function diff(pa, pb, outPath) {
  const A = load(pa), B = load(pb);
  const { width: w, height: h } = A;
  if (B.width !== w || B.height !== h) return { error: `size mismatch ${w}x${h} vs ${B.width}x${B.height}` };
  const CELL = 50;
  const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
  const heat = Array.from({ length: rows }, () => Array(cols).fill(0));
  const changed = { n: 0, sum: 0, max: 0 };
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dc = (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2])) / 3 / 255;
      if (dc > 0.01) {
        changed.n++; changed.sum += dc;
        if (dc > changed.max) changed.max = dc;
        heat[Math.floor(y / CELL)][Math.floor(x / CELL)] += dc;
        out.data[i] = Math.min(255, dc * 255 * 4);
        out.data[i + 3] = 255;
      } else {
        out.data[i] = A.data[i]; out.data[i + 1] = A.data[i + 1]; out.data[i + 2] = A.data[i + 2]; out.data[i + 3] = 255;
      }
    }
  }
  if (outPath) writeFileSync(outPath, PNG.sync.write(out));
  return {
    changed: changed.n,
    pct: +(100 * changed.n / (w * h)).toFixed(2),
    meanDelta: changed.n ? +(changed.sum / changed.n).toFixed(4) : 0,
    maxDelta: +changed.max.toFixed(4),
    heat,
  };
}

const base = 'C:/Users/fortn/mu-visual-history/';
const shot = diff(
  base + '010-amber-key-002/screenshot.png',
  base + '011-lightpillar/screenshot.png',
  base + '011-lightpillar/diff-010-vs-011.png',
);
console.log('FULL SCREENSHOT 010 vs 011:');
console.log(JSON.stringify({ ...shot, heat: undefined }, null, 2));
console.log('heat map (50px cells, Δ lum-sum):');
for (const row of shot.heat) console.log(row.map((v) => String(Math.min(9, Math.round(v * 10))).padStart(2)).join(''));

const canvas = diff(
  base + '010-amber-key-002/stage-canvas.png',
  base + '011-lightpillar/stage-canvas.png',
);
console.log('\nSTAGE CANVAS 010 vs 011 (expect idle-pose noise only):');
console.log(JSON.stringify(canvas, null, 2));
