import React, { useRef } from 'react';

export interface LaunchStep {
  step: string;
  label: string;
  status: 'pending' | 'working' | 'done' | 'error';
  /** Real completion fraction of this step, 0..1 — only ever set from
   *  measured progress (Java provisioning percent, MCLC download events).
   *  Never synthesized; absent = no measurement for this step. */
  progress?: number;
}

interface ForgeLineProps {
  stages: readonly { id: string; label: string; real: readonly string[] }[];
  launchSteps: LaunchStep[];
  hasLaunchedBefore: boolean;
}

type StageStatus = 'pending' | 'working' | 'done' | 'error';

function stageStatus(steps: LaunchStep[], realSteps: readonly string[]): StageStatus {
  const relevant = steps.filter((s) => realSteps.includes(s.step));
  if (relevant.some((s) => s.status === 'error')) return 'error';
  if (relevant.some((s) => s.status === 'working')) return 'working';
  if (relevant.length > 0 && relevant.every((s) => s.status === 'done')) return 'done';
  return 'pending';
}

/**
 * How far through its segment the ACTIVE stage is: the furthest measured
 * fraction among its working steps. Unmeasured work contributes 0 — the bead
 * enters the segment and waits for real data rather than guessing halfway.
 */
function stageFraction(steps: LaunchStep[], realSteps: readonly string[]): number {
  let fraction = 0;
  for (const s of steps) {
    if (realSteps.includes(s.step) && s.status === 'working' && typeof s.progress === 'number') {
      fraction = Math.max(fraction, Math.min(1, Math.max(0, s.progress)));
    }
  }
  return fraction;
}

/**
 * The filament — launch progress as a single horizontal thread of light.
 * While launching, this is the screen's one ember element (the pill yields).
 * Track: hairline. Fill: ember gradient. Head: a small glowing bead.
 *
 * Position is TRUTH: fill is derived only from stage completions and measured
 * progress fractions. Tempo (the head's pulse, the beacon, the character) is
 * the separate "activity" channel — never a proxy for completion.
 */
const ForgeLine: React.FC<ForgeLineProps> = ({ stages, launchSteps, hasLaunchedBefore }) => {
  const statuses = stages.map((s) => stageStatus(launchSteps, s.real));
  const doneCount = statuses.filter((s) => s === 'done').length;
  const activeIdx = statuses.findIndex((s) => s === 'working');

  // Fill: completed stages plus the active stage's measured fraction.
  const unit = 100 / stages.length;
  const rawPct = Math.min(100, doneCount * unit + (activeIdx >= 0 ? stageFraction(launchSteps, stages[activeIdx].real) * unit : 0));

  // Monotonic within a launch: progress never visibly regresses (event
  // streams can re-emit or reorder). A fresh launch (everything pending)
  // re-arms the clamp.
  const maxFillRef = useRef(0);
  if (rawPct <= 0) maxFillRef.current = 0;
  const fillPct = Math.max(rawPct, maxFillRef.current);
  maxFillRef.current = fillPct;

  return (
    <div className="filament-enter w-[340px]">
      <div className="filament-track">
        {/* Arc-style memory: a faint bead where past launches began */}
        {hasLaunchedBefore && (
          <div className="absolute left-0 top-1/2 h-[4px] w-[4px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ember/25" />
        )}
        <div className="filament-fill" style={{ width: `${fillPct}%` }} />
        {fillPct > 0 && fillPct < 100 && (
          <div className="filament-head" style={{ left: `${fillPct}%` }} />
        )}
      </div>

      {/* Stage names: a quiet row beneath the thread */}
      <div className="mt-4 flex justify-between">
        {stages.map((stage, i) => {
          const st = statuses[i];
          return (
            <span
              key={stage.id}
              className={`text-[11px] tracking-[0.04em] transition-colors duration-state ease-exit ${
                st === 'working'
                  ? 'text-ink'
                  : st === 'done'
                    ? 'text-dim'
                    : st === 'error'
                      ? 'text-danger'
                      : 'text-faint'
              }`}
            >
              {stage.label}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export default ForgeLine;
