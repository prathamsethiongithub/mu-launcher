# 03 — IPC MAP

Full Electron boundary. Every channel verified by cross-grepping `ipcMain.handle(` in `src/main/index.ts` against `ipcRenderer.invoke(` in `src/preload/index.ts` (all 42 pairs matched — `CONFIRMED`). Event channels listed separately.

Conventions: **In** = renderer→main payload, **Out** = resolved value. Errors are returned as `{ success:false, error: string }` (or thrown → invoke rejection) with human-readable `[Exxx]` codes where applicable. All handlers registered in `registerIpcHandlers()` (index.ts L214+).

## 1. Meta / environment

| Channel | In | Out | Main handler | Preload | Side effects |
|---|---|---|---|---|---|
| `get-app-version` | – | `string` | L215 | L5 | none |
| `get-platform` | – | `string` (`process.platform`) | L228 | L11 | none |
| `open-external-link` | `url: string` | `void` | L219 — validates via `security/ipc-validate.ts` `validateExternalUrl` (allowlist), then `shell.openExternal` | L8 | opens OS browser |
| `get-installed-versions` | – | `string[]` | L793 → `launch-service.getInstalledVersions()` (scans `versions/` dirs with valid `<name>.json`, launch-service L370–376) | (invoke present L?) | read-only fs |
| `run-preflight-check` | – | `{ ok, checks[] }` | L814 → preflight-check.ts | L119 | wmic disk probe; **no renderer caller** |
| `is-game-running` | – | `boolean` | L803 → `launchManager?.isRunning()` | L142 | none |

## 2. Auth / identity

