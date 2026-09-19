import { useCallback, useEffect, useRef, useState } from 'react';

import {
  buildShufflePermutation,
  computePixelGrid,
  computeScatterOffsets,
  curtainPhase,
  dissolveSweepGeometry,
  EQUIP_CURTAIN_BUDGET,
  importRevealPhase,
  IMPORT_REVEAL_BUDGET,
  shouldSkipCurtain,
  SKIP_SAMPLE_WINDOW_MS,
  type PixelCurtainVariant,
} from '../../shared/pixel-curtain';

const SOURCE = 64; // skin texture is 64x64
const GROUND_FALLBACK = '#0b0a09';

export interface PixelCurtainProps {
  dataUrl: string;
  variant: PixelCurtainVariant;
  seed: number;
  /** equip: fired once at hold start; import: fired once at reveal start. */
  onSwapWindow: () => void;
  onComplete: () => void;
  onSkip: () => void;
}

/**
 * Container-level overlay above the hero portrait (inside the hero box,
 * never inside fx/). Draws the skin's own 64x64 pixels: shuffled into a
 * curtain for equip morphs, gathered from a deterministic scatter for
 * import reveals. Time-driven via requestAnimationFrame + performance.now
 * deltas, so backgrounding pauses naturally and resume converges on real
 * time. Any click (or load failure, or reduced motion, or a slow first
 * 200ms) skips straight to the end state with no second animation.
 */
export function PixelCurtain({ dataUrl, variant, seed, onSwapWindow, onComplete, onSkip }: PixelCurtainProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef(0);
  const startAtRef = useRef(0);
  const lastFrameRef = useRef(0);
  const fpsSamplesRef = useRef<number[]>([]);
  const fpsDecidedRef = useRef(false);
  const swappedRef = useRef(false);
  const finishedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const budget = variant === 'equip' ? EQUIP_CURTAIN_BUDGET : IMPORT_REVEAL_BUDGET;

  // Keep the latest callbacks in a ref so finish/skip stay identity-stable
  // even when the parent re-renders with inline handlers.
  const cbsRef = useRef({ onSwapWindow, onComplete, onSkip });
  cbsRef.current = { onSwapWindow, onComplete, onSkip };

  const finish = useCallback((viaSkip: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    cancelAnimationFrame(rafRef.current);
    if (!swappedRef.current) {
      swappedRef.current = true;
      cbsRef.current.onSwapWindow();
    }
    if (viaSkip) cbsRef.current.onSkip();
    else cbsRef.current.onComplete();
  }, []);

  const skip = useCallback(() => finish(true), [finish]);

  // Load the texture once; the curtain cannot start without it.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) {
        skip();
        return;
      }
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) skip();
    };
    img.src = dataUrl;
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [dataUrl, skip]);

  // Animation loop: starts only once the texture is ready.
  useEffect(() => {
    if (!ready) return;
    const ground = getGroundColor();
    const tick = (now: number) => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (startAtRef.current === 0) {
        startAtRef.current = now;
        lastFrameRef.current = now;
      }
      const elapsed = now - startAtRef.current;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

      // fps guard (D8): sample the first 200ms, then decide once.
      // Fewer than 3 samples or a fast median → no evidence, no skip.
      if (!fpsDecidedRef.current) {
        if (elapsed <= SKIP_SAMPLE_WINDOW_MS) {
          fpsSamplesRef.current.push(now - lastFrameRef.current);
        } else {
          fpsDecidedRef.current = true;
          if (shouldSkipCurtain(false, fpsSamplesRef.current)) {
            finish(true);
            return;
          }
        }
      }
      lastFrameRef.current = now;

      const fireSwap = () => {
        if (!swappedRef.current) {
          swappedRef.current = true;
          cbsRef.current.onSwapWindow();
        }
      };

      if (variant === 'equip') {
        const ph = curtainPhase(elapsed, budget);
        if (ph.name === 'assemble') {
          drawAssemble(ctx, img, cssW, cssH, ph.progress, seed, ground);
        } else if (ph.name === 'hold') {
          fireSwap();
          drawFull(ctx, img, cssW, cssH, ground);
        } else {
          fireSwap();
          drawFull(ctx, img, cssW, cssH, ground);
          const rect = dissolveSweepGeometry(ph.progress, cssW, cssH);
          ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
        }
      } else {
        const ph = importRevealPhase(elapsed, budget);
        if (ph.name === 'flyin') {
          drawFlyIn(ctx, img, cssW, cssH, ph.progress, seed, ground);
        } else {
          fireSwap();
          drawFull(ctx, img, cssW, cssH, ground);
        }
      }

      if (elapsed >= budget) {
        finish(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [budget, finish, onSwapWindow, ready, seed, variant]);

  return (
    <div
      className="absolute inset-0 z-20 cursor-pointer"
      style={{ background: groundStyleValue }}
      onClick={skip}
      data-testid="pixel-curtain"
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

const groundStyleValue = 'var(--ground)';

function getGroundColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
  return v || GROUND_FALLBACK;
}

/** Full-canvas crisp draw of the 64x64 texture — the curtain's final face. */
function drawFull(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  ground: string,
) {
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, SOURCE, SOURCE, 0, 0, w, h);
}

/**
 * Assemble: cells appear one by one in a seeded shuffle order; each cell
 * draws the source pixel it will hold in the final image, so the scattered
 * curtain coheres into the true texture.
 */
function drawAssemble(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  progress: number,
  seed: number,
  ground: string,
) {
  const grid = computePixelGrid(w, h, SOURCE);
  const total = grid.cols * grid.rows;
  if (total === 0) return;
  const visible = Math.max(1, Math.floor(progress * total));
  const order = buildShufflePermutation(total, seed);

  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < visible; k += 1) {
    const cell = order[k];
    const gx = cell % grid.cols;
    const gy = Math.floor(cell / grid.cols);
    const px = Math.min(SOURCE - 1, Math.floor((gx * SOURCE) / grid.cols));
    const py = Math.min(SOURCE - 1, Math.floor((gy * SOURCE) / grid.rows));
    ctx.drawImage(img, px, py, 1, 1, gx * grid.tile, gy * grid.tile, grid.tile + 0.5, grid.tile + 0.5);
  }
}

/** Fly-in: every cell starts at a deterministic scatter offset and lands home. */
function drawFlyIn(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  progress: number,
  seed: number,
  ground: string,
) {
  const grid = computePixelGrid(w, h, SOURCE);
  const total = grid.cols * grid.rows;
  if (total === 0) return;
  const eased = 1 - (1 - progress) * (1 - progress); // ease-out landing

  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, w, h);
  for (let cell = 0; cell < total; cell += 1) {
    const gx = cell % grid.cols;
    const gy = Math.floor(cell / grid.cols);
    const off = computeScatterOffsets(cell, seed);
    const tx = gx * grid.tile + off.dx * grid.tile * (1 - eased);
    const ty = gy * grid.tile + off.dy * grid.tile * (1 - eased);
    const px = Math.min(SOURCE - 1, Math.floor((gx * SOURCE) / grid.cols));
    const py = Math.min(SOURCE - 1, Math.floor((gy * SOURCE) / grid.rows));
    ctx.drawImage(img, px, py, 1, 1, tx, ty, grid.tile + 0.5, grid.tile + 0.5);
  }
}
