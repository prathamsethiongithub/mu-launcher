# 14 — LIFECYCLE / CONCURRENCY

Async lifecycle audit: who starts, who owns, who cancels, what can race. All findings from current source; `CONFIRMED` unless noted.

## Login / logout / account operations

| Flow | Starts | Owns | Cancels | Double-start? | Late arrivals | After unmount/restart |
|---|---|---|---|---|---|---|
| Microsoft login (Account tab) | `add-microsoft-account` → msmc GUI | main awaits | user closes msmc window → error result | Renderer disables during flow (local state); main does **not** guard concurrent logins — second msmc window possible (`CONFIRMED` no guard) | `notifyAuthChanged` after completion | Registry persisted before notify |
| Legacy login (Play gate) | `auth-login` → msmc | main | same as above | same | same | session file persisted |
| Logout / sign-out | user action | main | n/a (fast) | idempotent-ish (logout twice safe) | – | file deleted |
| **Remove account** | user + two-step confirm | main; **clear-and-verify ordering** | abort path returns error, state intact | single click handler | notify after registry removal | guard guarantees legacy file gone *or* account kept (06-AUTH) |
| Switch account | `set-active-account` | main | n/a | last-write-wins | notifyAuthChanged once | persisted `activeAccountId` |

## Skin loading

- `PlayerIdentity` fetches `get-skin` on mount/identity change; late IPC results after identity switch can race (`CONFIRMED` — no request token/abort in the component). Severity: low (skin mismatch flash possible when switching accounts quickly; self-corrects on next render trigger).
- Studio upload: `select-skin-file` → staged main-side path → `upload-skin`. A second `select-skin-file` overwrites the staged path (single variable — 05-CONTRACTS #3). No upload concurrency guard; double-click could double-POST (non-destructive upstream).

## Java provisioning

- Owner: JavaProvisioner instance per `get-java-path` call. **No concurrency guard** — two simultaneous calls could double-provision (`CONFIRMED`: no in-flight flag). Mitigating fact: renderer calls it once per launch flow, and launch guards serialize launches; but `get-java-path` is also callable directly via bridge.
- Cancel: none (bounded by network guards, not cancellable). After completion pointer written; partial states self-heal (12-PERSISTENCE).

## Minecraft launch

- Triple-guarded: renderer `launchingRef` → main `launchInProgress` → `isRunning()` (E604/E605). Guard cleared in `finally` — all paths (success/fail/cancel) covered (`CONFIRMED` trace in REPORT-003 + source).
- Cancel: `cancel-launch` exists; **no renderer caller** (`CONFIRMED`).
- Launcher restart mid-launch: in-flight promise dies with process; next start has no memory of it; orphaned Minecraft invisible to E605 (REPORT-003 limitation, still current).

## Progress listeners

- One app-scope `launch-step` listener (REPORT-001 fix); `removeAllListeners` teardown only at app scope. Adding a second subscriber today would be silently dropped by the removeAll pattern (`CONFIRMED` asymmetry note in 03).
- `java-progress` same pattern.
- Late events after view navigation: impossible to lose — listener lives in App which never unmounts.

## Renderer unmount / viewer lifecycle

- SkinViewerCanvas: RAF canceled + rig disposed + viewer disposed in cleanup; mount-order defect fixed by the always-mounted canvas tree (09-SKIN). Viewer creation strictly once per component lifetime.
- Navigation away from Play unmounts PlayView → viewer destroyed; returning recreates it (skin re-fetched from cache — no leak path found).
- Reduced-motion: director lights absent; static shot (09-SKIN) — no dual-owner lighting conflict.

## App restart

- All in-memory mirrors reset; persistence restores identity/worlds; `is-game-running` reconciles the running bit on mount; progress story starts idle.
- `window-all-closed` → `app.quit()` — no background main process (`CONFIRMED`).

## Race register (summary)

| # | Race / stale-callback risk | Where | Class |
|---|---|---|---|
| 1 | Concurrent msmc logins (no main-side guard) | add-microsoft-account / auth-login | LOW (UX annoyance) |
| 2 | Concurrent Java provisioning (no in-flight guard) | java-provisioner | MEDIUM (disk/network waste; last-pointer wins) |
| 3 | Skin fetch race on fast account switching | PlayerIdentity | LOW (flash) |
| 4 | Orphaned Minecraft invisible to E605 after launcher restart | launch guard | MEDIUM (double instance) |
| 5 | Staged skin path overwrite between select and upload | index.ts L705–763 | LOW |
| 6 | Worlds no change events (multi-writer desync) | world IPC | LOW (single window today) |
| 7 | validate-session refreshes tokens during read probes | identity-service | LOW (semantic surprise, not corruption) |
