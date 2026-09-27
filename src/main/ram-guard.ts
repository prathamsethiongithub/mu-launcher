/**
 * Hardware-aware RAM guard (first-contact pack, deliverable 2).
 *
 * THE #1 QUIT MOMENT: a first-time user on a low-RAM machine clicks Play, the
 * JVM is handed the default 4 GB, and the launch either thrashes or dies with
 * an OutOfMemoryError the user cannot interpret. This guard reads the machine's
 * real memory before the first launch and quietly hands the JVM what the box
 * can actually hold.
 *
 * Pre-registered rule (stated before the code, per the mission brief):
 *   total system RAM < 6 GB  AND  the world is still on the default allocation
 *     -> adjust to 2 GB
 *   otherwise                -> do nothing (null)
 *
 * The "still on the default" clause is what makes the adjustment ONE-TIME and
 * the message honest: the moment 2048 is persisted, the condition can never
 * hold again, so the notification cannot nag on the second launch. It also
 * means a user who deliberately set 8 GB is never overruled — the guard only
 * ever moves a value the user never chose.
 *
 * `freeMemBytes` is accepted because the brief asks for it and because the
 * truth doc records it — but it is deliberately NON-DECISIVE. Free memory at
 * boot is noise (it swings with every other process on the box); total
 * installed RAM is the stable fact. A test pins that freemem cannot change the
 * verdict.
 */

import { freemem, totalmem } from 'node:os';

/** The launcher's default allocation — what a world starts life at. */
export const DEFAULT_RAM_ALLOCATION_MB = 4096;

/** What a low-RAM machine gets instead. */
export const LOW_RAM_ALLOCATION_MB = 2048;

/** Below this much installed RAM, 4 GB is a lie. */
export const LOW_RAM_TOTAL_BYTES = 6 * 1024 ** 3;

/** The one-time notification copy. Lowercase, same voice as "Ready." */
export const RAM_ADJUSTED_NOTICE = 'adjusted memory for your machine.';

export interface RamEnvironment {
  /** `os.totalmem()` — the decisive fact. */
  totalMemBytes: number;
  /** `os.freemem()` — recorded for the truth doc, never decisive. */
  freeMemBytes?: number;
}

export interface RamAdjustmentInput extends RamEnvironment {
  /** The world's current `ramAllocation` in MB. */
  currentAllocationMb: number;
  defaultAllocationMb?: number;
  lowRamThresholdBytes?: number;
  lowRamAllocationMb?: number;
}

/**
 * Returns the allocation the world should be moved to, or `null` when the
 * machine is fine or the user's own choice must be respected.
 */
export function suggestRamAdjustment(input: RamAdjustmentInput): number | null {
  const {
    totalMemBytes,
    currentAllocationMb,
    defaultAllocationMb = DEFAULT_RAM_ALLOCATION_MB,
    lowRamThresholdBytes = LOW_RAM_TOTAL_BYTES,
    lowRamAllocationMb = LOW_RAM_ALLOCATION_MB,
  } = input;

  // Unmeasurable hardware: never guess on a NaN/0 read.
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return null;
  if (!Number.isFinite(currentAllocationMb)) return null;

  // Enough RAM — 4 GB is fine, change nothing.
  if (totalMemBytes >= lowRamThresholdBytes) return null;

  // The user has chosen a value (or a previous launch already adjusted it).
  // Respect it; this is the clause that makes the guard one-time.
  if (currentAllocationMb !== defaultAllocationMb) return null;

  // Nothing to gain — already at or below the low bucket.
  if (currentAllocationMb <= lowRamAllocationMb) return null;

  return lowRamAllocationMb;
}

/** Read the machine once, in the shape the guard wants. */
export function readRamEnvironment(): RamEnvironment {
  return { totalMemBytes: totalmem(), freeMemBytes: freemem() };
}
