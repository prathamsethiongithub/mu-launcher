# PROJECT TRUTH — Master Launcher

**Audit date:** 2026-09-13 · **Audit scope:** read-only forensic investigation, documentation output only
**Worktree audited:** branch `master`, single commit `b450754` ("Pre-canary stable build") plus a large **uncommitted** worktree delta (+1,909/−3,566 across 40 files — see `git status` in 01-ARCHITECTURE §0).

## What this is

The current mental model of the Master Launcher as it **exists on disk today**. Every load-bearing claim is cited to `file path` + `symbol` (+ line range where practical). Historical documents were treated as evidence only; where code and documents disagree, **source code wins** and the disagreement is recorded in `16-HISTORY-RECONCILIATION.md`.

## Claim statuses used throughout

| Status | Meaning |
|---|---|
| `CONFIRMED` | Verified directly against current source (file/symbol/lines cited) |
| `INFERRED` | Deduced from current source with stated reasoning chain |
| `HISTORICAL` | True of a past state; documented in REPORTs/TIMELINE, not re-verified as current |
| `STALE` | Document claim no longer matches current source |
| `CONTRADICTORY` | Two current sources disagree; both recorded |
| `UNKNOWN` | Could not be established from available evidence; not guessed |

## Files

| File | Contents |
|---|---|
| `01-ARCHITECTURE.md` | System shape, process boundaries, entry points, Phase-0 git state |
| `02-FILE-MAP.md` | Every owning file grouped by responsibility, incl. dead/orphan files |
| `03-IPC-MAP.md` | Full Electron IPC boundary: 42 invoke channels + 5 event channels |
| `04-STATE-OWNERSHIP.md` | Source of truth / in-memory / persisted / derived for every major state |
| `05-CONTRACTS.md` | Cross-boundary type contracts and implicit contracts |
| `06-AUTH-IDENTITY.md` | Legacy AuthService ↔ IdentityService, resolution rule, resurrection guard |
| `07-LAUNCH-PIPELINE.md` | Play click → Minecraft running, every stage, failure/cancel paths |
| `08-IGNITION.md` | Progress events → buckets → ForgeLine; backend-truth vs UI status |
| `09-SKIN-ANIMATION.md` | skinview3d lifecycle, RAF chain, PlayerDirector poses/gaze |
| `10-VISUAL-ARCHITECTURE.md` | Lighting/CSS/composition contributors incl. yellow-shift analysis |
| `11-UI-ARCHITECTURE.md` | Views, ownership boundaries, state flow |
| `12-PERSISTENCE.md` | Every persisted path, schema, owner, recovery behavior |
| `13-EXTERNAL-DEPENDENCIES.md` | msmc, MCLC, skinview3d, three, Fabric, Modrinth, Mojang, Adoptium-adjacent |
| `14-LIFECYCLE.md` | Concurrency, races, stale callbacks, restart behavior |
| `15-VERIFICATION.md` | `~/mu-verify` harness inventory with evidence levels |
| `16-HISTORY-RECONCILIATION.md` | Doc claims vs current source, classified |
| `17-KNOWN-RISKS.md` | Ranked risks (CRITICAL/HIGH/MEDIUM/LOW) — documented, not fixed |
| `18-PRODUCT-INVARIANTS.md` | Current status of the product-level invariants |

Machine-readable models in `model/`: `inventory.json`, `components.json`, `ipc.json`, `state.json`, `flows.json`, `contracts.json`, `dependencies.json`, `verification.json`, `risks.json`.

## Method

1. Phase 0 git capture (status/branch/log/diff — no worktree mutation).
2. Read every main-process, preload, shared, and renderer source file in full.
3. `ipcMain.handle` ↔ `ipcRenderer.invoke` cross-grep to pair every channel (no name-guessing).
4. Line-level reads of the auth resolution, removal guard, lighting config, and persistence paths.
5. Read of all 8 REPORT-*.md, TIMELINE, DEBUG-ARCHIVE, handoff docs for Phase-14 reconciliation.
6. Worktree re-verification (`git status`) to prove only `docs/project-truth/` changed.

## Known limitations of this audit

- No runtime observation was performed (read-only mandate): all behavior claims are static-source `CONFIRMED`; runtime behavior claims remain `INFERRED` unless a prior REPORT ran them (marked `HISTORICAL`).
- The `mu-verify` harnesses live **outside** the repo (`C:\Users\fortn\mu-verify\`); they were inspected but their behavior claims depend on focus/timing assumptions documented in 15-VERIFICATION.
- `identity-tokens.bin` encryption strength (safeStorage backend on this machine) is `UNKNOWN`.
