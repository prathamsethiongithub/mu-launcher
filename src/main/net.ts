/**
 * Bounded network helpers.
 *
 * Every fetch on the launch path must be bounded: a dead or stalling
 * connection has to surface as a catchable error, never an indefinite hang.
 * The 120s MCLC launch timeout does NOT cover these phases — Java
 * provisioning, the Fabric profile fetch, and mod downloads all run before
 * (or outside) that timeout, so without these guards a network drop leaves
 * the launcher spinning forever (Stabilization Sprint 3, TEST "network
 * disconnect during launch").
 */

/**
 * fetch() with a total-window timeout covering headers AND body.
 * Intended for small JSON endpoints (Mojang manifests, Fabric Meta).
 * The timer is one-shot and unref'd; aborting after completion is a no-op,
 * so callers do not need to clear anything — they must simply consume the
 * body within the window (30s default is generous for KB-sized JSON).
 */
export async function timedFetch(url: string, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `[E220] Network request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            'Please check your internet connection and try again.',
        ),
      ),
    timeoutMs,
  );
  timer.unref?.();
  return fetch(url, { signal: controller.signal });
}

export interface DownloadGuard {
  controller: AbortController;
  /** Call once response headers arrive to stop the connect-phase timer. */
  headersReceived: () => void;
}

/**
 * AbortController wired to a connect-phase timeout, for streaming downloads
 * where a fixed total window would wrongly kill slow-but-alive transfers.
 * Pair with readWithStallGuard() to bound the body phase per-chunk.
 */
export function downloadGuard(connectTimeoutMs = 20_000): DownloadGuard {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `[E221] Could not reach the download server within ${Math.round(connectTimeoutMs / 1000)}s. ` +
            'Please check your internet connection and try again.',
        ),
      ),
    connectTimeoutMs,
  );
  timer.unref?.();
  return { controller, headersReceived: () => clearTimeout(timer) };
}

/**
 * Await a single stream read, aborting (and rejecting) if no data arrives
 * within stallTimeoutMs. A connection that dies mid-download otherwise makes
 * reader.read() pend for many minutes (OS TCP timeout) or forever.
 */
export async function readWithStallGuard<T>(
  readPromise: Promise<T>,
  controller: AbortController,
  stallTimeoutMs = 60_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject FIRST so the race deterministically settles with our E222,
      // then abort. (abort() can reject the raced read synchronously, which
      // would otherwise win the race with a raw AbortError — proven by the
      // Sprint-3 harness.) Swallow the read's own rejection so it cannot
      // surface as an unhandled rejection after the race has settled.
      reject(
        new Error(
          `[E222] Download stalled — no data received for ${Math.round(stallTimeoutMs / 1000)}s. ` +
            'Please check your internet connection and try again.',
        ),
      );
      void readPromise.catch(() => {});
      controller.abort();
    }, stallTimeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([readPromise, stall]);
  } finally {
    clearTimeout(timer);
  }
}
