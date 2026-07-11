# DEBUG-002 — Typecheck red / build-vs-typecheck divergence

**Timestamp:** 2026-07-10 (session order #2)
**Objective:** Verifying REPORT-001, `npx tsc --noEmit` failed with many errors while `npm run build` passed. Determine why and whether it's a release blocker.

**Hypothesis:** The errors are in a file not reachable from the build entrypoints (dead code), so esbuild never parses it, but `tsc` (which checks all `include`d files) does.

**Investigation:**
- `npm run build` → exit 0 (main 70.6 kB, preload, renderer all built).
- `npx tsc --noEmit` → exit 2; errors all in `src/main/mod-list.ts` (`TS1002 Unterminated string literal`, `TS1005`).
- `sed -n` on flagged lines → apostrophes inside single-quoted strings: `'Reese's …'`, `'Xaero's …'`, `'Icon Xaero's'`, `'(Bee's) …'`.
- Import graph: `grep -rn "mod-list|mod-data" src/` → only `mod-installer.ts` imports `./mod-data`; **nothing imports `mod-list.ts`**. `mod-data.ts` header says "Auto-generated …". So `mod-list.ts` is a dead, hand-maintained duplicate.

**Evidence:** Build passes because esbuild tree-shakes to reachable modules only; `mod-list.ts` is never bundled. `tsc` checks it → red. So the release gate (`typecheck`) is broken, runtime is not.

**Conclusion:** Real CI/release blocker (typecheck), zero runtime impact. Fix = escape apostrophes. Also recommend deleting the dead file.

**Result:** Apostrophes escaped. After fix, `tsc` surfaced one further, unrelated error in a LIVE file (`java-provisioner.ts:170`) → see DEBUG-003. Build remained green throughout.
