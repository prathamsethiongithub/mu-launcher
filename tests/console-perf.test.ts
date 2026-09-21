/**
 * Data-layer performance benchmark (console Phase B task item).
 *
 * The task required the filter/search data layer to be benchmarked at the
 * 50k-row scale with the number recorded. The live in-memory buffer is capped
 * at 5000 lines, but history files truncate at 5 MB ≈ 25–30k lines, so 50k is
 * the stress ceiling for the shared predicates (`matchesFilter` /
 * `countMatches`) that ConsoleView runs per keystroke.
 *
 * Deliberately generous assertions: this is a regression tripwire, not a
 * micro-optimization contest. If a future change makes the filter layer
 * orders-of-magnitude slower, this fails and someone asks questions.
 */
import { describe, expect, it } from 'vitest';
import { countMatches, matchesFilter, type ConsoleEntry, type FilterState } from '../src/shared/console-log';

const T = Date.UTC(2026, 8, 21, 12, 0, 0);

function makeEntries(n: number): { entries: ConsoleEntry[]; errorGameCount: number } {
  const entries: ConsoleEntry[] = [];
  let errorGameCount = 0;
  for (let i = 0; i < n; i++) {
    const source = i % 7 === 0 ? 'launcher' : 'game';
    // Every 11th row is an error, every 3rd of the rest is a warn.
    const level = i % 11 === 0 ? 'error' : i % 3 === 1 ? 'warn' : 'info';
    if (level === 'error' && source === 'game') errorGameCount++;
    const text =
      level === 'error'
        ? `Exception in thread "main" java.lang.RuntimeException: boom ${i}`
        : level === 'warn'
          ? `Deprecated API usage in mixin ${i}`
          : `[Render thread/INFO] ticking entity ${i}`;
    entries.push({ ts: T - (n - i) * 1000, source, level, text });
  }
  return { entries, errorGameCount };
}

const ALL: FilterState = { query: '', regexMode: false, sources: [], levels: [] };
const SEARCH: FilterState = { query: 'RuntimeException', regexMode: false, sources: ['game'], levels: ['error'] };

describe('console data-layer benchmark (50k rows)', () => {
  const { entries, errorGameCount } = makeEntries(50_000);

  it('50k rows: unfiltered full pass + counts stay well under a second', () => {
    const t0 = performance.now();
    let hits = 0;
    // Worst realistic keystroke: a visible() recompute plus a match-count pass.
    for (const e of entries) if (matchesFilter(e, ALL)) hits++;
    expect(countMatches(entries, ALL)).toBe(50_000);
    const ms = performance.now() - t0;
    expect(hits).toBe(50_000);
    expect(ms).toBeLessThan(1000);
    console.log(`[bench] 50k rows unfiltered pass: ${ms.toFixed(1)} ms`);
  });

  it('50k rows: combined substring+chips filter + count in one budget', () => {
    const t0 = performance.now();
    let hits = 0;
    for (const e of entries) if (matchesFilter(e, SEARCH)) hits++;
    expect(countMatches(entries, SEARCH)).toBe(hits);
    const ms = performance.now() - t0;
    // Deterministic by construction: exactly the game-side error rows.
    expect(hits).toBe(errorGameCount);
    expect(hits).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
    console.log(`[bench] 50k rows substring+chips filter: ${ms.toFixed(1)} ms (${hits} hits)`);
  });
});
