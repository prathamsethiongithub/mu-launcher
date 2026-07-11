import React, { memo, useEffect, useState } from 'react';
import LightPillar from './LightPillar';

/**
 * The world-beacon — the presence of the SMP behind the Launch button.
 *
 * A slowly turning column of ember light rising from below the horizon:
 * the world, seen from the room. It is atmosphere, never UI (DESIGN.md §8):
 * screen-blended, edge-masked, pointer-transparent, medium quality, and it
 * REACTS to the launcher's state instead of decorating it —
 *
 *   distant  (signed out)  → barely there, turning slowly
 *   waiting  (ready)       → present, patient
 *   igniting (launching)   → brightens and quickens
 *   alive    (running)     → calm, steady burn
 *   receding (error)       → the world pulls back
 *
 * Honors prefers-reduced-motion by rendering nothing (the static hearth
 * remains the room's only light).
 */
export type WorldState = 'distant' | 'waiting' | 'igniting' | 'alive' | 'receding';

const TUNING: Record<WorldState, { intensity: number; rotationSpeed: number }> = {
  distant:  { intensity: 0.35, rotationSpeed: 0.10 },
  waiting:  { intensity: 0.60, rotationSpeed: 0.16 },
  igniting: { intensity: 0.95, rotationSpeed: 0.38 },
  alive:    { intensity: 0.70, rotationSpeed: 0.20 },
  receding: { intensity: 0.22, rotationSpeed: 0.06 },
};

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

const WorldBeacon: React.FC<{ state: WorldState }> = ({ state }) => {
  const reduced = usePrefersReducedMotion();
  if (reduced) return null;

  const { intensity, rotationSpeed } = TUNING[state];

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      style={{
        opacity: 0.9,
        // Melt into the room: bottom-anchored cone, no hard canvas edges.
        maskImage:
          'radial-gradient(130% 105% at 50% 100%, black 28%, transparent 72%)',
        WebkitMaskImage:
          'radial-gradient(130% 105% at 50% 100%, black 28%, transparent 72%)',
        transition: 'opacity 600ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <LightPillar
        topColor="#FFB224"
        bottomColor="#E38330"
        intensity={intensity}
        rotationSpeed={rotationSpeed}
        glowAmount={0.0012}
        pillarWidth={3.6}
        pillarHeight={0.5}
        noiseIntensity={0.8}
        pillarRotation={0}
        interactive={false}
        mixBlendMode="screen"
        quality="medium"
      />
    </div>
  );
};

export default memo(WorldBeacon);
