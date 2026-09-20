/**
 * Resolution materialization — pure logic (no DOM, no React).
 *
 * v1 (PixelCurtain: shuffled texture atlas → assemble → sweep dissolve) was
 * rejected in user acceptance: the assembled state is a flat skin atlas, which
 * reads as "a weird PNG appeared on screen", not "the character was born from
 * pixels". v2 law: the atlas is NEVER shown. The 3D character itself starts at
 * a very low resolution and climbs a discrete ladder to full resolution —
 * every frame is the real character, which is Minecraft-native (the game
 * itself is pixel art).
 *
 * Equip morph: 300ms button dissolve (existing, unchanged) runs in parallel
 * with a 520ms ladder → total wall time ≤700ms budget. Import reveal: ~900ms
 * ladder starting at 1/24 — a new skin is born, and both import paths
 * (file import and save-current) share it.
 *
 * All timing is elapsed-driven (performance.now diffs), never frame-counted.
 */

// ── Variants ─────────────────────────────────────────────────────────────────

/** Ladder variant: equip morph vs import reveal (shared API shape). */
export type MaterializeVariant = 'equip' | 'import';

// ── Ladders (discrete resolution steps — never interpolated) ────────────────

export const EQUIP_LADDER_MS = 65; // dwell per step
export const IMPORT_LADDER_MS = 75;

/**
 * Equip ladder, exactly as specified: 1/16 → 1/12 → 1/8 → 1/6 → 1/4 → 1/3 →
 * 1/2 → 3/4 → 1 (9 rungs, 8 steps × 65ms = 520ms to reach scale 1). The
 * parallel 300ms button dissolve fits inside the ≤700ms equip budget.
 */
export const EQUIP_LADDER: readonly number[] = [
  1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 3 / 4, 1,
];
/** Equip budget = elapsed time at which scale 1 is reached. */
export const EQUIP_MATERIALIZE_BUDGET = (EQUIP_LADDER.length - 1) * EQUIP_LADDER_MS; // 520

/**
 * Import ladder: same mechanism, starting at 1/24 with more rungs at ~75ms
 * each → 900ms. 13 geometric rungs from 1/24 to 1 (ratio 24^(1/12)), so the
 * perceived climb keeps a constant feel across the wider range.
 */
export const IMPORT_LADDER: readonly number[] = geometricRungs(1 / 24, 13);
/** Import budget = elapsed time at which scale 1 is reached. */
export const IMPORT_MATERIALIZE_BUDGET = (IMPORT_LADDER.length - 1) * IMPORT_LADDER_MS; // 900

function geometricRungs(start: number, count: number): number[] {
  const rungs: number[] = [];
  const ratio = Math.pow(1 / start, 1 / (count - 1));
  for (let i = 0; i < count - 1; i += 1) rungs.push(start * Math.pow(ratio, i));
  rungs.push(1); // the terminal rung is exactly 1 — never a rounding-off value
  return rungs;
}

/**
 * The discrete scale at `elapsed`. Returns rung values only (no interpolation):
 * each rung holds for budget/(rungs.length-1) ms, the value jumps at exact
 * step boundaries, elapsed ≥ budget → 1 (terminal), elapsed ≤ 0 → first rung.
 */
export function resolutionLadder(elapsed: number, budget: number, variant: MaterializeVariant): number {
  const rungs = variant === 'equip' ? EQUIP_LADDER : IMPORT_LADDER;
  const e = Math.max(0, elapsed);
  if (e >= budget) return 1;
  const steps = rungs.length - 1;
  const stepMs = budget / steps;
  const index = Math.min(steps - 1, Math.floor(e / stepMs));
  return rungs[index];
}

// ── Skip decision (median-based, no evidence → no action) ───────────────────

/** Frame-interval window in which fps samples are collected before deciding. */
export const SKIP_SAMPLE_WINDOW_MS = 200;
/** Median needs at least this many samples before a skip may fire. */
export const SKIP_MIN_SAMPLES = 3;
/** Median frame interval above this (with enough samples) aborts the ladder. */
export const SKIP_MEDIAN_THRESHOLD_MS = 50;

/**
 * Reduced motion always skips (no ladder, straight to full resolution).
 * Otherwise the ladder aborts only on evidence: ≥ SKIP_MIN_SAMPLES frame
 * intervals collected within the first SKIP_SAMPLE_WINDOW_MS whose median
 * exceeds SKIP_MEDIAN_THRESHOLD_MS. Insufficient samples → no skip.
 */
export function shouldSkipMaterialize(reducedMotion: boolean, fpsSamples: number[]): boolean {
  if (reducedMotion) return true;
  if (fpsSamples.length < SKIP_MIN_SAMPLES) return false; // empty/insufficient samples → no skip
  const sorted = [...fpsSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return median > SKIP_MEDIAN_THRESHOLD_MS;
}

// ── Button mapping ───────────────────────────────────────────────────────────

export type EquipButtonPhase = 'idle' | 'busy' | 'dissolving';

/** materializing maps to the button's 'dissolving' kind; busy stays busy; everything else → idle. */
export function equipButtonPhase(ceremony: CeremonyPhase | null): EquipButtonPhase {
  if (ceremony === 'busy') return 'busy';
  if (ceremony === 'materializing') return 'dissolving';
  return 'idle';
}

// ── Equip ceremony state machine ─────────────────────────────────────────────
// Carried over from v1 (the materializing extension was designed correctly —
// only the visual carrier changed from "curtain" to "ladder"). The failure
// path is untouched: busy → fail → red flash + "couldn't reach mojang.".

export type CeremonyPhase = 'idle' | 'busy' | 'materializing' | 'done' | 'fail';

export type CeremonyEvent =
  | { type: 'EQUIP_START' } // user pressed the button
  | { type: 'EQUIP_SUCCESS' } // IPC succeeded → ladder begins (the swap window IS this moment)
  | { type: 'MATERIALIZE_END' } // complete, skip, fps-guard, or replaced by a newer ceremony
  | { type: 'EQUIP_FAIL' }; // IPC failed — semantics unchanged

/**
 * Pure transition: always returns a defined phase; unknown events are no-ops.
 * v1's SWAP_WINDOW event is gone: in v2 the hero remount happens in the same
 * batch as EQUIP_SUCCESS (the character must be at the first rung from its
 * first visible frame — there is no curtain behind which to stage a swap).
 */
export function equipCeremonyNext(phase: CeremonyPhase, event: CeremonyEvent): CeremonyPhase {
  switch (event.type) {
    case 'EQUIP_START':
      return phase === 'idle' || phase === 'done' ? 'busy' : phase;
    case 'EQUIP_SUCCESS':
      return phase === 'busy' ? 'materializing' : phase;
    case 'MATERIALIZE_END':
      return phase === 'materializing' ? 'done' : phase;
    case 'EQUIP_FAIL':
      return phase === 'busy' ? 'fail' : phase;
    default:
      return phase;
  }
}
