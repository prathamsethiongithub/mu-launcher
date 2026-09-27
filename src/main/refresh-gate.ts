/**
 * RefreshGate — single-flight + failure-backoff for token refreshes.
 *
 * RED-TEAM HARDENED (wave 2, B5): `IdentityService.validateSession` refreshes
 * the Microsoft session whenever the stored token is expired, and the renderer
 * can invoke `validate-session` at will. A revoked / permanently-invalid
 * refresh token therefore turns every call into a live request to Microsoft's
 * token endpoint: a UI re-render loop (or a hostile renderer) becomes a refresh
 * storm that burns the account's rate budget and can get the app throttled or
 * the account locked. Concurrent calls had a second failure mode — each one
 * ran a full refresh and then `saveTokens()`, so N in-flight refreshes
 * last-write-win clobbered each other's token state.
 *
 * This gate fixes both:
 *   - `run(key, fn)` COALESCES concurrent calls for the same account: the
 *     second..Nth caller await the first caller's promise instead of hitting
 *     the network again.
 *   - After a failed refresh, further attempts for that account short-circuit
 *     for `cooldownMs` (the previous error is replayed) instead of retrying.
 *
 * The gate is pure: the clock is injected, so the cooldown policy is
 * unit-testable without waiting on real time.
 */

export const DEFAULT_REFRESH_COOLDOWN_MS = 30_000;

interface Failure {
  at: number;
  message: string;
}

export class RefreshGate {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, Failure>();

  constructor(
    private readonly cooldownMs: number = DEFAULT_REFRESH_COOLDOWN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Milliseconds left before another attempt is allowed, or 0 when ready. */
  cooldownRemaining(key: string): number {
    const failure = this.failures.get(key);
    if (!failure) return 0;
    const elapsed = this.now() - failure.at;
    return elapsed >= this.cooldownMs ? 0 : this.cooldownMs - elapsed;
  }

  /** The message from the last failed attempt, or null. */
  lastError(key: string): string | null {
    return this.failures.get(key)?.message ?? null;
  }

  /** True while an attempt for `key` is in flight. */
  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /**
   * Run `fn` for `key` with single-flight + backoff semantics.
   *
   * - Resource-free short circuit if a failure is still inside its cooldown.
   * - Coalesces with an in-flight attempt for the same key.
   * - Records a failure (and starts the cooldown) when `fn` rejects.
   */
  async run(key: string, fn: () => Promise<void>): Promise<void> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    if (this.cooldownRemaining(key) > 0) {
      throw new Error(
        this.failures.get(key)?.message ?? 'Refresh suppressed while backing off.',
      );
    }

    const attempt = (async () => {
      try {
        await fn();
        this.failures.delete(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.failures.set(key, { at: this.now(), message });
        throw err;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, attempt);
    return attempt;
  }

  /** Forget any recorded failure (e.g. after an explicit re-sign-in). */
  reset(key: string): void {
    this.failures.delete(key);
  }
}
