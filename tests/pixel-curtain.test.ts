import { describe, it, expect } from 'vitest';
import {
  curtainPhase,
  importRevealPhase,
  importSwapWindowStart,
  computePixelGrid,
  computeScatterOffsets,
  buildShufflePermutation,
  shouldSkipCurtain,
  dissolveSweepGeometry,
  equipCeremonyNext,
  equipButtonPhase,
  hashSeed,
  EQUIP_CURTAIN_BUDGET,
  CURTAIN_ASSEMBLE_MS,
  CURTAIN_HOLD_MS,
  CURTAIN_DISSOLVE_MS,
  IMPORT_FLYIN_MS,
  IMPORT_SETTLE_MS,
  IMPORT_CONVERGE_MS,
  IMPORT_REVEAL_MS,
  IMPORT_REVEAL_BUDGET,
  SCATTER_MAX_RADIUS_TILES,
  SKIP_MIN_SAMPLES,
  SKIP_MEDIAN_THRESHOLD_MS,
  SKIP_SAMPLE_WINDOW_MS,
} from '../src/shared/pixel-curtain';

// ── constants ────────────────────────────────────────────────────────────────

describe('budgets', () => {
  it('equip curtain = 400 + 100 + 200 = 700', () => {
    expect(CURTAIN_ASSEMBLE_MS).toBe(400);
    expect(CURTAIN_HOLD_MS).toBe(100);
    expect(CURTAIN_DISSOLVE_MS).toBe(200);
    expect(EQUIP_CURTAIN_BUDGET).toBe(700);
  });

  it('import reveal = 350 + 200 + 150 + 200 = 900 (D9)', () => {
    expect(IMPORT_FLYIN_MS).toBe(350);
    expect(IMPORT_SETTLE_MS).toBe(200);
    expect(IMPORT_CONVERGE_MS).toBe(150);
    expect(IMPORT_REVEAL_MS).toBe(200);
    expect(IMPORT_REVEAL_BUDGET).toBe(900);
  });

  it('skip constants (D8)', () => {
    expect(SKIP_SAMPLE_WINDOW_MS).toBe(200);
    expect(SKIP_MIN_SAMPLES).toBe(3);
    expect(SKIP_MEDIAN_THRESHOLD_MS).toBe(50);
  });
});

// ── hashSeed ─────────────────────────────────────────────────────────────────

describe('hashSeed (D7)', () => {
  it('parses first 8 hex chars of a sha1', () => {
    expect(hashSeed('deadbeef1234567890')).toBe(Number.parseInt('deadbeef', 16));
  });
  it('short or non-hex input falls back to 0', () => {
    expect(hashSeed('zzzz')).toBe(0);
    expect(hashSeed('')).toBe(0);
  });
  it('returns an unsigned 32-bit int', () => {
    const s = hashSeed('ffffffff1234');
    expect(s).toBe(4294967295);
  });
});

// ── curtainPhase ─────────────────────────────────────────────────────────────

describe('curtainPhase boundaries', () => {
  it('elapsed 0 → assemble start', () => {
    expect(curtainPhase(0)).toEqual({ name: 'assemble', progress: 0 });
  });
  it('mid-assemble', () => {
    expect(curtainPhase(200)).toEqual({ name: 'assemble', progress: 0.5 });
  });
  it('exactly 400 → hold start', () => {
    expect(curtainPhase(400)).toEqual({ name: 'hold', progress: 0 });
  });
  it('mid-hold', () => {
    expect(curtainPhase(450)).toEqual({ name: 'hold', progress: 0.5 });
  });
  it('exactly 500 → dissolve start', () => {
    expect(curtainPhase(500)).toEqual({ name: 'dissolve', progress: 0 });
  });
  it('mid-dissolve', () => {
    expect(curtainPhase(600)).toEqual({ name: 'dissolve', progress: 0.5 });
  });
  it('exactly 700 → dissolve complete (progress clamped to 1)', () => {
    expect(curtainPhase(700)).toEqual({ name: 'dissolve', progress: 1 });
  });
  it('timeout beyond budget stays clamped at dissolve/1', () => {
    expect(curtainPhase(800)).toEqual({ name: 'dissolve', progress: 1 });
  });
  it('negative elapsed clamps to 0', () => {
    expect(curtainPhase(-5)).toEqual({ name: 'assemble', progress: 0 });
  });
  it('scaled budget keeps proportional split', () => {
    // 350 budget → assemble 200, hold 50, dissolve 100
    expect(curtainPhase(200, 350)).toEqual({ name: 'hold', progress: 0 });
    expect(curtainPhase(250, 350)).toEqual({ name: 'dissolve', progress: 0 });
    expect(curtainPhase(350, 350)).toEqual({ name: 'dissolve', progress: 1 });
  });
});

