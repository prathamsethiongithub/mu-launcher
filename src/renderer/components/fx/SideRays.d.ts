/* Type shim for the pristine vendor SideRays.jsx (React Bits).
   Keeps the .jsx source untouched while giving strict-TS consumers types —
   same pattern as LightPillar.d.ts. Prop names/types mirror the vendor
   component's own defaults; values themselves are set at the mount site. */
import * as React from 'react';

export interface SideRaysProps {
  speed?: number;
  rayColor1?: string;
  rayColor2?: string;
  intensity?: number;
  spread?: number;
  origin?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  tilt?: number;
  saturation?: number;
  blend?: number;
  falloff?: number;
  opacity?: number;
  className?: string;
}

declare const SideRays: React.FC<SideRaysProps>;
export default SideRays;
