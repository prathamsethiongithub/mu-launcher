# 15 — VERIFICATION

Inventory of every diagnostic harness, what it claims to prove, and its **evidence level**. Harnesses live in `C:\Users\fortn\mu-verify\` (**outside the repo** — inspected read-only). All app-side claims static-verified against current source; harness behavior `HISTORICAL` (last runs documented in the visual lab / TIMELINE).

## Shared infrastructure

| File | Role |
|---|---|
| `cdp.mjs` | Raw Chrome DevTools Protocol client (connects to Electron's remote debugging port) |
| `common.mjs` | Launch ritual: builds if needed, spawns the **real Electron app** with CDP port + `MU_CAPTURE`-style flags, locks viewport **1280×800**, writes identity-state backups (`identity.json.pre-*` files in the dir listing), teardown |
| `visual-capture.mjs` | Real-app screenshot pipeline: launch → VerifyBot navigates to Play stage → capture `screenshot.png` + live three.js params dump (`params.json`) → archive into `mu-visual-history/<NNN-slug>/` |

**Assumptions:** app focus, timing (waits for stage), DOM structure of the Play stage, offline availability of the harness-only VerifyBot skin. **False-positive risks:** numeric guards calibrated on a past look can pass a wrong-but-similar image; **false-negative risks:** focus stealing/animation timing can flake captures.

## Harness inventory + evidence levels

| Harness | Claims to prove | Observes | Evidence level |
|---|---|---|---|
| `anim-diag.mjs` | RAF loop alive; director drives pose; ignition ramp works | live three.js params (light intensities 2→2.285 on energetic), gaze/body reactions, console errors | **Infrastructure-only** (params are app-truth; user-facing look not judged) |
| `anim-interact.mjs` | Pointer interaction chain (gaze follows, wave triggers) | synthetic pointer events → pose params | Infrastructure-only; timing-sensitive |
| `anim-persist.mjs` | Animation identity survives restart (state restored, no double-viewer) | params across two launches | Infrastructure-only |
| `anim-calib.mjs` + `calib-samples.json` | Amber-chroma numeric guard calibration (hue ≈34°, G/R ≈0.72; drift flag ≥45°/G/R>0.80) | pixel sampling of stage canvas | Calibration artifact — guard is **stale-ish** (calibrated pre-001 framing; p85 gate documented stale in the lab) |
| `anim-probe/shots/tilt/visual.mjs`, `animation-truth.mjs` | Earlier animation forensics (pre-PlayerDirector extraction) | various params/screenshots | `HISTORICAL` — superseded by diag/interact/persist |
| `launch-truth.mjs` + `launch-truth-samples.json` | Launch pipeline events observable via CDP (steps, errors) | IPC/event traffic during a real launch attempt | Infrastructure-only; full-download runs not performed in-session |
| `skin-render-diag1/2/3.mjs`, `skin-fallback-smoke.mjs` | Skin renders; fallback default look works | canvas presence, image bytes | Infrastructure-only (`HISTORICAL` era of REPORT-006) |
| `rig-probe.mjs` | Stage rig params live (key/floor/zoom/lift) | three params dump | Infrastructure-only |
| `flow3/5/6.mjs`, `smoke-launch.mjs`, `launch-ui-smoke.mjs`, `worlds-fix-check.mjs` | Earlier E2E smoke passes | UI navigation + IPC | `HISTORICAL` |
| `visual-capture.mjs` runs (000-baseline, 001-amber-restored) | Real-app visual state per experiment | screenshots + region sampling + numeric guard | **User-facing evidence** (screenshots judged by owner; numerics辅助) |
| In-repo `scripts/debug-toml.js`, `extract-mods.js`, `gen-mod-data.js` | Mod manifest generation | offline | Tooling, not verification |

## What a passing diagnostic does NOT prove

- `anim-diag` passing proves the *animation machinery* runs — not that the character looks right (the yellow-shift regression passed all green diagnostics while violating the visual identity; the lab screenshots were what caught it).
- Numeric guards are calibrated snapshots, not invariants — recalibration is required after any framing/lighting change (documented in the lab INDEX).
- Launch harness evidence does not cover the full download path (bandwidth-dependent), real-machine error copy rendering, or end-user focus behavior.
- No automated test suite exists in the repo (`package.json` has no `test` script — `CONFIRMED`); **all** runtime verification is harness-based and manual.
