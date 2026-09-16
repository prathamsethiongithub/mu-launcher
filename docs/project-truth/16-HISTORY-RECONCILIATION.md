# 16 — HISTORY RECONCILIATION

Document claims vs current source. Classification: `CURRENT` / `HISTORICAL` / `INTENDED` / `STALE` / `CONTRADICTORY` / `UNKNOWN`.

## Root documents

| Document | Claim | Status | Notes |
|---|---|---|---|
| `README.md` | Product description/setup | `CURRENT` (describes scripts that exist) | – |
| `AGENT-HANDBOOK.md` | Working conventions for agents | `CURRENT` (process doc) | Not architecture |
| `PROJECT_STATE.md` | Session log incl. lighting lab outcomes | `CURRENT` for the 001-amber-restored state; `HISTORICAL` for earlier sessions | Matches PlayerDirector comments |
| `DESIGN.md` | EMBER design laws (one flame per screen, type carries state…) | `CURRENT` as *intent*; REPORT-008 shipped the alignment pass | Design constitution, not mechanism |
| `RELEASE_READINESS.md` | Pending real-machine test list | `HISTORICAL` (several listed tests later run via REPORTs; list not maintained) | Unknown which items remain — `UNKNOWN` |
| `CONTRIBUTING.md` | Contribution flow | `CURRENT` | – |
| `docs/TIMELINE.md` | Session chronology | `HISTORICAL` | Evidence-only |
| `docs/debug/DEBUG-ARCHIVE.md` | Archived debug sessions | `HISTORICAL` | Supersedes deleted DEBUG-001..006 (deleted in worktree) |
| `FREEBUFF-LOOK-HERE.md` | Session-10 entry context | `HISTORICAL` | Pre-lab state |
| `FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md` | PlayerDirector design handoff | `INTENDED`/`HISTORICAL` | Current source implements it with post-lab amendments (palette of record, fill removal); the doc does not reflect 001 — read source for truth |

## REPORT series

| Report | Claim | Status vs current source |
|---|---|---|
| REPORT-001 | Launch state lifted to App; single listener; props-driven PlayView | **`CURRENT`** — verified in App.tsx/PlayView.tsx |
| REPORT-002 | mod-list dead code + smokeTest arity fixed | **`CURRENT`** (worktree now *deletes* mod-list.ts — staged; smokeTest has 2-arg signature, java-provisioner L341) |
| REPORT-003 | E604/E605 guards + `launchInProgress` finally-cleared | **`CURRENT`** in index.ts; documented limitation (no cross-process detection) still true |
| REPORT-004 | net.ts bounded I/O at 7 former bare-fetch sites | **`CURRENT`** (timedFetch/downloadGuard/readWithStallGuard present and used in java-provisioner/fabric-installer/mod-installer); runtime proofs `HISTORICAL` |
| REPORT-005 | Fabric cache validation + atomic writes; servers.dat corrupt recovery; recovery matrix | **`CURRENT`** in source; runtime proofs `HISTORICAL` |
| REPORT-006 | RC-1 stable canvas tree; RC-2 static import; identity UX; gaps list | **`CURRENT`** — and its gap list remains accurate: launch now uses identity (REPORT-007 closed gap #1); AuthView still orphaned; WorldData still duplicated ×5 (was ×4 in the report; SettingsView added); offline skins still default; validate-session still mutates |
| REPORT-007 | resolvePlayerIdentity single rule; no silent wrong-person launches | **`CURRENT`** (index.ts L165–212) |
| REPORT-008 | 14 design subtractions | `HISTORICAL` (spot-checked rows match current code) |

## Contradictions / stale spots found

1. **`env.d.ts` vs preload:** `getJavaPath` typed 0-arg; main/preload accept optional `mcVersion`. Renderer passes none. Minor drift — `CONTRADICTORY` (types) with a practical no-op.
2. **`FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md`** describes the Stage-10 rig regime (fill light, dominant key ramp) that `001-amber-restored` then replaced. Doc is `STALE` on lighting; `CURRENT` on pose machinery.
3. **`_graveyard/` referenced in some docs as archived code**: the directory is **deleted in the worktree** (git status). Docs mentioning it as extant are `STALE`.
4. **`mod-list.ts`**: REPORT-002 said "left in place… flagged for a human decision" — the worktree has since staged its deletion. Report text is `HISTORICAL`; tree state is the newer truth.
5. **`RELEASE_READINESS.md`** test checklist vs completed REPORT verifications: overlap unmaintained — `UNKNOWN` which items are genuinely outstanding.
6. **`mu-verify` calibration numbers** (hue ≈34°, G/R ≈0.72) vs lab-measured 001 values (hue 32.2°, G/R 0.566): guard thresholds were calibrated on a different framing/lighting — the INDEX itself flags the p85 gate stale. `CONTRADICTORY` with the current look; needs recalibration before reuse as an invariant.
7. **README/DESIGN describe "Setup" as configurable memory**; current SettingsView is read-only manifest (memory lives in world creation + world registry). `STALE`/`INTENDED` depending on reading.

## Reconciliation rule applied

Where a document and source disagree, source won and the disagreement was recorded above — nothing was silently harmonized, and no document was edited by this audit (documentation of discrepancies only).
