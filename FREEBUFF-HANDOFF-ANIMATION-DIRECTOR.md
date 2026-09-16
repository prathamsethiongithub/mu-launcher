# 📌 FREEBUFF HANDOFF — Home Character Animation Director (Session 2)

**Timestamp:** 2026-09-11
**Written by:** Buffy (Freebuff / GLM 5.3-flash) for the next Freebuff instance
**Read alongside:** `FREEBUFF-LOOK-HERE.md` (auth + launch-truthfulness sessions) and `PROJECT_STATE.md` (durable state). This file covers ONLY the animation-director session — read the other two for the rest.

---

# 🔴 SESSION 9 ADDENDUM (2026-09-12) — MEASURED CALIBRATION VERDICT: NO VISUAL CHANGES. Read this FIRST.

> Final owner pass: "inspect the ACTUAL rendered launcher at normal + extreme cursor positions; tune only dials the numbers prove need it." Built a read-only probe (`~/mu-verify/anim-calib.mjs`, backup/restore convention, keep-alive, CDP Input.dispatchMouseEvent) that measures rendered rotations, screen-space projection (head center vs arm tip via matrixWorld→NDC→px), luminance p85, and saves 13 screenshots (`shots/calib-*.png`) + `calib-samples.json`. Results — **every criterion already met; zero dials touched**:
> • **Upright**: root pRotX/pRotZ ≡ 0.0000, body child bRotY ≡ 0 across all 15 cursor positions. No hidden tilt.
> • **Gaze symmetry (the perception trap)**: head-LOCAL yaw looks asymmetric (left −0.25 vs right +0.55) but the body holds the −0.38 camera three-quarter base, so WORLD-frame gaze = pRotY + hY: left edge −0.37…−0.41, right +0.35…+0.40, center ≈ 0.01, rest ≈ +0.02. **World-frame tracking is symmetric**; the head-local asymmetry is the base pose showing through — correcting it would BREAK the world-frame perception. Pitch ±0.21 symmetric, saturates gracefully at window edges, returns to rest without snap.
> • **Wave on screen**: hand tip sits 26–37px ABOVE head center (beside/above = "hi"); nearest swing approach is 33px horizontal clearance from head center — no face overlap (the mental flag of −70px at swing max was momentary overlap of the PROJECTION of the tip point, which sits 10px below the true hand, i.e. ≈ mid-forearm; margin is real). Greeting peak −1.4493 (target −1.45), wave settles home (ax −0.0003) after energetic=false.
> • **Readability**: p85 luminance 0.298–0.305 across ALL 16 states incl. full wave (0.2974) — spotlight consistent, character never buried.
> Probe is reusable for future calibration. Gates inherited from Session 8: tsc 0 / build 0 / diag+interact+persist all green (untouched this session — no source files changed).

# 🔴 SESSION 8 ADDENDUM (2026-09-12) — FINAL VISUAL CALIBRATION. Read this SECOND.

> Owner-eyes pass after full automation went green. **Constant dials only — zero architecture changes.** PlayerDirector.ts: `breathLift 0.05→0.035` (breath truly subconscious), `GAZE max 0.44/0.26 → 0.40/0.22` (connected, not possessed), `GREET raiseX −2.0→−1.45` (hand beside head at eye height = "hi", NOT overhead salute nor at-camera punch — the two salutes flanking the range are exactly the gestures the owner rejected) + `swingRate 10→8.5` (one relaxed sweep instead of a brisk flutter), `WAVE raiseX −2.55→−2.35` (high and open without the full straight-overhead silhouette), `swingAmp 0.40→0.36` + `rateRamp 0.25→0.15` (wave reads as waving, never flailing), `ampBreathe 0.08→0.10`. index.css spotlight: peaks `0.20/0.10/0.12 → 0.14/0.07/0.09` with broadened falloffs — ambience the eye never parses as a glow disc. Gaze sign-convention lore documented in updateGazeDemand (camera at +Z, positive head.rotation.y = screen-right). Gates: tsc 0 / build 0 / anim-diag PASS / anim-interact 5/5 (greet peak −0.904 ≥ threshold, bodyYawRange 0.046, wave minAx −2.0-range OK, returns home) / anim-persist 3/3 (p85 0.302, lateSwingStd 0.262 at t≥6.5s).

