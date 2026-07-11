# DEBUG-004 — Sprint 3: launch-guard verification + investigation sweep

**Timestamp:** 2026-07-10 (session order #4)
**Objective:** Verify FIX A (launch guard, applied end of Sprint 2) survived on disk, and complete the code reads needed to prove/disprove the remaining Sprint-3 failure modes before editing anything.

**Hypothesis:** Guard intact; remaining risks concentrated in (a) unbounded fetches, (b) unvalidated caches (fabric), (c) corrupt servers.dat fatality.

**Investigation:**
- `grep launchInProgress|E604|E605 src/main/index.ts` → present at lines 15/187/191/200/221; `finally` clears the flag on every path. ✔
- Read in full: `java-provisioner.ts` install loop (182-340), `fabric-installer.ts`, `server-injector.ts`, `mod-installer.ts`, `auth-service.ts` persistence block, `preflight-check.ts` usage.
- `grep runPreflightCheck src/renderer/` → **no usages** (built but unwired).
- Deps check for harness: `prismarine-nbt` ✓, esbuild binary ✓.

**Evidence highlights:**
- mod-installer already ideal: hash-verifies existing files, atomic tmp+rename, error path unlinks tmp, per-item non-fatal.
- JRE self-heal proven: cache pointer written only post-smoke-test (L329); loop re-downloads unconditionally (L261-288).
- fabric cache blind-trust (L65-68) + non-atomic write (L120) → P1.
- servers.dat parse failure → fatal E501 → launch dead forever → P1.

**Conclusion:** Fix set = FIX B (bounded net), FIX C (fabric validate+atomic), FIX D (servers.dat recovery). FIX A verified intact.
**Result:** proceeded to implementation; see DEBUG-005/006.
