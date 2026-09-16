# 13 — EXTERNAL DEPENDENCIES

All major external services/libraries, their integration points, and failure behavior. Versions from `package.json` (`CONFIRMED`).

## Runtime libraries

| Dependency | Version | Purpose | Integration points | Failure behavior |
|---|---|---|---|---|
| `electron` | ^40 | Shell | main/preload | – |
| `react` / `react-dom` | ^19 | UI | renderer | – |
| `msmc` | ^5.0.5 | Microsoft OAuth → Xbox → MCLC tokens | auth-service (`Auth('select_account')`, `refresh`, `getMinecraft().mclc()`), identity-service login | GUI flow; refresh failures → null/E107 → re-login prompt |
| `minecraft-launcher-core` | ^3.18.2 | Downloads + JVM spawn | launch-service `launchWithFabric` (auth triple, root, memory) | 120s timeout E302; spawn errors E303; its internal downloads are NOT bounded by net.ts (only the 120s window covers them) |
| `skinview3d` | ^3.4.2 | Character viewer | SkinViewerCanvas | pins three@0.156 internally — **dedupe alias is load-bearing** (01-ARCHITECTURE) |
| `three` | ^0.185.1 | Renderer underneath skinview3d | SkinViewerCanvas/PlayerDirector | r185 API (no `onBuild`) |
| `prismarine-nbt` | ^2.8.0 | servers.dat + level.dat parsing | server-injector, world-manager health | parse failure → corrupt-recovery (servers.dat) / warning health |
| `adm-zip` | ^0.5.18 | World backup/restore zip | world-manager | `adm-zip.d.ts` unsafe declaration merging noted in lint debt |
| `electron-updater` | ^6 | Auto-update plumbing | updater.ts → renderer events | GitHub provider (see below) |
| `ogl` | ^1.0.11 | Aurora background shader | AuroraBackground.tsx | decorative |
| `motion` | ^12 | Animation primitives | fx components | decorative |
| `@tabler/icons-react`, `clsx`, `tailwind-merge` | – | UI utilities | renderer | – |

## Network services (trust boundaries)

| Service | Endpoint | Used by | Assumptions / failure |
|---|---|---|---|
| Mojang Java runtime manifest | `launchermeta.mojang.com/v1/products/java-runtime/…all.json` | java-provisioner (component per MC version) | pinned manifest hash in URL; E210 if component missing |
| Mojang version metadata | via MCLC + version JSON | launch-service | 120s window |
| Fabric meta | `meta.fabricmc.net` (loader profile) | fabric-installer | cached+validated profile; bounded fetch |
| Modrinth CDN / CurseForge CDN | `cdn.modrinth.com`, `mediafilez.forgecdn.net` | mod-installer (static manifest `mod-data.ts`) | per-file hash (sha512/sha1) verification; per-item non-fatal |
| Minecraft services API | `api.minecraftservices.com` (skin upload; token via msmc) | identity-service, skin-service | allowlisted in `security/ipc-validate.ts`; 401 → one refresh-retry; 30s abort |
| GitHub releases | `prathamsethiongithub/mu-launcher` | electron-updater | `releaseType: release`; unsigned Windows builds (no signature verification beyond updater's own) |
| MSMC/Xbox Live/Microsoft OAuth | via msmc internals | auth + identity login | network-bound; errors surfaced as login failure |

## Windows platform APIs

| API | Used by | Notes |
|---|---|---|
| `app.getPath('userData')` | everything persisted | base for all USER DATA (12-PERSISTENCE) |
| safeStorage (DPAPI-backed) | auth-session.bin, identity-tokens.bin | availability checked; absent → tokens don't persist (documented warn) |
| `child_process` (JVM spawn, wmic) | MCLC, preflight disk check | wmic deprecated on newest Windows — `UNKNOWN` long-term availability |
| `shell.openExternal` | open-external-link | allowlisted URLs only |
| `dialog.showOpenDialog` | select-skin-file | main-side only; path never crosses bridge |

## Assumption ledger (fragile conventions)

1. skinview3d must keep working against root three r185 (dedupe aliases) — upstream bump could break it again.
2. `mod-data.ts` is generated static content — upstream file moves/hashes rot silently until hash check fails (then re-download from CDN fails too).
3. Uncompressed NBT for servers.dat (MC 26.1.2 expectation) — a format change upstream breaks injection.
4. Unsigned NSIS builds — SmartScreen friction for end users is expected behavior, not a bug.