# 🔴 SESSION 7 ADDENDUM (2026-09-12) — BlurText + character spotlight. Read this SECOND; details below are partially superseded.

> The owner re-ran the full product spec (cursor gaze / idle life / greeting / goodbye / lighting / typography / a11y / perf). Audit verdict: **Parts 1–6, 8, 10–13 were already landed and runtime-verified in Sessions 3–6** (head-only gaze with verified signs, calm no-spin idle, front-raise greeting, launch-duration-driven goodbye with envelope/organic variation, rim light, reduced-motion static, `__skinViewer`/`__skinDirector` intact). Two genuine gaps remained; both closed this session, touching exactly two files (+1 new):
> ① **BlurText** — NEW `src/renderer/components/fx/BlurText.tsx` (motion/react, ALREADY in package.json — no dep added). Words resolve out of ~8px blur with ~80ms stagger, 6px travel, design ease `[0.22,1,0.36,1]`; `animateBy="words"`; `aria-label` on the container + `aria-hidden` word spans (screen readers get one clean string). Wired into the PlayView hero `<h1>` — the h1 stays keyed on the hero string (remount = replay) and keeps the geometry classes, so zero layout shift. `prefers-reduced-motion` renders a plain span in the same position.
> ② **Character spotlight** — `.spotlight-pool` in `src/renderer/index.css`: a `::before` on the PlayView identity wrapper (280px stage box) with three layered radial gradients (back glow 20% amber / rim halo / ground glow), inset −55%/−45% so it reads as a pool around the character, `z-index:-1` behind the canvas, 11s ±1.5% scale breathe (felt, not seen). Pure gradients — no filter, no extra GPU layer. Static composition survives reduced-motion (global CSS kills the breath only).
> Gates: tsc 0 / build 0 / anim-diag PASS (bRotY=0, gaze 0→1, ignition reacts) / anim-interact 5/5 (yawDir, yawSym, pitchDir, bodyStable torso=0, greeting latch, wave home, rapid-clicks finite) / anim-persist 3/3 (p85 0.302 readable, lateSwingStd 0.297 at t≈8.5s, no dim). PlayerDirector.ts and SkinViewerCanvas.tsx untouched this session.

# 🔴 SESSION 3 ADDENDUM (same day) — Interaction rewrite. Read this SECOND; details below are partially superseded.

> **SESSION 5 (2026-09-12) delta — wave persistence + rim light. Read this before Session 4's note.**
> Owner re-specified the goodbye: it must wave for the WHOLE launch state (Igniting/Forging/Launching runs 20s+),
> never a 2.6s one-shot that freezes mid-farewell; and the skin must stay lit like a product shot. Landed:
> ① **Wave is launch-duration-driven** — `waveSwingEnv()` no longer decays on a timer (`duration`/`holdTail` deleted;
> the old late-window swing std was 0.013 = arm frozen raised); tempo ramps over `choreoWindow: 2.6s` then holds a
> steady ~1.25× tempo with a slow ±8% amplitude swell (`ampBreathe`) so a long goodbye never reads as a metronome.
> Release = `energetic`↓ → `wavePose` eases home (λ5). Re-trigger edge now keys off `wavePose < 0.05` (arm home)
> instead of a time window. ② **Rim/separation light** — `SKIN_CONFIG` + a `DirectionalLight` at (−30,40,−55)
> (from behind-left, toward camera), intensity 0.55 → 1.05 during ignite, added to `viewer.scene` in
> SkinViewerCanvas and damped by the director like the other two lights (colors blend toward amber via
> `rimAmberMix: 0.45`). Ground truth: skinview3d ships only AmbientLight(globalLight)+camera PointLight — nothing
> separated the back edge from the dark background. ③ **New harness `mu-verify/anim-persist.mjs`**: probes
> character luminance via the 85th-percentile of the center band (mean is background-dominated; and note
> `preserveDrawingBuffer:false` clears the WebGL buffer at compositing — call `v.render()` synchronously in the
> same task before `drawImage` or you read black). Runtime results: p85 idle 0.302 / wave 0.302 / after 0.305
> (readable, no dim), late-window swing std 0.294 at t≈8.5s (still waving), anim-diag PASS, anim-interact 5/5
> PASS, tsc 0, build 0. Screenshot evidence: `mu-verify/shots/gaze-{center,left,right}.png greet-peak.png
> wave-mid.png` (new `anim-shots.mjs`). Gaze/body/greeting behavior untouched from Session 4.

