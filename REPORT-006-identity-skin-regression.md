# REPORT-006 — Identity Skin Regression + Account UX Completion

**Date:** 2026-07-11 · **Status:** Fixed, verified, shipped

## Symptom

After the Identity Management backend landed (IdentityService, SkinViewerCanvas
extraction, Identity Studio V1): the Play screen hero character stopped
rendering, and the Account screen showed "No skin" for a signed-in Microsoft
account.

## Root causes (two independent bugs, one shared symptom)

### RC-1 — SkinViewerCanvas mount-order defect (killed the Play hero)

The extraction of PlayerIdentity's viewer into `SkinViewerCanvas` introduced a
conditional tree: when `skinUrl` was null the component returned a "No skin"
`<div>` **with no `<canvas>` element**. The skinview3d viewer is created in a
`useEffect(..., [])` that runs exactly once — on mount, when the skin has never
yet arrived (it always resolves async over IPC). The effect bailed on
`canvasRef.current === null`, the viewer was never created, and the later
`loadSkin` effect no-oped forever. Deterministic, not a race.

**Fix:** one stable tree — the canvas is always mounted; the empty state is an
overlay (`emptyLabel`, default hidden so the Play stage stays clean).

### RC-2 — `require('./skin-service')` inside the bundled main process (killed the Account screen)

`IdentityService.getSkin()` did a runtime
`require('./skin-service')`. electron-vite bundles the entire main process
into a single `out/main/index.js`; there is no sibling `skin-service.js` on
disk, so the require threw MODULE_NOT_FOUND, the `catch` swallowed it, and
`get-identity-skin` returned null → "No skin". Verified by grepping the actual
bundle (the literal require was present pre-fix, absent post-fix).

**Fix:** static top-level import + shared instance. Also removed the same
hazard from `clearAll()` (fs/path requires), `generateOfflineUUID()` (crypto),
and the old upload path (`form-data` package — replaced entirely).

## Fixes shipped

| File | Change |
|---|---|
| `src/renderer/components/fx/SkinViewerCanvas.tsx` | RC-1 fix; `emptyLabel` prop; energetic via ref |
| `src/main/identity-service.ts` | RC-2 fix; `signOut()`; uploadSkin rewritten (see below); msmc typing matched to auth-service (`new Auth('select_account')`, `minecraft.mclc().access_token`) |
| `src/main/skin-service.ts` | `getSkin(uuid, {force})` cache bypass; public `putCache()`; require() cleanup |
| `src/main/index.ts` | `get-skin` prefers identity active account (falls back to legacy auth); `get-accounts` enriched with `hasSession`; new `select-skin-file` (native dialog + PNG validation, path held in main); `upload-skin` re-signed to `(accountId, model)`; new `identity-sign-out` (also ends the legacy launch session when UUIDs match) |
| `src/preload/index.ts` | New/changed bridge methods, typed via `shared/types` |
| `src/env.d.ts` | Typed identity + worlds blocks (`Account`/`SkinProfile`/`World` replace `any`) |
| `src/preload/index.d.ts` | Neutralized — it declared a stale second `Window.electronAPI` (11 methods) that shadowed the real one and caused the phantom `isGameRunning` type error |
| `src/renderer/components/IdentityView.tsx` | Full UX pass (see below) |
| `src/renderer/App.tsx` | Dead `AuthView` import removed; `createdAt` added to WorldData; IdentityView prop cleanup |

## Upload flow architecture

1. Renderer calls `selectSkinFile()` → **main** opens `dialog.showOpenDialog`,
   validates PNG magic bytes + IHDR dimensions (64×64, legacy 64×32) + size,
   stores the path in a main-process variable, returns only a preview data URL.
   Filesystem paths never cross the bridge in either direction.
2. Studio stages the skin: live 3D preview on the actual character, arm-style
   toggle (Classic/Slim), explicit "Use this skin" confirm.
3. `uploadSkin(accountId, model)` → main POSTs native `FormData`/`Blob` to
   `api.minecraftservices.com/minecraft/profile/skins` (Bearer = Minecraft
   token; one refresh-and-retry on 401; 30s abort timeout).
4. On success the uploaded PNG is written straight into the skin cache
   (`putCache`) — every surface (hero, studio) reflects it instantly, no CDN
   propagation wait. Refresh button calls `getIdentitySkin(id, force=true)` to
   bypass the 24h cache when the skin changed outside the launcher.

## Account screen UX

- Sign out (active MS account; reuses `AuthService.logout()` for the legacy
  session so signed out means signed out everywhere), signed-out state chip +
  re-sign-in action, Switch on inactive rows, Remove with inline two-step
  confirm (danger color only inside the confirm), ember active-rail matching
  the Worlds selection language, quiet offline-studio empty state, progressive
  disclosure (upload parameters appear only while a skin is staged).

## Verification

- `tsc --noEmit`: **0 errors** (3 pre-existing errors also resolved).
- ESLint: **0 errors in all touched files** (repo-wide 43 → 22; remainder in
  untouched legacy files: mod-list, world-manager, server-injector, adm-zip.d.ts).
- `npm run build`: clean (main/preload/renderer).
- Bundle check: `require("./skin-service")` absent; new endpoint present.
- Runtime smoke: app boots, `[auth] Session restored`, no identity/skin errors.

## Remaining gaps (documented, not shipped)

1. **Launch doesn't use IdentityService** — `launch-game` still calls
   `getAuthService().getAuthorizationForMCLC()` (index.ts). Switching the
   active identity account changes your face, not the launch token.
   `IdentityService.ensureValidSession()` is ready to wire in; needs its own
   QA pass (offline-mode launch, mid-launch refresh).
2. **AuthView.tsx is orphaned** (no imports) — candidate for `_graveyard/`.
3. **`WorldData` is duplicated in 4 renderer files** (App, PlayView,
   WorldsView, WorldSwitcher) and drifts (the `createdAt` mismatch caught this
   session) — should import one shared type.
4. **Offline-account skins**: offline accounts always show the default look;
   local skin files for offline accounts would need a renderer-side store.
5. **`validateSession` refreshes as a side effect** — fine for launch, but a
   read-only session probe would let the UI show expiry without mutating.
