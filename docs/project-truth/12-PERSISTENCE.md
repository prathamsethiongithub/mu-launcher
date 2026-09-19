# 12 — PERSISTENCE

Every persisted location, its owner, and behavior on corruption/deletion. `Base = app.getPath('userData')` (Electron standard: `%APPDATA%/<productName>` on Windows).

## USER DATA (survives uninstall — `deleteAppDataOnUninstall: false` in electron-builder.yml)

| Path | Schema/shape | Owner | Readers/Writers | Startup | Corruption behavior |
|---|---|---|---|---|---|
| `Base/identity.json` | `{ accounts: Account[], activeAccountId, skinProfiles… }` (no tokens) | IdentityService | all account IPC | loaded at init | parse failure → service error path; exact fallback `UNKNOWN` (not runtime-verified) |
| `Base/identity-tokens.bin` | safeStorage-encrypted per-account tokens | IdentityService | ensureValidSession, validate | loaded at init | unreadable → warn "tokens will not persist" (L552); accounts remain, tokens re-login |
| `Base/auth-session.bin` | safeStorage blob (legacy single session) | AuthService | login/logout/restore/launch | restoreSession; **corrupt → delete + signed-out** (L258–264) | recovers by design |
| `Base/worlds.json` | `{ worlds: World[], activeWorldId }` with `rootPath` templates | WorldManager | all world IPC | lazy on first call | `UNKNOWN` (no explicit repair path found) |
| `Base/worlds/<id>/minecraft/` | full MC root: `mods/ resourcepacks/ saves/ versions/` | WorldManager scaffold; MCLC fills | launch | created on world create (L154–162) | partial dirs recreated on demand |
| `Base/worlds/<id>/backups/*.zip` | adm-zip of `saves/` | WorldManager | backup/restore/verify/delete | – | verify-backup integrity check; restore uses `saves.pre-restore` safety dir (L437) |
| `Base/minecraft/` | managed-world MC root + `servers.dat` | MCLC/ServerInjector | launch, injection | created at launch if needed | `servers.dat` corrupt → `.corrupt-<ts>` + fresh (REPORT-005 B, runtime-proven `HISTORICAL`) |
| `Base/minecraft/versions/fabric-loader-*/…json` | Fabric profile JSON | FabricInstaller | ensureFabric | on demand | **validated on read; corrupt → deleted + re-fetched**; atomic writes (REPORT-005 A) |
| `Base/skins/<uuid>.png + .json` | skin cache + metadata (24h TTL) | SkinService | get-skin / get-identity-skin / putCache | on demand | stale TTL → re-fetch; corrupt → re-fetch |
| `Base/runtime/current-java-path.txt` | cached JRE exe path | JavaProvisioner | get-java-path | on demand | existsSync + version-aware smoke test; stale/corrupt → re-provision |
| `Base/runtime/jre/**` | provisioned JRE files | JavaProvisioner | java launch | on demand | partial install self-heals (re-download); pointer written only after smoke test |

## INSTALL FILES (app dir, not userData)

| Path | Notes |
|---|---|
| `out/main/index.js`, `out/preload/index.js`, `out/renderer/**` | electron-vite build output; preflight-check verifies main+preload exist (L172–190) |
| `dist/Ember-…-setup.exe` | NSIS installer output (electron-builder; `productName: Ember`) |
| `build/icon.ico` | app icon |

## CACHE vs SOURCE-OF-TRUTH classification

- **Source of truth:** `identity.json`, `worlds.json`, per-world `saves/`.
- **Cache (reconstructible):** `skins/`, `runtime/` (JRE + pointer), Fabric profile JSON, MCLC assets/libraries, `mods/`+`resourcepacks/` (hash-verified re-download).
- **Game-owned (launcher edits surgically):** `servers.dat` (inject/idempotent/recover), `saves/` (backup/restore only).
- **Temporary state:** `*.tmp` artifacts from atomic writes ( Fabric profile, mods) — orphaned on kill, harmless junk (REPORT-005, P3).

## Migration / deletion behavior

- **Legacy migration:** WorldManager migrates a pre-existing `Base/minecraft/` into a managed world (L678–704); the template root `"{userData}/minecraft"` remains the managed world's root (registry default).
- **Deletion:** `delete-world` removes the world root recursively (fs rm); `remove-account` removes registry entry + tokens (legacy session cleared first via the 06 guard); uninstall keeps everything (NSIS flag).
- **No schema versioning/migrations exist in any persisted file** (`CONFIRMED` — no version field anywhere) → format changes are hand-rolled per feature (e.g. `createdAt` addition caught drift in REPORT-006).
