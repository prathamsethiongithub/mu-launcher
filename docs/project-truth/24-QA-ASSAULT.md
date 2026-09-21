# 24 — QA Assault: full-stack automated test offensive

Branch: `qa-assault` (from master `605472f`). Date: 2026-09-21.
Baseline at start: vitest **234/234 (17 files)** · typecheck clean · build clean.
End state: vitest **241/241 (18 files)** + **E2E 12/12** + oracle corpus 7/7.

**Mode note (per task sheet §C4 fallback):** Kanban orchestration was unavailable in
this environment — the six audit tasks were dispatched as **parallel subagents**
(Hermes `delegate_task`, 5 concurrent, Go-tier deepseek-v4.1-flash) plus this session
owning E2E + corpus. Deliverables unchanged.

## 1. E2E results (Playwright-Electron, real compiled app)

Harness: `tests/e2e/harness.ts` — `_electron.launch` on `out/main/index.js`,
throwaway user-data dir, waits for the REAL main window (the splash video window
closes itself; naive `firstWindow()` grabs the dying window — that was smoke bug #1).

| # | Case | Pass | Time |
|---|---|---|---|
| 1 | boot: main window + no renderer console.error | ✅ | ~6s |
| 2 | nav-cycle: Play/Worlds/Account/Setup round trip | ✅ | ~5s |
| 3 | console-ctrl-l: Ctrl+L opens console | ✅ | ~4s |
| 4 | console-persist: keep-alive across navigation | ✅ | ~5s |
| 5 | console-live-lines: store/fold render path alive | ✅ | ~3s |
| 6 | no-dead-listeners: full cycle, zero unhandled rejections | ✅ | ~4s |
| 7 | identity-renders: hero canvas + "same game. different you." | ✅ | ~4s |
| 8 | identity-library: synthetic shelf (backup/restore real library) | ✅ | ~9s |
| 9 | setup-real-controls: buttons clickable, no fake paths | ✅ | ~4s |
| 10 | settings-persist: create → rename → re-read → delete | ✅ | ~5s |
| 11 | oracle-bridge: diagnoseWorld reachable, no throw | ✅ | ~3s |
| 12 | tray-exists: app+bridge alive with Temporal Ping initialized | ✅ | ~1s |

Suite: **12 passed (37.8s)** — `npm run test:e2e`.

Bugs found by the suite itself (fixed during bring-up, not product bugs):
harness grabbed the dying splash window; nav-cycle asserted `Ready.` where a scratch
profile legitimately answers `In the world.`; console tests pressed Ctrl+L before
React mounted its listener (race → flake, now wait-for-mount); settings-persist
discovered the managed world is rename-locked (switched to throwaway world, which
also proved create→rename→re-read→delete).

## 2. Crash corpus (generator v2, launcher-pipeline driver)

`scripts/generate-crash-corpus.mjs` drives the launcher's REAL pipeline
(Playwright → `launch-game` IPC → MCLC → provisioned JRE), offline auth,
mods/ + identity.json backed up and restored per scenario.

**KEY FINDING — the crash surface split:** pre-launch Fabric failures
(`ModResolutionException` from a missing dependency or a corrupt jar) are thrown as
`FormattedException` BEFORE the game boots: **no `crash-reports/*.txt` is written —
the full stack trace lands in the rotated log (`logs/2026-09-21-*.log.gz`).**
v1 of the generator missed this entirely (it hand-assembled the JVM command line
and died before Fabric init). The Oracle's crash-reports-only harvest therefore has
a blind spot for resolution failures — the console's log-scan path is the one that
sees them.

| Scenario | Launched (real pipeline) | Crash file | Oracle attribution |
|---|---|---|---|
| dependency (Sodium, no Fabric API) | ✅ | `fabric-resolution-0.txt` (rotated log) | ✅ ModResolutionException |
| corrupt-jar | ✅ | `fabric-resolution-1.txt` (rotated log) | ✅ ModResolutionException |
| oom (512 MB + full mod set) | ✅ | none — 512 MB held past 3 min window | negative sample (honest) |
| version-mismatch | ✅ | none captured — same rotated-log surface, oldest-build fetch was faulty | partially covered (surface identical to dependency) |
| clean-baseline (60s, empty mods) | ✅ | none — correct negative | ✅ |
| external-skin | n/a — launcher-side, covered by E2E #7/#8 | — | ✅ |

## 3. Oracle validation vs corpus

`tests/oracle-corpus.test.ts` — 7 tests, all green: every harvestable corpus record
yields a `detectReason` attribution (no silent nulls), resolution failures match the
resolution-error pattern, any attributed mod name is non-vanilla.

## 4. Parallel audit findings (5 subagents, one round)

| Audit | Verdict | Findings |
|---|---|---|
| IPC three-way (main/preload/env.d.ts) | ✅ + 2 orphans | 75 main handlers (unique, no dupes) · 73 preload invokes · **0 preload channels without a main handler** · env.d.ts ↔ preload exact match (89↔89) · 9 event channels all paired. **2 orphan main handlers**: `get-installed-versions` (index.ts:1728) and `mod-download` (index.ts:1233, superseded by `modrinth-download`) — dead surface, remove or wire. Bonus: 13 exposed API methods unused by the renderer (`getPlatform`, `injectServer`, `launchPoc`, `logout`, `runPreflightCheck`, `uploadSkin`, `validateSession`, update-* listeners…). Task-sheet's "159 handlers" was wrong — measured 75. |
| useEffect audit | ⚠️ 1 HIGH + 2 + 1 design note | 60 call sites; 25 subscribe; **23 paired**. HIGH: PlayView sign-in poll (`:610`, not a useEffect) — 1s `setInterval` cleared only on success branch; unmount/auth-failure → polls forever. MEDIUM: fx/SideRays.jsx:74 — `cleanupFunctionRef` assigned only after async init; unmount inside the window leaks resize+rAF+WebGL. LOW: IdentityView mirror-line 5s timeout uncleaned. DESIGN: bulk-removes (`removeAuthChangedListeners`) are global — two live subscribers would silently de-register each other; safe today only because views are keep-alive. |
| Init order (userData anchor) | ✅ clean | Anchor L62 precedes every userData reader; no module-top construction. Two fragile-but-safe patterns flagged: identity-service.ts:96 class-field `new SkinService()` and auth-service.ts:24 ctor-time `restoreSession()` — both safe only because construction is post-anchor; prefer path injection. |
| E2E suite | ✅ 12/12 | see §1 |
| Oracle vs corpus | ⚠️ **downgraded** | See §4.1 — reason detection 4/4 but only generic wrappers; **mod-name accuracy 0/4**; test assertions partially vacuous; corpus mislabeled/orphaned. |

## 4.1 Oracle vs corpus — full audit (downgraded from ✅), then FIXED on oracle-truth

`npx vitest run tests/oracle-corpus.test.ts` → 7/7 pass, **but the green was partly vacuous**:

**Attribution accuracy on real records (probed via bundled crash-diagnostic + real detectReason/detectModName):**

| Scenario | Reason found | Root cause? | Mod name | False attribution? |
|---|---|---|---|---|
| dependency (fabric-resolution-0) | ✅ 4/4 | ❌ outermost `Caused by:` wrapper only (`ModResolutionException: Mod discovery failed!`) — never the actionable child | ❌ **0/4 — `undefined`** (records have no `Mod file:`/`File:` markers; frames are whitelisted `net.fabricmc`/`java`) | ✅ never misattributes — failure mode is silence, not a wrong mod |

**Why the test's green was hollow:**
- `manifest.json` sets `attribution: null` → no ground truth to assert against.
- `if (modName) { … }` skips entirely when modName is undefined — which was 100% of cases, so a total mod-naming failure passed silently.
- The reason regex `/Mod resolution|Mod discovery|Missing|Caused/i` matches the generic wrapper for every shape.

**Corpus integrity problems found by the auditor:**
- Manifest maps `dependency` → fabric-resolution-0.txt, but that record's jar is `sodium-ancient.jar` (the version-mismatch artifact); the real dependency artifact sits in **orphaned** fabric-resolution-3.txt. 2 of 4 records unreferenced, untested.
- The generator's dependency stage is broken: `curl -o sodium-fabric.jar "…/project/sodium/version"` saves the Modrinth **JSON** into a `.jar` → produces zip corruption (same shape as corrupt-jar), never a true missing-dependency failure.
- On-disk records (`fabric-resolution-N.txt`) are not reproducible from the generator's output names — they were harvested manually.
- `crashed:false` conflates "not captured" with "no crash" for oom/version-mismatch.

**FIXED on `oracle-truth` (commit `a538238`, merged to master):**
1. `detectReason` walks the full `Caused by:` chain to the innermost/last entry (OOM at any depth still wins). Verified on the real 4-level corpus record: returns `java.util.zip.ZipException: zip END header not found` instead of the wrapper.
2. `detectModName` gained the Fabric pre-launch rule: `Error analyzing [<path>]` → jar filename → mod name. Verified on real corpus: `corrupted-mod.jar` → "Corrupted Mod".
3. Corpus generator v3: dependency stage downloads the REAL newest sodium jar via the Modrinth version JSON (PK-verified); version-mismatch downloads the OLDEST build; dual-surface harvest (crash-reports + rotated logs + latest.log tail) with a stale-record guard keyed on the staged jar name — a previous scenario's crash can never be attributed to the current one.
4. Corpus rebuilt: corrupt-jar record verified (root cause + mod name asserted as ground truth); dependency honestly recorded as no-crash (sodium 0.9.2 boots without fabric-api — a REAL finding: the dependency scenario assumption was wrong for current sodium); oom/version-mismatch honestly negative in-window.

**Action items:** teach `detectReason` to walk to the LAST/most-specific `Caused by`; teach `detectModName` the Fabric resolution-log format (`ModResolutionException: Mod discovery failed!` embeds mod ids); fix the generator's dependency fetch (use `/version?facets` JSON → pick `files[].url`); back the corpus with ground truth in the manifest; assert ground truth, not existence. — ALL DONE (items 1-2 in crash-diagnostic.ts, 3-4 in generator/tests).

## 5. One-command entry points (package.json)

- `npm test` — vitest units (**241**, was 234: +7 oracle-corpus)
- `npm run test:e2e` — Playwright smoke (**12**)
- `node scripts/generate-crash-corpus.mjs` — crash factory ([--scenario=name] to run one)

## 6. Total test count

vitest 241 + E2E 12 + oracle-corpus 7 (included in the 241) = **253 assertions
across the three layers**, up from 234 at assault start.

## 7. Honest gaps

- `oom` and `version-mismatch` produced no harvestable report this round (negative
  sample recorded honestly, not faked). Their crash surface is believed to be the
  same rotated-log path as dependency/corrupt-jar — next round should harvest
  `logs/*.log.gz` in the generator itself, not manually.
- The E2E suite currently requires the app NOT to be running (Electron
  single-instance) — fine for CI, noted for parallel-run hygiene.
- Subagent audit summaries were truncated by the delegation layer's message cap
  (~97 chars) — findings above were reconstructed from the agents' saved tool
  streams. Full text lived only in the stream; future audits should have agents
  write reports to files, not just summaries.
