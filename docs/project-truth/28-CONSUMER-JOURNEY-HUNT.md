# 28 — CONSUMER JOURNEY HUNT: DEATH-SESSION RECOVERY

> **Owner request (verbatim):** "狩猎四类旅程中间态缺陷——①下载中途死亡→重生完整性 ②过期令牌归来老兵 ③休眠唤醒托盘僵尸 ④首启诚实性测量。生产代码零改动，除非狩猎发现真实缺陷——按证据修，引用行号，一缺陷一 commit。"

## What was built

`tests/e2e/journey/` — journey = a user's mid-state disaster script, driven on the real app through real IPC. Shared instrumentation in `tests/e2e/journey/lib.ts`:

- **Slow-drip body streams** — `patchMainNetworkStream` answers headers immediately, then drips N chunks at a fixed rate (`ReadableStream`), so a `process.kill()` mid-body lands inside the transfer. Re-patching composes onto the captured original fetch (`__realFetch`), never onto a previous patch.
- **Canned msmc auth chains** — msmc requires its own node-fetch, so main-process `globalThis.fetch` patching can't see the token chain. Instead the REAL `Auth` class is reached through `process.mainModule.constructor._cache` (msmc is require-external in the esbuild bundle) and `Auth.prototype.launch/.refresh` are prototype-patched. msmc's exports are getter-only (TS-transpiled), but the class prototype is mutable — every instance identity-service ever builds is intercepted. Launch mints real encrypted tokens through the real `addMicrosoftAccount`/`updateSession`/`saveTokens` path with a deterministic veteran profile; refresh resolves or rejects per mode.
- **Resettable clock shim** — `shiftMainClock` captures the original `Date.now` ONCE on `globalThis.__realDateNow`; offset 0 genuinely restores. (The first implementation captured the current `Date.now` each call — the "restore" re-wrapped the patch and the shifted clock never came back, silently invalidating every downstream expiry contract. Caught during expired-token debugging.)

## The hunt

| Prey | Script | Tests | Result | Findings |
|---|---|---|---|---|
| #1 kill-mid-download | Modrinth jar slow-dripped (16s total) → SIGKILL at ~30/60/90% body → respawn → retry completes | 3 E2E (`kill-mid-download.spec.ts`) | ✅ 3/3 | **Zero production defects.** tmp+rename atomic discipline (`mod-downloader.ts` step 5) held: truncated `.jar.tmp` never masquerades as a mod; respawn healthy; retry completes for real. Storage model: mods/ only ever sees fully-written jars. |
| #2 expired-token veteran | Tokens minted through the REAL path while the main clock is shifted back 3d2h (born expired on disk) → silent re-auth (refresh ok) / honest verdict (refresh dead) / cold-restart revival | 3 E2E (`expired-token.spec.ts`) | ✅ 3/3 | **Zero production defects.** validate-session judges expiry against the ENCRYPTED token store (identity-tokens.bin), not identity.json's decorative sessions metadata. Dead refresh → honest "Session expired. Please sign in again." in <10s — no dead wall, no infinite spinner. |
| #3 hibernate tray zombie | Unit: fake timers, 8h suspend → interval keeps firing, wedged/rejecting pings can't block the loop, dispose clears the only timer, initTray idempotent. E2E: close-to-tray + dead-server ping → app healthy, window returns | 6 unit (`tray-timers.test.ts`) + 1 E2E (`tray-wake.spec.ts`) | ✅ 7/7 | **Zero production defects.** Node timers are relative — an 8h suspend does not deschedule the 60s monitor; per-ping 5s idle + 6s hard cap bounds any socket behavior. |
| #4 first-boot honesty | Clean profile → first Play on the REAL chain (real Mojang egress) → segmented timing to game process | 1 E2E (`first-boot-timing.spec.ts`) | ✅ 1/1 | **Measurement, not a bug.** TOTAL **158–194s** (three runs) — way past the 90s budget. Follow-up task suggested below. |

## Cold-boot segment data (journey-first-boot.json)

| Segment | Run 1 | Run 2 (full gate) | Run 3 (full gate) |
|---|---|---|---|
| play-click → java | 9,133 ms | 8,261 ms | 7,956 ms |
| play-click → launch (MCLC pipeline done) | 193,597 ms | 158,372 ms | 180,420 ms |
| play-click → game-proc | 193,597 ms | 158,372 ms | 180,420 ms |

