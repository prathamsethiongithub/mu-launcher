# REPORT-002 — Typecheck/Build Blockers (mod-list strings + smokeTest arity)

**Date:** 2026-07-10
**Author:** Release QA
**Priority:** P0 for CI/release gate (`npm run typecheck` was red); P2 latent runtime reliability
**Status:** FIXED (typecheck + build now green)

## Issue Summary
`npm run typecheck` failed with dozens of errors from two independent root causes:
1. Unterminated string literals in `src/main/mod-list.ts` (unescaped apostrophes inside single-quoted strings).
2. `src/main/java-provisioner.ts:170` calls `smokeTest(cachedPath, expectedMajorVersion)` (2 args) but `smokeTest` was declared with 1 parameter.

## Observed Behavior
- `npx tsc --noEmit` → exit 2, many `TS1002 Unterminated string literal` / `TS1005` in `mod-list.ts`, plus `TS2554 Expected 1 arguments, but got 2` in `java-provisioner.ts`.
- `npm run build` (electron-vite/esbuild) **passed** — because esbuild does not type-check and `mod-list.ts` is unimported dead code (never bundled).

## Expected Behavior
`npm run typecheck` exits 0 so the release gate is green.

## Reproduction Steps
`npx tsc --noEmit`

## Evidence
- Offending strings in `mod-list.ts`: `'Reese's Sodium Options'`, `'Xaero's Minimap'`, `'Xaero's World Map'`, `'(Bee's) Fancy Crops'`, `'Icon Xaero's 1.22.zip'` / `'Icon Xaero's'` — apostrophes closed the string early.
- Import graph: `grep -rn "mod-list|mod-data" src/` → only `mod-installer.ts` imports `./mod-data`; `mod-list.ts` has **no importers** (dead/duplicate of the auto-generated `mod-data.ts`).
- `smokeTest` defined at `java-provisioner.ts:340` as `(javaPath: string)`, checked only `major >= 17`; called with a second `expectedMajorVersion` at line 170 (cache-hit path). The extra arg was dropped at runtime → cache validation was **not** version-aware, despite the code's intent.

## Root Cause
1. Apostrophes not escaped inside single-quoted string literals.
2. `smokeTest`'s signature was never updated to accept the `expectedMajorVersion` its cache-validation caller passes.

## Files Involved
- `src/main/mod-list.ts`
- `src/main/java-provisioner.ts`

## Implementation
- Escaped the apostrophes (`\'`) and removed the stray `\(`/`\)` intent so the literals terminate correctly.
- `smokeTest(javaPath, expectedMajorVersion?)`: keeps the `>= 17` baseline; when `expectedMajorVersion` is supplied, additionally requires an **exact** major-version match so a stale cached Java of the wrong version is rejected and re-provisioned. The other caller (line 320) passes one arg → unchanged behavior.

## Verification
- `npx tsc --noEmit` → **exit 0** (0 errors).
- `npm run build` → success (main/preload/renderer all built).

## Regression Risk
- `mod-list.ts`: **zero runtime risk** — it is not imported or bundled.
- `java-provisioner.ts`: happy path unchanged — a correct cached Java still matches `expectedMajorVersion` → cache hit. Only a wrong-version stale cache is now rejected (→ re-download), which is the intended reliability improvement.

## Next Actions
- **Recommended:** delete `src/main/mod-list.ts` — it is dead, superseded by the auto-generated `src/main/mod-data.ts` (proof above). Left in place this turn to avoid an unrequested destructive change; flagged for a human decision.
- Lint remains red from **pre-existing** debt unrelated to these fixes (`no-require-imports` in `launch-service.ts`, `no-explicit-any`, `adm-zip.d.ts` unsafe declaration merging, `no-async-promise-executor` in `auth-service.ts`). Triage separately — do NOT refactor working systems (esp. auth) without proof of a real defect. See PROJECT_STATE.
