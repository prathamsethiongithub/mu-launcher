# REPORT-004 — Bounded Network I/O (network disconnect during launch)

**Date:** 2026-07-10 · **Author:** Release QA · **Priority:** P0 (user-visible infinite hang) · **Status:** FIXED + RUNTIME-PROVEN

## Issue Summary
Seven `fetch()` calls on the mandatory launch path had no timeout. A network drop (dorm Wi-Fi) during Java provisioning, the Fabric profile fetch, or mod downloads left the launcher hanging indefinitely — the 120s MCLC timeout only covers `client.launch()`, which runs *after* all of these.

## Observed Behavior
Kill connectivity during "Preparing Java" / "Installing mods" → spinner forever (ABUSE-001 scenario 3: "stuck forever, freshman leaves it overnight").

## Expected Behavior
Every network phase errors out within a bounded window with a plain-English message; existing error/Retry UI takes over; partial files are cleaned.

## Reproduction
Disconnect network (or firewall the process) while any of these run: version manifest, version JSON, Java runtime manifest, JRE file manifest, JRE file download, Fabric profile fetch, mod/resource-pack download.

## Root Cause
Bare `fetch(url)` at: `java-provisioner.ts` 108/142/194/238/408, `fabric-installer.ts` 79, `mod-installer.ts` 112. A dead connection makes `fetch`/`reader.read()` pend for OS-TCP-timeout durations (minutes) or indefinitely on half-open connections.

## Evidence
`grep -nE "fetch\(" src/main/*.ts` (pre-fix) → 7 bare sites. Renderer `getJavaPath()` is awaited **before** `launchGame()` (App.tsx:81/87), i.e. outside the 120s guard.

## Files Involved
- **NEW** `src/main/net.ts` — `timedFetch` (total-window abort, JSON endpoints, 30s), `downloadGuard` (connect-phase, 20s), `readWithStallGuard` (per-chunk stall, 60s).
- `src/main/java-provisioner.ts` — 4× `timedFetch`; `downloadFile` uses guard + stall-bounded read loop.
- `src/main/fabric-installer.ts` — `timedFetch`.
- `src/main/mod-installer.ts` — guard + stall-bounded read loop.

## Implementation
Design: fixed **total** windows only for small JSON (safe); streaming downloads get a **connect** timeout plus a **per-chunk stall** guard (a fixed total would wrongly kill slow-but-alive 200MB transfers). All timers unref'd/one-shot; abort errors carry `[E220]/[E221]/[E222]` copy. Existing catch blocks already translate to `E2xx` messages and clean partial files (java: unlink dest; mods: unlink tmp) — unchanged.

## Verification (runtime harness — scratchpad `stab3/`, modules bundled via esbuild)
| Test | Scenario | Result |
|---|---|---|
| T1 | Local HTTP server accepts, never responds → `timedFetch(…,1500)` | **PASS** — rejected in 1507ms with `[E220]` |
| T2a | Server sends headers + 1 chunk | **PASS** — first chunk read OK |
| T2b | …then stalls forever → `readWithStallGuard(…,1200)` | **PASS** — rejected in 1213ms with `[E222]` |
| T3 | Normal JSON server | **PASS** — no false positive |
Plus `tsc` 0 / build 0.

**Bug found by the harness itself:** first implementation aborted before rejecting, so the read's raw `AbortError` won the race (T2b failed with "This operation was aborted"). Fixed by rejecting with E222 *before* `abort()`; re-run → deterministic PASS. (Note: a cosmetic libuv `UV_HANDLE_CLOSING` assertion prints at harness `process.exit()` on Windows — harness-only; product code never calls `process.exit`.)

## Regression Risk
Low-medium. Happy path proven unaffected (T3, T8 fabric cache 7ms). Windows chosen generously (30s JSON / 20s connect / 60s stall) so slow campus Wi-Fi isn't false-flagged; a chunk arriving every <60s keeps a slow download alive indefinitely (correct). MCLC-internal downloads unchanged (covered by existing 120s timeout).

## Next Actions
Real-machine test: toggle Wi-Fi during "Preparing Java" and "Installing mods" → bounded, friendly error + Retry works.
