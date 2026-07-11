/* Type shim for the pristine vendor LightPillar.jsx (React Bits).
   Keeps the .jsx source untouched while giving strict-TS consumers types. */
import * as React from 'react';

export interface LightPillarProps {
  topColor?: string;
  bottomColor?: string;
  intensity?: number;
  rotationSpeed?: number;
  interactive?: boolean;
  className?: string;
  glowAmount?: number;
  pillarWidth?: number;
  pillarHeight?: number;
  noiseIntensity?: number;
  mixBlendMode?: React.CSSProperties['mixBlendMode'];
  pillarRotation?: number;
  quality?: 'low' | 'medium' | 'high';
}

declare const LightPillar: React.FC<LightPillarProps>;
export default LightPillar;
