/**
 * Pixel materialization — pure logic (no DOM, no React).
 *
 * Equip curtain: assemble 400ms → hold 100ms → dissolve 200ms (budget 700ms hard cap).
 * Import reveal: fly-in 350 → settle 200 → converge 150 → reveal 200 (900ms).
 * All timing is elapsed-driven (performance.now diffs), never frame-counted.
 */

// ── Constants ────────────────────────────────────────────────────────────────

export const CURTAIN_ASSEMBLE_MS = 400;
export const CURTAIN_HOLD_MS = 100;
export const CURTAIN_DISSOLVE_MS = 200;
export const EQUIP_CURTAIN_BUDGET = CURTAIN_ASSEMBLE_MS + CURTAIN_HOLD_MS + CURTAIN_DISSOLVE_MS; // 700

export const IMPORT_FLYIN_MS = 350;
export const IMPORT_SETTLE_MS = 200;
export const IMPORT_CONVERGE_MS = 150;
export const IMPORT_REVEAL_MS = 200;
export const IMPORT_REVEAL_BUDGET = IMPORT_FLYIN_MS + IMPORT_SETTLE_MS + IMPORT_CONVERGE_MS + IMPORT_REVEAL_MS; // 900

/** Mid-frame-interval above this median (with enough samples) aborts the curtain. */
export const SKIP_SAMPLE_WINDOW_MS = 200;
export const SKIP_MIN_SAMPLES = 3;
export const SKIP_MEDIAN_THRESHOLD_MS = 50;

// ── Seed (D7: sha1 first-8-hex → parseInt) ───────────────────────────────────

export function hashSeed(sha1: string): number {
  const first8 = sha1.slice(0, 8);
  const n = Number.parseInt(first8, 16);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

// ── Equip curtain phases ─────────────────────────────────────────────────────

export type CurtainPhaseName = 'assemble' | 'hold' | 'dissolve';

export interface CurtainPhase {
  name: CurtainPhaseName;
  /** 0..1 progress inside the current phase. */
  progress: number;
}

/** Scales the default 400/100/200 split to an arbitrary budget (assembles proportionally). */
function scaledSplit(budget: number): { assemble: number; hold: number; dissolve: number } {
  const s = budget / EQUIP_CURTAIN_BUDGET;
  return {
    assemble: CURTAIN_ASSEMBLE_MS * s,
    hold: CURTAIN_HOLD_MS * s,
    dissolve: CURTAIN_DISSOLVE_MS * s,
  };
}

export function curtainPhase(elapsed: number, budget = EQUIP_CURTAIN_BUDGET): CurtainPhase {
  const { assemble, hold, dissolve } = scaledSplit(budget);
  const e = Math.max(0, elapsed);
  if (e < assemble) {
    return { name: 'assemble', progress: assemble === 0 ? 1 : e / assemble };
  }
  if (e < assemble + hold) {
    const inner = e - assemble;
    return { name: 'hold', progress: hold === 0 ? 1 : inner / hold };
  }
  const inner = e - assemble - hold;
  return { name: 'dissolve', progress: dissolve === 0 ? 1 : Math.min(1, inner / dissolve) };
}

// ── Import reveal phases ─────────────────────────────────────────────────────

export type ImportPhaseName = 'flyin' | 'settle' | 'converge' | 'reveal';

export interface ImportPhase {
  name: ImportPhaseName;
  /** 0..1 progress inside the current phase. */
  progress: number;
}

export function importRevealPhase(elapsed: number, budget = IMPORT_REVEAL_BUDGET): ImportPhase {
  const s = budget / IMPORT_REVEAL_BUDGET;
  const flyin = IMPORT_FLYIN_MS * s;
  const settle = IMPORT_SETTLE_MS * s;
  const converge = IMPORT_CONVERGE_MS * s;
  const reveal = IMPORT_REVEAL_MS * s;
  const e = Math.max(0, elapsed);
  if (e < flyin) return { name: 'flyin', progress: flyin === 0 ? 1 : e / flyin };
  if (e < flyin + settle) return { name: 'settle', progress: settle === 0 ? 1 : (e - flyin) / settle };
  if (e < flyin + settle + converge) {
    return { name: 'converge', progress: converge === 0 ? 1 : (e - flyin - settle) / converge };
  }
  const inner = e - flyin - settle - converge;
  return { name: 'reveal', progress: reveal === 0 ? 1 : Math.min(1, inner / reveal) };
}

/** The import swap window starts exactly when `reveal` starts. */
export function importSwapWindowStart(budget = IMPORT_REVEAL_BUDGET): number {
  return (IMPORT_FLYIN_MS + IMPORT_SETTLE_MS + IMPORT_CONVERGE_MS) * (budget / IMPORT_REVEAL_BUDGET);
}

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Pixel grid ───────────────────────────────────────────────────────────────

export interface PixelGrid {
  /** Grid tiles across the hero box (may slightly over-cover rounded edges). */
  cols: number;
  rows: number;
  /** Tile size in CSS px. */
  tile: number;
}

export function computePixelGrid(width: number, height: number, srcSize = 64): PixelGrid {
  if (width <= 0 || height <= 0) return { cols: 0, rows: 0, tile: 0 };
  // One tile per source pixel axis, but never larger than 8 CSS px (keeps cost bounded).
  const tile = Math.max(1, Math.min(8, Math.ceil(Math.max(width / srcSize, height / srcSize))));
  return { cols: Math.ceil(width / tile), rows: Math.ceil(height / tile), tile };
}

// ── Deterministic scatter offsets ────────────────────────────────────────────

export interface ScatterOffsets {
  /** Horizontal offset in tiles (from the target tile position). */
  dx: number;
  /** Vertical offset in tiles. */
  dy: number;
  /** Rotation in radians (subtle, deterministic). */
  rot: number;
}

export const SCATTER_MAX_RADIUS_TILES = 6;

/** Same seed + same index → same offsets, always. */
export function computeScatterOffsets(index: number, seed: number): ScatterOffsets {
  const rand = mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);
  const angle = rand() * Math.PI * 2;
  const radius = 1 + rand() * (SCATTER_MAX_RADIUS_TILES - 1);
  const dx = Math.cos(angle) * radius;
  const dy = Math.sin(angle) * radius;
  const rot = (rand() - 0.5) * (Math.PI / 8); // ±11.25°
  return { dx, dy, rot };
}