// ── importRevealPhase ────────────────────────────────────────────────────────

describe('importRevealPhase boundaries', () => {
  it('elapsed 0 → flyin start', () => {
    expect(importRevealPhase(0)).toEqual({ name: 'flyin', progress: 0 });
  });
  it('exactly 350 → settle start', () => {
    expect(importRevealPhase(350)).toEqual({ name: 'settle', progress: 0 });
  });
  it('exactly 550 → converge start', () => {
    expect(importRevealPhase(550)).toEqual({ name: 'converge', progress: 0 });
  });
  it('exactly 700 → reveal start (swap window per D9)', () => {
    expect(importRevealPhase(700)).toEqual({ name: 'reveal', progress: 0 });
    expect(importSwapWindowStart()).toBe(700);
  });
  it('exactly 900 → reveal complete', () => {
    expect(importRevealPhase(900)).toEqual({ name: 'reveal', progress: 1 });
  });
  it('timeout beyond budget clamps', () => {
    expect(importRevealPhase(1000)).toEqual({ name: 'reveal', progress: 1 });
  });
  it('negative elapsed clamps to 0', () => {
    expect(importRevealPhase(-1)).toEqual({ name: 'flyin', progress: 0 });
  });
  it('mid phases', () => {
    expect(importRevealPhase(175)).toEqual({ name: 'flyin', progress: 0.5 });
    expect(importRevealPhase(450)).toEqual({ name: 'settle', progress: 0.5 });
    expect(importRevealPhase(625)).toEqual({ name: 'converge', progress: 0.5 });
    expect(importRevealPhase(800)).toEqual({ name: 'reveal', progress: 0.5 });
  });
  it('scaled budget keeps proportional split', () => {
    // 450 budget → flyin 175 / settle 100 / converge 75 / reveal 100; reveal starts at 350.
    expect(importRevealPhase(350, 450)).toEqual({ name: 'reveal', progress: 0 });
    expect(importRevealPhase(450, 450)).toEqual({ name: 'reveal', progress: 1 });
  });
});

// ── computePixelGrid ─────────────────────────────────────────────────────────

describe('computePixelGrid', () => {
  it('covers a 300x200 hero box with ≤8px tiles', () => {
    const g = computePixelGrid(300, 200);
    expect(g.tile).toBeGreaterThanOrEqual(1);
    expect(g.tile).toBeLessThanOrEqual(8);
    expect(g.cols * g.tile).toBeGreaterThanOrEqual(300);
    expect(g.rows * g.tile).toBeGreaterThanOrEqual(200);
  });
  it('degenerate dims → empty grid', () => {
    expect(computePixelGrid(0, 200)).toEqual({ cols: 0, rows: 0, tile: 0 });
    expect(computePixelGrid(100, -1)).toEqual({ cols: 0, rows: 0, tile: 0 });
  });
  it('tiny box still yields ≥1x1 grid', () => {
    const g = computePixelGrid(4, 4);
    expect(g.cols).toBeGreaterThanOrEqual(1);
    expect(g.rows).toBeGreaterThanOrEqual(1);
  });
  it('larger srcSize → smaller tiles → denser grid', () => {
    const a = computePixelGrid(300, 200, 64);
    const b = computePixelGrid(300, 200, 128);
    expect(b.tile).toBeLessThanOrEqual(a.tile);
    expect(b.cols).toBeGreaterThanOrEqual(a.cols);
  });
});

