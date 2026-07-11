# REPORT-003 — Launch Guards: "Minecraft already running" + Play spam

**Date:** 2026-07-10 · **Author:** Release QA · **Priority:** P1 · **Status:** FIXED (static-verified; runtime E2E pending on a real machine)

## Issue Summary
The `launch-game` IPC handler had no concurrency protection: nothing stopped a second launch while one was orchestrating, or while a Minecraft process was already alive.

## Observed Behavior
Two rapid `launch-game` invocations each created a fresh `LaunchManager`; the second overwrote the module-level reference, orphaning the first (uncancellable) and allowing two Minecraft processes (ABUSE-001 scenario 2).

## Expected Behavior
One launch at a time. Second attempt during orchestration → clear error. Attempt while the game is running → clear error.

## Reproduction
1. (Spam) Invoke `launch-game` twice back-to-back (devtools: `window.electronAPI.launchGame(p)` ×2).
2. (Already running) Launch, wait for Minecraft, invoke `launch-game` again.

## Root Cause
`src/main/index.ts` `launch-game` unconditionally did `launchManager = new LaunchManager()` — no in-progress flag, no `isRunning()` check. UI-level protection (Play hidden while `launching`) is not authoritative.

## Evidence
Pre-fix `index.ts` (no guard around handler); `launch-service.ts` `isRunning()` existed but was never consulted by the handler. ABUSE-001 documented the two-window outcome.

## Files Involved
`src/main/index.ts`

## Implementation
- Module-level `launchInProgress` flag; set before orchestration, cleared in `finally`.
- Guard at handler entry: in-progress → `{success:false, error:'[E604] A launch is already in progress…'}`; `launchManager.isRunning()` → `[E605] Minecraft is already running…`.
- Renderer already renders `success:false` errors via the existing error card (no UI change).
- Defense-in-depth stack: Play button hidden while launching (UI) → `launchingRef` re-entry guard (renderer, REPORT-001) → **E604/E605 (main, authoritative)**.

## Verification
- `npx tsc --noEmit` → 0; `npm run build` → 0.
- Guard presence verified on disk (`grep launchInProgress|E604|E605` → lines 15/187/191/200/221).
- Logic trace: success path clears flag in `finally`; failure path clears in `finally`; cancel path resolves/rejects `launchWithFabric` → `finally` runs. No path leaves the flag stuck.
- Runtime click-test pending on a real machine (GUI not drivable in this environment) — tracked in RELEASE_READINESS.

## Regression Risk
Low. Pure additive guard at one entry point; error shape identical to existing failures; single-flag lifecycle covered by `finally`.

## Known Limitation (documented, not fixed)
If the **launcher itself is restarted** while Minecraft is still open, the new process has a fresh `launchManager` (null) — E605 cannot see the orphaned game and a second instance can be launched. Cross-process game detection is out of minimal scope; recorded as P2 in PROJECT_STATE.

## Next Actions
Real-machine TEST: Play ×10 rapid clicks → exactly one game; Play while game open → E605 error card.
