# RELEASE_READINESS

**Date:** 2026-07-10 (post Stabilization Sprint 3) · **Prepared by:** Release QA
**Verification levels used:** `static` (code proof + tsc/build) · `runtime-harness` (real modules exercised under Node with fault injection) · `runtime-E2E` (real machine, GUI) — only the last is missing in this environment.

## Completed Systems
Auth+session, Java provisioning, MC 26.1.2 + Fabric 0.19.3 launch, mods/resource packs, server injection, repeat launches, launch-progress UI, single-instance, launch guards, bounded network I/O. Gates green: `tsc` 0, build 0.

## Stability Test Matrix (Sprint-3 scope)
| Test | Scenario | Status | Proof |
|---|---|---|---|
| Minecraft already running | second launch while game alive | **FIXED (guard)** | E605 at IPC layer; static trace (REPORT-003). Cross-process restart gap = P2 known limitation |
| Play spam ×10 | rapid re-clicks | **FIXED (3-layer guard)** | UI hidden + renderer ref + main E604; static (REPORT-003) |
| Network disconnect during launch | drop Wi-Fi at any custom phase | **FIXED + RUNTIME-PROVEN** | harness NET 4/4: E220 @1507ms, E222 @1213ms, no false positives (REPORT-004) |
| Close launcher during launch | kill mid-download/mid-write | **NO PERMANENT BREAKAGE (audited)** | JRE self-heals (pointer-after-smoke-test); fabric now atomic+validated; servers.dat atomic; mods atomic. Cost = re-download time only (REPORT-005 E) |
| Corrupt cache/session | garbage in any persisted state | **FIXED + RUNTIME-PROVEN / RECOVERS** | INJECT 7/7 (backup+rebuild, user entries preserved); FABRIC 3/3 (validate+refetch); session/java/mods audited recovering (REPORT-005 A-C) |
| Missing Java | cache stale/deleted, no system Java | **RECOVERS (audited)** | re-provision path + bounded failure (REPORT-005 D) |
| Fresh machine | first-run directory/IO walk | **PASS (static audit)** | every write path mkdirs first (REPORT-005 F); runtime-E2E still required |
| Offline/error handling | each phase offline | **BOUNDED (audited)** | ≤30s JSON / ≤20s connect / ≤60s stall / ≤120s MCLC; friendly E-codes + Retry (REPORT-005 G) |

## Remaining Bugs
P2: cross-process already-running blindness after launcher restart · no JRE resume · lint debt · P3: dead `mod-list.ts`, unwired preflight, orphaned `.tmp`.

## Known Risks (release-blocking, non-code)
1. **No version control** (no git → no rollback/CI/managed release).
2. **Unsigned installer** (SmartScreen/AV — top funnel leak).
3. **No runtime-E2E performed** — environment cannot drive the GUI.

## Fresh Machine Status
`Install → Login → Play → Join Server → Close → Repeat`: **UNVERIFIED at runtime-E2E level.** Static audit passes; all fault-injection harness tests pass; the one remaining step is a human (or GUI-driving agent) executing the chain on real Windows hardware and recording it as DEBUG-007.

## Recommended Release Decision
### 🔴 NO-GO — wide/public release
Version control absent + unsigned installer + E2E unproven.
### 🟡 CONDITIONAL GO — supervised pilot (≤ a few testers)
After: (1) one clean fresh-machine E2E recorded; (2) gates still green (✅ today); (3) during that E2E, spot-check the two headline fixes live: navigation-during-launch and Wi-Fi-toggle-during-Java.
### Gate to full GO (100 students)
git init + release pipeline · signed installer · pilot telemetry clean · P2s accepted or fixed.

**Bottom line:** every stability scenario students were predicted to hit now has a proven fix or an evidence-backed recovery path — the launcher's remaining risk is operational (git, signing, one real E2E), not behavioral.
