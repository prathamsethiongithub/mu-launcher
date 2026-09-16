# 08 — IGNITION / PROGRESS

How real backend events become the user-facing progress story (ForgeLine / hero text).

## Event flow

```
MCLC download/extract events ─┐
JavaProvisioner progress ─────┼→ LaunchManager.step emitter ─→ webContents.send('launch-step',
static step list (steps 1–8) ─┘                                  {step, status, progress})
                                                      ↓ (single app-scope listener, App.tsx)
                                        App.launchSteps mirror (never unmounts — REPORT-001)
                                                      ↓
                                    ForgeLine (rendered line) + hero copy
```

Java sub-events arrive on `java-progress` and are folded into the launch narrative (App.tsx L127 note: identity rewrites of high-frequency MCLC events are skipped to avoid state churn).

## Stage definitions (LaunchManager)

Steps are a fixed sequence (Preparing Java → Preparing Fabric → Installing mods → Injecting MU SMP → Launching Minecraft → Running), each emitting `{step, status, progress}`. Status vocabulary consumed by ForgeLine: pending / active / done / error (`CONFIRMED` in renderer rendering code).

## Progress calculation

- **Java**: percent from file counts/bytes in java-provisioner (`java-progress` phase/percent/message).
- **MCLC**: launcher-core's own progress callbacks mapped into the current step's percent; not a launcher-computed global percentage.
- **Aggregation**: none — there is no single global "total percent" computed across steps; the UI shows step-level progress. `CONFIRMED` (no aggregation math in launch-service).

## BACKEND TRUTH ≠ USER-FACING STATUS (documented gaps — do not fix from this doc)

| Gap | Evidence | Severity class |
|---|---|---|
| No global percent; user infers overall progress from step labels | launch-service | cosmetic |
| `launching` mirror is optimistic until E604/E605 reply | App.tsx / index.ts guards | low |
| Launcher restart mid-launch: progress mirror lost; only `isRunning` reconciled | App.tsx L105 | medium |
| `cancel-launch` implemented but not surfaced in the renderer | grep: no caller | UX gap |
| Terminal "Running" is real (process-based); there is no "game exited" celebration/return-to-idle flow beyond error card | launch-service | UX gap |

## Completion / errors

Completion = MCLC resolution → step "Running" → `launchInProgress` cleared. Errors follow the typed-error card + Retry (see 07). Per-item mod failures are non-fatal by design; the launch continues (documented in mod-installer).
