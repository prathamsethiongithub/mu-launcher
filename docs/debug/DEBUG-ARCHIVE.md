# DEBUG Archive — Investigation Diary Digest (DEBUG-001…006)

> The six per-session investigation diaries (`docs/debug/DEBUG-001..006.md`) were merged
> into this digest on **2026-09-11** and deleted to reduce doc duplication. Their full
> outcomes live in `REPORT-001..005` (repo root) and `PROJECT_STATE.md`. This file keeps
> the one-paragraph essence of each investigation. All dates are 2026-07-10 (Sprint 2–3).

## DEBUG-001 — Launch state reset on navigation
PlayView held launch state in local `useState` and attached the `launch-step` IPC listener in `handlePlay`; the view unmounts on navigation, so progress reset while the backend kept running. Also found: `registerStepListener()` leaks a listener per Play press. Root cause confirmed by reading index.ts / App.tsx / PlayView.tsx / preload. Fixed by lifting state to App.tsx with a single app-scope listener → REPORT-001.

## DEBUG-002 — Typecheck red while build green
`npx tsc --noEmit` failed while `npm run build` passed. Cause: the errors lived in dead code (`mod-list.ts` mod-name strings, plus a `smokeTest` arity mismatch) not reachable from build entrypoints, so esbuild never parsed it but tsc checks all included files. Lesson recorded: build ≠ typecheck; both are gates. Fixes → REPORT-002.

## DEBUG-003 — java-provisioner smokeTest arity
`smokeTest` was called with an expected-version argument it didn't accept, so version-aware Java cache validation silently never ran. Real defect (stale/partial JRE could pass), not cosmetic. Signature widened, cache made version-aware → REPORT-002.

## DEBUG-04 — Launch-guard verification + failure-mode sweep
Verified FIX A (main-side launch guard: `launchInProgress` [E604] + `isRunning()` [E605]) survived on disk, then proved the remaining Sprint-3 risks concentrated in: unbounded fetches (→ DEBUG-005), unvalidated fabric cache and corrupt servers.dat (→ DEBUG-006). Everything else already recovered by design.

## DEBUG-005 — Bounded network I/O + runtime harness
Seven bare `fetch` sites could hang forever on network drop. Design decision: JSON gets a 30s total window; streaming downloads get 20s connect timeout + 60s per-chunk stall guard (a fixed total would kill slow-but-alive big downloads). New `src/main/net.ts`; wired into java-provisioner, fabric profile fetch, mod downloads. **Runtime-proven** (fault injection harness) → REPORT-004.

## DEBUG-006 — Corrupt-state recovery + audits
Two permanent-breakage paths closed: fabric cache now validates cached JSON (`id` required), deletes + refetches on corruption, writes atomically (tmp+rename); server-injector isolates parse and renames corrupt `servers.dat` to `servers.dat.corrupt-<ts>` (user data preserved) before rebuilding. Runtime harness: INJECT 7/7, FABRIC 3/3. Audits confirmed session/Java/JRE-partials/mods all recover by design; fresh-machine walk found no missing-mkdir path. → REPORT-005.
