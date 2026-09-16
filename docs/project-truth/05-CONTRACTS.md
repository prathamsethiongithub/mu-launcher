# 05 — CONTRACTS

Cross-boundary type contracts and the **implicit** contracts that types don't capture.

## Typed contracts (`CONFIRMED` — shared/types.ts, env.d.ts, preload/index.ts)

| Contract | Defined in | Consumers |
|---|---|---|
| `World { id, name, rootPath, template, createdAt, … }` | `src/shared/types.ts` | main (world-manager) ↔ preload ↔ renderer (App/PlayView/WorldsView/WorldSwitcher/SettingsView) |
| `Account { id, type: 'microsoft'\|'offline', uuid, username, skinProfile? }` | shared/types | main (identity) ↔ preload ↔ renderer (IdentityView) |
| `SkinProfile { …, model: 'classic'\|'slim' }` | shared/types | identity-service/skin-service ↔ IdentityView |
| `WorldTemplate`, `MemoryOption` | shared/types | NewWorldDialog, world-manager |
| `UpdateState` | shared/types | updater.ts ↔ renderer listeners |
| `Window.electronAPI` ambient surface | `src/env.d.ts` | all renderer code |

## Implicit contracts (documented — nothing enforces these today)

1. **`launch-step` event ordering** — App's mirror assumes steps arrive in order and `status` values match what ForgeLine renders; the main process does not version the payload. Drift would silently mis-render progress (`CONFIRMED` payload is `{step, status, progress}` only).
2. **`launch-game` javaPath precondition** — the renderer must call `get-java-path` first; main does not validate that the path exists before MCLC spawn (spawn failure surfaces as E303).
3. **`select-skin-file` → `upload-skin` handshake** — the staged file path lives in a main-process variable; `upload-skin` for a *different* account or after a canceled dialog relies on main's internal state being consistent (single-variable staging; `CONFIRMED` L705–763).
4. **`{userData}` root template placeholder** — world `rootPath` strings are stored as templates (`"{userData}/minecraft"`, `"{userData}/worlds/<id>/minecraft"`) and resolved at use sites (world-manager L615–620, launch-service root override). Anything writing a raw path into the registry would bypass the placeholder convention.
5. **Legacy UUID equivalence** — removal/sign-out match the legacy session by **normalized UUID** (dashes stripped, index.ts L670/L771). This is the load-bearing contract preventing wrong-account legacy clears.
6. **`auth-status` unified shape** — renderer treats `{loggedIn, profile, source, activeAccountId, accountCount}` as one truth; `source: 'identity'|'legacy'` is set by main's resolution, and `profile` for identity source carries the active account's profile (`CONFIRMED` L146–158, L333).
7. **MCLC auth triple** — `{access_token, uuid, name}` from either auth system must satisfy MCLC; `ensureValidSession` and `getAuthorizationForMCLC` both conform (`CONFIRMED`).
8. **servers.dat NBT format** — written as *uncompressed* NBT because MC 26.1.2 expects raw NBT for servers.dat (server-injector L195 comment). Any future compression would break the game's read.
9. **Event listener lifecycle** — renderer must call `removeLaunchListeners`/`removeJavaProgressListeners` only at app teardown (they `removeAllListeners` the channel — see 03 §inconsistencies).
10. **`mod-data.ts` hash format** — sha512 for Modrinth items, sha1 for at least one CurseForge item (`chat_heads`, L18); mod-installer dispatches on `hashFormat`. A malformed entry fails validation and re-downloads (non-fatal).
