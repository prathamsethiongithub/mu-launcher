# 02 — FILE MAP

Every important file grouped by responsibility, with what it **actually owns**. Statuses: `CONFIRMED` = read directly.

## Main process (`src/main/`)

| File | Lines | Owns | Notes |
|---|---|---|---|
| `index.ts` | 909 | App/window lifecycle; **all 42 `ipcMain.handle` registrations**; `resolvePlayerIdentity()` (L175–188) and `resolveLaunchAuthorization()` (L192–212); legacy↔identity sign-in convergence (`add-microsoft-account` L609–635) and removal guard (`remove-account` L655–691); module singletons `launchManager`, `launchInProgress`, `identityService` | The orchestration hub. Also forwards updater events. |
| `auth-service.ts` | 428 | **Legacy** Microsoft auth: msmc `Auth('select_account')`, token refresh, `persistSession()`/`restoreSession()` to `auth-session.bin` (safeStorage), `getAuthorizationForMCLC()` (L267), `hasPersistedSession()` (L415) | Single-slot legacy session. On restore failure **deletes the file** (L258–264). |
| `identity-service.ts` | 580 | **Account registry**: multi-account `identity.json` (accounts + activeAccountId + skin profiles) + `identity-tokens.bin` (encrypted per-account sessions); `addMicrosoftAccount`, `addOfflineAccount`, `importSession` (legacy→identity bridge, L101, L259), `ensureValidSession` (L321), skin upload to Mojang API (L411–465) | Tokens separated from profile state by design (L19–20 comment). |
| `launch-service.ts` | 384 | `LaunchManager`: the 9-step Fabric launch orchestrator (steps below); MCLC invocation with 120s timeout; `isRunning()`, `cancel()`; emits `launch-step` events; `getInstalledVersions()` | Consumes JavaProvisioner, FabricInstaller, ModInstaller, ServerInjector. |
| `world-manager.ts` | 825 | `worlds.json` registry; per-world root dirs `{userData}/worlds/<id>/minecraft` with `mods/ resourcepacks/ saves/ versions/` (L154–162); create/rename/duplicate/delete; backups (zip via adm-zip, `backups/` sibling dir), restore with `saves.pre-restore` safety dir (L437), metrics, health check (`level.dat` parse via prismarine-nbt L340); `{userData}` placeholder resolution (L615–620); legacy `{userData}/minecraft` migration (L678–704) | Root template stored in registry: `"{userData}/minecraft"` for managed world. |
| `java-provisioner.ts` | 487 | JRE provisioning from Mojang runtime manifest (`launchermeta.mojang.com/v1/products/java-runtime/…all.json` L74); version-aware cache via `current-java-path.txt` + `smokeTest(path, expectedMajor)` (L161–171, L341, L387–396: `major < 17` baseline + exact-match when expected); bounded downloads via `net.ts` | Component/majorVersion resolved from the Minecraft version JSON (L161). |
| `fabric-installer.ts` | 152 | Fabric loader profile fetch (`meta.fabricmc.net`), cached in `versions/fabric-loader-*/…json`; **validates cache** on read + atomic `.tmp`+rename writes (REPORT-005 Part A, `HISTORICAL` runtime-proven) | `CONFIRMED` cache dir L19. |
| `mod-installer.ts` | 186 | Mods + resource packs into per-world `mods/` `resourcepacks/`; per-file hash verification (sha512/sha1 per `mod-data.ts`); `timedFetch`/stall-guarded streaming; per-item non-fatal errors | Manifest = static `mod-data.ts`. |
| `mod-data.ts` | 66 | Static auto-generated manifest: ~25 mods + 4 resource packs (Modrinth/CurseForge CDN URLs, hashes) | **Generated** by `scripts/gen-mods.js`-family tooling (scripts/ below). |
| `skin-service.ts` | 154 | Skin cache `{userData}/skins/<uuid>.png/.json` (24h TTL); `getSkin(uuid,{force})` bypass; `putCache()` write-through used after upload (REPORT-006) | Cache only — upload lives in identity-service. |
| `server-injector.ts` | 202 | NBT `servers.dat` injection of the MU SMP entry (prismarine-nbt); idempotent; corrupt-file recovery → rename `servers.dat.corrupt-<ts>` + fresh create (REPORT-005 Part B); atomic NBT write (L195 comment: uncompressed NBT expected by MC 26.1.2) | `removeServer()` exists (L138–174) for uninstall paths. |
| `net.ts` | 97 | `timedFetch` (30s total, JSON), `downloadGuard` (20s connect), `readWithStallGuard` (60s per-chunk) — REPORT-004 runtime-proven (`HISTORICAL` tests, `CONFIRMED` source) | Error codes E220/E221/E222. |
| `preflight-check.ts` | 217 | Disk space (wmic, ≥1GB), launcher files present, version manifest reachability | **Built + IPC-exposed (`run-preflight-check` L814) but never invoked by the renderer** — `CONFIRMED` orphan (grep: only preload + env.d.ts reference it). REPORT-005 Part G documented this; still true today. |
| `updater.ts` | 39 | electron-updater wiring for the GitHub publish provider; forwards events to renderer | No auto-download decision visible in file; events only. |

## Preload (`src/preload/`)

