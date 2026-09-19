# AGENT HANDBOOK — Ember

> **Read this before touching code.** It condenses everything an agent (or a new
> human) needs to work on this repo without re-deriving it. Written 2026-09-11.
>
> Reading order for a fresh session: **this file → `PROJECT_STATE.md` (current
> status) → `DESIGN.md` (only if touching UI) → relevant handoff/REPORT.**
> `docs/TIMELINE.md` has the full history.

---

## 1. What this project is

A **Windows-only Electron launcher for the Masters' Union SMP** (private Minecraft
server at `mastersunion.minekeep.gg:25565`). Product promise: one-click join, zero
friction — Microsoft sign-in, Java provisioning, Fabric install, mods, and launch
all invisible to the student using it.

Product philosophy: *"a premium desktop launcher that happens to contain
Minecraft"* — restrained, warm, near-black EMBER aesthetic. Restrained beats
clever; state lives in type, one flame per screen.

Currently in **stabilization**: core chain (auth → Java → Fabric → Minecraft)
works and much of it is runtime-proven; release blockers are known and triaged.

## 2. Architecture (as-built, with file paths)

```
Electron (single window)
├── src/main/            Node side — all privileged work lives here
│   ├── index.ts         IPC wiring, startup reconciliation, auth bridges
│   ├── auth-service.ts  LEGACY single-session MSMC OAuth (auth-session.bin, safeStorage)
│   ├── identity-service.ts  MULTI-account registry (identity.json + identity-tokens.bin)
│   ├── launch-service.ts    MCLC pipeline: java→version→fabric→mods→inject→spawn
│   ├── java-provisioner.ts  Mojang JRE download, SHA-1 per file, version-aware cache
│   ├── fabric-installer.ts  validated+atomic cached Fabric profile
│   ├── mod-installer.ts     hash-verified atomic mod downloads (stall-guarded)
│   ├── server-injector.ts   servers.dat injection, corrupt-file recovery
│   ├── net.ts           bounded network I/O — ALL fetches go through here
│   ├── skin-service.ts  skin fetch/cache
│   ├── world-manager.ts world scan (async! dirSize once froze the main process)
│   └── mod-data.ts      generated mod list (from scripts/gen-mod-data.js)
├── src/preload/index.ts  the ONLY bridge — typed IPC surface (window.electronAPI)
└── src/renderer/         React UI
    ├── App.tsx           view switch; launch state lives HERE (not in views)
    ├── components/       PlayView, IdentityView, ForgeLine, WorldSwitcher…
    └── components/fx/    atmosphere: WorldBeacon, PlayerIdentity,
                          SkinViewerCanvas, PlayerDirector (home character)
```

**Two auth systems coexist BY DESIGN — never merge them.** IdentityService is the
multi-account registry; legacy AuthService is the MSMC single session. Bridges
connect them (`syncMicrosoftSignIn()`, `adoptExternalSession()`); the
`auth-changed` IPC event keeps every view in sync after any mutation. This is the
#1 trap for a new agent.

**Renderer↔main contract:** everything crosses the preload bridge as typed IPC.
Launch state is app-lifted (survives navigation). The launch pipeline emits
`launch-step` events; App.tsx maps MCLC events to ForgeLine stages.

## 3. The gates (mandatory for every change)

```bash
npm run typecheck   # tsc --noEmit — 0 errors
npm run build       # electron-vite — clean
```

**The build uses esbuild and does NOT catch everything tsc does** (dead code,
type-level errors in unreached modules). A green build means nothing without a
green typecheck. This bit the project once (DEBUG-002); don't let it again.

Runtime evidence standard: behavioral fixes are proven at runtime where possible
(there is a CDP harness tradition in `~/mu-verify/`, outside the repo). Static
proof + gates is the minimum for any fix; "typecheck passes" alone is NOT done.

## 4. Project conventions & hard-won rules

- **All network I/O goes through `src/main/net.ts`** (30s JSON / 20s connect /
  60s stall guard). No bare fetch. Never add a synchronous filesystem walk on the
  main process (the Worlds nav freeze).
- **Atomic writes + validation for anything cached on disk** (fabric profile,
  mods, JRE). Corruption must degrade to re-download, never break the install.
- **User data is sacred:** `%APPDATA%/mu-master-launcher` — worlds, accounts,
  saves. `deleteAppDataOnUninstall: false` exists for a reason. Auth fixes may
  only touch auth state; a data-preservation test (FLOW 7, byte-identical) is the
  standard.
- **Design law:** read `DESIGN.md` before any renderer UI change. One ember
  element per screen; remove, never add; restrained motion.
- **Never refactor a working system without a proven defect** (lint debt is known
  and deliberate; `no-explicit-any` etc. are pre-existing, not yours to fix).
- **Git:** branch `master` (there is no `main`), one commit exists
  (`b450754`), everything else is uncommitted working tree. Never
  `reset --hard`/`clean`/commit without the owner's say-so. Suggested commit
  split lives in PROJECT_STATE.
- **This repo is NOT the Mio crack project** (`prathunder-client` is a different
  desktop folder). Don't confuse them.

## 5. Docs map — what to trust

| Doc | Trust level / use |
| --- | --- |
| `PROJECT_STATE.md` | **Authoritative current status.** When anything disagrees with it, it wins. |
| `AGENT-HANDBOOK.md` | This file — durable understanding, rarely needs updating |
| `docs/TIMELINE.md` | Full chronological history (newest at bottom) |
| `DESIGN.md` | UI law. Current. (2026-09-10) |
| `REPORT-001..008` | Per-fix QA reports with evidence. Historical, accurate. |
| `docs/debug/DEBUG-ARCHIVE.md` | Digest of the deleted investigation diaries |
| `RELEASE_READINESS.md` | ⚠️ Historical snapshot (2026-07-10) — banner explains |
| `FREEBUFF-LOOK-HERE.md` | Session handoff: auth sync + launch truthfulness (2026-09-10/11) |
| `FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md` | Session handoff: animation director (2026-09-11) |
| `README.md` / `CONTRIBUTING.md` | Corrected 2026-09-11 to match reality |

## 6. Known traps for a new agent

1. **Don't create/replace the skin viewer's animation instance** — the
   skinview3d `animation` setter calls `resetJoints()` (pose snaps). One
   `PlayerDirector` owns all pose state for the viewer's life. Full details in
   the animation handoff's internals cheat sheet.
2. **Skin tri-state:** `undefined` = still resolving (render NOTHING — Steve must
   never flash as a placeholder), `null` = confirmed no skin (bundled Steve),
   string = custom. Breaking this was REPORT-006's regression.
3. **Preload APIs can be dead-but-harmless** (`runPreflightCheck`,
   `cancel-launch`, …). Check `PROJECT_STATE.md` before assuming wiring is needed.
4. **`importSession()` reconciliation** recreates the legacy session at startup —
   any auth change must be checked against it (that's how the resurrection bug
   was born).
5. **CI:** `build.yml` triggers on `main` but the branch is `master` → the build
   pipeline has never run. Lint workflow fails on known debt. Release ops is a
   separate workstream.
6. **MCLC progress quirk:** completed counts arrive in `e.task`, NOT `e.current`
   (cost a full session to prove; fixed in launch-service).

## 7. Open work (pointer, not duplicate)

Do not start any of these unprompted; see `PROJECT_STATE.md` for triage detail:
MS-OAuth runtime flows · animation runtime tests A–H · three P1 launch-UX owner
rulings · working-tree commit split · release blockers (unsigned installer,
build.yml, lint) · unwired preload APIs.
