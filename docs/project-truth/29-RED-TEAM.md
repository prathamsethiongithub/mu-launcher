# 29 — RED TEAM: NINE-ATTACK LIVE-FIRE VERIFICATION

> **Owner order (verbatim):** "红队执行令：EMBERFALL —— 前置模型已完成的对抗分析，现在逐条实弹验证。九项攻击先取证 → 再实弹 → 后判定 → P0/P1 立即修复。执行顺序 1 → 2 → 3 → 6 → 7 → 5 → 4 → 8 → 9，按可利用性排序。"
>
> **Iron rules honoured:** every payload synthesised in-test (no external tools, no downloads); every live fire confined to a per-test `mkdtemp` sandbox; real user profile never touched; fixes only for real defects, referenced by line, one defect one commit; baseline unit/E2E suites only grow.

---

## 1. Battle results — nine attacks

| # | Attack | Verdict | Evidence | Severity | Fix |
|---|---|---|---|---|---|
| 1 | `rootPath` path traversal (worlds.json → fs) | **HELD** (fix pre-existed) | `world-manager.ts:725-735` — `resolveRoot()` confines any raw path not prefixed by `userData + sep` back to `join(base,'minecraft')`; `:889-896` quarantines an escapee registry entry. All fs entry points route through it (`:131,:159,:315,:342-343,:394,:413,:451,:485,:520`). Tests `redteam-data.test.ts:49,70,82`. | P0 | none needed (already fixed, `5e14d9b`) |
| 2 | `assertSafeFilename` bypass (payload matrix) | **BREACHED (contained) → FIXED** | Old guards only tested `/`, `\`, `..`. Four hostile classes reached the fs: Windows reserved devices (`con.jar`/`nul.jar`/`lpt1.jar`), NTFS ADS (`evil.jar:stream`), control chars (embedded NUL), trailing dot/space + over-long names. No *directory escape* — the classic traversal payloads were already stopped, so severity is correctness/DoS, not breakthrough. | P2 | `6399401` — `src/main/mod-filename.ts`; all 3 former guards now delegate (`mod-manager.ts:46`, `mod-downloader.ts:49`, `update-checker.ts:46`) |
| 3 | Forged crash log → Oracle misattribution | **HELD** (fix pre-existed) | `crash-diagnostic.ts:214` "RED-TEAM honesty gate: confirm the accused mod is actually installed"; `:37` documents the contract. Tests `redteam-data.test.ts:181` (forged accuses uninstalled → no slander + no repair button), `:194` (genuine installed mod is still accused), `:205` (100 MB report bounded), `:219` (binary garbage degrades). | P1 (trust) | none needed (already fixed, `8445fbb`) |
| 6 | `.mrpack` decompression bomb | **BREACHED → FIXED** | adm-zip `zipEntry.js` does `Buffer.alloc(_centralHeader.size)` **before** inflating. A 42 KB `.mrpack` whose central directory declares a 4 GB entry makes the main process allocate 4 GB before one byte is decompressed — no inflate limit can help. Proven by live fire: a real archive with a patched CD size field is refused with `[E705]` and nothing is written. | **P0** | `69079b2` — `src/main/archive-guard.ts`; integrated `modpack-installer.ts:95,98,172,188,390` |
| 7 | Dual-process write race (same userData) | **DEGRADED** | Single-instance lock exists (`index.ts:1818`) but is gated on `app.isPackaged` — unpackaged/dev builds can run two processes. Blast radius is bounded by the atomic registry write: `world-manager.ts:753-757` tmp + `renameSync`, and `save()` at `:744-750` documents that a synchronous body cannot interleave. Outcome of a dev-mode race is last-writer-wins, never a torn `worlds.json`. | P2 | none (bounded by design); caveat recorded |
| 5 | Token refresh storm | **BREACHED → FIXED** | `validate-session` is renderer-callable (`index.ts:1452`, `preload/index.ts:354`). Pre-fix, every expired-token validation ran a full network refresh with no gate: N concurrent calls = N Microsoft token requests plus N `saveTokens()` last-write-win clobbers, and a revoked token meant every call hit the network forever. | P1 | `2c93a2e` — `src/main/refresh-gate.ts`; wired `identity-service.ts:103,169,371` |
| 4 | MOTD injection → XSS chain | **HELD** | Repo-wide grep for `dangerouslySetInnerHTML\|innerHTML\|outerHTML\|insertAdjacentHTML\|document.write` returns **zero** hits across `src/`. `server-pinger.ts:99-113` flattens chat components to `.text` only (style fields ignored), and MOTD has **no render path at all** — `src/main/server-pinger.ts` is the only file in the tree mentioning it. Pinned by `redteam-wave2.test.ts` (zero-sink scan + flatten + no-render). | n/a | none needed |
| 8 | Update source integrity | **HELD** | `updater.ts` never calls `autoUpdater.setFeedURL`; contains no `readFileSync`/`existsSync`/`process.env`. Feed resolution is electron-updater's build-time `app-update.yml` only. `index.ts` has no `setFeedURL` either. Pinned by `redteam-wave2.test.ts`. | n/a | none needed |
| 9 | Main-process stdout credential leak | **HELD** | The one argv path carrying a live token (MCLC `--accessToken`) is redacted at capture: `console-service.ts:104` `this.launchCommand = redactTokens(argv.join(' '))`; game lines (`:131`) and both error paths (`:163,:168`) are redacted before persist/broadcast. A scan of every `console.*` in `src/main/` finds **no** call interpolating a token-bearing expression (only static messages like `'Failed to load tokens:'`). `redactTokens` covers labelled creds, `--accessToken` flags and raw JWTs (`console-log.ts:72-89`). | n/a | none needed |

**Totals: 5 held · 1 degraded · 3 breached-and-fixed (1 × P0, 2 × P1, 1 × P2).**

---

## 2. The three findings that mattered

### 2.1 — P0: a 42 KB file allocates 4 GB (attack 6)

`adm-zip`'s `ZipEntry.getData()` trusts the central directory:

```js
var data = Buffer.alloc(_centralHeader.size);   // node_modules/adm-zip/zipEntry.js
```

`size` is attacker-controlled metadata. An `.mrpack` — a file users are *told* to drag in from third parties — can declare a 4 GB entry inside a 42 KB archive. The allocation happens before any inflate, so an inflate-size limit is the wrong instrument; the only safe stop is **before `getData()`**.

New `archive-guard.ts` reads declared sizes and refuses the archive outright, with no `getData()` ever reached:
- archive on disk ≤ 512 MB
- entry count ≤ 20 000
- single inflated entry ≤ 512 MB
- all inflated entries ≤ 2 GB

Integrated on every admit path in `modpack-installer.ts` — the index reader (`:95/:98`, which covers `installModpackFiles`), the overrides extractor (`:172/:188`), and the on-disk pre-check (`:152/:378/:390`).

The live fire is genuine, not a mock: the test builds a real `.mrpack` with `adm-zip`, locates the 46-byte central-directory record for `overrides/bomb.jar`, patches its uncompressed-size field at `+24` to `0xF0000000`, and asserts the install is refused with `[E705]` **and** that no extraction directory was created. A real Modrinth pack sits far inside all four budgets (a 400 × 4 MB pack is accepted by test).

### 2.2 — The "safe filename" check was a path-traversal check (attack 2)

Three modules carried three copies of:

```ts
if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..'))
```

That stops `../` — and nothing else. It let four hostile classes through to the filesystem:

1. **Windows reserved device names** — `con.jar`, `nul.jar`, `aux.jar`, `prn.jar`, `com1.jar`, `lpt1.jar` do not name a file in `mods/`; they resolve to the *device*. A write can hang on the console device or silently discard the payload.
2. **NTFS alternate data streams** — `evil.jar:hidden` opens a stream on `evil.jar`; a `.jar`-only lister never sees the bytes.
3. **Control characters** — an embedded NUL terminates the path at the syscall boundary, desynchronising the checked name from the written one.
4. **Trailing dot/space** (Windows silently strips them) and names past `MAX_PATH`.

One guard, one policy: `src/main/mod-filename.ts` normalises then re-checks, blacklists the reserved bases (case-insensitively, extension-stripped), rejects `:`, control chars, trailing dot/space, over-length names and non-string input, and takes a `requireJar` flag for the download/update callers. All three former call sites delegate to it, so the three policies can never drift again.

Pinned by a 22-payload rejection matrix, a non-string input set, a legitimate-name acceptance set (`console.jar` and `com10.jar` are correctly *allowed*), and — the assertion that actually generalises — a **containment invariant**: for every accepted name (including Unicode look-alikes `／` and U+202E), `resolve(join(modsDir, name))` must stay inside `mods/`.

### 2.3 — P1: the refresh storm (attack 5)

`validate-session` is renderer-callable. Before the fix it had no gate whatsoever:

```
validateSession → session expired → refreshMicrosoftSession → network + saveTokens()
```

Consequences: a UI re-render loop became a live stream of requests to Microsoft's token endpoint (rate-limit burn → possible account lockout), and N concurrent validations each ran a full refresh and each wrote the token store, last-write-win clobbering each other.

`refresh-gate.ts` is a pure, clock-injected gate:
- **single-flight** — concurrent `run(key, fn)` coalesce onto the first attempt's promise (20 concurrent validations → exactly **one** network call, asserted);
- **failure backoff** — after a failed refresh, further attempts short-circuit for 30 s and replay the prior error, so a revoked token is not retried forever;
- **per-account keys** — one bad account cannot starve another;
- **reset on sign-out** — `signOut` clears the account's backoff so a later re-sign-in starts clean.

---

## 3. Attack-4/7/8/9 defence pinning

Electron lifecycle, build-time feed resolution and repo-wide sink absence cannot be exercised by a unit test, so they are pinned as *source-invariant* assertions in `tests/redteam-wave2.test.ts` plus the following positive E2E coverage:

| Surface | Pinned by |
|---|---|
| Attack 4 | zero HTML-sink scan over all of `src/`; `extractMotd` `.text`-only flatten; MOTD render-path absent |
| Attack 7 | `requestSingleInstanceLock` + `app.quit()` + `second-instance` present; atomic tmp+rename registry write present |
| Attack 8 | no `setFeedURL`, no fs/env read in `updater.ts`, no `setFeedURL` in `index.ts` |
| Attack 9 | `launchCommand` redaction, game-line/error redaction, `redactTokens` behaviour, no token-interpolating `console.*` |

`redactTokens` is asserted directly: `--accessToken SEA_…`, `access_token: …`, `"accessToken":"…"`, `authorization: Bearer …`, and a raw three-segment JWT all lose their secret; idempotency and ordinary prose are preserved.

---

## 4. Regression tests added

| File | Tests | Covers |
|---|---|---|
| `tests/redteam-wave2.test.ts` | **53** | attack 6 (9, incl. 2 live fires), attack 2 (25 + 2 wiring), attack 5 (6 + 1 wiring), attack 4 (3), attack 7 (2), attack 8 (2), attack 9 (4) |

**Unit suite: 302 → 355, all passing. Typecheck clean. Committed E2E: 8/8 pass on the changed surfaces** (`oracle-recovery` × 4, `identity-library` × 1, `smoke-core` × 4 — 32 s).

### Known, pre-existing flakiness (NOT a regression) — **RESOLVED**

`tests/e2e/redteam-assault.spec.ts` (new, untracked, from the prior wave) has 4 failures in this environment: A1, A2, A4, C1. A1/A2 were re-run against a `git stash`-reverted worktree with **unmodified HEAD sources** and failed **identically** (`waitForText('Ready.')` false; 120 s timeout). They are renderer-readiness/timing failures under load, independent of this wave's main-process changes, and were left **unmodified** so the wave keeps a clean, honest diff. **(Superseded: all four were later diagnosed and fixed at the test layer — see §7.)** A4's failure is also not attributable to the filename fix — the canned response filename is `journey-mod.jar`, which the new guard accepts.

---

## 5. Reproducing the gates

```bash
npm run typecheck
npm test                              # 355 unit tests
npm run build && npx playwright test tests/e2e/oracle-recovery.spec.ts \
  tests/e2e/identity-library.spec.ts tests/e2e/smoke-core.spec.ts
