import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Color, DirectionalLight, PCFSoftShadowMap } from 'three';
import { SkinViewer } from 'skinview3d';
import { installStageRig, PlayerDirector, SKIN_CONFIG, STAGE_LIGHT_CONFIG } from './PlayerDirector';

/**
 * Reusable skin viewer — renders a Minecraft skin in 3D using skinview3d.
 *
 * Accepts an explicit skinUrl (data URL, HTTP URL, or blob URL) and model type.
 *
 * skinUrl tri-state:
 *   string    → that custom skin
 *   null      → the player has NO custom skin (confirmed): the bundled
 *               default Steve is shown instead — the viewer is never empty
 *   undefined → the skin is still being resolved: render nothing. This is
 *               what prevents Steve from flashing as a loading placeholder —
 *               when a custom skin exists, the first visible frame is it.
 *
 * A custom skin that fails to load/decode also falls back to Steve. The
 * fallback is display-only: nothing is persisted, no skin data is modified.
 *
 * Animation is owned by PlayerDirector (fx/PlayerDirector.ts): idle
 * breathing, pointer gaze, occasional glances, and the ignition posture +
 * amber light ramp. The director is created ONCE per viewer and reused
 * across skin loads — swapping the animation instance snaps the pose via
 * resetJoints(), so skin changes must never recreate it.
 *
 * Pointer tracking uses window-level listeners (never the canvas — it is
 * pointer-events-none) so the character watches the whole home screen.
 * Listeners are attached only when a director is live, and removed on
 * unmount — no duplicate loops after repeated navigation.
 *
 * Focus / visibility: the render loop pauses while the app window is
 * hidden or unfocused and resumes cleanly on return. skinview3d's
 * renderPaused re-arms its own RAF, so resume is one property flip.
 */

const STEVE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAdVBMVEUAAAAKvLwAzMwmGgokGAgrHg0zJBE/KhW3g2uzeV5SPYn///+qclmbY0mQWT8Af38AaGhVVVWUYD52SzOBUzmPXj5JJRBCHQp3QjVqQDA0JRIoKCg3Nzc/Pz9KSko6MYlBNZtGOqUDenoFiIgElZUApKQAr6/wvakZAAAAAXRSTlMAQObYZgAAAolJREFUeNrt1l1rHucZReFrj/whu5hSCCQtlOTE/f+/Jz4q9Cu0YIhLcFVpVg+FsOCVehi8jmZgWOzZz33DM4CXlum3gH95GgeAzQZVeL4gTm6Cbp4vqFkD8HwBazPY8wWbMq9utu3mNZ5fotVezbzOE3kBEFbaZuc8kb00NTMUbWJp678Xf2GV7RRtx1TDQQ6XBNvsmL2+2vHq1TftmMPIyAWujtN2cl274ua2jpVpZneXEjjo7XW1q53V9ds4ODO5xIuhvGHvfLI3aixauig415uuO2+vl9+cncfsFw25zL650fXn687jqnXuP68/X3+eV3zE7y6u9eB73MlfAcfbTf3yR8CfAX+if8S/H5/EAbAxj5LN48tULvEBOh8V1AageMTXe2YHAOwHbZxrzPkSR3+ffr8TR2JDzE/4Fj8CDgEwDsW+q+9GsR07hhg2CsALBgMo2v5wNxXnQXMeGQVW7gUAyKI2m6KDsJ8Au3++F5RZO+kKNQjQcLLWgjwUjBXLltFgWWMUUlviocBgNoxNGgMjSxiYAA7zgLFo2hgIENiDU8gQCzDOmViGFAsEuBcQSDCothhpJaDRA8E5fHqH2nTbYm5fHLo1V0u3B7DAuheoeScRYabjjjuzs17cHVaTrTXmK78m9swP34d9oK/dfeXSIH2PW/MXwPvxN/bJlxw8zlYAcEyeI6gNgA/O8P8neN8xe1IHP2gTzegjvhUDfuRygmwEs2GE4mkCDIAzm2R4yAuPsIdR9k8AvMc+3L9+2UEjo4WP0FpgP19O0MzCsqxIoMsdDBvYcQyGmO0ZJRoYCKjLJWY0BAhYwGUBCgkh8MRdOKt+ruqMwAB2OcEX94U1TPbYJP0PkyyAI1S6cSIAAAAASUVORK5CYII=';

