/* Type shim for the vendor MagicRings.jsx (React Bits, with the two
   documented shader corrective patches described in the .jsx header).
   Keeps the .jsx source untouched while giving strict-TS consumers types —
   same pattern as SideRays.d.ts. Prop names/types mirror the vendor
   component's own defaults; values themselves are set at the mount site
   (the approved/locked configuration lives ONLY in PlayView.tsx). */
import * as React from 'react';

export interface MagicRingsProps {
  color?: string;
  colorTwo?: string;
  speed?: number;
  ringCount?: number;
  attenuation?: number;
  lineThickness?: number;
  baseRadius?: number;
  radiusStep?: number;
  scaleRate?: number;
  opacity?: number;
  blur?: number;
  noiseAmount?: number;
  rotation?: number;
  ringGap?: number;
  fadeIn?: number;
  fadeOut?: number;
  followMouse?: boolean;
  mouseInfluence?: number;
  hoverScale?: number;
  parallax?: number;
  clickBurst?: boolean;
  alphaMode?: 'luminance' | 'coverage';
}

declare const MagicRings: React.FC<MagicRingsProps>;
export default MagicRings;