> **SESSION 4 (2026-09-12) delta:** Session 3's architecture held up under audit against the rig/library ground truth
> (arm pivot at shoulder; `rotation.x −2.55` = hand +0.83 up / +0.56 forward → the front-raise wave is geometrically
> correct). Three fixes landed: greeting now eases through a damped `greetPose` and the goodbye wave PRE-EMPTS it
> (previously `energetic` mid-greeting could push `rightArm.rotation.x` past −π → broken pose); ignition lights are
> dt-damped (`lightEase`), not fixed-per-frame lerp; greeting swing amplitudes raised slightly. The mu-verify
> harness was also made truthful — it now uses `v.canvas` (NOT `querySelector('canvas')`, which collides with
> AuroraBackground), drives the cursor via CDP `Input.dispatchMouseEvent` (synthetic MouseEvent is clobbered by the
> physical cursor), pins focus (`Page.bringToFront` + renderPaused keep-alive), and checks the raise on
> `rotation.x`. All five interact probes PASS runtime; tsc 0 / build 0. Everything below this note remains accurate.

The owner ruled that session 2's perceived-life strategy (amplified continuous body-yaw sway) read as "a cheap character rotating back and forth" and re-specified the product as **interaction**: true cursor→head look-at, one-shot greeting, calm idle, and a real goodbye wave. PlayerDirector.ts was behaviorally REWRITTEN (same file, same single-director-owns-all-pose architecture, same SkinViewerCanvas wiring pattern). The session-2 description below is **historical**; the deltas that matter:

- **Idle is calm now.** `swayIdle 0.28 → 0.04` (±2.3° residual weight shift), `breathFreq 0.52 → 0.42` (natural 6.6s), `breathLift 0.09 → 0.055`, `driftYaw 0.032 → 0.02`. The 30°-sweep "windshield wiper" is gone; the body stays put.
- **Gaze is HEAD-ONLY and event-driven, not sinusoidal.** `setPointer(clientX, clientY)` receives raw window coords from SkinViewerCanvas; the director normalizes against the **canvas's bounding rect** (refreshed on resize/scroll — handles window moves, DPR-invariant because clientX is CSS px). Mapping: `targetYaw = shapeX · MAX_YAW` (26°), `targetPitch = shapeY · MAX_PITCH` (14°), with a 0.06 deadzone and a soft power curve (exp 1.25) so small drifts don't twitch the head. Smoothing is **dt-based exponential** (`alpha = 1 − exp(−rate·dt)`, rate 10 in / 6 out ≈ 100–160 ms response) — frame-rate independent. Cursor leaves the window (`mouseleave` on documentElement) → target eases back to neutral. **body.rotation.y is never touched by gaze** (measured torso delta over a full hard sweep: exactly 0).
- **Greeting** = one-shot arm gesture, fired by `onShown()` (called once from SkinViewerCanvas at first `reveal()`). Timeline: anticipation dip 0.12s → right arm raise to z −2.2/x +0.12 → 3 compact waves (z ±0.18 at 5.2 Hz, `absolute assignment` — see ratchet note) → settle 0.35s → total ~1.4s, then eased back to idle. Latched: fires once per viewer mount.
- **Goodbye/ignite** = `energetic` edge (the existing `launching` prop chain — no new events): 0.15s anticipation crouch → arm raise z −2.35 → wave ramping 4.2→7.5 Hz and amplitude ±0.22→±0.3 over 1.1s with slight posture lift → runs concurrently with the real launch, cleans up on unmount. Faster + bigger than greeting by design.
- **Bone-ownership rule that bit us**: skinview3d's `IdleAnimation` base overwrites `leftArm/rightArm.rotation.z` every frame, so additive (`+=`) wave offsets there ratchet and never return. The director now **owns** `rotation.x`/`rotation.y` on arms absolutely and composes `rotation.z` by absolute assignment after `super.animate()`. Any future arm layer must do the same.
- **Verification (runtime, CDP `mu-verify/anim-interact.mjs`, new)**: gaze direction correct on all 4 axes, torso delta 0, greeting raises+settles with latch, rapid double-clicks stay finite (energetic re-arms), wave returns home exactly. `anim-diag.mjs` still passes (bRotY = 0 in both pose samples — proof the wiper is gone). typecheck 0 / build 0.
- **TEMP DIAGNOSTIC handles kept** (`__skinViewer`/`__skinDirector` in SkinViewerCanvas): the harnesses hard-require them and they cost nothing — documented in-code as DIAGNOSTIC, not TEMP.
- New tuning surface: `GAZE_CONFIG` (maxYaw/maxPitch/response/out/deadzone), `GREETING_CONFIG` (timings/amplitudes), `WAVE_CONFIG` (ramp/freq/amp) at the top of PlayerDirector.ts. Tune there, as before.

