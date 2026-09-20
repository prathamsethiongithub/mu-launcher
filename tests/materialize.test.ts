import { describe, it, expect } from 'vitest';
import {
  EQUIP_LADDER,
  EQUIP_LADDER_MS,
  EQUIP_MATERIALIZE_BUDGET,
  IMPORT_LADDER,
  IMPORT_LADDER_MS,
  IMPORT_MATERIALIZE_BUDGET,
  resolutionLadder,
  shouldSkipMaterialize,
  equipCeremonyNext,
  equipButtonPhase,
  SKIP_SAMPLE_WINDOW_MS,
  SKIP_MIN_SAMPLES,
  SKIP_MEDIAN_THRESHOLD_MS,
} from '../src/shared/materialize';

// ── ladder constants ─────────────────────────────────────────────────────────

describe('equip ladder', () => {
  it('is exactly the specified rungs 1/16 → 3/4 → 1', () => {
    expect(EQUIP_LADDER).toEqual([1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 3 / 4, 1]);
  });
  it('budget = 8 steps × 65ms = 520 (inside the ≤700ms equip budget)', () => {
    expect(EQUIP_LADDER_MS).toBe(65);
    expect(EQUIP_MATERIALIZE_BUDGET).toBe(520);
    expect(EQUIP_MATERIALIZE_BUDGET).toBeLessThanOrEqual(700);
  });
});

describe('import ladder', () => {
  it('starts at 1/24 and terminates at exactly 1', () => {
    expect(IMPORT_LADDER[0]).toBeCloseTo(1 / 24, 12);
    expect(IMPORT_LADDER[IMPORT_LADDER.length - 1]).toBe(1);
  });
  it('has more rungs than equip (spec: 级数更多), at ~75ms each → ~900ms', () => {
    expect(IMPORT_LADDER.length).toBeGreaterThan(EQUIP_LADDER.length);
    expect(IMPORT_LADDER_MS).toBe(75);
    expect(IMPORT_MATERIALIZE_BUDGET).toBe(900); // 12 steps × 75ms
  });
  it('is strictly increasing and never exceeds 1', () => {
    for (let i = 1; i < IMPORT_LADDER.length; i += 1) {
      expect(IMPORT_LADDER[i]).toBeGreaterThan(IMPORT_LADDER[i - 1]);
      expect(IMPORT_LADDER[i]).toBeLessThanOrEqual(1);
    }
  });
});

// ── resolutionLadder ─────────────────────────────────────────────────────────

