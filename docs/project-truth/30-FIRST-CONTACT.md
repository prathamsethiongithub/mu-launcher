# 30 — First-Contact Pack

**Mission:** kill the #1 quit moment found by the consumer-journey hunt
([28-CONSUMER-JOURNEY-HUNT.md](./28-CONSUMER-JOURNEY-HUNT.md)).

**Status:** shipped to `red-team` (deliverables 1 + 2 in code + tests; deliverable 3
as a doc). Not yet merged to `master`.

---

## The quit moment

A first-time user opens Ember, sees **"Ready."** — the launcher's word for *it
worked* — and clicks Play. Then nothing, for **158–194 seconds** (measured cold
start, truth doc 28). On a low-end machine that runs past **eight minutes**.

"Ready." is true. It is not the whole truth. The gap between the two is where trust
dies: the user cannot tell a slow legitimate download from a frozen app, so they
kill it, decide it's broken, and never come back.

Two changes close the gap. Both are deliberately **one line / one check** — the
restraint is the design.

---

## Deliverable 1 — first-boot expectation copy

**File:** `src/shared/first-boot.ts` (pure) · rendered in
`src/renderer/components/PlayView.tsx`.

**The line:**

> first time takes a few minutes. it's worth it.

Shown under the play button on a world that has **never been launched**. After the
first successful launch it disappears forever.

**Why one line and nothing else.** A progress bar would be a lie — the launcher
does not know how long the download will take on this connection. A percentage, a
spinner, a "this may take a while" banner: all of them draw attention to the wait
and make it feel longer. What the user needs is the *fact stated once*, so silence
reads as expected instead of broken. It is static, lowercase, and un-animated.

**The signal already existed.** `World.lastPlayedAt` is `null` until the game has
actually exited once (`world-manager.ts:109` sets it on `stopped.done`). No new
field, no new IPC channel, no migration, no extra state to keep in sync.

**Predicate** (`isFirstBoot`): true when `lastPlayedAt` is `null` **or the field is
missing** — a hand-written or legacy registry entry with no launch history is
exactly the entry whose user has never seen the wait. An explicit `0` is a value
(the epoch), so it reads as "has launched", not as "unknown".

**Visibility gate:** `isLoggedIn && !launching && !isRunning && !launchError &&
isFirstBoot(activeWorld)`. It never competes with the launch UI, the error state,
or the running state — it is context for the moment of decision, not a feature.

**Not restricted to managed worlds.** A personal world's first launch downloads the
same client and assets and takes the same minutes. The honest predicate is "this
world has never been launched", which is exactly what the state says.

---

## Deliverable 2 — hardware-aware RAM guard

**File:** `src/main/ram-guard.ts` (pure) · wired in `src/main/index.ts` (launch-game
handler).

**The rule, stated before the code:**

| Condition | Action |
| --- | --- |
| `totalmem() < 6 GB` **and** allocation is still the default (4096 MB) | adjust to **2048 MB**, persist it, notice once |
| anything else | do nothing (`null`) |

**The notice:** `adjusted memory for your machine.` — one line, lowercase, quiet.
Not an alarm, not an error, not a modal.

**Why this guard cannot annoy or overrule anyone.** Two clauses carry the whole
design:

1. **"still on the default"** makes it *one-time*. The moment 2048 is persisted, the
   condition can never hold again — the notification cannot nag on the second launch.
2. **The guard only moves a value the user never chose.** A user who deliberately
   set 8 GB is never overruled; the adjustment only ever applies to the untouched
   default.

**`freemem()` is read but deliberately NON-DECISIVE.** Free memory at boot is noise —
it swings with every other process on the box. Total installed RAM is the stable
fact. A unit test pins that free memory cannot change the verdict in either
direction. The read is kept because the brief asks for it and the truth doc records
it; the *decision* ignores it.

**Unmeasurable hardware is never guessed at.** `NaN`, `0`, or a negative total
returns `null` — the guard does not act on a read it does not trust.

---

## Deliverable 3 — Discord launch message

**File:** [docs/discord-launch-message.md](../discord-launch-message.md).

The actual message to the first 10 friends. It states the SmartScreen warning and
the unsigned status *before* the user hits them (explaining it is what keeps it from
reading as sketchy), sets the same first-run expectation as the app, and ends with
the specific, low-stakes ask: **"tell me what breaks. that's the point of this."**

---

## What was deliberately NOT built

- No progress bar or ETA — the launcher genuinely cannot know.
- No "optimizing…" style filler copy — it would be a lie.
- No settings toggle for the RAM guard — a guard you have to opt into does not help
  the user who most needs it.
- No new IPC channel, no new persisted field, no new dependency. The pack reuses
  existing world state and the existing `updateWorldSettings` channel.

If any of these wanted to grow into a feature, the instruction was to stop and
report. None did.

---

## Verification

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | clean (main + preload + renderer) |
| `npm test` (unit) | 374 passed / 25 files — baseline 355 grew by 19, nothing regressed |
| `npx playwright test tests/e2e/first-boot-note.spec.ts` | **3/3 pass** — appears on a fresh world, absent with launch history, survives a restart |

**Unit coverage** (`tests/first-contact.test.ts`, 19 tests) pins: the 6 GB
threshold (inclusive), the one-time property (fire → persist → never again), the
"respect the user's choice" clause, unmeasurable-input refusal, `freemem`
non-decisiveness, injectable thresholds, and the exact copy of both strings.

**E2E coverage** (`tests/e2e/first-boot-note.spec.ts`) drives the real on-disk
registry the production app parses — it never touches a production file, and no
Minecraft client is required: the "after first launch" state is the same
`lastPlayedAt` transition `world-manager.ts` performs on game exit.

---

## Iron rules — respected

- `src/renderer/components/fx/` **untouched**.
- **Design system untouched** — no new tokens, classes, or components; the note
  reuses the existing `text-[12px] text-faint` treatment already used for quiet
  context.
- **Existing IPC channels unchanged** — `launch-game` gained an optional `notice`
  field on its existing return; no channel added or renamed.
- **No new dependencies.**
- **Copy is lowercase and honest** — both new strings pass the voice test against
  "Ready." / "couldn't reach mojang. nothing changed."
