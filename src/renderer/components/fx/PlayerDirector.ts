import {
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  SpotLight,
} from 'three';
import { IdleAnimation, PlayerObject } from 'skinview3d';

/**
 * PlayerDirector — the home character's animation brain.
 *
 * One long-lived PlayerAnimation instance owns ALL pose state, so nothing
 * ever fights over the bones and no `viewer.animation` swap (which snaps
 * via resetJoints) ever happens. Everything eases; nothing snaps.
 *
 * Behavioral layers (2026-09-11 interaction rework) — composed additively
 * every frame, never last-write-wins:
 *
 *   BASE      calm idle: slow breath bob, quiet ±1.7° body sway, micro head
 *             drift, occasional glances. The body mostly STANDS. Alive-ness
 *             comes from interaction, not motion amplitude.
 *   GAZE      head-first cursor tracking. Pointer (window client coords) →
 *             canvas-rect NDC → CAMERA-frame yaw/pitch target (±25° world
 *             sweep, symmetric) → head-LOCAL demand (target − bodyYaw)
 *             clamped to the neck's ±35° limit. While the pointer is live
 *             the body also eases ~7° toward facing the user (a slow,
 *             direction-independent posture shift — never cursor
 *             tracking), which keeps the whole world sweep inside the neck
 *             budget so BOTH screen edges read clearly. Exponentially
 *             damped with a dt-based lambda → identical feel at any frame
 *             rate. Gaze keeps running under every other layer.
 *   GREETING  one-shot on first reveal (onShown()): authored timeline —
 *             anticipation → right arm raises THROUGH THE FRONT to a
 *             friendly height → two compact lateral greeting swings →
 *             settle home. Total ~1.6s, then the character is simply
 *             standing again.
 *   GOODBYE   `energetic` (the real launch signal from PlayView) plays a
 *             PHASED farewell: notice (posture perk + light ramp) → the
 *             right arm raises through the FRONT, hand raised high and
 *             clearly forward of the torso → readable lateral waves
 *             whose tempo ramps up over the first seconds, then holds a
 *             steady slightly-faster human tempo FOR AS LONG AS THE LAUNCH
 *             STATE LASTS (Igniting/Forging/Launching can run tens of
 *             seconds — the launch is the duration driver, never a 2.6s
 *             one-shot). When `energetic` drops the arm eases home. No
 *             jabbing and no cocked-back windup: the raise travels through
 *             the front (rotation.x) and the only oscillation is lateral
 *             (rotation.z) around the raised pose.
 *
 * Priority emerges from composition: events add on top of the base, gaze
 * keeps running underneath events (the character stays aware of you while
 * waving), and glances yield to both. No state machine library — the only
 * state is a handful of scalars, all re-derived each frame, so rapid
 * prop flips and re-triggers cannot corrupt anything.
 */

export const IDLE_CONFIG = {
  tempo: 0.6,          // inner IdleAnimation speed (stock arm micro-swing pace)
  yawBase: -0.30,      // product-shot three-quarter angle (~-17°). Static offset.
  swayIdle: 0.03,      // quiet ±1.7° body sway — breathing support, NEVER the "alive" mechanism
  breathFreq: 0.36,    // ~9s breathing cycle with tempo multiplier
  breathLift: 0.035,   // body bob amplitude (units) — chest breathing, not bouncing
                       // (calibrated: felt subconsciously, never a visible bob)
  driftYaw: 0.018,     // idle micro head drift
  driftPitch: 0.012,
  weightRoll: 0.008,   // body.rotation.z weight shift
  armSettle: 0.012,    // arms hang a touch closer than stock (static pose life)
  postureLift: 0.32,   // energetic body.position.y straighten (units)
  posturePitch: -0.035, // energetic chest-up
} as const;

/**
 * Head-first gaze. Two clamps keep it believable on this rig:
 *
 *   maxYaw      the WORLD (camera-frame) sweep the face makes — ±23°,
 *               symmetric left/right, so both screen edges read clearly.
 *   maxLocalYaw the NECK limit — head.rotation.y relative to the torso.
 *               The three-quarter body pose means a symmetric world sweep
 *               maps to an asymmetric local one; without this clamp the
 *               right edge used to demand a 0.85 rad (49°) neck swivel
 *               while the left edge demanded ~nothing (the old bug: head
 *               dead on the left, grotesquely twisted on the right).
 *
 * bodySquare is the small, slow, DIRECTION-INDEPENDENT posture shift that
 * makes the symmetric world sweep reachable without the neck twist: while
 * the pointer is inside the window, the body eases ~7° toward facing the
 * user ("hey, I see you") and drifts back to the full product pose when
 * it leaves. It never tracks the cursor's direction — the gaze demand is
 * computed against the live bodyYaw, so the face target is unaffected.
 */
export const GAZE_CONFIG = {
  maxYaw: 0.40,        // ~23° world head yaw each way — clearly reads, never possessed
  maxPitch: 0.22,      // ~13° head pitch each way — follows top/bottom edges naturally
  maxLocalYaw: 0.62,   // ~35° neck limit — head-local yaw is clamped here
  bodySquare: 0.12,    // body eases this much toward camera while the pointer is live
  squareEase: 1.2,     // slow λ for the square-up — a posture drift, never a turn
  ease: 8.5,           // damped λ while tracking (~95% in 0.35s — responsive, no snap)
  easeReturn: 3.0,     // gentler settle when the cursor leaves/stops
  deadzone: 0.04,      // normalized deadzone: sub-4% drift never twitches the head
  rectRefreshMs: 500,  // canvas-rect refresh cadence (also throttled-refreshed on pointer events)
} as const;

export const GLANCE_CONFIG = {
  minEvery: 8,         // seconds between glances (bounded random)
  maxEvery: 20,
  yaw: 0.2,            // glance amplitude
  pitch: 0.06,
  easeIn: 2.2,         // damped λ moving INTO a glance — deliberate, not a twitch
  easeOut: 3.0,        // damped λ settling back out of one
  minHold: 0.5,
  maxHold: 1.5,
} as const;

/**
 * One-shot greeting — an authored timeline (explicit keyframes, not a sine):
 *
 *   0.00–0.10  anticipation (character is still)
 *   0.10–0.32  right arm raises through the FRONT to greeting height
 *   0.32–1.00  two compact greeting swings ("hey — hey")
 *   1.00–1.45  arm settles home
 *   1.60       done — plain idle resumes
 *
 * Rig axis facts (verified against skinview3d's own WaveAnimation +
 * model.js; Euler order XYZ, so rotation.z applies before rotation.x):
 *   rotation.x < 0 swings the arm up through the FRONT — hand ends up
 *   forward and high, fully visible to the camera (the friendly "hi").
 *   rotation.z is the LATERAL axis; oscillating it sweeps the hand side
 *   to side. Raising via rotation.z instead (the old bug) arcs the arm
 *   around the body's far side — behind the torso plane, cocked upward —
 *   which read as a boxer winding up a punch.
 */
