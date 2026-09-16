# 10 — VISUAL / LIGHTING ARCHITECTURE

What actually controls the Play character's color, luminance, shadow, and composition — current source. **No visual values were changed by this audit.**

## Layer stack (Play stage, back → front)

1. **CSS atmosphere** — `index.css` page/panel backgrounds, gradients (aurora panel classes), surrounding Play rail/eyebrow text. Sits *behind* the opaque canvas — it frames the stage but cannot recolor the character (`CONFIRMED`: canvas is opaque `alpha:false`, background 0x000000, SkinViewerCanvas L130–132).
2. **WebGL canvas** (skinview3d) — the only surface the character renders on.
3. **Three scene**: stage floor mesh + SpotLight key (+target) + ambient (`viewer.globalLight`) + camera light (`viewer.cameraLight`) + DirectionalLight rim + player wrapper.
4. **FX overlays** (WorldBeacon decorative light, BlurText) — additive DOM, no color authority over the character.

## Color authority map (`CONFIRMED` — PlayerDirector.ts L210–358 + SkinViewerCanvas L95–135)

| Perceptual property | Primary controller | Config surface |
|---|---|---|
| Character hue | **Ambient** `SKIN_CONFIG.globalColor '#d9cbb8'` @ 2.0 (dominant illuminant) + camera light 0.8 | `SKIN_CONFIG` |
| Luminance | Ambient intensity (2.0) + camera (0.8); ignite +15% (2.3/0.92) | `SKIN_CONFIG`, `IGNITE_CONFIG.globalLight/cameraLight` |
| Directional depth | Key SpotLight `'#e6a55c'` @ 450 (≈0.18 effective at skin, decay=2 physical mode) — **subordinate by construction** | `STAGE_LIGHT_CONFIG` |
| Contact shadow | Real `castShadow` from key onto MeshStandardMaterial floor (`'#382718'`, roughness 1.0, receiveShadow) | `STAGE_LIGHT_CONFIG` floor group |
| Silhouette separation | Rim DirectionalLight `'#e8ddd0'` @ 0.6 from behind-left | `SKIN_CONFIG.rim*` |
| Background | Opaque black clear color + CSS room framing | SkinViewerCanvas + index.css |
| Composition/framing | `stageZoom 0.80` + `stageLift 4.5` (feet + floor strip visible; stock 0.92 cropped feet) + `stageFloorY −20` | `STAGE_LIGHT_CONFIG` |
| Skin material color | The skin texture itself (Mojang PNG) via skinview3d materials — lighting multiplies, never replaces | upstream |

**Perceived-hue rule embodied in code:** the palette of record is ambient-carried (warm-neutral `#d9cbb8`), with the brand-amber key as an accent that mathematically cannot dominate (450/2536 ≈ 0.18 vs ambient 2.0 — comment L246–249). Ignition blends colors *toward* `#e6a55c` at partial mixes (0.35/0.2) and never amplifies the key (`keyLight: 1.0` with an explicit comment that Stage 10's key ramp was what caused the yellow shift, L352–358).

## The yellow/gold regression — contributor analysis (Phase 8 question)

Observed regression (owner-reported): the Stage 10 result read yellow/gold instead of amber. Contributor determination (evidence: visual lab `mu-visual-history/000-baseline` + `001-amber-restored`, code comments L219–230):

| System | Contribution to the yellow shift | Status |
|---|---|---|
| Dominant warm-yellow key (`'#ffca8a'` @ 2900 ≈ **1.06 effective**) replacing ambient as primary illuminant | **Primary cause** — carried the yellow cast on highlights | `CONFIRMED` (lab + code) |
| Crushed ambient (0.55 / `'#3a3230'`) | **Enabler** — removed the warm-neutral carrier, ceding color authority to the key | `CONFIRMED` |
| Fill light 0.5 | Compensator for the crushed ambient (no independent identity role); **removed** with the regime rollback | `CONFIRMED` |
| CSS atmosphere, floor color, shadow setup, framing | Non-contributors — region samples byte-identical across versions in the lab | `CONFIRMED` (lab measurements) |
| Rim | Neutral-warm; shapes silhouette, minor hue influence | `CONFIRMED` |

The worktree already contains the corrective state (`001-amber-restored` applied to `PlayerDirector.ts`/`SkinViewerCanvas.tsx` before this audit); this audit **documents** it, made no further change, and notes the final arbiter is the owner's eye against the lab screenshots (invariant #4).

## Which layers are actually visible

- Canvas: opaque — CSS behind it is invisible *inside* the canvas rect; visible only around it (stage framing, rails).
- WebGL-visible: floor only where the key cone + restored ambient light it (matte dark albedo ≈ black unlit — no giant-platform effect by design comment L280–284); character; nothing else.

## Fragility notes (documented)

- The three-dedupe alias is load-bearing for *any* material to compile (01-ARCHITECTURE); visual changes that add materials ride on it.
- `installStageRig` returns only `{key, remove}`; the director's `lights.fill` branch is dead-but-present compatibility code (post-001 there is no fill light) — harmless, documented.
