import React, { memo, useEffect, useState } from 'react';
import LightPillar from './LightPillar';

/**
 * The world-beacon — the presence of the SMP behind the player.
 *
 * One wrap-around amber firewall: the React Bits LightPillar (owner config,
 * #c88735), inside a dedicated atmosphere region that WRAPS the character's
 * opaque stage canvas — glow above the head and beside the silhouette, so
 * the firewall reads as behind the character without ever touching a canvas
 * pixel. It is atmosphere, never UI (DESIGN.md §8): pointer-transparent,
 * layout-neutral, screen-blended, and masked to a soft window
 * (.pillar-window in index.css) that dissolves into the near-black room on
 * all four sides — clear of the header, gone before the h1/CTA.
 *
 * LIGHTING OWNERSHIP IS SACRED (three separate layers):
 *   ambient character lighting → the stage canvas (untouched skin palette)
 *   real stage spotlight       → the stage canvas (floor pool + shadow, untouched)
 *   this firewall              → THIS layer only, strictly behind the canvas
 *
 * The stage canvas is opaque and z-stacked above this layer (z-0 vs z-10),
 * so the pillar physically cannot illuminate the skin, repaint the floor
 * pool, or touch the shadow. The wrapper carries the flat page-ground color
 * so the shader's opaque-black empty pixels screen to a no-op against it
 * (screen(black, ground) = ground — the confined region sits entirely in
 * the flat ground zone of the body gradient, so the wrapper is invisible
 * by construction: no seam, no box). Honors prefers-reduced-motion by
 * rendering nothing.
 */
export type WorldState = 'distant' | 'waiting' | 'igniting' | 'alive' | 'receding';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const WorldBeacon: React.FC<{ state: WorldState }> = () => {
  const reduced = usePrefersReducedMotion();

  if (reduced) return null;

  // Beacon region — measured against the real 1280×800 Play stage
  // (mu-verify/geo-audit.mjs, CSS px):
  //   wrapper    x 336..944, y  75.8..451.8   (608 × 376, top 3.7% of a 752 stage)
  //   stage cvs  x 430..850, y 179.7..451.7   (420 × 272, OPAQUE)
  // The wrapper is the full 376px the shader was tuned against — resizing it
  // changes the shader's aspect and warps the beam, so the wrapper's shape is
  // fixed and the *window* (.pillar-window) does the constraining: it keeps
  // full strength to 18% of the height (y 143) and reaches zero by 28%
  // (y 181), i.e. just above the canvas top at 179.7. The glow's measured core
  // is y 115..166, so the whole core survives and nothing survives to the
  // canvas edge.
  //
  // Why zero at the canvas top is not optional: the stage canvas is opaque and
  // painted the exact page ground, so a page-layer glow that is still burning
  // where the canvas begins is cut off by a straight horizontal line across an
  // otherwise black room — the "dark rectangle". The measured step was
  // RGB(94,68,31) → RGB(11,10,9) at y=179.7 — a hard edge a human eye reads as
  // a box, and the failure recorded in versions 011 through 016.
  //
  // No background beyond the flat page ground, no border, no shadow,
  // z-0 under the z-10 stage — never affects layout, never takes pointer.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-0 overflow-hidden"
      style={{
        left: 'calc(50% - 304px)',
        top: '3.7%',
        width: '608px',
        height: '50%',
        backgroundColor: 'var(--ground)',
      }}
    >
      <LightPillar
        topColor="#c88735"
        bottomColor="#c88735"
        intensity={0.75}
        rotationSpeed={0.25}
        glowAmount={0.001}
        pillarWidth={2.8}
        pillarHeight={0.3}
        noiseIntensity={0.35}
        pillarRotation={25}
        interactive={false}
        mixBlendMode="screen"
        quality="high"
        className="pillar-window"
      />
    </div>
  );
};

export default memo(WorldBeacon);
