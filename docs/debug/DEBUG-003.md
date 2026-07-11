# DEBUG-003 — java-provisioner smokeTest arity / version-aware cache

**Timestamp:** 2026-07-10 (session order #3)
**Objective:** After fixing mod-list, `tsc` reported `java-provisioner.ts(170): Expected 1 arguments, but got 2`. Determine if it's cosmetic or a real reliability defect before changing launch-path code.

**Hypothesis:** `smokeTest` is called with an expected-version arg it doesn't accept, so version-aware cache validation is silently not happening.

**Investigation:**
- `grep -n smokeTest java-provisioner.ts` → def at 340 `smokeTest(javaPath: string)`; callers at 170 `smokeTest(cachedPath, expectedMajorVersion)` and 320 `smokeTest(finalJavaPath)`.
- Read body (340–391): on `-version`, parses major via regex, returns `major >= 17`. Comment at 386: "The caller also ensures the component-specific version matches" — but the caller passes the expected version INTO smokeTest, which drops it.
- Confirmed `java-provisioner` is on the live launch path (imported by `index.ts`, used by `get-java-path`).

**Evidence:** Cache-hit path (166–176) intended to reject a cached Java whose major version ≠ the target MC's required major. Because the arg is dropped, any cached Java ≥17 is accepted. Benign today (single pinned MC/Java 26.1.2), but a Java-major bump with a stale `current-java-path.txt` would launch the wrong Java → Play breaks.

**Conclusion:** Real latent P2 reliability bug + the last typecheck blocker. Root cause: signature never updated to accept `expectedMajorVersion`.

**Result:** `smokeTest(javaPath, expectedMajorVersion?)` — keeps `>=17` baseline; exact-match only when an expected version is provided (line-320 caller unchanged). `npx tsc --noEmit` → **exit 0**; `npm run build` → green. Happy path unchanged; only wrong-version stale cache now re-provisions. See REPORT-002.
