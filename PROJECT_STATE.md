# PROJECT_STATE

**Last updated:** 2026-07-10 (Stabilization Sprint 3) by Release QA
**Read this first.** Another model should be able to continue from this file alone.

## Working Systems
- ✅ Microsoft Auth (MSMC Electron popup) + persisted session (`safeStorage`); corrupt session self-deletes → re-login
- ✅ Java provisioning (Mojang runtime, SHA-1 per file, **version-aware** smoke test, cache; partials self-heal)
- ✅ Minecraft launch (MCLC, pinned 26.1.2) with 120s timeout; Fabric 0.19.3 via validated+atomic cached profile
- ✅ Mods/resource packs (hash-verified, atomic, per-item non-fatal, stall-guarded downloads)
- ✅ Server injection (atomic, idempotent, **corrupt-file recovery with .corrupt backup** — runtime-proven)
- ✅ Launch-progress UI survives navigation (state lifted to App)
- ✅ Single-instance lock (packaged builds)
- ✅ **Launch guards**: UI (Play hidden) → renderer re-entry ref → main-side `launchInProgress` [E604] + `isRunning()` [E605]
- ✅ **All custom network I/O bounded** (`net.ts`: 30s JSON / 20s connect / 60s-stall downloads) — runtime-proven
- ✅ Gates: `tsc --noEmit` = 0 · `electron-vite build` = 0

## Completed Fixes
| Sprint | Fix | Report | Proof |
|---|---|---|---|
| 2 | BUG-001 launch-state reset on navigation | REPORT-001 | static + build |
| 2 | typecheck blockers (mod-list strings, smokeTest arity) | REPORT-002 | tsc 0 |
| 2/3 | main-side launch guard (spam + already-running) | REPORT-003 | static; flag lifecycle traced |
| 3 | bounded network I/O (7 sites) + stall guard | REPORT-004 | **runtime harness: NET 4/4** |
| 3 | fabric cache validate + atomic write | REPORT-005 A | **runtime: FABRIC 3/3** |
| 3 | servers.dat corrupt recovery (backup + rebuild) | REPORT-005 B | **runtime: INJECT 7/7** |

## Known Bugs / Risks (open, triaged)
- **[P0 release-ops] Not a git repository** — no history/rollback/CI. Blocks managed release.
- **[P0 release] Unsigned installer** — SmartScreen/AV funnel leak.
- **[P1 process] Runtime E2E unperformed** — this environment cannot drive the Electron GUI; fresh-machine chain unproven end-to-end.
- **[P2] Launcher restart while game open** → new process can't see the running game (E605 blind across processes); second instance possible.
- **[P2] No JRE download resume** — interruption restarts JRE from 0% (self-heals, just slow).
- **[P2] Lint debt** — 10 pre-existing errors in working code (`no-require-imports` launch-service, `no-explicit-any`, `adm-zip.d.ts` merging, `no-async-promise-executor` auth). Do NOT refactor working systems without a proven defect.
- **[P3] Dead code** `src/main/mod-list.ts` (superseded by generated `mod-data.ts`) — recommend deletion.
- **[P3] `runPreflightCheck` built but unwired** in renderer — redundant post-timeouts; leave or wire later.
- **[P3] Orphaned `.tmp`** files possible if killed mid-mod-download (harmless junk).

## Open Investigations
None active. Next planned work is verification, not code: real-machine E2E script (see RELEASE_READINESS "Fresh Machine Status").

## Current Focus
Stabilization only. No features, no UI redesign, no refactors. Code is ahead of process: version control + signing + one real E2E are the release bottlenecks.

## Release Readiness
See RELEASE_READINESS.md. Summary: 🔴 NO-GO wide · 🟡 conditional GO for supervised pilot after one clean fresh-machine E2E. All Sprint-3 stability scenarios are fixed-and-proven (runtime harness) or audited-with-evidence.