Java provisioning is ~9s; the other ~2.5 minutes are MCLC version/assets/libraries downloads on real Mojang egress.

> **Follow-up task suggestion (recorded, NOT fixed — journey #4 is measurement-only):** first-boot copy should set expectations — at >150s the user stares at a progress line with no sense of the total. A "first launch downloads ~X MB, takes a few minutes" line (or a bytes-progress figure) during the MCLC phase is the cheap honest fix. Tone example (user's ear, matches the launcher's lowercase voice): "first time takes a few minutes. it's worth it." First-time UX bug triage belongs to a dedicated task, not to a hunt whose contract is zero production change.

## Test-side defects found and fixed (the hunt's own snares — zero production change)

1. **`test(name, fn, 300_000)` is a Jest signature; Playwright silently ignores the third argument** (`kill-mid-download.spec.ts`). Every #1 test was killed by the config's 60s default long before the ~90s three-boot journey could finish — the failure masqueraded as "download never grew" but the real cause was the harness itself. Fix: `test.setTimeout(300_000)` at file top level (the correct Playwright way, already used in `first-boot-timing.spec.ts`).
2. **Drip-rate math made the 90% kill point unsatisfiable by construction** (`lib.ts jarSlowBody`). 250ms × 16KB chunks = 65,536 B/s → the 90% threshold (2.36 MB) needed 36s to arrive, but the growth-poll window is 30s. Fix: 100ms/chunk → 163,840 B/s → 90% at ~14.4s, comfortably inside the window. Kill points remain well-spaced (16s total transfer).
3. **Renderer `window.close()` is IGNORED by Chromium for non-script-opened windows under `sandbox:true`** (probe v5 evidence, preserved as a comment in `tray-wake.spec.ts`). The close-to-tray journey must fire the real close event from the main side — `app.evaluate(({BrowserWindow}) => …close())` — exactly as a user's X-button does. The same probe also killed a red herring: the window HIDES (close intercepted → `mainWindow.hide()`), it is never destroyed, so `show()` from the main side is the tray-click equivalent.
4. **`app.browserWindow(page)` returns a Promise** — calling `.evaluate` on it un-awaited throws TypeError. Same main-side evaluate pattern as (3) fixed it.

Diagnostic probes used during the hunt were removed after their findings were recorded (`_probe.spec.ts` v5 close-to-tray forensics; `_probe-drip.spec.ts` v7 — rebuilt with a REAL worldId from getWorlds and an awaited IPC result, proving the pipeline itself is sound: `success:true, journey-mod.jar` on disk, tmp→rename atomic). Probes pointed the blame at the two real snares above plus the fake-worldId snare (6) below.

6. **A probe with a hardcoded `worldId:'PENDING'` produces INVALID evidence, not app evidence** — the IPC resolved `World not found` without ever reaching the downloader, so its tmp=0 reading diagnosed nothing. The rebuilt probe resolves the worldId through `getWorlds()` and AWAITS the IPC result first (never-throw means `success:false` carries the app's own error string — diagnostic gold), then samples fs.statSync bytes on a 2s×15 curve. Verdict: download completes, mods state clean.

## Storage model fact worth keeping (journey #2)

`validateSession` judges expiry against the **encrypted token store** (`identity-tokens.bin`, safeStorage), NOT the `identity.json` sessions metadata — the JSON field is decorative for the expiry decision. That is why the veteran is seeded by minting tokens through the real `addMicrosoftAccount` path on a back-dated clock rather than by hand-editing JSON: hand-edited sessions are never consulted.

## Red lines honored

- `stash@{0}` (crash-corpus WIP: owo-lib dep scenario + missing-dependency attribution rules) — untouched; it is prey #5 with its own task order.
- Production code: **zero changes across the whole hunt** (diff vs master is tests + config + docs only). Every prey's "no production defect" verdict is evidence-backed by green tests, not by absence of failures.

## Gates

Unit **281/281** (274 baseline + 7 tray-timers), E2E **30/30** (22 baseline + 8 journey), typecheck + build clean. `playwright.config.ts` globalTimeout 12→20 min (journey adds eight more full boots: three SIGKILL respawn chains ×2 boots each + one real-egress first-Play measurement).
