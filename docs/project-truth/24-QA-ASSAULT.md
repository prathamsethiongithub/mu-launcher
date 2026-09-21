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
| IPC three-way (main/preload/env.d.ts) | ✅ clean | 75 main handlers (unique, no dupes) · 73 preload invokes · 0 preload channels without a main handler · **2 main handlers with no preload invoke**: `get-installed-versions`, `mod-download` (main-only by design, noted in truth 18 §5) · task-sheet's "159 handlers" was wrong for this branch — measured 75 |
| useEffect subscriptions | ⚠️ 2 + 1 | 60 call sites, 25 subscribe, **23 paired correctly**. Flagged: (1) **HIGH — PlayView sign-in poll** (`PlayView.tsx:610`, not a useEffect): `onClick` starts a 1s `setInterval` that is cleared ONLY on the success branch — if the user closes the auth panel or signs out mid-poll, the interval polls forever; (2) IdentityView init race — a ref assigned only after awaits is read during the unmount window (racy, low impact); (3) LightPillar (fx/, vendor) correctly paired. |
| Init order (userData anchor) | ✅ clean | All imports at index.ts L6-23 execute before the L62 anchor, but none read `app.getPath('userData')` at module top; all consumers run inside whenReady/IPC. The consoleService post-anchor construction (truth 22 §10.3) holds. |
| E2E suite | ✅ 12/12 | see §1 |
| Oracle vs corpus | ✅ 7/7 | see §2-3 |

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
