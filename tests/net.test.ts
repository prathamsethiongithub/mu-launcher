import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadGuard, readWithStallGuard, timedFetch } from '../src/main/net';

/**
 * Test 5 — net.ts pure/timing logic with vitest fake timers. No real
 * sockets: downloadGuard/readWithStallGuard are observed purely through
 * AbortController state and promise settlement; timedFetch is observed
 * through a 4-line inline fetch stub that only captures the abort signal
 * (the real-network happy path is intentionally uncovered — recorded in
 * 18-TRUST-REPAIR-LOG.md).
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('downloadGuard', () => {
  it('aborts with [E221] after the connect window elapses', () => {
    vi.useFakeTimers();
    const guard = downloadGuard(20_000);
    vi.advanceTimersByTime(20_000);
    expect(guard.controller.signal.aborted).toBe(true);
    expect((guard.controller.signal.reason as Error).message).toContain('[E221]');
  });

  it('headersReceived() cancels the connect timer (guard order)', () => {
    vi.useFakeTimers();
    const guard = downloadGuard(20_000);
    guard.headersReceived();
    vi.advanceTimersByTime(120_000);
    expect(guard.controller.signal.aborted).toBe(false);
  });
});

describe('readWithStallGuard', () => {
  it('returns the chunk when the read settles within the window', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await expect(
      readWithStallGuard(Promise.resolve('chunk'), controller, 60_000),
    ).resolves.toBe('chunk');
    expect(controller.signal.aborted).toBe(false);
  });

  it('rejects with [E222] and aborts the controller when no data arrives', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const never = new Promise<never>(() => {});
    const pending = readWithStallGuard(never, controller, 60_000);
    const assertion = expect(pending).rejects.toThrow(/\[E222\]/);
    vi.advanceTimersByTime(60_000);
    await assertion;
    expect(controller.signal.aborted).toBe(true);
  });

  it('race settles with [E222] even when the read rejects on abort (guard order)', async () => {
    // Encodes the documented invariant: the stall timer rejects FIRST so
    // Promise.race deterministically settles with the E222 error, then
    // aborts — the read's own AbortError must never win the race.
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('AbortError')));
    });
    const pending = readWithStallGuard(read, controller, 60_000);
    const assertion = expect(pending).rejects.toThrow(/\[E222\]/);
    vi.advanceTimersByTime(60_000);
    await assertion;
  });
});

describe('timedFetch', () => {
  it('aborts with [E220] when the total window elapses', async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) => {
      captured = init?.signal;
      return new Promise<Response>((_, reject) => {
        captured?.addEventListener('abort', () =>
          reject((captured?.reason as Error) ?? new Error('aborted')),
        );
      });
    });
    const pending = timedFetch('https://example.invalid/manifest', 30_000);
    const assertion = expect(pending).rejects.toThrow(/\[E220\]/);
    vi.advanceTimersByTime(30_000);
    await assertion;
    expect(captured?.aborted).toBe(true);
  });

  it('does not abort before the window elapses', () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) => {
      captured = init?.signal;
      return new Promise<Response>(() => {});
    });
    void timedFetch('https://example.invalid/manifest', 30_000).catch(() => {});
    vi.advanceTimersByTime(29_999);
    expect(captured?.aborted).toBe(false);
  });
});