export const GREET_CONFIG = {
  duration: 1.6,
  raiseStart: 0.1,     // anticipation hold before any motion
  raiseEnd: 0.32,      // arm fully up
  swingStart: 0.32,    // greeting swings begin
  swingEnd: 1.0,       // swings end
  settleEnd: 1.45,     // arm fully home (before duration → beat of stillness)
  // ── THE ARM MECHANICS NOW COME FROM WAVE_CONFIG (the launch farewell) ──
  // The greeting previously carried its own raiseX (-1.45) and baseZ (-0.42).
  // Because Euler order is XYZ, rotation.z applies BEFORE rotation.x: a shallower
  // front raise combined with a LARGER outward tilt swings the hand out to the
  // SIDE at shoulder height — a lateral shoulder raise, not a wave. Confirmed by
  // frame comparison against the launch wave (mu-verify/probe-026.mjs + the
  // 026-arm-compare frames): greeting = "arm extended straight out to the side",
  // launch = "raised up, hand near head height". Rather than invent a second set
  // of arm numbers, the greeting now reuses WAVE_CONFIG's raiseX / baseZ /
  // swingAmp — the launch wave is the proven source of truth for arm mechanics.
  // Only the CHOREOGRAPHY below stays greeting-specific (timing + swing tempo).
  swingRate: 8.5,      // rad/s over the 0.68s window ≈ two compact greeting swings
  nodPitch: 0.05,      // small chin-down acknowledgment at the raise
  sweepYaw: 0.04,      // tiny verbal side-to-side while swinging
  bodyLift: 0.1,       // small chest-up at the peak
  raiseEase: 10,       // damped λ of the raise — softens the authored curve, lets the
                       // gesture YIELD to the goodbye wave instead of snapping off it
} as const;

/**
 * Goodbye wave — the launch farewell, built for THIS rig (one rigid arm
 * segment per side, no elbow/hand joint). Choreography in absolute seconds
 * since the launch edge:
 *
 *   Phase A  NOTICE   0 – 0.2s    posture perk + light ramp (no arm motion)
 *   Phase B  RAISE    0 – 0.6s    damped raise THROUGH THE FRONT (rotation.x
 *                                 → −2.35): the hand ends raised above shoulder
 *                                 height and clearly in front of the torso, tilted
 *                                 outward — the open, friendly 👋 silhouette.
 *                                 No side arc, no cocking back, no jab.
 *   Phase C  WAVE     0.55s → ∞   lateral swings around the raised pose
 *                                 (rotation.z oscillation ±0.36). The swing
 *                                 eases in AFTER the arm arrives, the tempo
 *                                 ramps up over `choreoWindow` (the "see
 *                                 you!" lift), then holds a steady, slightly
 *                                 faster tempo indefinitely: real launches
 *                                 run 20s+ through Igniting/Forging, and the
 *                                 wave must wave for ALL of it. A slow ±8%
 *                                 amplitude swell keeps a long goodbye from
 *                                 reading as a metronome.
 *   RELEASE           on energetic↓ — wavePose eases home (λ 5) and the
 *                                 swing fades with it. No snap.
 *
 * The oscillation is LATERAL ONLY (rotation.z). There is deliberately NO
 * oscillation on rotation.x: a rhythmic swing on that axis moves the hand
 * toward/away from the camera — a jab — which is exactly the silhouette
 * being eliminated.
 */
export const WAVE_CONFIG = {
  raiseX: -2.35,       // front raise: hand raised high, forward of the torso, tilted out
  baseZ: -0.32,        // outward tilt so the waving hand clears the head
  swingAmp: 0.36,      // lateral hand-wave oscillation on rotation.z — a wave, never a flail
  swingRate: 6.4,      // base swing angular speed, rad/s (~1.0 Hz — a human wave tempo)
  rateRamp: 0.15,      // tempo lifts ~1.15× across the choreo window ("see you!"), then holds
  choreoWindow: 2.6,   // seconds over which the tempo ramps; after it, steady waving continues
  raiseEase: 5.0,      // exp damping λ of the raise (~95% up in 0.6s = Phase B)
  swingDelay: 0.55,    // Phase C starts after the arm has arrived
  swingRamp: 0.35,     // swing amplitude eases in over this many seconds
  ampBreathe: 0.10,    // ±10% slow amplitude swell (~7s period) — organic, never metronomic
  rateWobble: 0.07,    // ±7% guard (see INDEX.md) — tempo drift ±7%, phase-offset from the swell
  rateWobbleFreq: 0.6, // rad/s of the tempo drift (~10s period)
  lean: 0.04,          // subtle forward lean while waving
  turn: 0.10,          // subtle body square-up toward the camera while waving
  headPitch: -0.05,    // chin slightly up during the wave
} as const;

/**
 * Skin lighting — palette of record (visual lab 001-amber-restored).
 *
 * History: Stage 10 (000-baseline) made a saturated warm key dominant →
 * the character read yellow/gold (rejected). 001 restored the ambient-
 * dominant recipe (2.0 / #d9cbb8) — correct character, but no readable
 * stage. 002/003 used ONE saturated dominant key for both body and floor:
 * the character was repainted orange (rejected). 004 fixed the color but
 * still failed: opaque-black canvas box visible on the page, floor 4.5
 * units BELOW the lifted feet (floating character), back side crushed to
 * black by a too-strong key, pool invisible. Owner re-spec 2026-09-14 —
 * the 005 architecture, all five requirements at once:
 *
 *   AMBIENT  the 001 foundation, unchanged: 2.0 / #d9cbb8 — the light that
 *            CARRIES the character's amber identity.
 *   KEY      a gentle SpotLight above-front-right: directional depth only.
 *            010 AMBER CALIBRATION (2026-09-14, this change): restored to
 *            the 001-amber-restored palette entry — 450 / #e6a55c @
 *            [14,30,42], cone 0.30 / pen 0.80 (effective ≈0.15 of the
 *            ambient's contribution). The 009-era entry (4500 / #f3e2c8 @
 *            [12,62,44], 0.45/0.45) sat at ≈0.74 effective — ~5× the 001
 *            weight — which lifted the amber midtones toward mustard/gold
 *            (owner-reported drift). The key keeps its 009 ARCHITECTURE
 *            (layer-1 character-only, castShadow=false, one-shadow rule):
 *            color authority returns to the ambient recipe (2.0/#d9cbb8).
 *            castShadow=false: it does NOT own the shadow — one light, one
 *            shadow.
 *   POOL     the cone-decoupled floor painter. The 002–004 trap: any light
 *            bright enough to paint a visible pool on a near-black floor
 *            under ambient-2.0 also repaints the body, because the torso is
 *            CLOSER to any overhead light than the floor is. The escape is
 *            GEOMETRY: a steep, narrow SpotLight aimed at the floor ~14
 *            units in FRONT of the feet whose cone mathematically misses
 *            the torso (chest ≈ 0.29 rad off-axis vs 0.20 rad cone) — so
 *            its large floor irradiance contributes ZERO to the body while
 *            the ankles graze its penumbra rim (grounding). It casts THE
 *            one real compact shadow, falling behind the character (~59°
 *            elevation) into the fog-dimmed floor.
 *   FLOOR    AT the LIFTED feet: y = stageLift − 16 = −11.5 (the 004 bug —
 *            −16 put the plane 4.5 under the feet). Huge half-size so the
 *            edge is never in frame; matte warm-black albedo (#141110) —
 *            invisible unlit (≈ ambient floor ≈ the room black), visible
 *            only inside the pool cone.
 *   ROOM     scene.background = #0b0a09 — EXACTLY the page's --ground
 *            token where the stage sits (verified: the body gradient is
 *            past its 55% stop at the canvas region). skinview3d's canvas
 *            is opaque (renderer created without alpha), so matching the
 *            room color is the only way the canvas stops reading as a box.
 *            The fog color equals the background, so the floor dissolves
 *            INTO the room with distance — a seamless cyclorama, no plane
 *            boundary, no horizon line. The character (d≈87) stays inside
 *            the unfogged range (110).
 *   RIM      low 0.6 / #e8ddd0 back-left DirectionalLight, nearly
 *            horizontal — a whisper of silhouette separation that cannot
 *            wash the dark floor.
 *
 * Geometry facts (verified against skinview3d r3.4.2): PlayerObject feet
 * at local y = −16; camera at (0,0,~87) at zoom 0.80 / fov 28, horizontal,
 * eye at y=0; lifted character spans y −11.5 (feet) .. +20.5 (head top).
 *
 * All numbers live here (Phase 28: one tunable surface). The rig
 * geometry/flags are installed once in SkinViewerCanvas's init effect.
 */
