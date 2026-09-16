# Project Timeline — Master Launcher

> Chronological record of every development session on this repository, compiled
> 2026-09-11 from doc timestamps, REPORT/DEBUG records, git history, and session
> handoffs. Newest at the bottom. For *current status* see `PROJECT_STATE.md`
> (this file is history, not status — when they disagree, PROJECT_STATE wins).
>
> Note on gap: there is exactly one git commit (`b450754` "Pre-canary stable build",
> 2026-07-11 21:43 IST, branch `master`, pushed to
> `github.com/prathamsethiongithub/mu-launcher`). Everything after that date is
> uncommitted working-tree state. A future commit split is proposed in PROJECT_STATE.

---

## Phase 0 — Origin (pre-July 2026)

- **Before 2026-07-09** — No artifacts in-repo. (The unrelated `refmap.json` dated
  2025-08-09 that used to sit in the repo root was a stray Mio-mod artifact from a
  game run whose CWD was the repo; deleted 2026-09-11.)

## Phase 1 — Foundation (2026-07-09)

- Repo scaffolded: Electron + electron-vite + React + TypeScript + Tailwind.
  Config files, README, CONTRIBUTING, prettier/eslint configs dated this day.
- Original README described an aspirational feature set (Crash Diagnostics, Smart
  Doctor, Server Status, Auto Config Sync) and a different repo/MC version —
  several claims never materialized; README corrected 2026-09-11.
- `out/` first build output; `scripts/` created.

## Phase 2 — Stabilization Sprints 1–2 (2026-07-09 → 07-10)

- **Mod data pipeline** (2026-07-09 23:5x): `tmp_mod_data.json` /
  `tmp_mod_data_full.json` scraped from a Prism Launcher instance via
  `scripts/extract-mods.js`, compiled to `src/main/mod-data.ts` via
  `scripts/gen-mod-data.js`. (The tmp JSONs stayed in the root until deleted
  2026-09-11.)
- **2026-07-10 · DEBUG-001 / REPORT-001 (BUG-001):** Launch progress UI reset when
  navigating Play → Account → Play; listener leaked per Play press. Root cause:
  launch state local to PlayView + listener attached in component lifecycle.
  Fix: state lifted to App.tsx, single app-scope listener.
- **2026-07-10 · DEBUG-002 / REPORT-002:** Discovered `tsc --noEmit` red while
  `npm run build` green — dead code (`mod-list.ts` strings, `smokeTest` arity)
  unreachable from build entrypoints. Fixed both; established both gates as
  mandatory. `smokeTest` fix made Java cache version-aware (DEBUG-003).
- **`docs/debug/` diaries** (DEBUG-001..006) written as per-session investigation
  logs; merged into `docs/debug/DEBUG-ARCHIVE.md` and the originals deleted
  2026-09-11 (full detail lives in the REPORTs).

## Phase 3 — Stabilization Sprint 3 (2026-07-10)

- **DEBUG-004 / REPORT-003:** Main-side launch guards verified in place
  (`launchInProgress` [E604] + `isRunning()` [E605]) — Play spam + already-running
  protected.
- **DEBUG-005 / REPORT-004:** Bounded network I/O. New `src/main/net.ts`
  (`timedFetch` 30s JSON; `downloadGuard` 20s connect + 60s stall guard for
  streams); 7 bare-fetch sites bounded. **Runtime-proven** via fault-injection
  harness (NET 4/4).
- **DEBUG-006 / REPORT-005:** Corrupt-state recovery: fabric cache validated +
  atomic writes (FABRIC 3/3); corrupt `servers.dat` → `.corrupt-<ts>` backup +
  rebuild (INJECT 7/7). Audits closed corrupt-cache/missing-Java/close-during-
  launch/fresh-machine/offline as recover-by-design. Zero permanent-breakage
  paths remained.
- **RELEASE_READINESS.md** written as the Sprint-3 gate assessment
  (static + runtime-harness; runtime-E2E on real machines still pending).
  *(Now banner-marked as a historical snapshot.)*

## Phase 4 — Identity & product polish (2026-07-11)

- **REPORT-006:** Identity/skin regression fixed + account UX completion
  (skin tri-state lifecycle: undefined = resolving / null = confirmed-Steve /
  string = custom; display-only Steve fallback; no Steve-flash).
