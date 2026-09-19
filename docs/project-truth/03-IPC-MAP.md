# 03 — IPC MAP

Full Electron boundary. Every channel verified by cross-grepping `ipcRenderer.invoke(` in `src/preload/index.ts` against `ipcMain.handle(` in `src/main/index.ts` — **59 invoke channels exposed by preload, all 59 paired in main** (one multi-line registration, `perform-mod-update`, counted). Two main-only handlers exist with **no preload invoke** (`get-installed-versions`, `mod-download`) — see the drift section. Event channels listed separately.

Conventions: **In** = renderer→main payload, **Out** = resolved value. Errors are returned as `{ success:false, error: string }` (or thrown → invoke rejection) with human-readable `[Exxx]` codes where applicable. All handlers registered in `registerIpcHandlers()` (index.ts). Line numbers are NOT pinned here — they drift with every edit; use the channel name as the anchor.

## 1. Meta / environment

| Channel | In | Out | Notes |
|---|---|---|---|
| `get-app-version` | – | `string` | reads app version |
| `get-platform` | – | `string` (`process.platform`) | none |
| `open-external-link` | `url: string` | `void` | validates via `security/ipc-validate.ts` `validateExternalUrl` (allowlist), then `shell.openExternal`; opens OS browser |
| `fetch-version-list` | `kind: 'minecraft' \| 'fabric' \| 'quilt'` | `{success, versions?}` | remote version manifests for the New World dialog |
| `is-game-running` | – | `boolean` | `launchManager?.isRunning()` |
| `ping-server` | `host: string, port: number` | `ServerStatus` (`{online, ...}`) | SLP over raw socket (server-pinger); never throws — failures degrade to `{online:false}` |
| `select-directory` | – | `string \| null` | native directory picker |
| `parse-modpack` | `filePath: string` | `{success, modpack?: {name, version, minecraft, loader}}` | phase 1 of .mrpack import: reads `modrinth.index.json`, no install yet |
| `run-preflight-check` | – | `{ ok, checks[] }` | wmic disk probe; **no renderer caller** (orphan, still exposed) |

## 2. App storage & cache (Setup screen)

| Channel | In | Out | Notes |
|---|---|---|---|
| `open-app-data-dir` | – | `{success, error?}` | `shell.openPath(app.getPath('userData'))` |
| `get-app-metrics` | – | `{ path: string, bytes: number }` | async recursive walk of the userData dir (threadpool) |
| `clear-cache` | – | `{success, bytesCleared}` | deletes ONLY `skins/` and `minecraft/cache` — worlds/, identity.json, identity-tokens.bin, auth-session.bin are user data and never touched |

## 3. Auth / identity

| Channel | In | Out | Notes |
|---|---|---|---|
| `auth-login` | – | profile or error | `AuthService.login()` (msmc `select_account` GUI); writes `auth-session.bin`; `notifyAuthChanged()` |
| `auth-logout` | – | `{success}` | deletes legacy session file; notify |
| `auth-status` | – | `{ loggedIn, profile, source, activeAccountId, accountCount }` | resolves through `resolvePlayerIdentity()` — **the same rule as launch**; identity-first branch, legacy profile otherwise |
| `get-skin` | – | `{ dataUrl, model } \| null` | identity-first; legacy fallback reads `AuthService` profile; offline → default look |
| `get-accounts` | – | `(Account & { hasSession })[]` | identity registry enriched with live-session flag |
| `get-active-account` | – | `Account \| null` | identity registry read |
| `set-active-account` | `accountId` | `{success, error?}` | `identityService.setActiveAccount`; notify |
| `add-microsoft-account` | – | `{success, account?}` | msmc login → registry add; converges the legacy session (imports tokens into `AuthService` and sets it active) so both systems name the same person |
| `add-offline-account` | `username` | `{success, account?}` | canonical `OfflinePlayer:` UUID (identity-service) |
| `remove-account` | `accountId` | `{success, error?}` | **resurrection guard** (details in 06): UUID-matches the legacy session, clears legacy first via `auth.logout()`, verifies the session file is gone, aborts removal if it survived; only then `identityService.removeAccount` |
| `validate-session` | `accountId` | `{valid, error?}` | `identityService.validateSession`; may refresh tokens as a side effect |
| `identity-sign-out` | `accountId` | `{success, error?}` | signs out identity session; if UUID == legacy session's, also ends the legacy launch session |
| `get-identity-skin` | `accountId, force?` | `SkinProfile \| null` | skin-service (24h cache, `force` bypasses); cached PNG → data URL |