export const STAGE_LIGHT_CONFIG = {
  // ── Stage composition ──
  // stageZoom — the hero camera scale, and pass 024's ONLY visual variable.
  // 0.80 → 0.70 pulls the camera back (distance 4.5 + 16.5/tan(fov/2)/zoom:
  // 87.2 → 99.0 units) so the render frame holds more ROOM around the subject.
  // The character's share of the frame drops 87.4% → ~76.5%, and because
  // HERO_CANVAS grew 366 → 416 px in the same pass, the character's on-screen
  // height is preserved (≈39-40% of the viewport) while the head finally gains
  // dark space above it. Nothing else in this file changed.
  stageZoom: 0.62,      // 046vh canvas (368px @800): character rescaled to fit the shorter frame, feet fully in frame
  stageLift: 4.5,       // playerWrapper.position.y — feet clear the frame bottom
  stageFloorY: -11.5,   // stage floor AT the LIFTED feet (stageLift − 16) — planted, never floating
  floorSize: 168,       // floor plane is 168×168 — sized to the radial fade (see below)
  floorCoreUnits: 10,   // radius with FULL stage albedo: the 0.10-rad pool cone (~7) + shadow live here
  // 028: 42 → 32. The floor's alpha now lives on the floor itself (see
  // installStageRig), and the hero canvas' own side edge sits ~34 world units
  // from the floor's centre at the rows where the floor is visible. At a 42-unit
  // fade the floor was still ~60% opaque out there, which left a measured +3.14
  // luminance step where the amber floor light met the canvas' left edge. Fading
  // out by 32 clears the edge completely while leaving the 22-unit core — the
  // pool and the real shadow — untouched.
  floorFadeUnits: 16,   // radius where the albedo reaches the exact room color
                        // floor strip spans ±46 (fov math), so every floor pixel the camera
                        // sees near the canvas edges is already EXACTLY the background.
                        // This is what finally kills the box: the floor cannot contrast
                        // with the room it sits in.
  floorColor: '#141110', // warm-black matte albedo — invisible unlit, reads only inside the pool
  floorRoughness: 1.0,
  roomColor: '#0b0a09', // the page --ground token — canvas background AND fog color
  fogNear: 110,         // distance fog: the floor dissolves into the room color
  fogFar: 320,          // (character at d≈87 stays unfogged)

  // ── Key light — gentle body shaper (no shadow ownership) ──
  // 010 AMBER CALIBRATION: the 001-amber-restored palette entry (450 /
  // #e6a55c @ [14,30,42], 0.30/0.80 — effective ≈0.15 of ambient) replaces
  // the 009-era entry (4500 / #f3e2c8 @ [12,62,44], 0.45/0.45 — ≈0.74
  // effective). Single controlled variable: the ambient recipe re-assumes
  // total color authority; the mustard/gold drift leaves the midtones.
  // The key keeps the 009 ARCHITECTURE (layer-1 character-only, no shadow
  // ownership). Same direction (front-right, above), so the shaping role
  // is preserved at the demoted weight.
  keyColor: '#e6a55c',
  keyIntensity: 450,
  keyPosition: [14, 30, 42] as [number, number, number],  // 001 palette entry (front-right, above)
  keyTarget: [0, -14, 3] as [number, number, number],     // through the legs — axis lands on the floor near the feet
  keyAngle: 0.30,       // rad — 001 cone
  keyPenumbra: 0.80,    // 001 soft cone edge
  keyLayer: 1,          // lights only meshes that enable layer 1 (the character) — 009 architecture kept

  // ── Pool light — THE stage spotlight (floor painter + shadow caster) ──
  // Steep narrow cone aimed at the floor in front of the feet. 005 (45000)
  // repainted the legs hot gold: leg fronts sit ~2.3× ambient under that
  // intensity (legs ≈ equidistant with the pool center — geometry gives no
  // escape, only intensity does). 18000 drops leg fronts to ≈ ambient 1.6
  // (a warm grounding edge, never a glow) while the floor pool stays clearly
  // visible: a warm SUBTLE pool exactly as specced. The character still
  // intersects the cone (feet ≈ 0.19 rad off-axis) → it casts THE one real
  // compact shadow receding behind the body (~59° elevation), hidden from
  // this camera by the character itself — the physically correct look.
  // 010: unchanged — the pool stays the stage; the key owns nothing of it.
  // 028 SPOTLIGHT REMOVAL: 18000 → 4000. At 18000 the pool read 27–47 luminance
  // against a room at 10.1 — a distinctly brighter oval under the feet that made
  // the character look like he was standing on a lit platform (owner-reported).
  // 4000 measures as a soft ~1.5–2x lift instead: still the ONLY shadow caster
  // (castShadow stays true, and the floor's opaque core still receives it), so
  // the grounding survives as a subtle believable shadow rather than a spotlight.
  poolColor: '#f3e2c8',
  poolIntensity: 4000,
  poolPosition: [0, 65, 20] as [number, number, number],   // higher, near-overhead — short compact shadow
  poolTarget: [0, -11.5, 16] as [number, number, number],  // floor in front of the feet
  poolAngle: 0.10,      // rad — narrowest: pool fully retracts inside the canvas, never touches the edges
  poolPenumbra: 0.85,   // wide soft edge — the pool fades, never a hard circle
  poolShadowMapSize: 2048,
  poolShadowBias: -0.0004,
  poolShadowNormalBias: 0.05,
  poolShadowNear: 30,
  poolShadowFar: 160,   // light→shadow tip ≈ 89 — keep the shadow frustum honest
} as const;

/**
 * The room's own light — the ATMOSPHERE layer, and it lives INSIDE the canvas.
 *
 * Why in-canvas: a page-layer glow (the external LightPillar/WorldBeacon) can
 * never sit behind the character — it lights the page and stops dead where the
 * opaque canvas begins, which is precisely what drew the "dark rectangle"
 * across versions 011–017. Worse, by occupying the band above the stage it put
 * a hard ceiling on how large the hero could be. Inside the scene, both
 * problems disappear: the layer IS behind the player, the depth buffer
 * guarantees it can never cover him, and it contributes no light at all
 * (MeshBasicMaterial), so the skin, pool, floor and shadow are untouched.
 *
 * Compositing follows the SAME proven technique as the stage floor's matcher
 * plane (see installStageRig): a black-filled canvas whose radial gradient
 * drives an `alphaMap` (alpha maps read the green channel, so no colour-space
 * conversion is involved), multiplied by the material's `opacity`.
 *
 * Seamless by construction, not by masking:
 *   - The plane is 100 units wide and sits 60 units back, so it covers the
 *     whole frustum (the visible window is ≈36.6 units tall × ≈42 wide).
 *   - Every pixel outside the glow is *exactly* the room colour, because the
 *     only thing drawn there is `--ground` — the same value the canvas
 *     background and the page ground use. A canvas edge can therefore never
 *     contrast with the page, whatever the canvas size does.
 *   - The glow itself is bounded well inside the frame. Measured live frame
 *     (world y): −16.0 … +20.65 (the character's head sits 0.4 % below the top
 *     edge, so there is almost no headroom to use). The ellipse is centred at
 *     y = +7 with a vertical semi-axis of 9.5, and its gradient reaches
 *     TRANSPARENT at 85 % of the radius — so its influence dies by y ≈ +15,
 *     5.6 units short of the frame's top edge. Horizontally the semi-axis is
 *     15 against a half-width of ≈21.4 at the 019 framing. No edge is ever lit.
 *
 * Colour: `#c88735` — the beacon's own amber. Deliberately NOT the character's
 * `#e6a55c` (STAGE_LIGHT_CONFIG.keyColor): the two ambers must never merge, and
 * this layer must never be read as character lighting.
 */