---

## Repo map

| Thing | Path |
|---|---|
| **Source repo (git)** | `C:\Users\fortn\Desktop\check this ai agents this desktop folder is for you outside of this are my games\mu-launcher` |
| **Stack** | Electron + React + TypeScript, electron-vite, MCLC (launch), MSMC (MS auth), skinview3d ^3.4.2, three ^0.185.1, Tailwind |
| **Git HEAD** | `b450754` "Pre-canary stable build", branch `master`, remote `origin` = github.com/prathamsethiongithub/mu-launcher. Everything (auth fix, launch truth, animation director) is UNCOMMITTED in the working tree (~27 changed files). Never commit/reset without being asked. |
| **Runtime data** | `C:\Users\fortn\AppData\Roaming\mu-master-launcher` — NOT source, never wipe |
| **⚠️ Not this repo** | The other desktop repo `prathunder-client` (Mio crack project) is a DIFFERENT project. Don't confuse them. |

## Product context (why this feature exists)

Master Launcher is stabilizing toward "a premium desktop launcher that happens to contain Minecraft". The home-screen Minecraft player is part of the launcher identity, not decoration. The owner's spec (long, given verbatim in chat; not stored as a file) defined a **Home Character Animation Director**: layered animation system for the existing skinview3d player with a strict quality bar — subtle, deliberate, interruptible, never robotic/ADHD. Target reaction: *"Holy shit, he's alive."* Key spec rules: inspect before coding, repo is source of truth, no new dependencies, don't rewrite SkinViewerCanvas from scratch, use existing events (no new IPC), don't slow real launching, stop after implementation (no doc/spec files).

## What was built this session

Two files touched — nothing else:

1. **`src/renderer/components/fx/PlayerDirector.ts`** (NEW, ~260 lines) — the animation brain.
   `PlayerDirector extends IdleAnimation`. ONE instance owns ALL pose state for the whole viewer lifetime, so no two providers ever fight over bones and `viewer.animation` is never swapped.

   Layered behavior, all eased, never snapped:
   - **Idle**: breathing body-bob (`body.position.y` sine ±0.05 around the stock −6), ±8° yaw sway around `yawBase −0.38` (three-quarter product angle), body weight-roll, two-frequency head micro-drift.
   - **Gaze (pointer)**: window-level mousemove → head yaw/pitch (≤9°/≤6°) + 25% torso follow. Dead zone 0.12 normalized + soft power curve (exp 1.35). Attention strength eases in/out; decays after 1.6s of pointer stillness. Screen-sign convention (see below).
   - **Glance (personality)**: bounded-random look-aways every 8–20s, hold 0.5–1.5s, suppressed while gaze is live.
   - **Ignition**: `energetic` property flip (driven by the existing `launching` prop chain) = play-press signal. On each false→true edge: 350ms chin-down "ack" beat, posture straighten (`body.position.y` +0.32, chest-up pitch), idle tempo ×2.6, sway widens, amber light ramp (see config). On false: EVERYTHING eases back — launch failure/cancel automatically returns to idle because PlayView just drops `launching` (spec §25 solved for free, no new events).
   - **Lights**: constructor captures base intensity/color of `viewer.globalLight` + `viewer.cameraLight`; ignition lerps intensity (2.0→2.3 global, 0.8→1.0 camera... actual targets in `IGNITE_CONFIG`) and blends color toward `#e6a55c` at 35%/20% mix FROM the base color (never full amber repaint).

   All tuning constants grouped at top: `IDLE_CONFIG`, `GAZE_CONFIG`, `GLANCE_CONFIG`, `IGNITE_CONFIG`. Tune there.