## 4. Skin upload

| Channel | In | Out | Notes |
|---|---|---|---|
| `select-skin-file` | – | `{ preview: dataURL } \| { error }` | main opens the dialog, validates PNG magic + IHDR dims (64×64 / 64×32) + size, holds the path in a main-process variable — filesystem paths never cross the bridge |
| `upload-skin` | `accountId, model` | `{success, skin?, error?}` | POST `api.minecraftservices.com/minecraft/profile/skins` (Bearer = MC token, one 401 refresh-retry, 30s abort); success writes through the cache |

## 5. Java / launch

| Channel | In | Out | Notes |
|---|---|---|---|
| `get-java-path` | `mcVersion?` | `string` | JavaProvisioner provision-or-cache (version-aware smoke test); emits `java-progress` events; called before `launch-game`, outside MCLC's 120s window |
| `detect-java` | – | `{success, path?, error?}` | Setup screen "Detect" button — finds an existing runtime without provisioning |
| `launch-game` | `javaPath` | `{success} \| {success:false, error}` | guards: `launchInProgress` → `[E604]`; `isRunning()` → `[E605]`. Identity resolution same as `auth-status`; token via identity `ensureValidSession` (refreshes; failure → `[E609]`, no silent legacy fallback). Root: managed → `{userData}/minecraft`, personal → world root; passes world `resolution` to MCLC's `window` option. Sets/clears `launchInProgress` in `finally` |
| `launch-poc` | `javaPath, root` | same shape | legacy proof-of-concept path; kept, no UI caller |
| `cancel-launch` | – | `{success}` | `launchManager?.cancel()`; `[E603]` when nothing to cancel |
| `inject-server` | – | `{success}` | ServerInjector standalone path (also runs inside launch step 5) |

## 6. Worlds

| Channel | In | Out | Notes |
|---|---|---|---|
| `create-world` | `spec {name, version, loader, loaderVersion?, ramAllocation?, settingsPath?, modpackPath?}` | `{success, world?, modpackNotice?}` | world-manager.createWorld + .mrpack import: overrides/ extraction AND files[] manifest download ([E701]-[E704]); partial failures surface honestly in `modpackNotice` while creation stands |
| `get-worlds` | – | `World[]` | registry read |
| `get-active-world` | – | `World \| null` | registry read |
| `set-active-world` | `worldId` | `{success, world?}` | registry mutation |
| `rename-world` | `worldId, newName` | `{success}` | registry mutation |
| `update-world-settings` | `worldId, settings {ramAllocation?, resolution?}` | `{success, world?, error?}` | RAM bounds 1024–16384 MB; resolution validated as `"WxH"` or null; persists via world-manager (atomic tmp+rename) |
| `delete-world` | `worldId` | `{success}` | fs rm -rf of world root + registry removal |
| `duplicate-world` | `worldId` | `{success, world?}` | copy tree + new registry entry |
| `repair-world` | `worldId` | `{success, ...}` | world repair pass |
| `get-world-metrics` | `worldId` | `{worldSize, backupSize}` | async dir walk |
| `check-world-health` | `worldId` | `'healthy'\|'warning'\|'corrupted'` | level.dat NBT parse |
| `backup-world` | `worldId` | `{success, name?}` | adm-zip of `saves/` → `backups/<ts>.zip` |
| `get-backups` | `worldId` | `{name,date,size}[]` | backup dir listing |
| `restore-world` | `worldId, backupName` | `{success}` | pre-restore safety dir, then extract |
| `verify-backup` | `worldId, backupName` | `{success, verified}` | zip integrity |
| `delete-backup` | `worldId, backupName` | `{success}` | backup deletion |