export const ATMOSPHERE_CONFIG = {
  color: '#c88735',
  baseOpacity: 0.0,     // REMOVED (2026-09-16 stage-rect pass): the "amber orb"
  igniteOpacity: 0.0,   // — owner re-brief §5 measured this plane as the bright
                        // backdrop wash reading as a lit stage-panel rectangle
                        // around the character. Diagnostic experiment proved
                        // causality (zeroed → orb + wash vanished, everything
                        // else pixel-identical). The slot is kept null-safe for
                        // the director's ignition ramp; see installStageRig §3b.
  distance: 60,         // world units behind the player (camera at z ≈ +87)
  planeSize: 100,       // covers the visible window with margin (see the ratio note)
  centerY: 8,           // plane-units y of the glow's centre — the player's chest band
  // THE GEOMETRY IS IN **PLANE** UNITS, AND THE PLANE IS FARTHER THAN THE PLAYER.
  // Measured live (probe-atm2.mjs): camera z 87.2, plane z −60 → the plane is
  // 147.2 units away vs the character's ~87, i.e. 1.69× farther, so one
  // plane-unit subtends 1.69× LESS screen than one character-unit. Sizing the
  // ellipse against the character's world width therefore fails twice over:
  //   attempt 1 (radiusX 15): rim at 12.75 plane units — the character's screen
  //     silhouette alone spans ±14.7 plane units, so the whole glow was behind him.
  //   attempt 2 (radiusX 20): rim at 17.0 — still inside his ±14.7 subtent plus a
  //     2.3-unit sliver; every sample clear of him measured the exact room colour.
  // The visible frame at that distance is ±36.8 plane-units wide and ±30.5 tall.
  //   radiusX 30 → rim (0.88 r) at 26.4: 11.7 units of real halo beyond his edge
  //     and 10.4 units of clean room before the frame's side.
  //   radiusY 18 → rim at 15.8, so its influence tops out at y ≈ +23.8 plane
  //     units = 11 % down the canvas — 38 CSS px of untouched room below the
  //     canvas top, which is what keeps the top edge seamless.
  radiusX: 30,          // horizontal semi-axis (PLANE units)
  radiusY: 18,          // vertical semi-axis (PLANE units)
  rimEnd: 0.88,         // fraction of the radius at which the gradient is fully transparent
  textureSize: 512,
} as const;

export const SKIN_CONFIG = {
  // Palette of record (visual lab 001-amber-restored): ambient-dominant
  // warm-neutral illumination (2.0 / #d9cbb8) carries the character's amber
  // identity; the stage key (STAGE_LIGHT_CONFIG) now sits at its 001
  // effective weight (≈0.15 of ambient) and adds directional depth WITHOUT
  // exceeding ambient at the skin. cameraLight keeps its historical value —
  // as a PointLight attached to the camera ~87 units out, its physical
  // falloff (decay 2) makes it a no-op; it survives only as the ignition
  // ramp's historical slot. Lighting shapes, never recolors.
  globalIntensity: 2.0,
  globalColor: '#d9cbb8',
  cameraIntensity: 0.8,
  rimIntensity: 0.6,        // whisper of silhouette separation (001 value)
  rimColor: '#e8ddd0',
} as const;

/**
 * Stage rig installer — the POOL cone + the PLANTED STAGE FLOOR + the
 * room-colored fog cyclorama.
 *
 * Runs ONCE in SkinViewerCanvas's init effect, after the viewer exists and
 * before the first frame. Casts no lasting reference outside what it
 * returns: the returned object is what PlayerDirector ramps, and the
 * cleanup closure removes every object it added.
 *
 * Why a lit floor, not a ShadowMaterial catcher: the canvas is opaque
 * (renderer created without alpha), so any black floor would sit on black —
 * invisible. A warm-black matte MeshStandardMaterial floor is invisible
 * unlit (its ambient response ≈ the room black) and visible only inside
 * the pool cone — grounding the character while the rest melts into the
 * room. The shadow inside that pool is automatic: the character occludes
 * the pool light, and the floor receives the real soft shadow.
 *
 * The floor sits AT the lifted feet (stageFloorY = stageLift − 16). It is
 * TWO stacked planes (008 box fix): a lit stage surface that owns the
 * pool + shadow, and an unlit matcher plane painted the exact room color
 * with a radial alpha map — transparent over the pool, opaque outside it.
 * The matcher ERASES the stage plane's ambient response beyond the core
 * (that response rendered brighter than the room and betrayed the canvas
 * edges), so the visible floor is the pool — and outside it, literally
 * the background. No edge, no slab, no box: a seamless stage dissolving
 * into darkness (the 002/003/004/006/007/008 failure, finally dead).
 *
 * Layer ownership (Phase 7 — no transform fights):
 *   playerWrapper.position.y = stageLift     → framing (feet visible)
 *   playerObject children                    → director (gaze/wave/breath)
 *   pool.target / key / rim / ambient / fog  → this rig + director ramp
 */
