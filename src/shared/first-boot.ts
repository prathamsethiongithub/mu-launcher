/**
 * First-boot expectation copy (first-contact pack, deliverable 1).
 *
 * THE #1 QUIT MOMENT, other half: the user sees "Ready." — the launcher's word
 * for *it worked* — clicks Play, and then waits 158–194 seconds (measured, see
 * truth doc 28) with nothing telling them this is normal. On a potato PC it can
 * run past eight minutes. That silence is where trust dies.
 *
 * The fix is one line of context under the launch button on a world that has
 * never been launched. Not a progress bar, not a spinner with a percentage —
 * just the honest fact stated once, in the product's own lowercase voice, so
 * the wait reads as expected instead of broken.
 *
 * The signal is existing world state: `World.lastPlayedAt` is null until the
 * game has actually exited once (`world-manager.ts:109`). No new field, no new
 * IPC channel, no migration.
 *
 * Deliberately NOT restricted to managed worlds: a personal world's first
 * launch downloads the same client and assets and takes the same minutes. The
 * honest predicate is "this world has never been launched", which is exactly
 * what the state says.
 */

/** The expectation line. Lowercase, no punctuation flourish, no animation. */
export const FIRST_BOOT_COPY = "first time takes a few minutes. it's worth it.";

/** Minimal shape needed to decide — keeps this testable without a World. */
export interface LaunchHistoryLike {
  lastPlayedAt?: number | null;
}

/**
 * True when this world has never finished a launch.
 *
 * A missing field counts as never-launched: a hand-written or legacy registry
 * entry that has no launch history is exactly the entry whose user has never
 * seen the wait before.
 */
export function isFirstBoot(world: LaunchHistoryLike | null | undefined): boolean {
  if (!world) return false;
  return world.lastPlayedAt === null || world.lastPlayedAt === undefined;
}