## 7. Mods & diagnosis

| Channel | In | Out | Notes |
|---|---|---|---|
| `mod-list` | `worldId` | `{filename, displayName, size, enabled}[]` | world's mods/ listing |
| `mod-add` | `worldId, sourceFilePath` | `{success, error?}` | copies a local jar into mods/ |
| `mod-toggle` | `worldId, filename, enable` | `{success, error?}` | renames to/from `.disabled` |
| `mod-delete` | `worldId, filename` | `{success, error?}` | removes the jar |
| `select-mod-file` | – | `string \| null` | native file picker (jar) |
| `modrinth-search` | `query, gameVersion?, loader?` | `ModrinthSearchResult[]` | Modrinth API; never throws — failures resolve to `[]` |
| `modrinth-download` | `worldId, projectId` | `{success, filename?, error?}` | downloads the newest version-compatible build into mods/ |
| `check-mod-updates` | `worldId` | `ModUpdateInfo[]` | update-checker: fabric.mod.json scan against Modrinth |
| `perform-mod-update` | `worldId, oldFilename, downloadUrl, newFilename` | `{success, error?}` | download-before-delete ordering (multi-line `ipcMain.handle(` registration) |
| `diagnose-world` | `worldId` | `{crashed, modName?, reason?}` | THE ORACLE — parses the world's latest crash report (crash-diagnostic) |

## 8. Updater (invoke)

No updater invoke channels. The updater surface is events only (below); `check-for-updates`/`perform-update` run main-side (update-checker.ts) on timers.

## 9. Event channels (main → renderer, `webContents.send`)

| Channel | Emitter | Preload pair | Notes |
|---|---|---|---|
| `launch-step` | LaunchManager per step | `onLaunchStep` / `removeLaunchListeners` | `{ step, status, progress }` (+ java sub-events remapped); App keeps ONE app-scope listener (REPORT-001 fix) |
| `java-progress` | JavaProvisioner | `onJavaProgress` / `removeJavaProgressListeners` | `{ phase, percent, message? }` |
| `auth-changed` | `notifyAuthChanged()` after login/logout/switch/remove/sign-out | `onAuthChanged` / `removeAuthChangedListeners` | App re-pulls the auth snapshot |
| `update-available` / `update-not-available` / `update-download-progress` / `update-downloaded` | updater.ts | `onUpdateAvailable` / `onUpdateNotAvailable` / `onUpdateDownloadProgress` / `onUpdateDownloaded` | `UpdateState` payloads |

## Duplicates / legacy / inconsistencies (documented, not fixed)

- **Two launch channels** (`launch-game` canonical, `launch-poc` legacy POC) share identity resolution — divergence risk if one drifts.
- **Two auth systems behind one `auth-status`** — the renderer sees a unified shape, but `get-accounts`/`get-active-account` are identity-only; a legacy-only session is invisible to the Account screen while still playing (documented resolution order in 06-AUTH-IDENTITY).
- **`run-preflight-check` orphan** — exposed, never called by the renderer.
- **Main-only handlers** — `get-installed-versions` and `mod-download` have `ipcMain.handle` registrations but no preload invoke, so the renderer cannot reach them. Dead surface as of this writing.
- **Listener removal asymmetry** — `removeLaunchListeners`/`removeJavaProgressListeners` use `removeAllListeners` on the channel; any second subscriber would be silently dropped (current code has exactly one subscriber each).
- **`env.d.ts` vs preload** — env.d.ts is manually maintained and can drift from the preload surface. It was last synced alongside the trust-repair branch (Setup channels, `updateWorldSettings(resolution)`, `createWorld(modpackNotice)`), but check it before adding new channels.
