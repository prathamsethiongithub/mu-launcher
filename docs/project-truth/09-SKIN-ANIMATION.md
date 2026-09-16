# 09 — SKIN / ANIMATION

The Play hero's runtime lifecycle, reconstructed from current source (not from handoff docs).

## Component chain

```
PlayView
  └ PlayerIdentity.tsx        (bridge: getSkin IPC → props; warns if bridge missing, L31)
      └ SkinViewerCanvas.tsx  (viewer owner)
          └ skinview3d SkinViewer  → three r185 (deduped, electron.vite.config)
              └ PlayerDirector.ts (pose brain + ignition lighting)
```

## Viewer lifecycle (`SkinViewerCanvas.tsx`)

- **One stable tree**: the `<canvas>` is always mounted; empty states are overlays (`emptyLabel` default hidden on the Play stage) — the RC-1 fix from REPORT-006 (a conditional no-canvas tree permanently killed the viewer because the init effect ran once before any skin could arrive). `CONFIRMED` in current source.
- Init effect (mount-once): create viewer → set background 0x000000, `alpha:false` (L130–132 comment) → install stage rig (`installStageRig`, one-time: floor mesh + SpotLight key + target, PlayerDirector L302–341) → apply `SKIN_CONFIG` ambient/camera/rim (L110–112, L132) → set `zoom` 0.80 + wrapper lift (L95–98) → wire director → start RAF.
- Skin load: separate effect keyed on `skinUrl`/`model` → `viewer.loadSkin` (async over IPC; failures logged, fallback default look).
- Cleanup (unmount): cancel RAF, dispose rig (`remove()` disposes floor geometry/material + key, PlayerDirector L338–341), viewer.dispose.
- `renderPaused` / visibility: draw loop reschedules via `animationID`; the resume branch requires `animationID === null` — the r156-crash froze the loop exactly because a stale id blocked re-arm (01-ARCHITECTURE dedupe note). Reduced motion: no director lights; a static balanced shot.

## RAF chain (exact reconstruction)

```
requestAnimationFrame loop (SkinViewerCanvas)
  → viewer.draw()
      → viewer.animation.update()   (skinview3d walk/idle base)
      → PlayerDirector.update(delta)  (gaze/wave/breath/ignite)
          → mutates playerObject rotations (head, arms, body) + light intensities/colors
  → renderer.render(scene, camera)
```

`CONFIRMED` ordering: director mutates pose before render within the same frame; delta-based damping (`1 - Math.exp(-λ·delta)`) used for all light lerps so speed is FPS-independent (PlayerDirector L780–817).

## PlayerDirector behaviors

| Behavior | Mechanism (current source) |
|---|---|
| Gaze | Pointer → head-local yaw/pitch demand (camera-frame target minus body yaw, neck-clamped); head is the ONLY gaze consumer; pitch negated so cursor-up = look-up (L758–772 comments + code) |
| Idle breathing | `breathPhase` accumulation driving torso/arm micro-motion |
| Wave/greeting | One-shot greeting timeline (`settleEnd 1.45` etc., WAVE_CONFIG L146) + `greetSweep/greetNod` head contributions |
| Energetic (ignition) | Boolean ramp: light targets lerp to `IGNITE_CONFIG` (ambient 2.0→2.3, camera 0.8→0.92, rim 0.6→1.1; **key held constant — `keyLight: 1.0`** explicitly so ignition can never re-amplify the rejected yellow regime, L350–358) and colors lerp toward `#e6a55c` mixes |
| Goodbye | Deliberate exit pose (distinct from greeting; same one-shot machinery) |
| Body policy | Body stays planted; only head tracks — "cheap cursor-driven swaying" is explicitly avoided by design comments (L758–762) |

## Skin loading / account switching

`get-skin` resolves identity-first (offline → default look, never borrows a skin). Switching accounts changes `skinUrl` → the load effect re-runs against the same viewer; the viewer is not recreated (`CONFIRMED`).

## Harness vs app distinction (invariant)

The animation lifecycle lives in `PlayerDirector`/`SkinViewerCanvas`; harnesses (`~/mu-verify/anim-*`) drive it through CDP — they never patch app code. See 15-VERIFICATION for what those runs actually prove.
