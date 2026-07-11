# EMBER — Master Launcher Design System

> One flame in a dark room.
> The launcher is a quiet, warm, near-black stage. Exactly one thing burns on it at a time.

References carried in, translated: **Nothing OS** (monochrome + a single signal color that only ever means one thing) · **Apple launch pages** (one hero moment per screen; type carries the state) · **Linear** (hairlines, not boxes; small type done perfectly) · **Arc** (personality in tiny memory moments) · **Stripe** (state polish, surgical gradients).

---

## 1 · Laws (non-negotiable)

1. **One flame per screen.** Exactly one ember-colored *UI element* may exist at a time: the Play pill (idle) → the progress filament (launching) → the live dot (running) → the Retry pill (error). If two interactive things are amber, one of them is wrong. (The atmosphere layer — §8 — sits beneath the UI plane and is governed separately.)
2. **Type is the hierarchy.** Every view has one display word that carries the state ("Ready." / "Forging." / "In the world."). Everything else drops to ≤13px.
3. **No boxes for information.** Hairlines organize; surfaces are reserved for *interactive* layers (panels, the nav rail). Data lives as quiet rows, never cards.
4. **All numbers are mono, tabular.** Versions, IPs, counts, RAM — `Cascadia Mono / Consolas`.
5. **Micro-labels are 11px uppercase, 0.18em tracking, dim.** They whisper.
6. **Honest data only.** No hardcoded player counts, no fake paths, no controls that don't control anything. If we don't know, show `—`.
7. **Motion is grammar, not garnish.** Three durations (120 / 300 / 600ms), one easing family. Ambient light is limited to the hearth (the room) and the world-beacon (the world, §8). `prefers-reduced-motion` silences everything.
8. **The OS's own voice.** System font stack (Segoe UI Variable). No remote font imports — the launcher must look identical offline.

## 2 · Tokens

| Token | Value | Use |
|---|---|---|
| `--ground` | `#0B0A09` | App background (warm near-black) |
| `--elevated` | `#151210` | Interactive surfaces (panel, rail) |
| `--ink` | `#F4F1EA` | Primary text (warm white) |
| `--dim` | `#9C958A` | Secondary text, labels |
| `--faint` | `#5C564E` | Decorative micro-text, pending states |
| `--line` | `rgba(244,241,234,0.07)` | Hairlines |
| `--line-strong` | `rgba(244,241,234,0.14)` | Hover hairlines, focus edges |
| `--ember` | `#FFB224` | THE signal. Primary action / live progress only |
| `--ember-deep` | `#E38330` | Gradient partner, never alone |
| `--ok` | `#3ECF8E` | Success semantics (quiet) |
| `--danger` | `#FF5D55` | Error semantics |

Radii: `10px` controls · `18px` surfaces · `999px` pills. Spacing on a 4px grid; generous by default (the stage needs air).

## 3 · Type scale

| Role | Spec |
|---|---|
| Hero | Segoe UI Variable Display · 68–76px · 750 · tracking −0.045em · `text-wrap: balance` |
| Sub | 14px · 400 · `--dim` · max 46ch |
| Body | 13px · 400 |
| Micro-label | 11px · 600 · UPPERCASE · 0.18em · `--dim` |
| Data | Mono 11–12px · tabular-nums · `--dim`/`--faint` |
| Row title | 15px · 600 · tracking −0.01em · `--ink` active / `--dim` rest |
| Chip | 10px · 600 · UPPERCASE · 0.14em · semantic color at ≤70% — never ember |
| Dialog title | Display · 24px · 700 · tracking −0.03em |
| Row meta | Mono 10px · tabular-nums · `--faint` · ≤4 facts, ·-separated |

## 4 · Motion grammar

- **Easing:** `--ease-exit: cubic-bezier(0.22,1,0.36,1)` for everything; springy hover is reserved for the Play pill alone.
- **Durations:** 120ms micro (hover) · 300ms state (fill, swap) · 600ms scene (view enter).
- **Scene enter:** `.rise` — fade + 6px lift, staggered `d1–d4` (60ms steps).
- **Ambient (the only loop):** the hearth — a bottom ember radial breathing over 9s.
- Reduced motion: all animation off, hearth static.

## 5 · Composition per view

