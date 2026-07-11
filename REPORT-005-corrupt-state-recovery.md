# REPORT-005 — Corrupt State Recovery (caches, session, servers.dat) + Fresh-Machine & Close-During-Launch Audit

**Date:** 2026-07-10 · **Author:** Release QA · **Priority:** two P1 fixes + audit · **Status:** FIXED + RUNTIME-PROVEN (fixes); AUDITED-WITH-EVIDENCE (rest)

## Part A — BUG: Corrupt Fabric profile cache was permanent breakage (P1) — FIXED
- **Reproduction:** kill the launcher during the profile write (or corrupt `versions/fabric-loader-0.19.3-26.1.2/*.json`), relaunch, press Play.
- **Root cause:** `ensureFabric()` returned any existing cache file **unvalidated** (`if (existsSync) return`), and the profile was written **non-atomically** (`fs.writeFile` direct) — so a mid-write kill created exactly the corrupt file that would then be trusted forever. Every future launch failed E303 until a human deleted the file.
- **Evidence:** pre-fix `fabric-installer.ts:65-68` (blind trust), `:120` (non-atomic write).
- **Fix:** (1) validate cache on read — `JSON.parse` + required `id`; corrupt → warn, delete, fall through to re-fetch; (2) atomic write via `.tmp` + `rename`.
- **Verification (runtime, harness `fabric.test.cjs`):** T8 valid cache honored in **7ms** (no network, no false positive). T9 corrupt cache (`{{{{ not json`) → detected, **deleted**, re-fetched, fresh valid profile written → **ALL PASS**.
- **Regression risk:** low — valid caches behave identically (T8); only the previously-fatal corrupt path changes.

## Part B — BUG: Corrupt servers.dat blocked every launch (P1) — FIXED
- **Reproduction:** write garbage into `minecraft/servers.dat` (Minecraft crash, disk issue), press Play.
- **Root cause:** `injectServer()` parse failure threw `[E501]`, which failed the whole launch (`launchWithFabric` catch → E303) — permanently, since the file was never repaired.
- **Evidence:** pre-fix `server-injector.ts:44-49` + `:111-115`; launch-service calls injection inside its fatal try.
- **Fix:** parse wrapped separately; on corruption the file is **renamed to `servers.dat.corrupt-<timestamp>`** (user's list preserved for manual recovery) and a fresh file is built via the existing create-from-scratch branch. Launch proceeds.
- **Verification (runtime, harness `inject.test.cjs`):** T4 fresh create ✓ · T5 idempotent (exactly one MU entry) ✓ · T6 **user entries preserved** on merge ✓ · T7 corrupt file → no throw, `.corrupt-*` backup exists, fresh valid file contains MU SMP → **ALL PASS**.
- **Regression risk:** low — healthy-file paths byte-identical (re-keyed on `parsed` instead of `existsSync`); atomic write already existed.

## Part C — Corrupt cache/session recovery matrix (audited, with evidence)
| State | Corruption outcome | Mechanism (evidence) | Verdict |
|---|---|---|---|
| `auth-session.bin` | signed-out, sign in again | `restoreSession` catch → delete file (`auth-service.ts:258-264`) | ✅ recovers |
| `current-java-path.txt` stale/corrupt | re-provision | existsSync + version-aware smoke test (`java-provisioner.ts:166-180`, REPORT-002) | ✅ recovers |
| Partial JRE (killed mid-install) | full re-download heals | cache pointer written only **after** smoke test (`:329`); install loop re-downloads unconditionally (`:261-288`) | ✅ self-heals (no resume = P2 slow) |
| Corrupt mod/resource-pack file | re-downloaded | per-file hash check on existing files → unlink + re-fetch (`mod-installer.ts:51-58`); atomic tmp+rename; per-item non-fatal | ✅ recovers |
| Fabric profile | **was permanent breakage** | Part A fix | ✅ now recovers (proven) |
| `servers.dat` | **was permanent breakage** | Part B fix | ✅ now recovers (proven) |

## Part D — Missing Java recovery (audited)
Cached path deleted → `existsSync` fails → re-provision (✅). Deleted between provision and spawn → MCLC spawn error → E303 + Retry → next Play re-provisions (✅ bounded). Renderer `getJavaPath()` throw falls back to `'java'`; with no system Java → E303, retryable (acceptable; documented).

## Part E — Close launcher during launch (audited)
`window-all-closed` → `app.quit()` kills in-flight work. Per artifact: JRE partials → self-heal (Part C); Fabric profile → **now atomic + validated** (Part A) — the last permanent-breakage path from this scenario is closed; `servers.dat` → already atomic; mods → atomic tmp+rename (orphaned `.tmp` = harmless junk, P3); session file → worst case corrupt → auto-deleted on restore (Part C). **Verdict: close-during-launch can cost time (re-downloads), never a broken install.**

## Part F — Fresh-machine audit (static walk, first run)
userData (Electron ✓) → runtime dir `mkdirSync` (`java-provisioner.ts:183`) → jreDir (`:251`) + per-file dirs (`:264`) → minecraft root **before any injection/fabric IO** (`launch-service.ts:138-139`) → fabric profile dir (`fabric-installer.ts` mkdir recursive) → mods/resourcepacks dirs (`mod-installer.ts:42-43,74-75`) → session file dir (`auth-service.ts:212`). **No missing-directory path found.** (Runtime fresh-machine E2E still required on real hardware — RELEASE_READINESS.)

## Part G — Offline / error handling (audited post-FIX B)
Every phase now bounded: preflight internet probe 5s abort (`preflight-check.ts:28-32`) · manifests/JSON ≤30s → E2xx → error card + Retry · downloads connect ≤20s / stall ≤60s → cleaned partials → Retry · MCLC ≤120s E302 · launch guard E604/E605. **Note:** `runPreflightCheck` is built + IPC-exposed but **never invoked by the renderer** (grep: no usages) — redundant now that all phases are bounded; recorded P3, no code change (rule: no unnecessary changes).

## Next Actions
Single real-machine pass covering: Wi-Fi toggle mid-Java + mid-mods; kill launcher mid-download → relaunch; corrupt servers.dat/fabric cache by hand → Play recovers.
