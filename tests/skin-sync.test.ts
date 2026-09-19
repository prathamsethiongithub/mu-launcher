// tests/skin-sync.test.ts — the equip→all-views sync pure logic:
// the cache write-through decision and the skin-changed payload shape.

import { describe, expect, it } from 'vitest';
import {
  buildSkinChangedPayload,
  shouldWriteThroughCache,
} from '../src/main/skin-library';

describe('shouldWriteThroughCache', () => {
  it('writes through for a real uuid', () => {
    expect(shouldWriteThroughCache('069a79f4-44e9-4726-a5be-fca90e38aaf5')).toBe(true);
  });
  it('never writes through for missing/empty uuids (no cache key exists)', () => {
    expect(shouldWriteThroughCache(undefined)).toBe(false);
    expect(shouldWriteThroughCache(null)).toBe(false);
    expect(shouldWriteThroughCache('')).toBe(false);
  });
});

describe('buildSkinChangedPayload', () => {
  it('carries accountId, model and an ISO changedAt from the injectable clock', () => {
    const now = new Date('2026-09-19T09:30:00').getTime(); // local, like Date(ms) round-trip
    expect(buildSkinChangedPayload('acc-1', 'slim', now)).toEqual({
      accountId: 'acc-1',
      model: 'slim',
      changedAt: new Date(now).toISOString(),
    });
  });
  it('defaults the clock to now and produces a parseable ISO stamp', () => {
    const before = Date.now();
    const p = buildSkinChangedPayload('acc-2', 'classic');
    const after = Date.now();
    const ts = Date.parse(p.changedAt);
    expect(p.accountId).toBe('acc-2');
    expect(p.model).toBe('classic');
    expect(ts).toBeGreaterThanOrEqual(before - 5);
    expect(ts).toBeLessThanOrEqual(after + 5);
  });
  it('payload round-trips the model verbatim (classic stays classic)', () => {
    expect(buildSkinChangedPayload('acc-3', 'classic').model).toBe('classic');
  });
});