- **REPORT-007:** Launch wired to IdentityService (closes REPORT-006 gap #1).
- **REPORT-008:** Product-design audit (Play · Worlds · Account · Setup; lens:
  Apple HIG/Linear/Arc/Raycast; rule: remove, never add). 14 changes shipped,
  3 proposals deliberately declined.
- **DESIGN.md — EMBER design system** authored: one flame per screen; the world
  behind everything; state in type. This is the governing UI law document.
- **2026-07-11 21:43 · Git commit `b450754` "Pre-canary stable build"** — the
  single commit. `.gitignore` finalized (auth/user data never committed).

## Phase 5 — Pre-canary stabilization sessions (uncommitted era begins)

- **2026-07-12:** electron-builder v26 pinned (v25 winCodeSign symlink-extraction
  failure worked around by staying unsigned by default); `electron-builder.yml`
  finalized (NSIS, `deleteAppDataOnUninstall: false` — worlds are never erased by
  uninstall); `dist/` first installer output.
- **2026-07-17:** `mio.mixins.json` stray artifact landed in repo root (deleted
  2026-09-11).
- **2026-07-23 → 2026-08-05:** quiet period (dir mtimes only).

## Phase 6 — Auth integrity + account removal (2026-09-10)

Session handoff: `FREEBUFF-LOOK-HERE.md` (§ current status). Key facts:

- **Original bug:** Remove Account resurrected the account on restart. Root cause:
  two auth systems coexist **by design** — multi-account `IdentityService`
  (identity.json + encrypted identity-tokens.bin) and legacy single-session
  `AuthService` (auth-session.bin, safeStorage). Removing an IdentityService
  account left the legacy session; startup reconciliation (`importSession()`)
  recreated the account every launch.
- **Fix (working tree):** `remove-account` matches by UUID (dashes stripped),
  clears legacy session first, **verifies** `hasPersistedSession() === false`,
  only then removes — consistent & retryable. Renderer reflects sign-out
  immediately.
- **Sign-in sync layer added:** `syncMicrosoftSignIn()` bridge (Play sign-in
  hydrates IdentityService), reverse bridge `AuthService.adoptExternalSession()`,
  `auth-changed` IPC broadcast after every mutation (incl. startup), PlayView +
  IdentityView subscribe. Play ↔ Account can no longer disagree.

## Phase 7 — Stabilization audit + launch truthfulness (2026-09-11 morning)

- **Stabilization audit:** Worlds nav froze the launcher — `dirSize()` walked
  world trees synchronously on the main process. Converted to fs/promises;
  runtime-verified (nav 9ms, was minutes). Known-unfixed candidates recorded
  (backup delete confirmation, cancel-launch unwired, dead-but-harmless preload
  APIs).
- **Launch truthfulness pass:** launch UI must show real stage + real progress,
  never frozen-looking, never done-on-failure. `version-jar` byte progress
  forwarded; App.tsx measured composite; `cancelLaunch()` emits error not done;
  beacon-catch flare strengthened.
- **e.task defect found + fixed + runtime-proven (13/13):** MCLC puts completed
  count in `e.task`, not `e.current` → all assets/classes/natives percent events
  computed 0%. Post-fix fill swept 50→72.4% tracking real downloads; exact
  arithmetic match. Harness: `~/mu-verify/launch-truth.mjs`.
- Three **P1 launch-UX design gaps** recorded for owner ruling (hero word vs
  actual operation; ignition catch at PLAY-click vs final transition; library
  downloads have no byte events) — still open.

## Phase 8 — Runtime E2E of auth flows (2026-09-11, CDP harness)

- Offline-account flows runtime-verified via CDP-driven real UI
  (`~/mu-verify/`): FLOW 6 convergence 12/12, FLOW 3 remove+no-resurrection 14/14,
  FLOW 5 multi-account 14/14, FLOW 7 data preservation byte-identical.
- **Still unproven (needs real Microsoft OAuth — user's hands):** FLOW 1/2/4 MS
  sign-in cross-sync, MS sign-out, a real MS-account Minecraft launch.

## Phase 9 — Home character animation director (2026-09-11 afternoon)

Session handoff: `FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md` (full detail incl.
skinview3d internals cheat sheet). Summary:

- Owner spec: premium "Home Character Animation Director" — layered animation
  (idle breathing → glances → pointer gaze → launch ignition) for the existing
  skinview3d player. Quality bar: subtle, deliberate, "Holy shit, he's alive."
- **Built:** `src/renderer/components/fx/PlayerDirector.ts` (new; single
  long-lived animation instance owning all pose state; config constants grouped)
  + `SkinViewerCanvas.tsx` rewired (window-level pointer gaze, focus/visibility
  render pausing, reduced-motion = static shot, director never recreated across
  skin loads because the `viewer.animation` setter snaps via resetJoints).
- Ignition reuses the existing `launching` prop — launch failure/cancel
  automatically eases back to idle; no new IPC/events created.
- Gates: tsc 0, build clean. **Runtime visual tests A–H pending user.**

## Phase 10 — Documentation professionalization (2026-09-11 evening) — this session

- Full stale/duplicate audit (see session summary in PROJECT_STATE once recorded).
- **Deleted:** `_graveyard/` (7 dead pre-EMBER UI components, git-tracked),
  `src/main/mod-list.ts` (dead code, superseded by mod-data.ts),
  `tmp_mod_data*.json` (baked into mod-data.ts), `refmap.json` + `mio.mixins.json`
  (Mio stray artifacts), `build/icon.ico.bak`, `src/renderer/assets/skins/steve.png`
  (orphan; code uses inline base64).
- **Merged:** `docs/debug/DEBUG-001..006` → `docs/debug/DEBUG-ARCHIVE.md`.
- **Corrected:** README.md (repo URL, MC 26.1.2, real feature set, doc map),
  CONTRIBUTING.md (`master` branch, no phantom format script).
- **Created:** `docs/TIMELINE.md` (this file) and `AGENT-HANDBOOK.md`.

## Open threads at time of writing

1. MS-account flows need real-OAuth runtime testing (user's hands).
2. Animation runtime tests A–H (user's eyes).
3. Owner rulings: three P1 launch-UX design gaps.
4. Commit the working tree in the suggested split (auth / launch truth / release
   config / animation director / docs cleanup).
5. Release blockers (separate workstream): unsigned installer [P0], build.yml
   branch trigger mismatch, lint errors (22), no tags/releases.