| File | Owns |
|---|---|
| `index.ts` (264) | `contextBridge.exposeInMainWorld('electronAPI', …)`: 42 invoke wrappers + 5 event-register/remove pairs (`launch-step`, `java-progress`, `auth-changed`, `update-*`). Typed via `shared/types`. |
| `index.d.ts` (9) | Neutralized stub (REPORT-006) — prevents a stale shadowing `Window.electronAPI`. |

## Renderer (`src/renderer/`)

| File | Owns |
|---|---|
| `main.tsx` | React root mount. |
| `App.tsx` (~260) | Shell + **cross-view state owner**: launch state (`launching/launchError/launchSteps/isRunning`), worlds, active world, auth snapshot; single app-scope `launch-step` listener (REPORT-001 fix); `launchingRef` re-entry guard; `is-game-running` refresh on mount (L105); world-switch rules during launch. |
| `components/PlayView.tsx` | Play stage: hero character, world eyebrow/rail, Play/Retry; **props-driven** (no launch state of its own). |
| `components/WorldsView.tsx` | World shelf: create/rename/duplicate/delete/backup/restore/delete-backup; health chip; overflow menu. |
| `components/WorldSwitcher.tsx` | Popover switcher (same world data). |
| `components/NewWorldDialog.tsx` | New-world form (template + memory option). |
| `components/IdentityView.tsx` | Account/Identity Studio: account list, switch/remove/sign-out, skin stage/preview/upload, `selectSkinFile` flow. |
| `components/SettingsView.tsx` | Setup manifest read from active world; memory option display. |
| `components/ForgeLine.tsx` | Progress line UI (consumes launch steps). |
| `components/Layout.tsx`, `DockNav.tsx`, `IconSidebar.tsx` | Chrome/nav. `DockNav` is **superseded by IconSidebar** (both present; Layout imports IconSidebar — `CONFIRMED` via imports). |
| `components/AuroraBackground.tsx` | ogl shader background layer. |
| `components/AuthView.tsx` | **ORPHANED** — no importers (`CONFIRMED` grep). Legacy pre-identity auth UI. REPORT-006 flagged for graveyard. |
| `components/fx/SkinViewerCanvas.tsx` | skinview3d viewer lifecycle (single stable canvas tree, REPORT-006 RC-1 fix), stage rig install, skin load, director wiring, reduced-motion fallback. |
| `components/fx/PlayerDirector.ts` (822) | Animation brain: gaze/wave/breath/idle/greeting/energetic/goodbye state machine + lighting ramp (`IGNITE_CONFIG`) + stage rig + tunable configs (`STAGE_LIGHT_CONFIG`, `SKIN_CONFIG`). |
| `components/fx/PlayerIdentity.tsx` | Bridge component: `getSkin` IPC → SkinViewerCanvas props. |
| `components/fx/ForgeLine.tsx` etc. | (ForgeLine listed above) `WorldBeacon.tsx` decorative world light, `BlurText.tsx` text entrance fx. |

## Shared / security

| File | Owns |
|---|---|
| `src/shared/types.ts` | `World`, `Account`, `SkinProfile`, `WorldTemplate`, `MemoryOption`, `UpdateState`, launch step payload type. |
| `src/security/ipc-validate.ts` | `validateExternalUrl` (allowlist `api.minecraftservices.com` etc.); imported only by `main/index.ts` `open-external-link` (L9, L219). `CONFIRMED` — narrow scope, not a general fetch validator. |
| `src/env.d.ts` | Ambient `Window.electronAPI` typing. |

## Tooling / docs / diagnostics

| Path | Owns |
|---|---|
| `scripts/debug-toml.js`, `extract-mods.js`, `gen-mod-data.js` | Offline mod-manifest generation (produced `mod-data.ts`). |
| `docs/TIMELINE.md`, `docs/debug/DEBUG-ARCHIVE.md` | History records (`HISTORICAL`). |
| `REPORT-001…008.md` (root) | Session fix reports (`HISTORICAL`, several claims re-verified current). |
| `AGENT-HANDBOOK.md`, `FREEBUFF-LOOK-HERE.md`, `FREEBUFF-HANDOFF-ANIMATION-DIRECTOR.md`, `PROJECT_STATE.md`, `DESIGN.md`, `README.md`, `RELEASE_READINESS.md`, `CONTRIBUTING.md` | Agent-facing process/product docs (reconciled in 16-HISTORY-RECONCILIATION.md). |
| `_graveyard/` | **Deleted in worktree** (was dead UI: Crucible, FloatingDockNav, LogPanel, Strands, TelemetryPanel, dock components). |
| `out/`, `dist/` | Build outputs (`out` electron-vite, `dist` electron-builder). Generated. |

## Dead / suspicious inventory

| Item | Status | Evidence |
|---|---|---|
| `AuthView.tsx` | Dead (orphaned) | No imports; `App.tsx` import removed (REPORT-006) |
| `DockNav.tsx` | Superseded (still imported? **no** — Layout uses IconSidebar; DockNav unreferenced) | grep `CONFIRMED` |
| `run-preflight-check` IPC | Built but unwired | No renderer caller |
| `launch-poc` channel | Legacy proof-of-concept launcher, still handled (index.ts L427) with same identity resolution | `CONFIRMED` |
| `removeServer()` | Implemented, no IPC caller | `CONFIRMED` |
| `world-manager` legacy migration path | Live code, one-shot migration from `{userData}/minecraft` | `CONFIRMED` |
| `identity.json.pre-*.mjs` backups in `~/mu-verify` | Harness artifacts, outside repo | see 15-VERIFICATION |