| Channel | In | Out | Main handler | Key behavior |
|---|---|---|---|---|
| `auth-login` | – | profile or error | L264 → `AuthService.login()` (msmc `select_account` GUI) | Writes `auth-session.bin`; `notifyAuthChanged()`. |
| `auth-logout` | – | `{success}` | L293 → `AuthService.logout()` | Deletes session file; notify. |
| `auth-status` | – | `{ loggedIn, profile, source, activeAccountId, accountCount }` | L333 | Resolves through `resolvePlayerIdentity()` (L313) — **the same rule as launch**; identity-first (L315 branch), legacy profile otherwise. |
| `get-skin` | – | `{ dataUrl, model } \| null` | L310 | Resolves identity-first; legacy fallback reads `AuthService` profile (L336–342). Offline → default look (no skin borrowing). |
| `get-accounts` | – | `(Account & { hasSession })[]` | L587–595 | Enriches registry with live-session flag. |
| `get-active-account` | – | `Account \| null` | L597–599 | Registry read. |
| `set-active-account` | `accountId` | `{success, error?}` | L602–607 → `identityService.setActiveAccount` | Persists `activeAccountId`; notify. |
| `add-microsoft-account` | – | `{success, account?}` | L609–635 | msmc login → registry add; **converges legacy session** (L612–630): imports refresh/access token into `AuthService` and sets it active, so legacy and identity name the same person. Legacy-sync failure is logged, not fatal (L627–630). |
| `add-offline-account` | `username` | `{success, account?}` | L637–653 | Canonical `OfflinePlayer:` UUID (identity-service). |
| `remove-account` | `accountId` | `{success, error?}` | L655–691 | **Resurrection guard** (details in 06): UUID-matches the legacy session; clears legacy first via `auth.logout()`, **verifies** `hasPersistedSession()` is false; aborts removal if the legacy file survived. Only then `identityService.removeAccount`. |
| `validate-session` | `accountId` | `{valid, error?}` | L693–696 → `identityService.validateSession` | May refresh tokens as a side effect (REPORT-006 gap #5, still current). |
| `identity-sign-out` | `accountId` | `{success, error?}` | L765–780 | Signs out identity session; if UUID == legacy session's, also ends the legacy launch session (L770–775). |
| `get-identity-skin` | `accountId, force?` | `SkinProfile \| null` | L698–707 → skin-service (24h cache, `force` bypasses) | fs read of cached PNG → data URL. |

## 3. Skin upload

| Channel | In | Out | Main handler | Key behavior |
|---|---|---|---|---|
| `select-skin-file` | – | `{ preview: dataURL } \| { error }` | L709–749 | Main opens `dialog.showOpenDialog`, validates PNG magic + IHDR dims (64×64 / 64×32) + size (L733 error copy), **holds the path in a main-process variable**; filesystem paths never cross the bridge. |
| `upload-skin` | `accountId, model` | `{success, skin?, error?}` | L751–763 → identity-service (POST `api.minecraftservices.com/minecraft/profile/skins`, Bearer = MC token, one 401 refresh-retry, 30s abort) | On success `putCache()` write-through so every surface reflects instantly (REPORT-006). |

## 4. Java / launch

| Channel | In | Out | Main handler | Key behavior |
|---|---|---|---|---|
| `get-java-path` | `mcVersion?` | `string` | L233–262 → JavaProvisioner | Provisions or cache-hits JRE (version-aware smoke test). Emits `java-progress` events during download. Renderer calls it **before** `launchGame` (App.tsx) — outside MCLC's 120s window. |
| `launch-game` | `javaPath` | `{success} \| {success:false, error}` | L362–425 | Guards: `launchInProgress` → `[E604]`; `isRunning()` → `[E605]`. Resolves `resolvePlayerIdentity()` (L381); token via `resolveLaunchAuthorization()` (L192–212) — identity: `ensureValidSession` (refreshes tokens; failure → `[E609]` with the reason, **no silent legacy fallback**); legacy: `getAuthorizationForMCLC`. Picks root: managed → `{userData}/minecraft`, personal → world root (L359 comment, L~386). Runs LaunchManager steps; sets/clears `launchInProgress` in `finally`. |
| `launch-poc` | `javaPath, root` | same shape | L427–473 | Legacy proof-of-concept path, same identity resolution (L435). Kept; no UI caller found in current renderer. |
| `cancel-launch` | – | `{success}` | L782–791 → `launchManager?.cancel()` | Cancels MCLC promise; `finally` clears `launchInProgress`. |
| `inject-server` | – | `{success}` | L836–843 → ServerInjector | Standalone injection path (also runs inside launch step 5). |

## 5. Worlds

| Channel | In | Out | Main handler |
|---|---|---|---|
| `create-world` | `spec {name, template, memory}` | `{success, world?}` | L475–507 → world-manager.createWorld (dir scaffold L154–162) |
| `get-worlds` | – | `World[]` | L509–515 |
| `get-active-world` | – | `World \| null` | L517–523 |
| `set-active-world` | `worldId` | `{success, world?}` | L525–533 |
| `rename-world` | `worldId, newName` | `{success}` | L535–538 |
| `delete-world` | `worldId` | `{success}` | L540–543 (fs rm -rf of world root) |
| `duplicate-world` | `worldId` | `{success, world?}` | L545–548 (copy tree + new registry entry) |
| `get-world-metrics` | `worldId` | `{worldSize, backupSize}` | L550–553 |
| `check-world-health` | `worldId` | `'healthy'\|'warning'\|'corrupted'` | L555–558 (level.dat NBT parse) |
| `backup-world` | `worldId` | `{success, name?}` | L560–563 (adm-zip of `saves/` → `backups/<ts>.zip`) |
| `get-backups` | `worldId` | `{name,date,size}[]` | L565–568 |
| `restore-world` | `worldId, backupName` | `{success}` | L570–573 (pre-restore safety dir, then extract) |
| `verify-backup` | `worldId, backupName` | `{success, verified}` | L575–578 (zip integrity) |
| `delete-backup` | `worldId, backupName` | `{success}` | L580–585 |

## 6. Updater (invoke)

| Channel | In | Out |
|---|---|---|
| (updater IPC surface per preload L13–29 registers listeners; no extra invoke channel besides the above) | | Events below. |

## 7. Event channels (main → renderer, `webContents.send`)

| Channel | Emitter | Payload | Preload pair | Renderer consumer |
|---|---|---|---|---|
| `launch-step` | LaunchManager per step (`mainWindow.webContents.send`) | `{ step, status, progress }` (+ java sub-events remapped; App.tsx L127 comment: identity rewrites are skipped for high-frequency MCLC events) | `onLaunchStep` / `removeLaunchListeners` (preload L256–263) | App.tsx — **one app-scope listener** (REPORT-001 fix) |
| `java-progress` | JavaProvisioner | `{ phase, percent, message? }` | `onJavaProgress` / `removeJavaProgressListeners` (preload L85–90) | App (via launch flow) |
| `auth-changed` | `notifyAuthChanged()` after login/logout/switch/remove/sign-out | (signal) | `onAuthChanged` / `removeAuthChangedListeners` (preload L98–110) | App re-pulls auth snapshot |
| `update-available` / `update-not-available` / `update-download-progress` / `update-downloaded` | updater.ts | `UpdateState` payloads | preload L13–29 | (rendered where update state is consumed) |

## Duplicates / legacy / inconsistencies (documented, not fixed)

- **Two launch channels** (`launch-game` canonical, `launch-poc` legacy POC) share identity resolution — divergence risk if one drifts.
- **Two auth systems behind one `auth-status`** — the renderer sees a unified shape, but `get-accounts`/`get-active-account` are identity-only; a legacy-only session is invisible to the Account screen while still playing (documented resolution order in 06-AUTH-IDENTITY).
- **`run-preflight-check` orphan** — exposed, never called.
- **Listener removal asymmetry** — `removeLaunchListeners`/`removeJavaProgressListeners` use `removeAllListeners` on the channel; any second subscriber would be silently dropped (current code has exactly one subscriber each — `CONFIRMED`).
- **`env.d.ts` vs preload** — env.d.ts is manually maintained and can drift from the preload surface (e.g. `getJavaPath(mcVersion?)` optional arg exists in main/preload; env.d.ts shows 0-arg form). `CONFIRMED` minor drift (env.d.ts L35 `getJavaPath: () => Promise<string>` vs preload `invoke('get-java-path')` without version — the optional version argument is **not passed by the renderer today**).
