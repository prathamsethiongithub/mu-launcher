# 04 — STATE OWNERSHIP

For each major state: source of truth, in-memory owner, persisted owner, derived state, readers/writers, lifecycle behavior. Classification per state: `IN-MEMORY` / `PERSISTED` / `DERIVED` / `LEGACY-FALLBACK`.

## Accounts & identity

| Aspect | Value | Status |
|---|---|---|
| Source of truth | `identity-service.ts` registry: `identity.json` (accounts, activeAccountId, skin profiles) + `identity-tokens.bin` (encrypted tokens per account) | `PERSISTED` |
| In-memory owner | `IdentityService` singleton in main (`identityService`, index.ts L34) | `IN-MEMORY` |
| Legacy/fallback owner | `AuthService` single-slot session → `auth-session.bin` | `PERSISTED` (LEGACY-FALLBACK by role) |
| Readers | `get-accounts`, `get-active-account`, `auth-status`, `get-skin`, `launch-game` (via `resolvePlayerIdentity`) | |
| Writers | `add-microsoft-account`, `add-offline-account`, `set-active-account`, `remove-account`, `identity-sign-out`, `auth-login`, `auth-logout` | |
| Startup restoration | IdentityService constructor loads both files; token file unreadable → warn "tokens will not persist" (L552); corrupt identity.json → `UNKNOWN` handling (file parse failure path present in service, exact UX not runtime-verified) | |
| Restart | Registry restores from disk; **the active account is whoever `identity.json` says**; if it has no session record, resolution falls to legacy (`CONFIRMED` — resolvePlayerIdentity L179–188). | |
| Failure behavior | `ensureValidSession` refresh failure throws → E609; does **not** mutate the registry. | |

## Launch state

| Aspect | Value |
|---|---|
| Backend truth | `launchManager` module singleton (main, index.ts L~15) — a new `LaunchManager` per launch; `launchInProgress` module flag; `isRunning()` tracks the MCLC child process | `IN-MEMORY` (main) |
| Renderer mirror | `App.tsx` holds `launching/launchError/launchSteps/isRunning` — **derived from `launch-step` events**, lifted to app scope (REPORT-001). It is a *mirror*, not the truth; `is-game-running` is pulled once on mount (L105) to reconcile after a restart. | `DERIVED` |
| Persisted | None. A launcher restart loses all launch progress; `launchInProgress` resets to false; a still-running Minecraft from a previous launcher session is invisible to E605 (REPORT-003 documented limitation, still current — `CONFIRMED` no cross-process detection in index.ts). | |
| Failure | Errors surface as `{success:false,error}` → launchError card + Retry. | |
| Race guard | Renderer `launchingRef` + main `launchInProgress` + `isRunning()` (E604/E605). | |

## Progress state (Ignition/ForgeLine)

| Aspect | Value |
|---|---|
| Source of truth | LaunchManager's internal step list + MCLC/java event stream (main). | `IN-MEMORY` |
| Renderer | App-owned `launchSteps` array, updated by the single `launch-step` listener; ForgeLine renders it. Hero text/percentage are **derived from event payloads**, not from backend truth directly — see 08-IGNITION for truth-vs-status gaps. | `DERIVED` |

## Worlds

| Aspect | Value |
|---|---|
| Source of truth | `world-manager.ts` + `worlds.json` (registry incl. `activeWorldId`, root templates, createdAt). | `PERSISTED` |
| In-memory | WorldManager singleton (main). | `IN-MEMORY` |
| Renderer | `App.tsx` `worlds` + `activeWorld` state, refreshed after every mutation via explicit re-fetch (`getWorlds`/`getActiveWorld`) — no cache, no event channel for worlds. | `DERIVED` |
| Startup | Registry loaded lazily on first IPC; legacy migration from `{userData}/minecraft` happens in WorldManager init (L678–704). | |
| Active-world semantics | `set-active-world` persists `activeWorldId`; launch uses the active world's root (managed → `{userData}/minecraft`). | |

## Skins

| Source of truth | Mojang profile (upstream) + local cache `{userData}/skins/`. | `CACHE` |
| Owner | `skin-service.ts` (cache, 24h TTL), `identity-service.ts` (profile metadata + upload). | |
| Renderer | PlayView hero + IdentityView studio read via `get-skin` / `get-identity-skin`; upload path: `select-skin-file` (main holds the path) → staged preview → `upload-skin` → `putCache` write-through. | |

## Java

| Source of truth | Mojang runtime manifest per MC version; cache pointer `{userData}/runtime/current-java-path.txt`. | `PERSISTED` (cache) |
| Validation | On cache hit: `existsSync` + `smokeTest(path, expectedMajor)` — exact major match enforced (java-provisioner L161–171, L387–396). Corrupt/stale → full re-provision. | |

## Minecraft configuration

| Item | Owner |
|---|---|
| `servers.dat` | ServerInjector — MU SMP injected every launch (idempotent); corrupt → `.corrupt-<ts>` backup + fresh file (REPORT-005 Part B). | `PERSISTED` (game-owned) |
| Options (memory etc.) | Memory is a world-registry field, passed to MCLC per launch; not written to `options.txt` by the launcher (`CONFIRMED` — no options.txt writer in src). | |
| Fabric profile | `{userData}/minecraft/versions/fabric-loader-…/…json` — validated on read, atomic writes (REPORT-005 Part A). | `CACHE` |

## Launcher configuration / UI state

| Item | Classification |
|---|---|
| Launcher settings (theme, etc.) | **No persisted launcher settings exist** — SettingsView is a read-only manifest of the active world (`CONFIRMED`). | — |
| Renderer view state (current view) | `IN-MEMORY` App state; resets to Play on restart. | |
| Update state | `IN-MEMORY`, event-driven from electron-updater. | `DERIVED` |
| Auth snapshot in renderer | `DERIVED` from `auth-status` + `auth-changed` events. | |

## Stale-state / race notes

- Worlds have **no change events**: two windows or an out-of-band fs change would desync the renderer (single-window app today — LOW).
- Launch mirror survives navigation but **not** an app restart; the `is-game-running` mount pull reconciles the `isRunning` bit only, not mid-flight progress (`CONFIRMED` App.tsx L105).
- Identity `validate-session` mutates tokens during a nominally read probe (REPORT-006 gap #5, still current).
