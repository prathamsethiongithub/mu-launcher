# 01 — ARCHITECTURE

## Phase 0 — Captured worktree state (2026-09-13)

```
branch:    master        commits: 1 (b450754 "Pre-canary stable build")
diffstat:  40 files changed, 1909 insertions(+), 3566 deletions(-)
```

Notable worktree deltas vs the single commit (all `CONFIRMED` via `git status`):

- **Staged deletion:** `src/main/mod-list.ts` (dead code — REPORT-002 recommended deletion; it happened in the worktree, not yet committed).
- **Deleted (unstaged):** `_graveyard/*` (7 files), `docs/debug/DEBUG-001..006.md`, `tmp_mod_data*.json`.
- **Untracked (new):** `AGENT-HANDBOOK.md`, `FREEBUFF-LOOK-HERE.md`, `FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md`, `docs/TIMELINE.md`, `docs/debug/DEBUG-ARCHIVE.md`, `src/renderer/components/fx/BlurText.tsx`, `src/renderer/components/fx/PlayerDirector.ts`, `mu-visual-history/` artifacts outside repo.
- **Modified:** nearly all main/preload/renderer sources + `package.json`, `package-lock.json`, `electron-builder.yml`, `electron.vite.config.ts`, root docs.

⚠️ Consequence: the **committed** tree and the **working** tree differ materially. Anything reading this repo at commit `b450754` sees an older architecture (no PlayerDirector as a separate module, mod-list.ts still present, old light rig).

## Build/tooling stack (`CONFIRMED` — package.json)

- Electron **40** via **electron-vite 3** (`main` → `out/main/index.js`, `preload` → `out/preload/index.js`, renderer root `src/renderer`). `"main": "out/main/index.js"`.
- React **19**, three **0.185.1**, skinview3d **3.4.2**, motion **12**, msmc **5**, minecraft-launcher-core **3.18.2**, prismarine-nbt **2.8**, adm-zip **0.5.18**, electron-updater **6**, ogl **1.0.11** (imported by `AuroraBackground.tsx`), Tailwind **3.4** (dev), TypeScript **5.7** (dev).
- Scripts: `dev` / `build` (electron-vite) / `build:electron` (+ electron-builder NSIS) / `lint` / `typecheck` (`tsc --noEmit`). **No test script exists** (`CONFIRMED`).
- Packaging: `electron-builder.yml` — NSIS, `deleteAppDataOnUninstall: false` (explicitly preserves worlds/accounts), GitHub publish provider (`prathamsethiongithub/mu-launcher`), unsigned Windows build.

## Critical build-level fix: three.js dedupe (`electron.vite.config.ts` renderer.resolve.alias)

skinview3d pins three@0.156; app uses three@0.185. Without aliases npm nests r156 and the bundle ships **both**; nested r156 calls `material.onBuild()` during program compile — removed in r185 — so the first r185 material (stage floor) crashed `getProgram()`, `draw()` died before its reschedule line, and the RAF loop froze with a stale `animationID` (resume branch requires `animationID === null`, so `renderPaused=false` could never re-arm). Aliases force bare `three` and `three/examples/jsm/*` onto the root r185 build. Status: `CONFIRMED` (config comment lines 22–41, `HISTORICAL` crash description). Fragile convention — see 17-KNOWN-RISKS R-07.

## Process boundaries

```
┌ Renderer (React 19, src/renderer) ─────────────────────────────┐
│ App.tsx shell: owns launch state, world state, auth snapshot    │
│ Views: PlayView, WorldsView, IdentityView, SettingsView         │
│ fx/: SkinViewerCanvas (skinview3d), PlayerDirector (poses+lights)│
│ fx/: PlayerIdentity, ForgeLine, WorldBeacon, BlurText, Aurora   │
└──────────────△──────────────────────────────────────────────────┘
               │ contextBridge `window.electronAPI` (src/preload/index.ts)
               │ 42 invoke channels + 5 event streams (03-IPC-MAP)
┌ Main (src/main) ────────────────────────────────────────────────┐
│ index.ts: window lifecycle, IPC registration,                   │
│           resolvePlayerIdentity / resolveLaunchAuthorization    │
│ auth-service.ts  legacy msmc session (auth-session.bin)         │
│ identity-service.ts account registry (identity.json/.bin)       │
│ launch-service.ts LaunchManager → MCLC (launch-game)            │
│ world-manager.ts worlds.json + per-world roots + backups        │
│ java-provisioner.ts Mojang JRE runtime                          │
│ fabric-installer.ts / mod-installer.ts / mod-data.ts            │
│ skin-service.ts (cache) / server-injector.ts (NBT servers.dat)  │
│ net.ts (timedFetch) / preflight-check.ts (unwired) / updater.ts │
└──────────────△──────────────────────────────────────────────────┘
               │ node fs/net/child_process
        Windows filesystem + network + Minecraft child process
```

Preload is the only bridge; renderer has no direct Node access (`CONFIRMED` — no `require`/`import` of node builtins in `src/renderer`).

## Entry points (`CONFIRMED`)

| Role | File | Notes |
|---|---|---|
| Main entry | `src/main/index.ts` (909 lines) | single Rollup input `src/main/index.ts` |
| Preload entry | `src/preload/index.ts` (264 lines) | `contextBridge.exposeInMainWorld('electronAPI', …)` |
| Renderer entry | `src/renderer/index.html` → `src/renderer/main.tsx` | mounts `App` |
| Shared | `src/shared/types.ts` | `World`, `Account`, `SkinProfile`, `WorldTemplate`, `MemoryOption`, `UpdateState` types; consumed by main+preload |
| Types ambient | `src/env.d.ts` | typed `Window.electronAPI`; `src/preload/index.d.ts` is a neutralized stub (REPORT-006) |

## Window/app lifecycle (`src/main/index.ts`)

- `app.whenReady()` → creates `BrowserWindow` (icon `build/icon.ico`, preload `../preload/index.js`), loads `../renderer/index.html` (`loadFile`, production path). Dev-server URL loading is **not present** in current source (`CONFIRMED` — no `ELECTRON_RENDERER_URL` branch found), so `npm run dev` serves the built-in electron-vite flow externally to this file.
- `identityService` initialized before window creation; `AuthService` lazy singleton via `getAuthService()`.
- `window-all-closed` → `app.quit()` (kills in-flight launch work — REPORT-005 Part E, `HISTORICAL` for runtime proof).
- Updater events forwarded to renderer on channels `update-*` (see 03-IPC-MAP event streams).
