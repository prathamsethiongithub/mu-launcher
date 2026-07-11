import React, { memo, useEffect, useRef, useState } from 'react';
import { SkinViewer, IdleAnimation, PlayerObject } from 'skinview3d';
import { DirectionalLight } from 'three';

/**
 * Reusable skin viewer — renders a Minecraft skin in 3D using skinview3d.
 *
 * Accepts an explicit skinUrl (data URL, HTTP URL, or blob URL) and model type.
 * If skinUrl is not provided, renders nothing (graceful empty state).
 *
 * Preserves the animation, lighting, and camera behavior from PlayerIdentity.
 */

const FINAL_YAW = -0.38;      // product-shot three-quarter angle (~-22°)
const YAW_SWING = 0.14;       // idle breathing ±8°
const BREATH_FREQ = 0.36;     // ~9s cycle with multiplier
const IDLE_TEMPO = 0.6;       // inner IdleAnimation speed
const ENERGETIC_MULT = 1.9;   // launch quickens idle

class PlayerIdle extends IdleAnimation {
  energetic = false;
  private timeOrigin = 0;

  override animate(player: PlayerObject): void {
    if (this.timeOrigin === 0) this.timeOrigin = performance.now();
    const realSeconds = (performance.now() - this.timeOrigin) / 1000;

    const speed = this.energetic ? ENERGETIC_MULT : 1;
    const it = realSeconds * speed;

    this.progress = it * IDLE_TEMPO;
    super.animate(player);

    player.rotation.y = FINAL_YAW + Math.sin(it * IDLE_TEMPO * BREATH_FREQ * 3.2) * YAW_SWING;
  }
}

interface SkinViewerProps {
  skinUrl?: string | null;
  model?: 'slim' | 'default';
  energetic?: boolean;
  /** Shown when no skin is available. Default null — render nothing (the
   *  Play stage must stay clean; only the studio labels its empty state). */
  emptyLabel?: string | null;
}

const SkinViewerCanvas: React.FC<SkinViewerProps> = ({
  skinUrl,
  model = 'default',
  energetic = false,
  emptyLabel = null,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<PlayerIdle | null>(null);
  const reducedRef = useRef(false);
  const viewerRef = useRef<SkinViewer | null>(null);
  const [ready, setReady] = useState(false);

  // Init viewer once
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    reducedRef.current = reduced;

    const viewer = new SkinViewer({
      canvas,
      width: wrap.clientWidth,
      height: wrap.clientHeight,
      fov: 28,
      zoom: 0.92,
    });
    viewerRef.current = viewer;

    viewer.controls.enableRotate = false;
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;

    viewer.globalLight.intensity = 1.5;
    viewer.globalLight.color.set('#d9cbb8');
    viewer.cameraLight.intensity = 0.35;
    try {
      const scene = viewer.scene as unknown as { add(o: object): void };
      const rimKey = new DirectionalLight(0xffb224, 5.0);
      rimKey.position.set(-2.2, 2.4, -3.0);
      const rimFill = new DirectionalLight(0xe38330, 2.4);
      rimFill.position.set(2.6, 0.8, -2.2);
      scene.add(rimKey);
      scene.add(rimFill);
    } catch (err) {
      console.warn('[skin-viewer] rim lights unavailable (non-fatal):', err);
    }

    if (reduced) {
      viewer.playerObject.rotation.y = FINAL_YAW;
    }

    const ro = new ResizeObserver(() => {
      if (!wrapRef.current) return;
      viewer.width = wrapRef.current.clientWidth;
      viewer.height = wrapRef.current.clientHeight;
    });
    ro.observe(wrap);

    return () => {
      ro.disconnect();
      animRef.current = null;
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Track energetic in a ref so the load effect never needs it as a dep
  const energeticRef = useRef(energetic);
  useEffect(() => {
    energeticRef.current = energetic;
    if (animRef.current && !reducedRef.current) {
      animRef.current.energetic = energetic;
    }
  }, [energetic]);

  // Load skin when skinUrl or model changes
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!skinUrl) { setReady(false); return; }
    if (!viewer) return;

    let cancelled = false;
    setReady(false);

    viewer.loadSkin(skinUrl, { model }).then(() => {
      if (cancelled) return;
      if (!reducedRef.current) {
        const anim = new PlayerIdle();
        anim.energetic = energeticRef.current;
        viewer.animation = anim;
        animRef.current = anim;
      }
      setReady(true);
    }).catch((err) => {
      console.warn('[skin-viewer] skin load failed:', err);
    });

    return () => { cancelled = true; };
  }, [skinUrl, model]);

  // One stable tree: the canvas is ALWAYS mounted. The previous version
  // returned a different tree (no <canvas>) while skinUrl was null — but the
  // viewer-init effect runs once, on mount, when the skin hasn't arrived yet
  // (it always arrives async over IPC). It bailed on the missing canvas and
  // no viewer was ever created, so every skin render stayed blank. That was
  // the root cause of the missing hero character.
  return (
    <div ref={wrapRef} className="pointer-events-none relative h-full w-full" aria-hidden>
      <canvas
        ref={canvasRef}
        className="h-full w-full transition-opacity duration-scene ease-exit"
        style={{ opacity: ready && skinUrl ? 1 : 0 }}
      />
      {!skinUrl && emptyLabel && (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-faint">
          {emptyLabel}
        </span>
      )}
    </div>
  );
};

export default memo(SkinViewerCanvas);