// ── computeScatterOffsets / buildShufflePermutation ─────────────────────────

describe('computeScatterOffsets determinism', () => {
  it('same seed + same index → identical offsets', () => {
    const a = computeScatterOffsets(42, 0xdeadbeef);
    const b = computeScatterOffsets(42, 0xdeadbeef);
    expect(a).toEqual(b);
  });
  it('same seed, different index → different offsets', () => {
    const a = computeScatterOffsets(1, 7);
    const b = computeScatterOffsets(2, 7);
    expect(a).not.toEqual(b);
  });
  it('radius within [1, SCATTER_MAX_RADIUS_TILES]', () => {
    for (let i = 0; i < 200; i++) {
      const { dx, dy } = computeScatterOffsets(i, 12345);
      const r = Math.hypot(dx, dy);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(SCATTER_MAX_RADIUS_TILES);
    }
  });
  it('rotation within ±π/8', () => {
    for (let i = 0; i < 100; i++) {
      const { rot } = computeScatterOffsets(i, 999);
      expect(Math.abs(rot)).toBeLessThanOrEqual(Math.PI / 8);
    }
  });
});

describe('buildShufflePermutation determinism', () => {
  it('same seed → same permutation', () => {
    expect(buildShufflePermutation(64, 1)).toEqual(buildShufflePermutation(64, 1));
  });
  it('is a permutation of [0..n)', () => {
    const p = buildShufflePermutation(64, 2);
    expect([...p].sort((x, y) => x - y)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });
  it('empty input → empty output', () => {
    expect(buildShufflePermutation(0, 5)).toEqual([]);
  });
});

// ── shouldSkipCurtain ────────────────────────────────────────────────────────

describe('shouldSkipCurtain (D8)', () => {
  it('reduced motion always skips', () => {
    expect(shouldSkipCurtain(true, [])).toBe(true);
    expect(shouldSkipCurtain(true, [5, 5, 5])).toBe(true);
  });
  it('empty samples → no skip (no evidence, no action)', () => {
    expect(shouldSkipCurtain(false, [])).toBe(false);
  });
  it('fewer than 3 samples → no skip', () => {
    expect(shouldSkipCurtain(false, [60])).toBe(false);
    expect(shouldSkipCurtain(false, [60, 60])).toBe(false);
  });
  it('median > 50ms with ≥3 samples → skip', () => {
    expect(shouldSkipCurtain(false, [60, 60, 60])).toBe(true);
    expect(shouldSkipCurtain(false, [10, 60, 80])).toBe(true); // median 60
  });
  it('median ≤ 50ms → no skip', () => {
    expect(shouldSkipCurtain(false, [16, 17, 16])).toBe(false);
    expect(shouldSkipCurtain(false, [10, 49, 200])).toBe(false); // median 49
  });
  it('resists a single frame spike (median, not mean/max)', () => {
    expect(shouldSkipCurtain(false, [16, 200, 16])).toBe(false);
    expect(shouldSkipCurtain(false, [16, 16, 16, 200])).toBe(false); // median 16
    expect(shouldSkipCurtain(false, [16, 16, 16, 200, 200])).toBe(false); // median 16
    expect(shouldSkipCurtain(false, [16, 16, 200, 200, 200])).toBe(true); // median 200
  });
  it('even-length samples use true median (≥3 samples)', () => {
    expect(shouldSkipCurtain(false, [40, 60, 60, 80])).toBe(true); // median 60 > 50
    expect(shouldSkipCurtain(false, [30, 40, 50, 60])).toBe(false); // median 45 ≤ 50
  });
});

// ── dissolveSweepGeometry ────────────────────────────────────────────────────

describe('dissolveSweepGeometry (D5)', () => {
  const W = 200;
  const H = 300;
  it('progress 0 → the cleared prefix already leads by H/8', () => {
    const r = dissolveSweepGeometry(0, W, H);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBe(W);
    expect(r.h).toBeCloseTo(H * 0.125);
  });
  it('progress 0.5 → prefix = p*H + H/8', () => {
    const r = dissolveSweepGeometry(0.5, W, H);
    expect(r.h).toBeCloseTo(H * 0.625);
  });
  it('progress 1 → the whole canvas is cleared', () => {
    const r = dissolveSweepGeometry(1, W, H);
    expect(r.h).toBe(H);
    expect(r.y + r.h).toBe(H);
  });
  it('prefix never exceeds canvas bounds', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const r = dissolveSweepGeometry(p, W, H);
      expect(r.y).toBe(0);
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeLessThanOrEqual(H);
    }
  });
  it('out-of-range progress clamps', () => {
    expect(dissolveSweepGeometry(-0.5, W, H).h).toBeCloseTo(H * 0.125);
    expect(dissolveSweepGeometry(1.5, W, H).h).toBe(H);
  });
});

