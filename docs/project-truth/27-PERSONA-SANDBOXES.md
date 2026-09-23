# 27 — PERSONA SANDBOXES: USER-PERSONA ENVIRONMENT MATRIX

> **Owner request (verbatim):** "为每个真实用户画像构造确定性沙盒（seed + 环境约束），运行针对性场景，验证启动器在最坏状态下不崩溃、不撒谎、可恢复。"

## What was built

`tests/e2e/personas/` — persona = deterministic seed + environment constraints + scenario assertions. Runner: `tests/e2e/persona-suite.spec.ts` (one `test.describe` per persona). The layout audit was extracted to `tests/e2e/layout-audit.ts` so the CI gate (`layout-integrity.spec.ts`) and the personas share ONE implementation; `harness.ts` gained `args` / `onLaunched` / `launchTimeoutMs` (test-side only).

## The matrix

| Persona | Seed | Constraints | Scenario | Result |
|---|---|---|---|---|
| grandma-first-boot | empty userData (explicit empty seed — harness default seeds an offline account, which is NOT "first boot") | CPU 4× | boot → "Almost there." → all 4 views → console (Ctrl+L) → zero uncaught exceptions/rejections | ✅ |
| corrupted-state | worlds.json truncated mid-object + stale `.corrupt-*` backup + identity.json legal-JSON-missing-accounts + skins.json `{}` + leftover `.tmp` | none | boot → recovery paths fire (fresh `.corrupt-<ts>` + rebuilt registry + stale backup preserved) → managed world renders → Account alive → `getAccounts` IPC answers → layout clean | ✅ |
| mod-hoarder | 150 skins (long/dup/missing-file names, deterministic PNGs) + 3 worlds | CPU 4× | shelf renders 150 cards < 5s → horizontal scroll reachable → preview + equip row usable → layout law at full width | ✅ |
| flaky-network | offline account | main-process `globalThis.fetch` patched to fail (piston-meta/forge domains, 120ms delay) → recovered (canned manifest) | version list fails → human copy ("Couldn't load versions." + Retry) → no crash → Retry after recovery → list fills | ✅ |
| potato-pc | offline account | CPU 6× + `--use-gl=swiftshader` + 900×600 | boot < 30s grace → all views navigable → layout audit passes → no unhandled rejections | ✅ |

Second batch (recorded, not built): returning-veteran (long history, deep settings), weird-display (DPI/scale/rotation).

## Real defects found and fixed (evidence-based, one commit each)

**1. SkinViewerCanvas: canvas CSS box could outlive a transient wrapper box** (`src/renderer/components/fx/SkinViewerCanvas.tsx`). skinview3d's constructor writes inline `width/height` px from a one-time measurement. On a mount observed mid-layout (150-card shelf hydration, keep-alive remount, CPU throttling) that measurement is transient — probe caught canvas at 183px inside a 174px wrapper at t=0, and under persona load the drift reached **253px vs 251px container and 200×431 canvas inside a 200×351 container**, dangling the canvas over the equip row (`covered: equip by CANVAS`). Fix: structural invariant — pin `canvas.style.width/height = '100%'` after construction and after every RO `viewer.width/height` assignment (same pin the materialize-scale path already applied). Backing store is still driven by the RO measurement.

**2. identity.json legal-JSON-wrong-shape stuck forever** (`src/main/identity-state.ts`, `identity-service.ts loadState`). `loadState()` returned any parseable JSON verbatim: `{"sessions":{}}` (accounts missing) → `getAccounts()` returned `undefined` → every account IPC threw TypeError (`get-accounts` → `.map`, index.ts:1326), the renderer swallowed the rejection, and `saveState()` wrote `{accounts: undefined}` back out — the malformed file was permanent. Unlike world-manager/skin-library (recover-to-known-good), identity let an illegal shape stick. Fix: `normalizeIdentityState()` pure normalizer (drop non-conforming accounts/sessions, clear dangling activeAccountId) wired into `loadState`; 7 unit tests in `tests/identity-state.test.ts`; corrupted-state persona now asserts `getAccounts` IPC actually answers.

## Mechanism notes (why the tests are shaped this way)

- **Main-process network is NOT CDP-offline-able** — `net.ts` uses Node global `fetch` (undici). Faults are injected by patching `globalThis.fetch` inside the running main process via `electronApp.evaluate` (test-side, zero production change); recovery phase re-patches with a canned minimal Mojang manifest so CI needs no external network.
- **Determinism**: all seeds use fixed timestamps/names/hashes; skins are hand-built 64×64 PNGs (real decodable bytes → real models).
- **equip end-to-end is out of scope**: tokens ride safeStorage encryption, so a real `minecraftservices` equip can't be deterministically seeded. Asserted instead as the offline-honest gate (disabled equip with honest styling); full flow stays manual.
- **Layout audit axis-awareness**: check #1 (outside-main-box) gained a scroll-reachable exemption for elements inside horizontally scrollable rails — shelf cards scrolled left inside `overflow-x-auto` are reachable content, not violations (same philosophy as check #3).
- **Harness default seed caveat**: `launchTestApp` without a seed seeds an offline account (guards older tests). Personas wanting true emptiness pass an explicit empty seed.

## Gates

Unit **274/274** (267 baseline + 7 new), E2E **22/22** (17 + 5 persona), typecheck clean. `playwright.config.ts` globalTimeout 5→12 min (five full boots with heavy seeds + throttling).