2. **`src/renderer/components/fx/SkinViewerCanvas.tsx`** (MODIFIED) — rewired to use the director:
   - Director created once in the viewer-init effect; skin-load effect no longer creates/replaces animation instances (old `PlayerIdle` class deleted).
   - Window-level `mousemove` + `document.documentElement.mouseleave` feed `setGaze()`. Attached only when a director exists (reduced-motion ⇒ none), removed on unmount. The canvas itself is `pointer-events-none` — tracking MUST be window-level.
   - Focus/visibility: `viewer.renderPaused = document.hidden || !document.hasFocus()` on visibilitychange/blur/focus. Reduced-motion: static product shot with `renderPaused = true` (no RAF loop at all).
   - Skin tri-state lifecycle PRESERVED UNTOUCHED: `undefined` = resolving (render nothing, never Steve-flash), `null` = confirmed no skin (bundled Steve data URL), string = custom skin w/ display-only Steve fallback. Canvas stays mounted always (previous blank-canvas bug documented in file comments).

## 🔑 skinview3d 3.4.2 internals cheat sheet (verified from node_modules — saves you the dig)

- `PlayerObject` (`libs/model.js`): `skin.head/body/leftArm/rightArm/leftLeg/rightLeg` are directly rotatable `Group`s. Stock pivots: `body.position.y = −6`, `head.position.y = 0`, legs at −6/−12. `resetJoints()` restores all stock poses.
- `IdleAnimation.animate()` only writes **arms (rotation.z cosine swing) + cape** — safe to layer head/body/rotation.y writes after calling `super.animate(player)`.
- `PlayerAnimation.update(player, deltaTime)` is called by the viewer's draw loop; `this.progress += delta` happens AFTER `animate()`. Setting `this.progress` inside `animate()` before `super.animate()` is the pattern the old code used to control tempo. The director instead keeps its own clamped clock (`delta = min(0.1, dt)`) — survives pauses without lurching.
- **`viewer.animation` SETTER SNAPS**: calls `resetJoints()` + zeroes player position/rotation whenever the instance CHANGES (same instance re-assign = no-op). This is why the director must be created once per viewer and reused across `loadSkin` calls.
- `viewer.renderPaused` (getter/setter) stops the RAF loop; the loop re-arms itself when set back to false (also skips if `disposed`).
- `viewer.globalLight` is an `AmbientLight`, `viewer.cameraLight` a `PointLight` — both mutable intensity/color at runtime.
- `viewer.loadSkin(source, {model})` swaps the texture on the shared skinCanvas — does NOT touch animation/joints (verified: it only redraws the canvas + infers model). Safe to call while director runs.
- **Sign conventions (verified)**: default camera sits at `+Z`. Positive Y-rotation turns the face toward SCREEN-RIGHT; positive X-rotation tips the face DOWN. Window coords: nx = (clientX/innerWidth)*2−1 (right⇒+), ny likewise (down⇒+). So gaze yaw/pitch use POSITIVE multipliers of the shaped input — there was a stray minus sign bug caught and fixed.
- Default `SkinViewer` constructor sets no animation (null) — nothing runs unless you assign one.

## Integration facts (renderer wiring, as-built)

