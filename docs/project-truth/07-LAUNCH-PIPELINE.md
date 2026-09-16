# 07 — LAUNCH PIPELINE

From **user clicks Play** to **Minecraft running** (or a typed failure), as the current source implements it.

## Stage map (`src/main/launch-service.ts` LaunchManager + index.ts `launch-game`)

| # | Stage (owner) | Input → Output | State changes | Progress source | Failure path | Cancel |
|---|---|---|---|---|---|---|
| 0 | Renderer gate (App.tsx) | `isGameRunning` pull on mount; `launchingRef` guard | sets `launching` | none (optimistic pre-E604/E605) | re-entry blocked silently | n/a |
| 1 | Main guard (index.ts L362+) | `javaPath` | `launchInProgress = true` (cleared in `finally`) | none | `[E604]` in-progress / `[E605]` already running | n/a |
| 2 | Identity resolution (L381) | – | none | none | `resolveLaunchAuthorization` throw → `[E609]` or null → "sign in" | n/a |
| 3 | Root resolution (L~386 + launch-service L125/L218) | active world | none | none | managed default `{userData}/minecraft`; personal world root | n/a |
| 4 | Step "Preparing Java" (java-provisioner) | MC version | cache pointer write after smoke test | `java-progress` events | `[E210–E218]` bounded (timedFetch 30s / connect 20s / stall 60s) | not individually cancellable |
| 5 | Step "Preparing Fabric" (fabric-installer) | MC version | cached profile validated + atomic write | launch-step events | corrupt cache → self-heal (re-fetch) | n/a |
| 6 | Step "Installing mods" (mod-installer) | mod-data manifest | per-world `mods/` + `resourcepacks/`; tmp+rename | launch-step + per-item | per-item non-fatal; network errors bounded | n/a |
| 7 | Step "Injecting MU SMP" (server-injector) | – | servers.dat (idempotent; corrupt → `.corrupt-<ts>` + fresh) | launch-step | `[E501]` | n/a |
| 8 | Step "Launching Minecraft" (MCLC) | auth triple + root | downloads assets/libraries into root; spawns JVM | MCLC progress events → launch-step | 120s timeout `[E302]`; spawn errors `[E303]` | `cancel-launch` → cancel() |
| 9 | Terminal state | – | `isRunning()` true while JVM alive; `launchInProgress` false after orchestration | process exit events | UI "Running" / error card + Retry | – |

Sequencing source: `launchWithFabric` in launch-service.ts (steps 4–8 in that order; mcRoot created **before** any injection/fabric IO, L138–139 — REPORT-005 Part F fresh-machine walk).

## Where UI state is real vs inferred

| UI element | Backed by | Level |
|---|---|---|
| "Running" | `isRunning()` via `is-game-running` + process events | **real backend truth** |
| Progress steps/percent | `launch-step` payloads mapped by LaunchManager | real events, **bucketed** (see 08) |
| Play button hidden while `launching` | renderer mirror | optimistic; authoritative guards are E604/E605 in main |
| Java sub-progress | `java-progress` events | real |
| Anything during a launcher restart | nothing (state lost; `isRunning` reconciled on mount, progress not) | inferred/idle |

## Failure semantics (typed errors users can see)

- `[E220/E221/E222]` network timeouts (net.ts) → friendly card + Retry; partial files cleaned (java: unlink dest; mods: unlink tmp) (REPORT-004/005).
- `[E210–E218]` Java provisioning failures.
- `[E302]` MCLC timeout; `[E303]` MCLC/generic launch failure (Retry re-provisions).
- `[E501]` server injection (only after its own corrupt-file recovery failed).
- `[E604/E605]` concurrency guards; `[E609]` identity session revival failure (names the Account screen → Sign in).

## Cancellation

`cancel-launch` → `launchManager.cancel()` (MCLC promise cancel; index.ts L782–791). Renderer currently does not surface a cancel button (`CONFIRMED` — no `cancelLaunch` caller in src/renderer; grep shows preload-only). Launcher close (`window-all-closed` → `app.quit()`) kills in-flight work; per-artifact recovery matrix in REPORT-005 Part C–E (`HISTORICAL` runtime-proven).

## Known truth-gaps (documented, not fixed)

- Launching during a launcher restart while Minecraft is open: E605 can't see the orphaned process (cross-process detection absent) → second instance possible (REPORT-003 limitation; still current).
- `getJavaPath` runs outside MCLC's 120s guard, but is itself fully bounded via net.ts (REPORT-004) — consistent.
- `launch-poc` duplicate path exists with the same resolution; divergence risk documented in 03.