```

Re-run only the wave-2 attacks:

```bash
npx vitest run tests/redteam-wave2.test.ts --reporter=verbose
```

---

## 6. Files touched

| File | Change |
|---|---|
| `src/main/archive-guard.ts` | **new** — declared-size / entry-count / on-disk budget guard |
| `src/main/mod-filename.ts` | **new** — single hardened filename policy for all mod paths |
| `src/main/refresh-gate.ts` | **new** — single-flight + failure-backoff refresh gate |
| `src/main/modpack-installer.ts` | integrate archive budget on all three admit paths |
| `src/main/mod-manager.ts` | delegate to shared filename guard |
| `src/main/mod-downloader.ts` | delegate to shared filename guard (`.jar` required) |
| `src/main/update-checker.ts` | delegate to shared filename guard (`.jar` required) |
| `src/main/identity-service.ts` | route `refreshMicrosoftSession` through the gate; reset on sign-out |
| `tests/redteam-wave2.test.ts` | **new** — 53 regression + live-fire tests |
| `tests/e2e/redteam-assault.spec.ts` | **new** — 6 live whole-app assaults (A1/A2/A5b/A4/C3/C1); verdicts below |

---

## 7. Wave 1 & 3 — live assault suite (`redteam-assault.spec.ts`)

The A/C series is the live, whole-app counterpart to the nine unit-level attacks. Six
assaults: A1 Play-spam, A2 navigation storm, A5b bridge-level custody refusal, A4
graceful close mid-download, C3 SIGKILL inside the splash window, C1 early-IPC strike.
Every boot runs on a throwaway `--user-data-dir`; the real profile is never touched.

**Verdict: 6/6 PASS, deterministic** — two consecutive full-file runs, 1.0 min each.

| # | Assault | Verdict | Live evidence |
|---|---|---|---|
| A1 | Play ×10 @1Hz | **HELD** | one pipeline pinned in-flight; `[REDTEAM][A1] verdicts: E604=10 other=0` — every shot refused by the guard, never a second pipeline, never a crash |
| A2 | nav storm @100ms ×30s | **HELD** | `switches=251–252 consoleErrors=0 unhandledRejections=0` — 250+ view switches incl. Ctrl+L/Ctrl+K, zero console errors, zero unhandled rejections |
| A5b | renderer-crafted `settingsPath` | **HELD** | `success=false error="Invalid settings folder. Pick it again with the folder chooser."` — refused at the IPC boundary, nothing copied |
| A4 | `window.close` mid-download | **HELD** | graceful exit mid-stream leaves only a `.tmp` (no full jar); next boot is honest and the retry writes exactly one jar of the expected size — no fake mod |
| C3 | SIGKILL during splash | **HELD** | next boot on the same profile reaches `Ready.`, account registry intact |
| C1 | IPC barrage 500 ms after boot | **HELD** | `5/5 answered` — every early call resolves; empty-name `createWorld` creates nothing; registry stays loadable |

### The four prior failures were TEST defects, not defence failures

The suite was written a wave earlier and left failing (see §4). All four causes are at
the **test layer** — no production behaviour was weakened to make them pass:

1. **A1 & C1 hung on a REAL launch.** `launchGame()` was called with no `javaPath`;
   `"undefined"` passes `SAFE_PATH_REGEX`, so `validatePath` let it through and a real
   JRE + Fabric + version download ran, blowing the 120 s timeout. Fix: A1 *occupies*
   the pipeline with **zero egress** — a new `hang` fetch rule
   (`tests/e2e/journey/lib.ts`) pins `ensureFabric`'s `timedFetch` open forever, and the
   arm signal is the first `launch-step` event, which is emitted strictly *after*
   `launchInProgress = true` (so proving the guard cannot itself become the hung call).
   C1 instead uses a `reject` rule so the pipeline settles on its typed error and every
   early call **answers**.
2. **A2 asserted on the wrong screen.** The storm is position-dependent (it ends on
   whatever phase the 6-step sequence lands on, and Ctrl+L toggles Console↔Play), and
   `clickNav` matched the **world card's** Play button rather than the dock nav. The
   storm itself was always clean. Fix: dock-scope `clickNav` to `nav button`, and return
   to Play before the liveness check.
3. **A4's retry was canned with no body.** `MODRINTH_CANNED.jar` carries no `body`, so
   the retry saw an empty response and the downloader correctly rejected it
   (`empty response body`, `mod-downloader.ts` requires a reader). Fix: a new `bytes`
   rule serves a fast, exact-size payload.

### Reproduce

```bash
npm run build
npx playwright test tests/e2e/redteam-assault.spec.ts
```

Green gates after the fix: `typecheck` clean, `npm test` 374/374, `build` clean,
assault suite 6/6 (×2), and 11/11 across `smoke-core` / `first-boot-note` /
`identity-library` / `oracle-recovery`.