// ── equipCeremonyNext ────────────────────────────────────────────────────────

describe('equipCeremonyNext (D6)', () => {
  it('happy path: idle → busy → materializing → done', () => {
    let p = equipCeremonyNext('idle', { type: 'EQUIP_START' });
    expect(p).toBe('busy');
    p = equipCeremonyNext(p, { type: 'EQUIP_SUCCESS' });
    expect(p).toBe('materializing');
    p = equipCeremonyNext(p, { type: 'SWAP_WINDOW' });
    expect(p).toBe('materializing'); // stays
    p = equipCeremonyNext(p, { type: 'CURTAIN_END' });
    expect(p).toBe('done');
  });
  it('done → idle-equivalent re-arm via EQUIP_START', () => {
    expect(equipCeremonyNext('done', { type: 'EQUIP_START' })).toBe('busy');
  });
  it('fail path: busy → fail, semantics unchanged', () => {
    let p = equipCeremonyNext('idle', { type: 'EQUIP_START' });
    p = equipCeremonyNext(p, { type: 'EQUIP_FAIL' });
    expect(p).toBe('fail');
  });
  it('fail is ignored once materializing (success already committed)', () => {
    let p = equipCeremonyNext('busy', { type: 'EQUIP_SUCCESS' });
    p = equipCeremonyNext(p, { type: 'EQUIP_FAIL' });
    expect(p).toBe('materializing');
  });
  it('EQUIP_SUCCESS ignored outside busy', () => {
    expect(equipCeremonyNext('idle', { type: 'EQUIP_SUCCESS' })).toBe('idle');
    expect(equipCeremonyNext('materializing', { type: 'EQUIP_SUCCESS' })).toBe('materializing');
  });
  it('CURTAIN_END ignored outside materializing', () => {
    expect(equipCeremonyNext('busy', { type: 'CURTAIN_END' })).toBe('busy');
    expect(equipCeremonyNext('done', { type: 'CURTAIN_END' })).toBe('done');
  });
  it('SWAP_WINDOW outside materializing is a no-op', () => {
    expect(equipCeremonyNext('busy', { type: 'SWAP_WINDOW' })).toBe('busy');
  });
});

describe('equipButtonPhase (D6 mapping)', () => {
  it('busy → busy (in-flight pulse)', () => {
    expect(equipButtonPhase('busy')).toBe('busy');
  });
  it('materializing → dissolving (the button fade rides the curtain)', () => {
    expect(equipButtonPhase('materializing')).toBe('dissolving');
  });
  it('idle / done / fail / null → idle', () => {
    expect(equipButtonPhase('idle')).toBe('idle');
    expect(equipButtonPhase('done')).toBe('idle');
    expect(equipButtonPhase('fail')).toBe('idle');
    expect(equipButtonPhase(null)).toBe('idle');
  });
});
