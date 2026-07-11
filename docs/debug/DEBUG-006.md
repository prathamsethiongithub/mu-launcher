# DEBUG-006 — Sprint 3: corrupt-state recovery fixes + audits

**Timestamp:** 2026-07-10 (session order #6)
**Objective:** Close the two permanent-breakage paths (fabric cache, servers.dat), then audit corrupt-cache/missing-Java/close-during-launch/fresh-machine/offline with citable evidence.

**Hypothesis:** Both P1s stem from "trust without validation" + one non-atomic write; everything else already recovers.

**Implementation:** fabric-installer — validate cached JSON (`id` required), delete+refetch on corruption, atomic tmp+rename write. server-injector — parse isolated; corrupt file renamed to `servers.dat.corrupt-<ts>` (user data preserved), fresh file rebuilt; healthy-path branches unchanged (re-keyed on `parsed`).

**Evidence (runtime harness):**
- `inject.test.cjs`: T4 fresh create ✔ · T5 idempotent (1 MU entry) ✔ · T6 user server preserved + MU added ✔ · T7 garbage servers.dat → no throw, `.corrupt-1783658814626` backup created, fresh valid file with MU SMP ✔ → **ALL PASS**
- `fabric.test.cjs`: T8 valid cache honored in **7ms** (no network) ✔ · T9 corrupt cache detected → deleted → re-fetched → fresh valid profile written ✔ → **ALL PASS**

**Audits (static, citations in REPORT-005):** session/java-path/JRE-partials/mods all recover by existing design; close-during-launch now has **zero** permanent-breakage paths (fabric was the last one); fresh-machine directory walk found no missing-mkdir path; offline matrix fully bounded post-FIX B; `runPreflightCheck` confirmed built-but-unwired (P3, left as-is).

**Conclusion:** corrupt state can cost a student time (re-downloads), never a broken install.
**Result:** tsc 0 / build 0. See REPORT-005. Remaining: real-machine E2E pass (env cannot drive the GUI).
