# DEBUG-005 — Sprint 3: bounded network I/O + runtime harness

**Timestamp:** 2026-07-10 (session order #5)
**Objective:** Eliminate indefinite hangs on network drop (7 bare fetch sites) and PROVE the behavior at runtime, not by inspection.

**Hypothesis:** Total-window timeout is right for JSON; streaming needs connect-timeout + per-chunk stall guard (fixed total would kill slow-but-alive big downloads).

**Investigation/Implementation:** new `src/main/net.ts` (`timedFetch` 30s, `downloadGuard` 20s connect, `readWithStallGuard` 60s/chunk); swapped 4 JSON sites + wrapped the JRE download loop (java-provisioner), fabric profile fetch, mod download loop.

**Evidence (runtime harness, scratchpad `stab3/`, real modules bundled via esbuild, electron stubbed):**
- T1 dead server (accepts, never responds): `timedFetch(…,1500)` rejected in **1507ms** with `[E220]` ✔
- T2a stalling server: first chunk read OK ✔
- T2b then silence: `readWithStallGuard(…,1200)` — **first run FAILED**: rejected at 1211ms but with raw `AbortError` ("This operation was aborted"). Root cause: `abort()` was called before `reject()`, so the read's rejection won the `Promise.race`. **Fixed net.ts ordering (reject → swallow → abort)**; re-run → rejected in **1213ms** with `[E222]` ✔
- T3 healthy server: no false positive ✔ → **NET: ALL PASS**
- Cosmetic: libuv `UV_HANDLE_CLOSING` assertion at harness `process.exit()` on Windows — harness-only artifact (prints after verdicts); product code never calls `process.exit`.

**Conclusion:** every custom network phase is now bounded and produces catchable `[E22x]` errors; existing catch blocks translate + clean partials. The harness paid for itself by catching the race-ordering bug pre-ship.
**Result:** tsc 0 / build 0 after fix. See REPORT-004.
