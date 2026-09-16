# 17 — KNOWN RISKS

Ranked by severity. **Documented only — nothing was fixed.**

## CRITICAL

| # | Risk | Evidence | Why it matters |
|---|---|---|---|
| R-01 | **three.js dual-copy fragility** — the dedupe aliases in `electron.vite.config.ts` are the only thing keeping skinview3d (pins r156) off the nested r156 runtime; any dependency resolution change (npm update, lockfile regeneration, upstream skinview3d bump) can re-nest r156 and reintroduce the frame-one `getProgram()` crash that froze the RAF loop | electron.vite.config.ts L22–41 | One lockfile change = dead hero character; symptom is subtle (silent freeze, `renderPaused=false` never re-arms) |
| R-02 | **No automated test suite at all** — every guarantee rests on manual harness runs (`CONFIRMED`: no test script) | package.json | Regressions in auth/launch/persistence have no safety net; REPORT fixes are logic-traced, not continuously verified |

## HIGH

| # | Risk | Evidence |
|---|---|---|
| R-03 | **Uncommitted mega-delta on master** — the entire current architecture (+1,909/−3,566 incl. identity, worlds, lab-corrected lighting) exists only in the worktree of a single-commit repo; any `git checkout/reset` loses it | Phase-0 capture (01-ARCHITECTURE §0) |
| R-04 | **`mod-data.ts` manifest rot** — static URLs+hashes to CDN files; upstream deletes/moves → per-file download failures at every launch (non-fatal but degrading) | mod-data.ts, mod-installer |
| R-05 | **Legacy `auth-session.bin` remains a live fallback path** — any future code that creates/imports a legacy session without the UUID convergence re-opens the resurrection class of bug (the guard protects removal only) | 06-AUTH; convergence exists only in `add-microsoft-account` |
| R-06 | **servers.dat uncompressed-NBT assumption** — pinned to MC 26.1.2 behavior; a Minecraft update changing the expectation silently breaks server injection (launch proceeds, server missing) | server-injector L195 |
| R-07 | **Orphaned-Minecraft double-instance window** — E605 can't see a game left running from a previous launcher session | REPORT-003 limitation, still current |

## MEDIUM

| # | Risk | Evidence |
|---|---|---|
| R-08 | Concurrent Java provisioning possible via direct bridge call (no in-flight guard) | java-provisioner (14-LIFECYCLE #2) |
| R-09 | Stale numeric guards in `mu-verify` (calibrated pre-001) could "certify" a wrong look if reused without recalibration | 15-VERIFICATION; lab INDEX note |
| R-10 | `identity.json`/`worlds.json` have no schema versioning and no explicit corruption-repair path (unlike session/servers.dat/fabric which all recover) | 12-PERSISTENCE |
| R-11 | `launch-poc` duplicate launch path shares resolution but can drift | index.ts L427 |
| R-12 | `WorldData` type duplicated across 5 renderer files (drift already bit once — `createdAt`) | REPORT-006 gap #3; grep |
| R-13 | `env.d.ts` hand-maintained surface can drift from preload (already 1 drift: `getJavaPath` arity) | 16-HISTORY #1 |

## LOW

| # | Risk | Evidence |
|---|---|---|
| R-14 | `run-preflight-check` orphan — dead IPC surface invites misuse-as-API | index.ts L814 |
| R-15 | `removeAllListeners` teardown pattern drops any future second subscriber silently | preload L263/L90 |
| R-16 | AuthView/DockNav dead files confuse navigation archaeology | 02-FILE-MAP |
| R-17 | Unsigned NSIS builds → SmartScreen friction (expected, worth knowing for support) | electron-builder.yml |
| R-18 | `wmic` dependency in preflight (deprecated on newest Windows; file is orphaned anyway) | preflight-check L69–72 |
| R-19 | Skins race on fast account switching (visual flash only) | 14-LIFECYCLE #3 |

## Security boundaries (documented)

- Preload bridge is wide but typed; no `nodeIntegration`; `open-external-link` allowlisted via `ipc-validate.ts`.
- Token files use safeStorage (machine-keyed); **backend strength is machine-dependent** — `UNKNOWN`.
- Filesystem paths never cross the bridge for skins (main-side staging) — a deliberate boundary worth preserving.
