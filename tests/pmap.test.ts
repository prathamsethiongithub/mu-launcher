import { afterEach, describe, expect, it } from 'vitest';
import { pMap } from '../src/main/net';

/**
 * pMap — bounded-concurrency ordered map (perf-strike groundwork).
 *
 * Pure logic only: no sockets, no fetch stubs. Concurrency is observed with
 * an in-flight counter and real microtask/timer boundaries — each mapper
 * awaits a small real timer so a whole worker batch is provably in flight
 * before any of it settles, which pins both the ceiling (peak ≤ concurrency)
 * and the floor (queued items are pulled as soon as a slot frees).
 */

const TICK = 5; // ms — long enough that a whole batch enters, short enough for CI

function tick(ms = TICK): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tracks peak in-flight mapper executions across the whole run. */
function makeConcurrencyTracker() {
  let active = 0;
  let peak = 0;
  return {
    async run<T, R>(
      items: readonly T[],
      concurrency: number,
      fn: (item: T) => Promise<R>,
    ): Promise<R[]> {
      return pMap(
        items,
        async (item) => {
          active++;
          peak = Math.max(peak, active);
          try {
            await tick();
            return await fn(item);
          } finally {
            active--;
          }
        },
        { concurrency },
      );
    },
    get peak() {
      return peak;
    },
  };
}

afterEach(() => {
  // Nothing to restore — the unhandledRejection probe below removes itself.
});

describe('pMap', () => {
  it('preserves input order regardless of completion order', async () => {
    const results = await pMap(
      [40, 10, 30, 20],
      async (delay) => {
        await tick(delay);
        return `done-${delay}`;
      },
      { concurrency: 4 },
    );
    expect(results).toEqual(['done-40', 'done-10', 'done-30', 'done-20']);
  });

  it('keeps the in-flight peak at or below concurrency', async () => {
    const tracker = makeConcurrencyTracker();
    const results = await tracker.run(
      Array.from({ length: 12 }, (_, i) => i),
      4,
      async (n) => n * 2,
    );
    expect(tracker.peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i * 2));
  });

  it('actually parallelizes: peak equals min(concurrency, items.length)', async () => {
    // Guards against a serial regression: with 6 items at concurrency 3 and a
    // real tick inside every mapper, the first three provably overlap.
    const tracker = makeConcurrencyTracker();
    await tracker.run([1, 2, 3, 4, 5, 6], 3, async () => undefined);
    expect(tracker.peak).toBe(3);
  });

  it('queues items beyond concurrency and runs each exactly once', async () => {
    const processed: number[] = [];
    const results = await pMap(
      Array.from({ length: 10 }, (_, i) => i),
      async (n) => {
        processed.push(n);
        await tick();
        return n + 100;
      },
      { concurrency: 3 },
    );
    expect(processed.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i + 100));
  });

  it('is serial at concurrency 1 (floor semantics)', async () => {
    const tracker = makeConcurrencyTracker();
    await tracker.run([1, 2, 3, 4], 1, async () => undefined);
    expect(tracker.peak).toBe(1);
  });

  it('returns an empty array for empty input without calling the mapper', async () => {
    let calls = 0;
    const results = await pMap([], async () => {
      calls++;
      return null;
    }, { concurrency: 4 });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects with the FIRST error to arrive and stops pulling new items', async () => {
    const started: number[] = [];
    const pending = pMap(
      Array.from({ length: 9 }, (_, i) => i),
      async (n) => {
        started.push(n);
        if (n === 0) {
          await tick(40); // slow failure
          throw new Error('slow-failure-0');
        }
        if (n === 2) {
          await tick(1); // fast failure — must win the race
          throw new Error('fast-failure-2');
        }
        if (n >= 6) return 'should-not-run';
        await tick();
        return n;
      },
      { concurrency: 3 },
    );
    await expect(pending).rejects.toThrow('fast-failure-2');
  });

  it('leaves late worker rejections observed (no unhandledRejection)', async () => {
    const unhandled: unknown[] = [];
    const probe = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', probe);

    try {
      const pending = pMap(
        [0, 1, 2],
        async (n) => {
          // Item 0 rejects AFTER the map has already settled on late-1.
          const delay = n === 0 ? 30 : n === 2 ? 20 : 1;
          await tick(delay);
          throw new Error(`late-${n}`);
        },
        { concurrency: 3 },
      );
      await expect(pending).rejects.toThrow('late-1');
      // Give the slow worker time to reject after the map already settled.
      await tick(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', probe);
    }
  });
});