- `PlayView.tsx` renders `<PlayerIdentity energetic={launching} />` — `launching` is App-lifted launch state (survives navigation). This is the ONLY launch-state signal the animation uses.
- `PlayerIdentity.tsx` (unmodified) fetches skin via `window.electronAPI.getSkin()` → tri-state prop into SkinViewerCanvas.
- PlayerIdentity only mounts inside PlayView's logged-in branch ⇒ navigating away unmounts viewer+director entirely; returning mounts fresh. Account switches in the current UI also remount (IdentityView lives elsewhere; PlayView re-renders identity after auth-changed). So §27/28 (dispose-on-unmount, account-switch reset) are satisfied by component lifecycle — no manual reset needed today. If the home character ever becomes persistent across views, THIS changes and the director will need explicit identity-change resets.
- No new IPC/events were needed (spec §47–48 satisfied). The ack beat is derived from the energetic edge inside the director.

## Verification status

- ✅ `npm run typecheck` → 0 errors (one fix: `sway: number` annotation — `as const` config object made the field's inferred type the literal `0.14`)
- ✅ `npm run build` (electron-vite) → clean

## Session 6 addendum (2026-09-12) — tilt audit + wave organic variation

- **"Character looks tilted" → investigated, not assumed.** Every transform writer enumerated (root/playerWrapper/camera/body/head/arms/CSS chain) and MEASURED at runtime by the new `mu-verify/anim-tilt.mjs` across idle/gaze-left/gaze-right/wave-early/wave-hold/released. Results: root `rotation.x/z` ≡ 0 in every state; max `body.rotation.z` 0.0076 rad (0.44°); no CSS rotation on the canvas ancestor chain. **There is no tilt bug — the perceived slant is the deliberate three-quarter product-shot yaw (−0.30 rad).** Geometry guarantee: the camera is unpitched, so Y-rotations alone cannot project a screen-space roll. If the owner dislikes the lean look, the dial is `IDLE_CONFIG.yawBase`, nothing else.
- **Wave organic variation (§16)**: added `rateWobble` (±7% tempo drift, ~10s period, phase-offset from the existing ±8% `ampBreathe` amplitude swell) so the sustained wave never reads metronomic; modulation lives on slow parameters, never on joints.
- **Probe hardening lore**: an unfocused CDP-driven window suspends RAF → bones hold a stale pose and every reading lies (identical samples to 4 decimals = the tell). anim-tilt stays live via a real `Input.dispatchMouseEvent` heartbeat parked at canvas center (deadzone-neutral) + one in-page async eval per state + a director-scalar time-series (`energetic/wavePose/greetPose/sameInstance`) to attribute anomalies precisely. `clearInterval` of a `const` declared inside `try` is not visible to `finally` (hoist it).
- Gates: tsc 0 / build 0 / anim-diag PASS / anim-interact 5/5 / anim-persist 3/3 (lateSwingStd 0.30 at 8.5s). Shots refreshed: `shots/tilt-{idle,gaze-left,wave-early,wave-hold,released}.png` + `gaze-*.png`, `greet-peak`, `wave-mid`.

## Session 3 addendum (historical) — runtime verification checklist

- ⚠️ **RUNTIME NOT TESTED** — visual behavior needs the user's eyes. Test checklist from the spec (condensed):
  - A: offline account `verifybot` → Steve visible on Play
  - B: idle open → subtle motion, not frozen, not hyper
  - C: move pointer → subtle head response; move away → smooth return
  - D: Play→Account→Play, →Worlds→Play, →Settings→Play → no dupes/leaks/frozen model
  - E: account switch → correct skin + state, no stale
  - F: press Play → ack beat + amber ramp + animation participates; launch proceeds
  - G: failure (if safely reproducible) → player returns to neutral, no frozen pose
  - H: restart → clean init
- Dev run: `npm run dev`. There is a CDP test harness tradition in `~/mu-verify/` (outside repo) from previous sessions — could be extended to drive pointer/launch flows headlessly.

## Known limitations / deferred (deliberate, per spec V1 scope §45)

- No wave, no hover-reactions on UI controls, no navigation-direction reactions (architecture allows adding later — it's just more cases in the head-target selection).
- No camera parallax (spec §41: character moves, not camera).
- `body.rotation.y` follows head at 25% share; at extreme glance yaw (±0.2 rad) the pivot is at the body center so feet pivot slightly — judged subtle enough; check at runtime.
- Reduced-motion = fully static (not a "reduced" tier). Spec allows full/reduced/off later; constants are already grouped to make intensity tiers trivial.

## Session 10B — animation chain PROVEN (three-dedupe + dispose bridge + harness fix)

Scope was locked to animation verification only (no lighting values, no choreography). What the frozen-samples mystery actually was:

1. **Two three.js copies.** `skinview3d@3.4.2` declares `three: ^0.156.0` as a hard dependency, so npm nested its own `three@0.156.1` while the app shipped `three@0.185.1`. Session 10's rig created the first-ever r185 materials (MeshStandardMaterial floor) and fed them into skinview3d's **r156** renderer → the very first `draw()` frame threw `TypeError: material.onBuild is not a function` (r156 calls `material.onBuild` during program build; r185 removed it) inside `viewer.render()`. `draw()` reschedules RAF at its END, so the throw killed the chain leaving `animationID` stale-non-null — and the keepAlive's `renderPaused=false` was a mathematical no-op (the resume branch requires `animationID == null`). **Fix: `electron.vite.config.ts` vite aliases `three` + `three/examples/jsm/*` → root r185. One REVISION in the bundle, 2.9 MB → 2.17 MB.** skinview3d dist uses no r156-only legacy APIs, verified before unifying.
2. **Unmasked by the dedupe: r185 renamed `ShaderPass.fsQuad` → `_fsQuad` (private).** skinview3d's `dispose()` ends with `this.fxaaPass.fsQuad.dispose()` → `undefined.dispose()` on EVERY unmount → React commit crash → blank app. **Fix: `SkinViewerCanvas.tsx` cleanup defines a `fsQuad` getter bridging to `_fsQuad` before `viewer.dispose()`.** This was a latent landmine for any future three upgrade, not caused by the rig.
3. **Windows occlusion throttling.** With any window on top of Electron, Chromium suspends frame production — RAF never fires (evidence: `pageRaf: 0` over 2s while handles were alive). `Page.bringToFront` does not lift this. **Fix (harness-only, `~/mu-verify/common.mjs`): launch flags `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion`.**

Runtime evidence (all on the real built app, `~/mu-verify/animation-truth.mjs` + the authoritative probes):
- **Chain proven per-link**: RAF alive (121 frames/2s) → `draw()` 121 runs, reschedules (id 868→1231) → `animation.update` 121 → `director.animate` 121 → pose changes (breathing) → `viewer.render` 121. Zero page errors, zero draw errors, zero rejections.
- **Manual isolation**: `director.animate()` and `animation.update()` call clean, no throws. Forced revive after clearing stale handle works.
- **anim-interact: 5/5 PASS** (gaze dir/sym/pitch, body stable, greeting, wave, rapid-clicks finite).
- **anim-persist: wavePersists PASS** (lateSwingStd 0.264, raisedLate at 8s+). **`lightOK` FAILS**: p85 0.126 vs the 0.25 readability gate — this gate was calibrated on the OLD flat-ambient look (calib p85 ≈ 0.30). Session 10 deliberately darkened the scene for directional staging; the character reads well in screenshots but the p85 threshold needs re-derivation or the rig needs intensity tuning. **That is Session 11's first task — it is a VISUAL TUNING item, intentionally untouched this session per scope lock.**

Files changed this session (production: exactly 2): `electron.vite.config.ts` (three dedupe aliases), `src/renderer/components/fx/SkinViewerCanvas.tsx` (fsQuad dispose bridge + comment). Harness: `common.mjs` (frame flags), new `animation-truth.mjs` (kept as the canonical chain probe).

## Guardrails for the next session

- Don't merge AuthService + IdentityService (by design — see FREEBUFF-LOOK-HERE.md).
- Scope lock still stands: no installers/CI/Modrinth/Worlds/UI redesign/auth refactor. Stabilization only.
- Don't `git reset --hard` / clean / commit unless the owner asks. Suggested commit split from PROJECT_STATE: auth fix / launch truthfulness / release config / animation director as separate commits.
- If you touch the animation: the ONLY sanctioned way to reset pose is ease-toward-target (the director's own easing); never `resetJoints()` mid-session, never swap `viewer.animation` for a new instance.
- PROJECT_STATE.md open items (launch-ux owner rulings, release blockers) are still open — they belong to other sessions, don't start them unprompted.