/** Deterministic Fisher-Yates permutation of [0..n). Same seed → same order. */
export function buildShufflePermutation(n: number, seed: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed >>> 0);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

// ── Skip decision (D8: median-based, no evidence → no action) ────────────────

export function shouldSkipCurtain(reducedMotion: boolean, fpsSamples: number[]): boolean {
  if (reducedMotion) return true;
  if (fpsSamples.length < SKIP_MIN_SAMPLES) return false; // empty/insufficient samples → no skip
  const sorted = [...fpsSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return median > SKIP_MEDIAN_THRESHOLD_MS;
}

// ── Dissolve sweep geometry (D5: simple sweep clearRect, no per-pixel fade) ──

export interface SweepRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Vertical sweep band cleared at `progress` (0..1): full width, quarter-height
 * band centered on the moving frontier. Union over successive progress steps
 * covers the whole canvas; every rect is clamped inside [0, height].
 */
export function dissolveSweepGeometry(progress: number, width: number, height: number): SweepRect {
  const p = Math.min(1, Math.max(0, progress));
  const band = height * 0.25;
  const front = height * p;
  const start = Math.max(0, front - band / 2);
  const end = Math.min(height, front + band / 2);
  return { x: 0, y: start, w: width, h: Math.max(0, end - start) };
}

// ── Equip ceremony state machine (D6) ────────────────────────────────────────

export type CeremonyPhase = 'idle' | 'busy' | 'materializing' | 'done' | 'fail';

export type CeremonyEvent =
  | { type: 'EQUIP_START' } // user pressed the button
  | { type: 'EQUIP_SUCCESS' } // IPC succeeded → curtain begins
  | { type: 'SWAP_WINDOW' } // curtain hold start → remount hero
  | { type: 'CURTAIN_END' } // complete or skip resolved
  | { type: 'EQUIP_FAIL' }; // IPC failed — semantics unchanged

/** Pure transition: always returns a defined phase; unknown events are no-ops. */
export function equipCeremonyNext(phase: CeremonyPhase, event: CeremonyEvent): CeremonyPhase {
  switch (event.type) {
    case 'EQUIP_START':
      return phase === 'idle' || phase === 'done' ? 'busy' : phase;
    case 'EQUIP_SUCCESS':
      return phase === 'busy' ? 'materializing' : phase;
    case 'SWAP_WINDOW':
      return phase === 'materializing' ? 'materializing' : phase;
    case 'CURTAIN_END':
      return phase === 'materializing' ? 'done' : phase;
    case 'EQUIP_FAIL':
      return phase === 'busy' ? 'fail' : phase;
    default:
      return phase;
  }
}