export function installStageRig(
  viewer: { scene: Object3D; playerWrapper: Object3D; zoom: number },
): {
  key: SpotLight;
  pool: SpotLight;
  /** The in-canvas atmosphere material — the director ramps its opacity with the
   *  ignition curve so the room warms when a launch begins (see ATMOSPHERE_CONFIG). */
  atmosphere: MeshBasicMaterial;
  remove: () => void;
} {
  const { floorColor, floorRoughness, floorSize, floorCoreUnits, floorFadeUnits, stageFloorY, stageLift, roomColor, fogNear, fogFar } = STAGE_LIGHT_CONFIG;

  // 1. Re-frame: lift the whole rig so feet + floor strip enter the frame
  //    (stock framing crops the feet below it — nothing could ever ground).
  viewer.playerWrapper.position.y = stageLift;

  // 2. Room-colored cyclorama: scene.background = the exact page ground
  //    (the canvas is opaque, so this is what kills the visible box), and
  //    distance fog in the same color dissolves the far floor into it —
  //    no plane edge, no horizon line, ever.
  // 2. TRANSPARENT room: the page (and the SideRays field behind the canvas) IS
  //    the room. skinview3d's context already has alpha:true, so clearing with
  //    alpha 0 (SkinViewerCanvas) plus a null background makes every pixel the
  //    scene does not paint genuinely see-through — which is what finally removes
  //    the visible black rectangle instead of matching its colour to the page.
  //    The fog stays: it dissolves the floor's lit edge into the same room colour
  //    and cannot affect alpha.
  const scene = viewer.scene as Object3D & { fog: Fog | null; background: Color | null };
  scene.background = null;
  scene.fog = new Fog(new Color(roomColor), fogNear, fogFar);

  // 3. The planted stage floor — ONE plane, transparent beyond the pool.
  //
  //    History: the floor used to be an opaque plane plus a second, unlit
  //    "matcher" plane on top painting the exact room colour beyond the pool
  //    core, which erased the floor's ambient response (the 006/007/008 box fix).
  //    That could only ever work while the CANVAS was opaque — an opaque matcher
  //    is just as much of a black rectangle as the floor it hides. Now that the
  //    room itself is transparent (scene.background = null + clearAlpha 0, so the
  //    page and the SideRays field are the room), the matcher is both unnecessary
  //    and a direct cause of the visible dark rectangle, so it is GONE and the
  //    floor carries its own radial alpha instead: opaque across the pool/shadow
  //    core, dissolving to fully transparent by the fade radius.
  //    Same geometry as the old matcher (floorCoreUnits / floorFadeUnits), simply
  //    inverted: alpha 1 inside, 0 outside. Alpha maps read the texture's green
  //    channel; 256², linear filters, disposed with the rig.
  const core = floorCoreUnits / (floorSize / 2);   // fraction of the half-width that stays opaque
  const fade = floorFadeUnits / (floorSize / 2);   // fraction where the floor is fully transparent
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = alphaCanvas.height = 256;
  const actx = alphaCanvas.getContext('2d');
  if (actx) {
    const grad = actx.createRadialGradient(128, 128, core * 128, 128, 128, fade * 128);
    grad.addColorStop(0, 'rgb(255,255,255)'); // opaque — the lit stage floor + THE real shadow
    grad.addColorStop(1, 'rgb(0,0,0)');       // transparent — the room shows through the plane
    actx.fillStyle = grad;
    actx.fillRect(0, 0, 256, 256);
  }
  const alphaTex = new CanvasTexture(alphaCanvas);
  alphaTex.minFilter = LinearFilter;
  alphaTex.magFilter = LinearFilter;

  const floorGeo = new PlaneGeometry(floorSize, floorSize);
  const floor = new Mesh(
    floorGeo,
    new MeshStandardMaterial({
      color: floorColor,
      roughness: floorRoughness,
      transparent: true,
      alphaMap: alphaTex,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = stageFloorY;
  floor.receiveShadow = true;
  // KILL SWITCH (shadow-bug final pass): this plane is the "dark block under
  // the feet" — its near-black albedo (#141110) sits as a distinct slab on the
  // page background, ignores every shadow setting (it is geometry, not a
  // shadow), and is flat-cut by the canvas' bottom edge. With shadows off and
  // grounding owned by the CSS pool + MagicRings, the 3D floor has no job.
  // Visible=false removes it from the render pass entirely; geometry stays for
  // a cheap re-enable.
  floor.visible = false;
  viewer.scene.add(floor);

  // 3b. THE ATMOSPHERE PLANE — REMOVED (2026-09-16 stage-rect pass).
  //    Owner re-brief §5: "NO artificial amber orb behind character." Runtime
  //    measurement attributed the bright backdrop wash (avgR 38.5 vs room
  //    10.1, maxR 244, luminance plateau spanning most of the canvas) to this
  //    plane, and the one diagnostic experiment (opacities zeroed) removed
  //    the orb + wash with every other stage pixel unchanged — causality
  //    proven, not assumed. The rig still exports an atmosphere slot (a
  //    dormant MeshBasicMaterial) so the director's ignition ramp and the
  //    SkinViewerCanvas wiring stay valid; the material is never added to
  //    the scene and never rendered. Do not re-add a backdrop glow plane —
  //    SideRays is the approved amber environment, MagicRings the identity
  //    aura, and the pool light the grounding.
  const atmosphere = new MeshBasicMaterial({ color: new Color(ATMOSPHERE_CONFIG.color) });

  // 4. Key light: gentle warm-neutral shaper above-front-right. Shapes the
  //    body's directional depth; casts NO shadow (one light, one shadow).
  const key = new SpotLight(
    STAGE_LIGHT_CONFIG.keyColor,
    STAGE_LIGHT_CONFIG.keyIntensity,
    0,
    STAGE_LIGHT_CONFIG.keyAngle,
    STAGE_LIGHT_CONFIG.keyPenumbra,
  );
  key.position.set(...STAGE_LIGHT_CONFIG.keyPosition);
  key.target.position.set(...STAGE_LIGHT_CONFIG.keyTarget);
  key.castShadow = false;
  // Character-only: the key's wide cone must never wash the floor (that
  // wash clipped at the canvas edges in 005 and re-summoned the box). The
  // key lives on layer 1; the player meshes below enable layer 1, the
  // floor never does — so the floor only ever sees the ambient + pool.
  key.layers.set(STAGE_LIGHT_CONFIG.keyLayer);
  viewer.scene.add(key);
  viewer.scene.add(key.target);

  // 5. Pool light: THE stage spotlight — steep narrow cone painting the
  //    floor around the feet, casting THE one compact soft shadow. Its
  //    cone misses the torso (see STAGE_LIGHT_CONFIG geometry), so the
  //    body's color stays owned by the ambient recipe.
  const pool = new SpotLight(
    STAGE_LIGHT_CONFIG.poolColor,
    STAGE_LIGHT_CONFIG.poolIntensity,
    0,
    STAGE_LIGHT_CONFIG.poolAngle,
    STAGE_LIGHT_CONFIG.poolPenumbra,
  );
  pool.position.set(...STAGE_LIGHT_CONFIG.poolPosition);
  pool.target.position.set(...STAGE_LIGHT_CONFIG.poolTarget);
  pool.castShadow = false; // OFF: the dark room hides real shadows anyway; a canvas-edge-cut shadow reads as a bug. The pool alone grounds the character.
  pool.shadow.mapSize.setScalar(STAGE_LIGHT_CONFIG.poolShadowMapSize);
  pool.shadow.radius = 32; // wide penumbra: shadow fully dissolves before the canvas edge
  pool.shadow.bias = STAGE_LIGHT_CONFIG.poolShadowBias;
  pool.shadow.normalBias = STAGE_LIGHT_CONFIG.poolShadowNormalBias;
  pool.shadow.camera.near = STAGE_LIGHT_CONFIG.poolShadowNear;
  pool.shadow.camera.far = STAGE_LIGHT_CONFIG.poolShadowFar;
  viewer.scene.add(pool);
  viewer.scene.add(pool.target); // the target must be in the scene graph to update

  return {
    key,
    pool,
    atmosphere,
    remove: () => {
      viewer.scene.remove(floor);
      viewer.scene.remove(key);
      viewer.scene.remove(key.target);
      viewer.scene.remove(pool);
      viewer.scene.remove(pool.target);
      floorGeo.dispose();
      (floor.material as MeshStandardMaterial).dispose();
      alphaTex.dispose();
      atmosphere.dispose();
      key.dispose();
      pool.dispose();
      scene.background = null;
      scene.fog = null;
    },
  };
}

export const IGNITE_CONFIG = {
  globalLight: 2.3,     // ambient lifts ~+15% over base (2.0) — the room warms with the mood
  cameraLight: 0.92,    // historical slot (no-op at camera distance — see SKIN_CONFIG)
  rimLight: 1.1,        // the rim lifts with the mood (0.6 base) — the silhouette separates harder
  keyLight: 1.0,        // the key does NOT amplify on ignition — never re-amplify the
                        // light that owns the character's color (Stage-10 lesson)
  amber: '#e6a55c',    // blended toward base color, never full amber
  amberMix: 0.35,
  cameraAmberMix: 0.2,
  rimAmberMix: 0.45,
  lightEase: 3.3,      // damped λ (1/s) of the light ramp — frame-rate independent
                       // (0.055 per 60fps frame ≈ 3.3/s; never a fixed per-frame lerp)
} as const;

const rand = (min: number, max: number): number => min + Math.random() * (max - min);

/** Frame-rate-independent exponential approach (critically damped feel). */
const damp = (current: number, target: number, lambda: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

const clampAbs = (v: number, max: number): number =>
  v > max ? max : v < -max ? -max : v;

const smooth01 = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/**
 * Normalized deadzone with continuous rescaling: input is zero below the
 * threshold and reaches ±1 exactly at |n| = 1, so crossing the threshold
 * never produces a jump.
 */
const deadzone = (n: number, dz: number): number => {
  const a = Math.abs(n);
  if (a <= dz) return 0;
  return Math.sign(n) * ((a - dz) / (1 - dz));
};

export class PlayerDirector extends IdleAnimation {
  energetic = false;

  /** Diagnostic-friendly: eases to 1 while the pointer is live, 0 when idle. */
  gazeStrength = 0;

  private lights: {
    global: AmbientLight;
    camera: PointLight;
    rim: DirectionalLight;
    key: SpotLight | null;   // stage key — null under reduced-motion (static shot)
    pool: SpotLight | null;  // stage pool — null under reduced-motion (static shot)
    atmosphere: MeshBasicMaterial | null; // in-canvas room light — unlit, opacity-ramped
    fill: DirectionalLight | null; // always null since 001 (fill removed; slot kept)
  };
  private canvas: HTMLCanvasElement | null;

  private globalBaseIntensity: number;
  private cameraBaseIntensity: number;
  private rimBaseIntensity: number;
  private globalBaseColor: Color;
  private cameraBaseColor: Color;
  private rimBaseColor: Color;
  private amberGlobal: Color;
  private amberCamera: Color;
  private amberRim: Color;
  private keyBaseIntensity: number;
  private amberKey: Color;
  private keyBaseColor: Color;
  private poolBaseIntensity: number;
  private fillBaseIntensity: number;

  // ── clocks ──
  private accum = 0;        // master animation clock (seconds)
  private breathPhase = 0;  // idle expression clock
  private lastNow = 0;
  private lastEnergetic = false;
  private timeSinceEdge = 0;

  // ── gaze: raw pointer → bounded demand → damped response ──
  private pointerX = 0;
  private pointerY = 0;
  private pointerActive = false;
  private rect: DOMRect | null = null;
  private lastRectAt = 0;
  private demandYaw = 0;
  private demandPitch = 0;
  private gazeYaw = 0;      // damped head-LOCAL yaw demand (camera-frame target − bodyYaw)
  private gazePitch = 0;    // damped head pitch
  private attn = 0;         // eased 0..1 — pointer present; drives the gentle body square-up

  // ── glance (personality look-aways, yield to events) ──
  private nextGlanceAt: number;
  private glanceTargetYaw = 0;
  private glanceTargetPitch = 0;
  private glanceYaw = 0;
  private glancePitch = 0;
  private glanceEndsAt = -1;

  // ── greeting (one-shot, authored timeline) ──
  private greeted = false;
  private greetStart = 0;
  private greetEndsAt = -1;
  private greetPose = 0;   // damped applied raise 0..1 — yields to the wave, never snaps

  // ── goodbye wave ──
  private wavePose = 0;        // damped 0..1 raised-arm amount
  private waveSwingPhase = 0;

  constructor(
    lights: {
      global: AmbientLight;
      camera: PointLight;
      rim: DirectionalLight;
      key: SpotLight | null;
      pool: SpotLight | null;
      atmosphere?: MeshBasicMaterial | null;
      fill: DirectionalLight | null;
    },
    canvas?: HTMLCanvasElement,
  ) {
    super();
    this.lights = { ...lights, atmosphere: lights.atmosphere ?? null };
    this.canvas = canvas ?? null;
    this.globalBaseIntensity = lights.global.intensity;
    this.cameraBaseIntensity = lights.camera.intensity;
    this.rimBaseIntensity = lights.rim.intensity;
    this.globalBaseColor = lights.global.color.clone();
    this.cameraBaseColor = lights.camera.color.clone();
    this.rimBaseColor = lights.rim.color.clone();
    this.keyBaseIntensity = lights.key ? lights.key.intensity : 0;
    this.keyBaseColor = lights.key ? lights.key.color.clone() : new Color(0);
    this.poolBaseIntensity = lights.pool ? lights.pool.intensity : 0;
    this.fillBaseIntensity = lights.fill ? lights.fill.intensity : 0;
    // Amber is a blend FROM the base color — never a full repaint of the scene.
    const amber = new Color(IGNITE_CONFIG.amber);
    this.amberGlobal = this.globalBaseColor.clone().lerp(amber, IGNITE_CONFIG.amberMix);
    this.amberCamera = this.cameraBaseColor.clone().lerp(amber, IGNITE_CONFIG.cameraAmberMix);
    this.amberRim = this.rimBaseColor.clone().lerp(amber, IGNITE_CONFIG.rimAmberMix);
    this.amberKey = this.keyBaseColor.clone().lerp(amber, 0.25);
    // First glance arrives fairly soon, but never in the first seconds of use.
    this.nextGlanceAt = rand(GLANCE_CONFIG.minEvery * 0.5, GLANCE_CONFIG.maxEvery * 0.6);
  }

  /**
   * Feed a raw pointer sample (window client coords — NOT normalized).
   * The conversion to a bounded head target happens in the animation loop,
   * which owns all visual updates; this only records lightweight state and
   * throttled-refreshes the cached canvas rect (resize/DPI safety).
   */
  setPointer(clientX: number, clientY: number): void {
    this.pointerX = clientX;
    this.pointerY = clientY;
    this.pointerActive = true;
    this.refreshRect(true);
  }

  /** Pointer left the window — the character stops tracking and eases back. */
  clearPointer(): void {
    this.pointerActive = false;
  }

  /** The character just became visible — fire the one-shot greeting. */
  onShown(): void {
    if (this.greeted) return;
    this.greeted = true;
    this.greetStart = this.accum;
    this.greetEndsAt = this.accum + GREET_CONFIG.duration;
  }

  private refreshRect(force: boolean): void {
    const now = performance.now();
    const min = force ? 250 : GAZE_CONFIG.rectRefreshMs;
    if (now - this.lastRectAt < min) return;
    this.lastRectAt = now;
    if (!this.canvas) return;
    this.rect = this.canvas.getBoundingClientRect();
  }

  /**
   * Cursor → bounded head demand (two coordinate frames, in order):
   *   1. client coords → canvas-rect NDC (Y up) → deadzone → CAMERA-FRAME
   *      yaw/pitch target, clamped to the face's natural sweep (±maxYaw).
   *   2. camera frame → head-LOCAL frame: world head yaw ≈ bodyYaw +
   *      head.rotation.y, so the local demand is yawWorld − bodyYaw — then
   *      CLAMPED to the neck's limit (±maxLocalYaw). The clamp is the fix
   *      for the three-quarter-pose trap: without it the right edge of the
   *      screen demanded a 0.85 rad neck swivel while the left edge
   *      demanded ~nothing (dead left / grotesque right). With the gentle
   *      bodySquare posture shift keeping bodyYaw near −0.18 while the
   *      pointer is live, the full ±25° world sweep fits inside the neck
   *      budget and BOTH edges read clearly and symmetrically.
   *   3. On this rig (default camera at +Z, product pose yawBase −0.30): a
   *      POSITIVE head.rotation.y turns the face toward SCREEN-RIGHT; a
   *      POSITIVE head.rotation.x tips the face DOWN (so screen-up ⇒ look
   *      up ⇒ negate ny here and re-negate at the head write). Cursor
   *      screen-right ⇒ nx > 0 ⇒ yaw > 0 ⇒ face screen-right — the
   *      direction mapping was runtime-verified with CDP probe shots at
   *      gaze-left/center/right (see handoff sessions 3–6).
   * Nothing is allocated; all conversion happens on scalars.
   */
  private updateGazeDemand(bodyYaw: number): void {
    if (!this.canvas || !this.pointerActive) return;
    this.refreshRect(false);
    const rect = this.rect;
    if (!rect || rect.width < 2 || rect.height < 2) return; // hidden/resizing — keep last

    const nx = deadzone(((this.pointerX - rect.left) / rect.width) * 2 - 1, GAZE_CONFIG.deadzone);
    // Screen Y grows downward; NDC/gaze Y grows upward — invert here, once.
    const ny = deadzone(-(((this.pointerY - rect.top) / rect.height) * 2 - 1), GAZE_CONFIG.deadzone);
    const yawWorld = clampAbs(nx * GAZE_CONFIG.maxYaw, GAZE_CONFIG.maxYaw);
    this.demandYaw = clampAbs(yawWorld - bodyYaw, GAZE_CONFIG.maxLocalYaw);
    this.demandPitch = clampAbs(ny * GAZE_CONFIG.maxPitch, GAZE_CONFIG.maxPitch);
  }

  /**
   * Goodbye swing envelope — the phased choreography in absolute seconds
   * since the launch edge (see WAVE_CONFIG doc for the phase map):
   *   Phase A/B  0 → swingDelay   the arm travels up; NO swing.
   *   Phase C    swingDelay → ∞   readable lateral waves, eased in over
   *                               swingRamp. The envelope NEVER decays on a
   *                               timer: the launch state is the duration
   *                               driver, so the character waves through
   *                               the whole Igniting/Forging/Launching
   *                               window. The release comes from `energetic`
   *                               dropping — wavePose then eases the arm
   *                               home and the swing fades with it. No snap.
   */
  private waveSwingEnv(): number {
    if (!this.energetic) return 0;
    const t = this.timeSinceEdge;
    return smooth01((t - WAVE_CONFIG.swingDelay) / WAVE_CONFIG.swingRamp);
  }

  override animate(player: PlayerObject): void {
    const now = performance.now();
    if (this.lastNow === 0) this.lastNow = now;
    const delta = Math.min(0.1, (now - this.lastNow) / 1000); // clamp huge deltas (hidden window)
    this.lastNow = now;

    // Clocks: the master clock always advances; envelopes are time-boxed on
    // it, so nothing can freeze the character.
    this.accum += delta;
    this.timeSinceEdge += delta;

    // Ignition edge: energetic flip = the launch signal. The wave timeline
    // restarts only if the previous wave fully released (arm home) —
    // re-triggering mid-wave CONTINUES it (no swing-amplitude jump), and
    // rapid clicks can never corrupt state (damped scalars + pure functions
    // of time).
    if (this.energetic && !this.lastEnergetic) {
      if (this.wavePose < 0.05) this.timeSinceEdge = 0; // arm is home → fresh farewell
    }
    this.lastEnergetic = this.energetic;

    const phase = this.breathPhase * IDLE_CONFIG.tempo * IDLE_CONFIG.breathFreq * 3.2;

    this.progress = this.accum * IDLE_CONFIG.tempo;
    super.animate(player); // stock arm micro-swing + cape (arms adjusted below)

    // ── BASE: calm idle body ─────────────────────────────────────────────
    const swaySin = Math.sin(phase);
    player.skin.body.position.y =
      -6 + swaySin * IDLE_CONFIG.breathLift;
    player.skin.body.rotation.z =
      Math.sin(this.accum * 0.23 + 2.0) * IDLE_CONFIG.weightRoll;

    // ── GAZE: cursor → damped head-only yaw/pitch ────────────────────────
    // Attention square-up first (direction-INDEPENDENT): while the pointer
    // is inside the window the body slowly eases a touch toward facing the
    // user; it drifts back to the full product pose when they leave. This
    // is a posture state, never cursor tracking — and it is what lets the
    // head's neck budget cover a symmetric world sweep (see GAZE_CONFIG).
    this.attn = damp(this.attn, this.pointerActive ? 1 : 0, GAZE_CONFIG.squareEase, delta);

    // Body yaw is composed ONCE, here — the gaze demand and the final head
    // write both consume this exact value, so the face never drifts off the
    // cursor as the body breathes or squares up.
    const bodyYaw =
      IDLE_CONFIG.yawBase +
      swaySin * IDLE_CONFIG.swayIdle +
      GAZE_CONFIG.bodySquare * this.attn +
      WAVE_CONFIG.turn * this.wavePose;

    this.updateGazeDemand(bodyYaw);
    const lambda = this.pointerActive ? GAZE_CONFIG.ease : GAZE_CONFIG.easeReturn;
    this.gazeYaw = damp(this.gazeYaw, this.pointerActive ? this.demandYaw : 0, lambda, delta);
    this.gazePitch = damp(this.gazePitch, this.pointerActive ? this.demandPitch : 0, lambda, delta);
    this.gazeStrength = damp(this.gazeStrength, this.pointerActive ? 1 : 0, 6, delta);

    // ── GLANCE: bounded-random look-aways, suppressed while events run ──
    const eventLive =
      this.greetEndsAt >= 0 || this.energetic || this.wavePose > 0.05;
    if (this.glanceEndsAt >= 0 && this.accum >= this.glanceEndsAt) {
      this.glanceEndsAt = -1;
      this.nextGlanceAt = this.accum + rand(GLANCE_CONFIG.minEvery, GLANCE_CONFIG.maxEvery);
    } else if (
      this.glanceEndsAt < 0 &&
      !eventLive &&
      this.gazeStrength < 0.02 &&
      this.accum >= this.nextGlanceAt
    ) {
      this.glanceTargetYaw = rand(-GLANCE_CONFIG.yaw, GLANCE_CONFIG.yaw);
      this.glanceTargetPitch = rand(-GLANCE_CONFIG.pitch, GLANCE_CONFIG.pitch * 0.6);
      this.glanceEndsAt = this.accum + rand(GLANCE_CONFIG.minHold, GLANCE_CONFIG.maxHold);
    }
    const glancing = this.glanceEndsAt >= 0;
    this.glanceYaw = damp(
      this.glanceYaw,
      glancing ? this.glanceTargetYaw : 0,
      glancing ? GLANCE_CONFIG.easeIn : GLANCE_CONFIG.easeOut,
      delta,
    );
    this.glancePitch = damp(
      this.glancePitch,
      glancing ? this.glanceTargetPitch : 0,
      glancing ? GLANCE_CONFIG.easeIn : GLANCE_CONFIG.easeOut,
      delta,
    );

    // Idle micro head drift (tiny — never a fake substitute for tracking).
    const driftYaw =
      Math.sin(this.accum * 0.31) * IDLE_CONFIG.driftYaw +
      Math.sin(this.accum * 0.17 + 1.7) * IDLE_CONFIG.driftYaw * 0.5;
    const driftPitch = Math.sin(this.accum * 0.23 + 0.6) * IDLE_CONFIG.driftPitch;

    // ── GREETING: authored one-shot timeline ─────────────────────────────
    // anticipation → raise → two compact swings → settle home. Pure
    // functions of elapsed time, so it is deterministic and repeatable.
    // The raise is applied through a DAMPED scalar (greetPose), not written
    // raw: the goodbye wave can start MID-greeting, and the two gestures
    // then sum on the same arm — without the damp, rightArm.rotation.x
    // could momentarily exceed −π (−2.35 wave + −1.45 greet) and flip the
    // hand behind the torso (the broken "punch" silhouette). The goodbye
    // PRE-EMPTS the greeting; greetPose eases out over ~0.3s.
    if (this.greetEndsAt >= 0 && this.energetic) this.greetEndsAt = -1;
    let greetTimelineRaise = 0;
    let greetSwing = 0;
    let greetSweep = 0;
    if (this.greetEndsAt >= 0) {
      const t = this.accum - this.greetStart;
      if (t >= GREET_CONFIG.duration) {
        this.greetEndsAt = -1;
        this.nextGlanceAt = this.accum + rand(GLANCE_CONFIG.minEvery, GLANCE_CONFIG.maxEvery);
      } else {
        const rise = smooth01((t - GREET_CONFIG.raiseStart) / (GREET_CONFIG.raiseEnd - GREET_CONFIG.raiseStart));
        const fall = 1 - smooth01((t - GREET_CONFIG.swingEnd) / (GREET_CONFIG.settleEnd - GREET_CONFIG.swingEnd));
        greetTimelineRaise = Math.min(rise, fall);
        if (greetTimelineRaise > 0 && t >= GREET_CONFIG.swingStart && t <= GREET_CONFIG.swingEnd) {
          const swingT = t - GREET_CONFIG.swingStart;
          greetSwing = Math.sin(swingT * GREET_CONFIG.swingRate) * WAVE_CONFIG.swingAmp;
          greetSweep = Math.sin(swingT * GREET_CONFIG.swingRate * 0.5) * GREET_CONFIG.sweepYaw;
        }
      }
    }
    this.greetPose = damp(this.greetPose, greetTimelineRaise, GREET_CONFIG.raiseEase, delta);
    const greetRaise = this.greetPose;
    greetSwing *= greetRaise;
    greetSweep *= greetRaise;
    const greetNod = greetRaise * GREET_CONFIG.nodPitch;
    const greetLift = greetRaise * GREET_CONFIG.bodyLift;

    // Wave bookkeeping (see WAVE_CONFIG doc): the swing envelope NEVER
    // decays on a timer — `energetic` is the release driver. wavePose is
    // a damped scalar so mid-wave re-trigger CONTINUES the wave (no jump),
    // and the swing term fades with wavePose on release.
    this.wavePose = damp(this.wavePose, this.energetic ? 1 : 0, WAVE_CONFIG.raiseEase, delta);
    const swingEnv = this.waveSwingEnv();
    const ampBreathe = 1 + WAVE_CONFIG.ampBreathe * Math.sin(this.timeSinceEdge * 0.9);
    const rateWobble = 1 + WAVE_CONFIG.rateWobble * Math.sin(this.timeSinceEdge * WAVE_CONFIG.rateWobbleFreq + 1.3);
    if (swingEnv > 0) {
      const tNorm = Math.min(1, this.timeSinceEdge / WAVE_CONFIG.choreoWindow);
      this.waveSwingPhase += delta * WAVE_CONFIG.swingRate * (1 + WAVE_CONFIG.rateRamp * tNorm) * rateWobble;
    }
    const waveSwing = Math.sin(this.waveSwingPhase) * WAVE_CONFIG.swingAmp * ampBreathe * swingEnv * this.wavePose;

    // ── POSE COMPOSITION ─────────────────────────────────────────────────
    player.rotation.y = bodyYaw;
    player.skin.body.rotation.x = this.wavePose * WAVE_CONFIG.lean + (this.energetic ? IDLE_CONFIG.posturePitch : 0);
    player.skin.body.position.y += (this.energetic ? IDLE_CONFIG.postureLift : 0) + greetLift;

    // Arms: the base micro-swing from IdleAnimation already ran in
    // super.animate — the hang/wave/greet terms are ADJUSTMENTS on top of
    // it (+= / -=), never absolute overwrites, so the stock motion and the
    // authored gestures sum instead of fighting.
    const hang = IDLE_CONFIG.armSettle * (1 - this.wavePose);
    const waveX = WAVE_CONFIG.raiseX * this.wavePose;
    const waveZ = this.wavePose > 1e-3 ? WAVE_CONFIG.baseZ * this.wavePose + waveSwing : 0;
    const greetX = WAVE_CONFIG.raiseX * greetRaise;
    const greetZ = greetRaise > 1e-3 ? WAVE_CONFIG.baseZ * greetRaise + greetSwing : 0;
    player.skin.leftArm.rotation.z -= hang;
    player.skin.rightArm.rotation.z += hang + waveZ + greetZ;
    // ONE arm, TWO poses of the same mechanic: the wave PRE-EMPTS the greeting.
    // Take the STRONGER raise (both are negative) instead of summing them — now
    // that the greeting shares WAVE_CONFIG.raiseX, a sum would momentarily reach
    // -4.7 rad during the ~0.3 s hand-off and flip the arm behind the torso (the
    // documented "punch" silhouette). min() is continuous, so the hand-off is
    // seamless: whichever pose is deeper wins, and neither can exceed -2.35.
    player.skin.rightArm.rotation.x = Math.min(waveX, greetX);
    player.skin.head.rotation.y = this.gazeYaw + this.glanceYaw + driftYaw + greetSweep;
    player.skin.head.rotation.x = -this.gazePitch + this.glancePitch + driftPitch + greetNod + this.wavePose * WAVE_CONFIG.headPitch;

    // ── IGNITION LIGHT RAMP ──────────────────────────────────────────────
    // Damped approach to the ignition targets when `energetic`, back to the
    // base values when released. One damped λ (IGNITE_CONFIG.lightEase) for
    // all intensities; colors lerp with the same time constant. The key and
    // pool are scaled by IGNITE_CONFIG.keyLight (= 1.0) — never re-amplify
    // the lights that could own the character's color (Stage-10 lesson).
    const lights = this.lights;
    const lightTarget = this.energetic;
    lights.global.intensity = damp(
      lights.global.intensity,
      lightTarget ? IGNITE_CONFIG.globalLight : this.globalBaseIntensity,
      IGNITE_CONFIG.lightEase,
      delta,
    );
    lights.camera.intensity = damp(
      lights.camera.intensity,
      lightTarget ? IGNITE_CONFIG.cameraLight : this.cameraBaseIntensity,
      IGNITE_CONFIG.lightEase,
      delta,
    );
    lights.global.color.lerp(lightTarget ? this.amberGlobal : this.globalBaseColor, 1 - Math.exp(-3.3 * delta));
    lights.camera.color.lerp(lightTarget ? this.amberCamera : this.cameraBaseColor, 1 - Math.exp(-3.3 * delta));
    lights.rim.intensity = damp(
      lights.rim.intensity,
      lightTarget ? IGNITE_CONFIG.rimLight : this.rimBaseIntensity,
      IGNITE_CONFIG.lightEase,
      delta,
    );
    lights.rim.color.lerp(lightTarget ? this.amberRim : this.rimBaseColor, 1 - Math.exp(-3.3 * delta));
    if (lights.key) {
      lights.key.intensity = damp(
        lights.key.intensity,
        lightTarget ? this.keyBaseIntensity * IGNITE_CONFIG.keyLight : this.keyBaseIntensity,
        IGNITE_CONFIG.lightEase,
        delta,
      );
      lights.key.color.lerp(lightTarget ? this.amberKey : this.keyBaseColor, 1 - Math.exp(-3.3 * delta));
    }
    if (lights.pool) {
      lights.pool.intensity = damp(
        lights.pool.intensity,
        lightTarget ? this.poolBaseIntensity * IGNITE_CONFIG.keyLight : this.poolBaseIntensity,
        IGNITE_CONFIG.lightEase,
        delta,
      );
    }
    if (lights.atmosphere) {
      // The room's own light rides the same ignition curve as everything else:
      // the atmosphere is part of the WORLD, not a page decoration, so it must
      // warm when the launcher ignites and settle when it does not.
      lights.atmosphere.opacity = damp(
        lights.atmosphere.opacity,
        lightTarget ? ATMOSPHERE_CONFIG.igniteOpacity : ATMOSPHERE_CONFIG.baseOpacity,
        IGNITE_CONFIG.lightEase,
        delta,
      );
    }
    if (lights.fill) {
      lights.fill.intensity = damp(
        lights.fill.intensity,
        lightTarget ? this.fillBaseIntensity * IGNITE_CONFIG.keyLight : this.fillBaseIntensity,
        IGNITE_CONFIG.lightEase,
        delta,
      );
    }

    this.breathPhase += delta;
  }
}