let steveImagePromise: Promise<HTMLImageElement> | null = null;
function getSteveImage(): Promise<HTMLImageElement> {
  if (!steveImagePromise) {
    steveImagePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = STEVE_DATA_URL;
    });
  }
  return steveImagePromise;
}

const FINAL_YAW = -0.30; // product-shot three-quarter angle (~-17°); mirrors IDLE_CONFIG.yawBase

interface SkinViewerProps {
  /** Tri-state: string = custom skin; null = confirmed no custom skin
   *  (bundled default Steve); undefined = still resolving (render nothing —
   *  never flash Steve as a loading placeholder). */
  skinUrl?: string | null;
  model?: 'slim' | 'default';
  energetic?: boolean;
  /** Shown only while the skin is unresolved (undefined). Default null —
   *  render nothing (the Play stage stays clean). */
  emptyLabel?: string | null;
  /**
   * Identity Studio only: enable orbit drag-rotation (skinview3d's own
   * OrbitControls — zoom/pan stay off) and give the canvas pointer events.
   * Default false: the Play stage keeps its pointer-events-none ambience.
   * Gaze (window-level head tracking) is unchanged either way.
   */
  interactive?: boolean;
  /** Fires once on the first orbit-drag start — the "drag to rotate" hint
   *  fade-out hook. Only meaningful with interactive. */
  onOrbitStart?: () => void;
  /**
   * Resolution materialization seam (v2). Default 1 = the exact default
   * behavior, byte-for-byte: this component then touches nothing. When < 1,
   * the canvas renders at backing store = CSS size × dpr × scale while the
   * CSS box stays full-size and image-rendering: pixelated upscales it —
   * a genuine low-resolution 3D character (Minecraft-native pixel look).
   * Only setSize-level operations are used (viewer.setSize → renderer +
   * composer + FXAA uniforms in one step); the renderer is never rebuilt,
   * and PlayerDirector, gaze, orbit and stage calibration are untouched.
   * Authorized in docs/project-truth/19 (v2 record), same protocol as
   * interactive/onOrbitStart: minimal, default-off, user-directed.
   */
  materializeScale?: number;
}
const SkinViewerCanvas: React.FC<SkinViewerProps> = ({
  skinUrl,
  model = 'default',
  energetic = false,
  emptyLabel = null,
  interactive = false,
  onOrbitStart,
  materializeScale = 1,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<PlayerDirector | null>(null);
  const reducedRef = useRef(false);
  const viewerRef = useRef<SkinViewer | null>(null);
  // Mirrors the IntersectionObserver state inside the init effect: true only
  // while the stage wrapper actually intersects the viewport. display:none
  // parents (keep-alive navigation) report isIntersecting: false.
  const ioVisibleRef = useRef(true);
  // Resolution materialization seam state (see materializeScale prop doc).
  // appliedScaleRef starts at 1 because the constructor already applied the
  // full default size — so a default (1) prop performs no work at all.
  const materializeScaleRef = useRef(1);
  const appliedScaleRef = useRef(1);
  const [ready, setReady] = useState(false);

  /**
   * Apply a materialization scale with a single viewer.setSize() call —
   * the one operation that updates renderer size (backing store = CSS × dpr ×
   * scale), camera aspect (ratio unchanged: the scale is uniform) and the
   * composer/FXAA uniforms together. The CSS box is then pinned back to
   * 100%/100% so the browser upscales the small backing store with
   * image-rendering: pixelated. Restoring scale 1 calls setSize with the
   * wrapper's client size, which reproduces exactly what the default path
   * sets (size, inline style) — then clears the pixelated hint.
   */
  const applyMaterializeScale = useCallback((scale: number) => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const viewer = viewerRef.current;
    if (!wrap || !canvas || !viewer) return;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    if (scale >= 1) {
      viewer.setSize(cssW, cssH);
      canvas.style.imageRendering = '';
      return;
    }
    const s = Math.max(1 / 64, Math.min(1, scale));
    viewer.setSize(Math.max(1, Math.round(cssW * s)), Math.max(1, Math.round(cssH * s)));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.imageRendering = 'pixelated';
  }, []);

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
      // Stage framing (STAGE_LIGHT_CONFIG): the stock 0.92 crops the feet
      // below the frame — no floor/shadow could ever show. 0.80 + the rig's
      // playerWrapper lift keeps feet + a thin floor strip in frame.
      zoom: STAGE_LIGHT_CONFIG.stageZoom,
    });
    viewerRef.current = viewer;
    // STRUCTURAL INVARIANT: the canvas CSS box is always exactly the
    // wrapper's box (h-full/w-full). skinview3d's constructor just wrote
    // inline px from the width/height measured above — but a mount observed
    // mid-layout (keep-alive remount, 150-card shelf hydration, CPU
    // throttling) measures a TRANSIENT box, and those inline px then outlive
    // it, letting the canvas dangle over content below it (caught by the
    // mod-hoarder layout audit as `covered: equip by CANVAS`). Pinning 100%
    // binds the paint box to whatever the wrapper actually is; the
    // ResizeObserver below still drives the BACKING STORE to the measured
    // size. Same pin the materialize path applies after every setSize.
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    // Diagnostic handle — required by the mu-verify CDP harness
    // (anim-diag.mjs exits without it; there is no DOM path to the
    // SkinViewer/three.js instances). Kept intentionally.
    (window as unknown as { __skinViewer?: SkinViewer }).__skinViewer = viewer;

    viewer.controls.enableRotate = false;
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;

    viewer.globalLight.intensity = SKIN_CONFIG.globalIntensity;
    viewer.globalLight.color.set(SKIN_CONFIG.globalColor);
    viewer.cameraLight.intensity = SKIN_CONFIG.cameraIntensity;

    // ── Stage rig (visual lab 004): planted floor + sub-dominant stage
    // spotlight + black fog cyclorama ──
    // Renderer-level shadow kill switch: with shadowMap OFF, NO light — pool,
    // skinview3d's built-in camera/global lights, anything — can project a
    // shadow, so the canvas-edge-cut shadow bug is impossible by construction.
    // PCFSoft + the per-light shadow config stay in place for a cheap re-enable.
    viewer.renderer.shadowMap.enabled = false;
    viewer.renderer.shadowMap.type = PCFSoftShadowMap; // moot while disabled
    // ── TRANSPARENT ROOM (pass 028) ──────────────────────────────────────
    // skinview3d's context already has alpha:true. Clearing with alpha 0, plus
    // scene.background = null in the rig, makes every pixel the scene does not
    // paint genuinely see-through — so the PAGE, and the SideRays field mounted
    // behind this canvas, ARE the room. That is what removes the visible black
    // rectangle rather than trying to colour-match it to the page.
    // The clear COLOUR keeps the room's own RGB at alpha 0, so if any pipeline
    // step ever flattens alpha the result degrades to the previous look instead
    // of to pure black.
    viewer.renderer.setClearColor(new Color(STAGE_LIGHT_CONFIG.roomColor), 0);
    const rig = installStageRig(viewer as unknown as Parameters<typeof installStageRig>[0]);

    // The character casts the shadow: every skin mesh, both layers. Set once
    // here — loadSkin() only swaps textures, the PlayerObject persists, so
    // these flags survive every skin/model change. Layer 1 (layer 0 stays
    // enabled by default) opts the player meshes into the character-only key
    // light — the floor must never receive the key's wide cone.
    viewer.playerObject.traverse((obj) => {
      obj.castShadow = true;
      obj.layers.enable(1);
    });

    // Soft rim/separation light: edges the back-left silhouette against the
    // dark background so the character never melts into it (see SKIN_CONFIG).
    // LOW and nearly horizontal on purpose: a high rim grazes the floor at a
    // steep angle and washes the whole plane — un-darkening the room the key
    // keeps black. Owned by the scene; the director ramps it (never
    // retargets position).
    const rim = new DirectionalLight(SKIN_CONFIG.rimColor, SKIN_CONFIG.rimIntensity);
    rim.position.set(-36, 16, -62);
    viewer.scene.add(rim);

    if (reduced) {
      viewer.playerObject.rotation.y = FINAL_YAW;
      viewer.renderPaused = true; // static product shot, no loop at all
    } else {
      // The one long-lived director: idle + gaze + glance + ignition in a
      // single animation instance, so nothing fights over the bones and
      // `viewer.animation` is never swapped (that setter snaps the pose).
      // The canvas is passed for cursor→head gaze (canvas-rect NDC mapping).
      // Stage key + pool ride the director's damped ignition ramp (fill
      // removed with the Stage 10 regime — passed as null to keep the slot).
      const director = new PlayerDirector(
        {
          global: viewer.globalLight, camera: viewer.cameraLight, rim,
          key: rig.key, pool: rig.pool, atmosphere: rig.atmosphere, fill: null,
          // The in-canvas atmosphere rides the director's ramp so the room warms
          // on ignition — inside the scene, where it belongs (ATMOSPHERE_CONFIG).
        },
        canvas,
      );
      viewer.animation = director;
      animRef.current = director;
      // Diagnostic handle — required by the mu-verify CDP harness
      // (anim-diag.mjs gaze/energetic probes drive the director through it).
      (window as unknown as { __skinDirector?: PlayerDirector }).__skinDirector = director;
    }

    const ro = new ResizeObserver(() => {
      if (!wrapRef.current) return;
      // During a materialization the wrapper resize must not restore the full
      // backing store — re-apply the current scale instead (same operation).
      if (materializeScaleRef.current < 1) {
        applyMaterializeScale(materializeScaleRef.current);
        return;
      }
      viewer.width = wrapRef.current.clientWidth;
      viewer.height = wrapRef.current.clientHeight;
      // Re-pin the CSS box: setSize() wrote fresh inline px from the
      // measurement; the box must stay 100% (see the constructor invariant).
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    });
    ro.observe(wrap);

    // ── Focus / visibility power saving (§37–38) ─────────────────────────
    // Pause the render loop entirely while hidden or unfocused; resume
    // cleanly on return (renderPaused re-arms the internal RAF). The pose
    // continues from where it was — the director clamps frame deltas, so
    // no lurch.
    // keep-alive note: with the Play view now hidden via CSS (App renders
    // all views with display:none) the app window stays visible and
    // focused, so the document-level signals below never fire. An
    // IntersectionObserver on the wrapper is the element-level gate that
    // actually notices display:none and pauses the loop off-screen.
    const pauseIfInactive = () => {
      if (reduced) return;
      viewer.renderPaused = document.hidden || !document.hasFocus() || !ioVisibleRef.current;
    };
    const io = new IntersectionObserver(([entry]) => {
      ioVisibleRef.current = entry.isIntersecting;
      pauseIfInactive();
    });
    io.observe(wrap);
    document.addEventListener('visibilitychange', pauseIfInactive);
    window.addEventListener('blur', pauseIfInactive);
    window.addEventListener('focus', pauseIfInactive);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', pauseIfInactive);
      window.removeEventListener('blur', pauseIfInactive);
      window.removeEventListener('focus', pauseIfInactive);
      ro.disconnect();
      animRef.current = null;
      rig.remove(); // stage floor + key + fill die with the viewer
      viewer.scene.remove(rim); // rim light dies with the viewer, not the scene graph
      // Clear diagnostic handles so unmount never leaves stale references.
      delete (window as unknown as { __skinViewer?: SkinViewer }).__skinViewer;
      delete (window as unknown as { __skinDirector?: PlayerDirector }).__skinDirector;
      // skinview3d's dispose() reads `this.fxaaPass.fsQuad.dispose()` at the
      // very end, but three r185 renamed ShaderPass.fsQuad → _fsQuad (private).
      // Bridge the rename so dispose cannot throw during unmount — a throw
      // here would crash React's commit phase and blank the whole app.
      const fxaaPass = viewer.fxaaPass as unknown as { fsQuad?: { dispose(): void }; _fsQuad?: { dispose(): void } };
      if (fxaaPass.fsQuad === undefined && fxaaPass._fsQuad) {
        Object.defineProperty(fxaaPass, 'fsQuad', { get: () => fxaaPass._fsQuad });
      }
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ── Pointer gaze (§14–16) ──────────────────────────────────────────────
  // Window-level: the character watches the whole home screen, not just
  // its own canvas. Head tracking only — the camera never moves (§43),
  // because viewer controls (rotate/zoom/pan) are disabled and the
  // director rotates bones directly.
  useEffect(() => {
    const anim = animRef.current;
    if (!anim) return; // reduced-motion: no tracking, no listeners

    // Raw client coords only — normalization (canvas-rect NDC, Y inversion,
    // deadzone) lives inside the director's animation loop, not here.
    const onMove = (e: MouseEvent) => {
      anim.setPointer(e.clientX, e.clientY);
    };
    const onLeave = () => { if (animRef.current) animRef.current.clearPointer(); };

    window.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
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

  // ── Interactive orbit (Identity Studio) ────────────────────────────────
  // Flips skinview3d's own OrbitControls rotate flag — the minimal touch the
  // studio needs for drag-rotate. Reduced-motion keeps the static pose (the
  // render loop is paused, so orbiting a paused canvas shows nothing).
  const onOrbitStartRef = useRef(onOrbitStart);
  useEffect(() => {
    onOrbitStartRef.current = onOrbitStart;
  }, [onOrbitStart]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const enabled = interactive && !reducedRef.current;
    viewer.controls.enableRotate = enabled;
    if (!enabled) return;
    const onStart = () => onOrbitStartRef.current?.();
    viewer.controls.addEventListener('start', onStart);
    return () => viewer.controls.removeEventListener('start', onStart);
  }, [interactive]);

  // ── Resolution materialization seam (default-off) ───────────────────
  // Mirror the prop into a ref, then apply on change. materializeScale === 1
  // (the default) is a no-op: appliedScaleRef already starts at 1, so not a
  // single setSize/style call is made on the default path.
  useEffect(() => {
    materializeScaleRef.current = materializeScale;
    if (materializeScale === appliedScaleRef.current) return;
    appliedScaleRef.current = materializeScale;
    applyMaterializeScale(materializeScale);
  }, [materializeScale, applyMaterializeScale]);

  // Load skin when skinUrl or model changes.
  // undefined = unresolved (stay hidden); null = confirmed no custom skin
  // (bundled Steve, always 'default' arms); string = that custom skin, with
  // Steve as the display fallback if it fails to load/decode.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (skinUrl === undefined) { setReady(false); return; }
    if (!viewer) return;

    const isFallback = skinUrl === null;
    let cancelled = false;
    setReady(false);

    const reveal = () => {
      if (cancelled) return;
      // The director is never recreated here — `viewer.animation` only
      // accepts a new instance by snapping resetJoints(). Same instance
      // assignment is a no-op in the setter, so the pose continues
      // seamlessly across skin swaps.
      // First visible frame → the character greets the user (one-shot).
      animRef.current?.onShown();
      // Reduced-motion: renderPaused cancelled the RAF before the FIRST
      // frame, so without this one-shot paint the static path shows an
      // empty canvas. Paint exactly one fully-lit product shot per skin
      // load — no loop, no motion (Phase 20: reduced ≠ broken/invisible).
      if (reducedRef.current) viewer.render();
      setReady(true);
    };

    const load = async () => {
      try {
        const steveImg = await getSteveImage();
        if (cancelled) return;
        const target = isFallback ? steveImg : skinUrl!;
        const targetModel = isFallback ? 'default' : model;

        try {
          await Promise.resolve(viewer.loadSkin(target, { model: targetModel }));
          reveal();
        } catch (err) {
          if (cancelled) return;
          console.warn('[skin-viewer] skin load failed:', err);
          if (isFallback) return;
          console.warn('[skin-viewer] falling back to default skin (display-only)');
          await Promise.resolve(viewer.loadSkin(steveImg, { model: 'default' }));
          reveal();
        }
      } catch (err) {
        console.warn('[skin-viewer] default Steve image load failed:', err);
      }
    };

    load();

    return () => { cancelled = true; };
  }, [skinUrl, model]);

  // One stable tree: the canvas is ALWAYS mounted. (History: a previous
  // version returned a different tree — no <canvas> — while the skin was
  // unresolved, but the viewer-init effect runs once at mount before the
  // skin arrives, so no viewer was ever created and renders stayed blank.)
  return (
    <div
      ref={wrapRef}
      className={`relative h-full w-full ${interactive ? '' : 'pointer-events-none'}`}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full transition-opacity duration-scene ease-exit"
        style={{ opacity: ready && skinUrl !== undefined ? 1 : 0 }}
      />
      {skinUrl === undefined && emptyLabel && (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-faint">
          {emptyLabel}
        </span>
      )}
    </div>
  );
};

export default memo(SkinViewerCanvas);
