// tests/studio-ritual.test.ts — every branch of the euphoria pure logic.

import { describe, expect, it } from 'vitest';
import {
  classifyStudioVisit,
  formatWearingSince,
  hasReturnedAfterAbsence,
  isFirstSkin,
  STUDIO_ABSENCE_MS,
} from '../src/shared/studio-ritual';

const DAY = 86_400_000;
// Fixed reference: a Wednesday, noon local — weekday math stays deterministic.
const NOW = new Date('2026-09-16T12:00:00').getTime();
expect(new Date(NOW).getDay()).toBe(3); // wednesday — guards the fixture

// ── formatWearingSince ──────────────────────────────────────────────────────
describe('formatWearingSince', () => {
  it('today', () => {
    expect(formatWearingSince(NOW - 1 * 60 * 60 * 1000, NOW)).toBe('wearing it since today');
    expect(formatWearingSince(NOW, NOW)).toBe('wearing it since today');
  });
  it('clamps future timestamps (clock skew) to today', () => {
    expect(formatWearingSince(NOW + 3 * DAY, NOW)).toBe('wearing it since today');
  });
  it('yesterday (by local midnight, not 24h arithmetic)', () => {
    // 23h ago but across midnight → yesterday; 20h ago same-day → today.
    expect(formatWearingSince(NOW - 23 * 60 * 60 * 1000, NOW)).toBe('wearing it since yesterday');
    const evening = new Date('2026-09-16T21:00:00').getTime();
    expect(formatWearingSince(evening - 20 * 60 * 60 * 1000, evening)).toBe('wearing it since today');
  });
  it('within a week → the weekday it happened', () => {
    // 2 days back = monday, 3 = sunday, 7 days back (start-of-day) = last wednesday
    expect(formatWearingSince(NOW - 2 * DAY, NOW)).toBe('wearing it since monday');
    expect(formatWearingSince(NOW - 3 * DAY, NOW)).toBe('wearing it since sunday');
    expect(formatWearingSince(NOW - 6 * DAY, NOW)).toBe('wearing it since thursday');
    expect(formatWearingSince(NOW - 7 * DAY, NOW)).toBe('wearing it since wednesday');
  });
  it('older than a week → the local date, lowercase', () => {
    expect(formatWearingSince(NOW - 8 * DAY, NOW)).toBe('wearing it since sep 8');
    expect(formatWearingSince(NOW - 40 * DAY, NOW)).toBe('wearing it since aug 7');
  });
});

// ── hasReturnedAfterAbsence ─────────────────────────────────────────────────
describe('hasReturnedAfterAbsence', () => {
  it('fires at exactly 6 hours', () => {
    expect(hasReturnedAfterAbsence(NOW - STUDIO_ABSENCE_MS, NOW, false)).toBe(true);
  });
  it('does not fire a minute early', () => {
    expect(hasReturnedAfterAbsence(NOW - STUDIO_ABSENCE_MS + 60_000, NOW, false)).toBe(false);
  });
  it('fires well past the threshold', () => {
    expect(hasReturnedAfterAbsence(NOW - 3 * STUDIO_ABSENCE_MS, NOW, false)).toBe(true);
  });
  it('never fires more than once per session', () => {
    expect(hasReturnedAfterAbsence(NOW - STUDIO_ABSENCE_MS, NOW, true)).toBe(false);
  });
  it('first visit ever (no lastVisit) is not a return', () => {
    expect(hasReturnedAfterAbsence(null, NOW, false)).toBe(false);
  });
  it('recent visit stays quiet', () => {
    expect(hasReturnedAfterAbsence(NOW - 60_000, NOW, false)).toBe(false);
  });
});

// ── isFirstSkin ─────────────────────────────────────────────────────────────
describe('isFirstSkin', () => {
  it('fires only for the 0 → ≥1 transition', () => {
    expect(isFirstSkin(0, 1)).toBe(true);
    expect(isFirstSkin(0, 3)).toBe(true);
  });
  it('never fires afterwards', () => {
    expect(isFirstSkin(1, 2)).toBe(false);
    expect(isFirstSkin(2, 2)).toBe(false);
    expect(isFirstSkin(2, 1)).toBe(false);
  });
  it('does not fire when nothing was added', () => {
    expect(isFirstSkin(0, 0)).toBe(false);
  });
});

// ── classifyStudioVisit ─────────────────────────────────────────────────────
describe('classifyStudioVisit', () => {
  it('wardrobe play → pleasure', () => {
    expect(classifyStudioVisit(['equip'])).toBe('pleasure');
    expect(classifyStudioVisit(['import', 'rename'])).toBe('pleasure');
    expect(classifyStudioVisit(['save-current'])).toBe('pleasure');
    expect(classifyStudioVisit(['set-model'])).toBe('pleasure');
  });
  it('a quiet look (no actions) → pleasure', () => {
    expect(classifyStudioVisit([])).toBe('pleasure');
  });
  it('housekeeping only → task', () => {
    expect(classifyStudioVisit(['delete'])).toBe('task');
    expect(classifyStudioVisit(['reveal'])).toBe('task');
    expect(classifyStudioVisit(['reveal', 'delete'])).toBe('task');
  });
  it('both kinds → mixed', () => {
    expect(classifyStudioVisit(['equip', 'delete'])).toBe('mixed');
    expect(classifyStudioVisit(['reveal', 'import'])).toBe('mixed');
  });
  it('unknown actions are ignored, not guessed', () => {
    expect(classifyStudioVisit(['something-else'])).toBe('pleasure');
    expect(classifyStudioVisit(['something-else', 'delete'])).toBe('task');
  });
});