describe('resolutionLadder boundaries (equip)', () => {
  it('elapsed 0 → first rung 1/16', () => {
    expect(resolutionLadder(0, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 16);
  });
  it('negative elapsed clamps to the first rung', () => {
    expect(resolutionLadder(-5, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 16);
  });
  it('one microsecond before a boundary still holds the lower rung (discrete, no interpolation)', () => {
    // boundary 1 = 65ms → 1/12; boundary 3 = 195ms → 1/6
    expect(resolutionLadder(64.999, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 16);
    expect(resolutionLadder(194.999, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 8);
  });
  it('an exact step boundary jumps to the next rung', () => {
    expect(resolutionLadder(65, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 12);
    expect(resolutionLadder(130, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 8);
    expect(resolutionLadder(195, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 6);
    expect(resolutionLadder(325, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1 / 3);
    expect(resolutionLadder(455, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(3 / 4);
  });
  it('mid-interval values are always exact rung values (never between rungs)', () => {
    const rungs = new Set(EQUIP_LADDER);
    for (let t = 0; t < EQUIP_MATERIALIZE_BUDGET; t += 7) {
      expect(rungs.has(resolutionLadder(t, EQUIP_MATERIALIZE_BUDGET, 'equip'))).toBe(true);
    }
  });
  it('budget reached → 1 (terminal)', () => {
    expect(resolutionLadder(EQUIP_MATERIALIZE_BUDGET, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1);
  });
  it('timeout beyond budget stays at 1', () => {
    expect(resolutionLadder(800, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1);
    expect(resolutionLadder(Number.POSITIVE_INFINITY, EQUIP_MATERIALIZE_BUDGET, 'equip')).toBe(1);
  });
  it('scaled budget redistributes step dwell evenly', () => {
    // half budget → steps of 32.5ms
    expect(resolutionLadder(32.4, 260, 'equip')).toBe(1 / 16);
    expect(resolutionLadder(32.5, 260, 'equip')).toBe(1 / 12);
    expect(resolutionLadder(260, 260, 'equip')).toBe(1);
  });
});

describe('resolutionLadder boundaries (import)', () => {
  it('elapsed 0 → first rung 1/24', () => {
    expect(resolutionLadder(0, IMPORT_MATERIALIZE_BUDGET, 'import')).toBeCloseTo(1 / 24, 12);
  });
  it('negative elapsed clamps to the first rung', () => {
    expect(resolutionLadder(-1, IMPORT_MATERIALIZE_BUDGET, 'import')).toBeCloseTo(1 / 24, 12);
  });
  it('step boundaries jump at 75ms cadence', () => {
    expect(resolutionLadder(74.999, IMPORT_MATERIALIZE_BUDGET, 'import')).toBeCloseTo(1 / 24, 12);
    expect(resolutionLadder(75, IMPORT_MATERIALIZE_BUDGET, 'import')).toBeCloseTo(IMPORT_LADDER[1], 12);
    expect(resolutionLadder(825, IMPORT_MATERIALIZE_BUDGET, 'import')).toBeCloseTo(IMPORT_LADDER[11], 12);
  });
  it('budget reached / timeout → exactly 1', () => {
    expect(resolutionLadder(IMPORT_MATERIALIZE_BUDGET, IMPORT_MATERIALIZE_BUDGET, 'import')).toBe(1);
    expect(resolutionLadder(2000, IMPORT_MATERIALIZE_BUDGET, 'import')).toBe(1);
  });
});

// ── shouldSkipMaterialize ────────────────────────────────────────────────────

describe('shouldSkipMaterialize', () => {
  it('constants', () => {
    expect(SKIP_SAMPLE_WINDOW_MS).toBe(200);
    expect(SKIP_MIN_SAMPLES).toBe(3);
    expect(SKIP_MEDIAN_THRESHOLD_MS).toBe(50);
  });
  it('reduced motion always skips (no ladder, straight to full resolution)', () => {
    expect(shouldSkipMaterialize(true, [])).toBe(true);
    expect(shouldSkipMaterialize(true, [5, 5, 5])).toBe(true);
  });
  it('empty samples → no skip (no evidence, no action)', () => {
    expect(shouldSkipMaterialize(false, [])).toBe(false);
  });
  it('fewer than 3 samples → no skip', () => {
    expect(shouldSkipMaterialize(false, [60])).toBe(false);
    expect(shouldSkipMaterialize(false, [60, 60])).toBe(false);
  });
  it('median > 50ms with ≥3 samples → skip', () => {
    expect(shouldSkipMaterialize(false, [60, 60, 60])).toBe(true);
    expect(shouldSkipMaterialize(false, [10, 60, 80])).toBe(true); // median 60
  });
  it('median ≤ 50ms → no skip', () => {
    expect(shouldSkipMaterialize(false, [16, 17, 16])).toBe(false);
    expect(shouldSkipMaterialize(false, [10, 49, 200])).toBe(false); // median 49
  });
  it('resists a single frame spike (median, not mean/max)', () => {
    expect(shouldSkipMaterialize(false, [16, 200, 16])).toBe(false);
    expect(shouldSkipMaterialize(false, [16, 16, 16, 200])).toBe(false);
    expect(shouldSkipMaterialize(false, [16, 16, 16, 200, 200])).toBe(false);
    expect(shouldSkipMaterialize(false, [16, 16, 200, 200, 200])).toBe(true);
  });
  it('even-length samples use the true median (≥3 samples)', () => {
    expect(shouldSkipMaterialize(false, [40, 60, 60, 80])).toBe(true); // median 60 > 50
    expect(shouldSkipMaterialize(false, [30, 40, 50, 60])).toBe(false); // median 45 ≤ 50
  });
});

// ── equipCeremonyNext ────────────────────────────────────────────────────────

describe('equipCeremonyNext', () => {
  it('happy path: idle → busy → materializing → done', () => {
    let p = equipCeremonyNext('idle', { type: 'EQUIP_START' });
    expect(p).toBe('busy');
    p = equipCeremonyNext(p, { type: 'EQUIP_SUCCESS' });
    expect(p).toBe('materializing');
    p = equipCeremonyNext(p, { type: 'MATERIALIZE_END' });
    expect(p).toBe('done');
  });
  it('done re-arms via EQUIP_START', () => {
    expect(equipCeremonyNext('done', { type: 'EQUIP_START' })).toBe('busy');
  });
  it('fail path: busy → fail, semantics unchanged from v1', () => {
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
  it('MATERIALIZE_END ignored outside materializing', () => {
    expect(equipCeremonyNext('busy', { type: 'MATERIALIZE_END' })).toBe('busy');
    expect(equipCeremonyNext('done', { type: 'MATERIALIZE_END' })).toBe('done');
    expect(equipCeremonyNext('fail', { type: 'MATERIALIZE_END' })).toBe('fail');
  });
  it('MATERIALIZE_END is idempotent once done (never re-enters)', () => {
    const p = equipCeremonyNext('done', { type: 'MATERIALIZE_END' });
    expect(equipCeremonyNext(p, { type: 'MATERIALIZE_END' })).toBe('done');
  });
});

describe('equipButtonPhase mapping', () => {
  it('busy → busy (in-flight pulse)', () => {
    expect(equipButtonPhase('busy')).toBe('busy');
  });
  it('materializing → dissolving (the button fade rides the ladder)', () => {
    expect(equipButtonPhase('materializing')).toBe('dissolving');
  });
  it('idle / done / fail / null → idle', () => {
    expect(equipButtonPhase('idle')).toBe('idle');
    expect(equipButtonPhase('done')).toBe('idle');
    expect(equipButtonPhase('fail')).toBe('idle');
    expect(equipButtonPhase(null)).toBe('idle');
  });
});