**Play (the stage).** Top bar: wordmark left, `v{version}` mono right, hairline below. Center hero stack: micro-eyebrow (server identity, mono) → display word (state) → sub-line → the flame (pill / filament / live dot). Bottom: hairline-topped metadata rail — `MC 26.1.2 · FABRIC 0.19.3 · 4 GB · mastersunion.minekeep.gg` in mono. Background: ground + hearth. Nothing else glows.

**Launching.** The pill yields to the **filament**: a 320px hairline track filling with the ember gradient, glowing head, current stage as the hero word, stage names as a quiet mono row beneath. The screen *is* the progress.

**Account / Settings.** Same grammar, no flame unless there's a primary action (Sign in / Retry earns the ember). Settings is honest: managed values as read-only hairline rows ("Managed automatically") — no fake sliders, no Forge.

**Nav.** A Linear-style segmented pill rail, bottom center: three text+icon tabs on an elevated surface. Active = ink on `white/6`. Never amber. The Arc-style memory: a 3px ember dot beside "Play" once you've launched before.

## 6 · The atmosphere layer — the world-beacon (§8)

**Problem it solves:** the user should feel *"the world is waiting for me,"* not *"this is a software product."*

**What it is:** a slowly turning column of ember light (`fx/WorldBeacon.tsx` wrapping the vendor `fx/LightPillar.jsx`, React Bits + three.js) rising from below the horizon behind the Play pill — the SMP's presence, seen from the room.

**Why it's presence and not clutter:** it *reacts* instead of decorates. One state machine, five moods:

| Launcher state | World mood | intensity / rotation |
|---|---|---|
| Signed out | **distant** — barely there | 0.35 / 0.10 |
| Ready | **waiting** — present, patient | 0.60 / 0.16 |
| Launching | **igniting** — brightens, quickens | 0.95 / 0.38 |
| Running | **alive** — calm steady burn | 0.70 / 0.20 |
| Error | **receding** — the world pulls back | 0.22 / 0.06 |

**Its laws:** wears only the heat gradient (`--ember` → `--ember-deep`; never a third hue) · `mix-blend-mode: screen` over the ground · edge-masked so it melts into the room (no canvas edges) · `pointer-events: none`, never interactive · quality capped at `medium` (it's ambience, not a demo) · Play view only — Account/Settings stay pure · `prefers-reduced-motion` removes it entirely (the static hearth remains) · WebGL-unsupported machines silently fall back to the hearth.

**Layering:** ground → hearth → world-beacon → hairline chrome → hero type → the flame. The beacon must never make body text harder to read; if it does, lower `opacity` (0.9) or `intensity` before touching anything else.

**The identity object (`fx/PlayerIdentity.tsx`).** The signed-in player's own skin (skinview3d), staged in the beacon's column like an Apple product shot: long lens (fov 28), three-quarter pose, warm low fill, **ember rim lights from behind** (`#FFB224` key, `#E38330` fill — the beacon is the light source, narratively). Motion: skinview3d's idle sway plus a breathing ±8° yaw; quickens while launching. Its laws: appears only when signed in · decorative and non-interactive (`pointer-events: none`) · skin resolved in the **main process** (Mojang session server → 24h disk cache; Crafatar fallback) — the renderer never fetches · fails silently (no skin → the stage stays as it was) · reduced-motion → static pose. This object *is* the launcher's visual identity: the user, already standing in the world.

## 7 · Component inventory

`Layout` (top bar + stage) · `PlayView` (hero composition) · `ForgeLine` (the filament) · `DockNav` (segmented rail) · `AuthView` · `SettingsView` · `fx/WorldBeacon` (state-reactive atmosphere; wraps vendor `fx/LightPillar.jsx`) · CSS primitives: `.pill-ember`, `.surface`, `.glass` (floating translucent rail — light passes through), `.hairline(-t)`, `.microlabel`, `.rise`, `.hearth`, `.filament-*`.

Deprecated (unused, kept on disk pending cleanup): `TelemetryPanel.tsx`, `ui/dock.tsx` (magnifying dock), `.glass-card` (aliased to surface for stragglers).

## 8 · Don'ts

- Don't add a second glow, orb, aurora, or particle system. The hearth + world-beacon ARE the atmosphere — the budget is spent.
- Don't put amber on nav, labels, borders, or icons.
- Don't box data. Don't center paragraphs of UI text.
- Don't import fonts from the network.
- Don't show data we don't have.
