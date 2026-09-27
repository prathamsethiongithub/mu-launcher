import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RAM_ALLOCATION_MB,
  LOW_RAM_ALLOCATION_MB,
  LOW_RAM_TOTAL_BYTES,
  RAM_ADJUSTED_NOTICE,
  readRamEnvironment,
  suggestRamAdjustment,
} from '../src/main/ram-guard';
import { FIRST_BOOT_COPY, isFirstBoot } from '../src/shared/first-boot';

/**
 * The First-Contact Pack (mission: kill the #1 quit moment), pure decisions
 * only — no Electron, no fs, mirroring the identity-state.ts convention.
 *
 * Two modules under test:
 *   src/main/ram-guard.ts   — hardware-aware RAM guard (deliverable 2)
 *   src/shared/first-boot.ts — the expectation line + its predicate (deliverable 1)
 *
 * The contract that matters most is the ONE-TIME property: the guard must be
 * able to fire exactly once per world, must never overrule a value the user
 * chose, and must never act on an unmeasurable machine.
 */

const GB = 1024 ** 3;

describe('suggestRamAdjustment — the RAM guard decision', () => {
  it('a 4 GB box on the default 4 GB allocation is moved to 2 GB', () => {
    expect(
      suggestRamAdjustment({ totalMemBytes: 4 * GB, currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB }),
    ).toBe(LOW_RAM_ALLOCATION_MB);
  });

  it('a 5.9 GB box (just under the line) is still adjusted', () => {
    expect(
      suggestRamAdjustment({ totalMemBytes: 5.9 * GB, currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB }),
    ).toBe(LOW_RAM_ALLOCATION_MB);
  });

  it('exactly 6 GB is NOT adjusted — the threshold is inclusive of "fine"', () => {
    expect(
      suggestRamAdjustment({ totalMemBytes: LOW_RAM_TOTAL_BYTES, currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB }),
    ).toBeNull();
  });

  it('a healthy 16 GB box is never touched', () => {
    expect(
      suggestRamAdjustment({ totalMemBytes: 16 * GB, currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB }),
    ).toBeNull();
  });

  it('a user-chosen allocation on a small box is respected, not overruled', () => {
    // The user deliberately raised it (or lowered it). The guard only ever
    // moves a value the user never chose.
    expect(
      suggestRamAdjustment({ totalMemBytes: 4 * GB, currentAllocationMb: 8192 }),
    ).toBeNull();
    expect(
      suggestRamAdjustment({ totalMemBytes: 4 * GB, currentAllocationMb: 6144 }),
    ).toBeNull();
  });

  it('ONE-TIME: once adjusted (current === 2048), it can never fire again', () => {
    const smallBox = { totalMemBytes: 4 * GB, currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB };

    const first = suggestRamAdjustment(smallBox);
    expect(first).toBe(LOW_RAM_ALLOCATION_MB);

    // Persist the result, as the launch handler does, and re-ask: null.
    const second = suggestRamAdjustment({ ...smallBox, currentAllocationMb: first! });
    expect(second).toBeNull();

    // And again, for good measure — no oscillation, no nagging.
    expect(suggestRamAdjustment({ ...smallBox, currentAllocationMb: first! })).toBeNull();
  });

  it('a world already below the low bucket is left alone', () => {
    expect(
      suggestRamAdjustment({ totalMemBytes: 4 * GB, currentAllocationMb: 2048 }),
    ).toBeNull();
    expect(
      suggestRamAdjustment({ totalMemBytes: 4 * GB, currentAllocationMb: 1024 }),
    ).toBeNull();
  });

  it('an unmeasurable machine (NaN / 0 / negative) is never guessed at', () => {
    expect(suggestRamAdjustment({ totalMemBytes: NaN, currentAllocationMb: 4096 })).toBeNull();
    expect(suggestRamAdjustment({ totalMemBytes: 0, currentAllocationMb: 4096 })).toBeNull();
    expect(suggestRamAdjustment({ totalMemBytes: -1, currentAllocationMb: 4096 })).toBeNull();
    expect(
      suggestRamAdjustment({ totalMemBytes: 4 * GB, currentAllocationMb: NaN }),
    ).toBeNull();
  });

  it('free memory is NON-DECISIVE: it can never change the verdict', () => {
    // Plenty of total RAM, almost none free → still no adjustment.
    expect(
      suggestRamAdjustment({
        totalMemBytes: 32 * GB,
        freeMemBytes: 64 * 1024 ** 2,
        currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB,
      }),
    ).toBeNull();
    // Little total RAM, all of it free → still adjusted.
    expect(
      suggestRamAdjustment({
        totalMemBytes: 4 * GB,
        freeMemBytes: 4 * GB,
        currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB,
      }),
    ).toBe(LOW_RAM_ALLOCATION_MB);
  });

  it('thresholds and buckets are injectable (keeps the rule testable)', () => {
    expect(
      suggestRamAdjustment({
        totalMemBytes: 3 * GB,
        currentAllocationMb: 8000,
        defaultAllocationMb: 8000,
        lowRamThresholdBytes: 4 * GB,
        lowRamAllocationMb: 3000,
      }),
    ).toBe(3000);
  });

  it('the guard only ever lowers default → low, never invents a third value', () => {
    const out = suggestRamAdjustment({
      totalMemBytes: 2 * GB,
      currentAllocationMb: DEFAULT_RAM_ALLOCATION_MB,
    });
    expect([LOW_RAM_ALLOCATION_MB, null]).toContain(out);
  });
});

describe('RAM_ADJUSTED_NOTICE — the copy', () => {
  it('is the exact lowercase line, no punctuation flourish', () => {
    expect(RAM_ADJUSTED_NOTICE).toBe('adjusted memory for your machine.');
  });
});

describe('readRamEnvironment — the machine read', () => {
  it('returns a finite, positive total and a free reading within it', () => {
    const env = readRamEnvironment();
    expect(Number.isFinite(env.totalMemBytes)).toBe(true);
    expect(env.totalMemBytes).toBeGreaterThan(0);
    expect(Number.isFinite(env.freeMemBytes)).toBe(true);
    expect(env.freeMemBytes!).toBeGreaterThanOrEqual(0);
    expect(env.freeMemBytes!).toBeLessThanOrEqual(env.totalMemBytes);
  });
});

describe('isFirstBoot — the expectation-line predicate', () => {
  it('a world that has never been launched is first-boot', () => {
    expect(isFirstBoot({ lastPlayedAt: null })).toBe(true);
    expect(isFirstBoot({ lastPlayedAt: undefined })).toBe(true);
  });

  it('a missing field counts as never-launched (hand-written/legacy entries)', () => {
    expect(isFirstBoot({})).toBe(true);
  });

  it('a world that has finished a launch is NOT first-boot', () => {
    expect(isFirstBoot({ lastPlayedAt: 1725148800000 })).toBe(false);
    expect(isFirstBoot({ lastPlayedAt: 0 })).toBe(false); // epoch-safe: 0 is a value
  });

  it('no active world means nothing to say', () => {
    expect(isFirstBoot(null)).toBe(false);
    expect(isFirstBoot(undefined)).toBe(false);
  });
});

describe('FIRST_BOOT_COPY — the copy', () => {
  it('is the exact lowercase line, in the product voice', () => {
    expect(FIRST_BOOT_COPY).toBe("first time takes a few minutes. it's worth it.");
  });

  it('is lowercase and draws no attention (no bang, no emoji)', () => {
    expect(FIRST_BOOT_COPY).toBe(FIRST_BOOT_COPY.toLowerCase());
    expect(FIRST_BOOT_COPY).not.toMatch(/[!]/);
  });
});
