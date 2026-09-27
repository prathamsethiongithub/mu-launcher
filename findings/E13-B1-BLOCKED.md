# E13-B1 — BLOCKED

**Experiment:** the text-path dose test — is the String-form text path's per-line
ICU bidirectional reordering (`FormattedBidiReorder.reorder` /
`ClientLanguage.getVisualOrder`) measurable enough to justify a cache?

**Verdict: BLOCKED. No data was collected. No thresholds were invented.**

---

## Why it cannot run here

The experiment spec is defined by §6 of `docs/EMBER-RND-PACKAGE.md`. That document
**does not exist in this repository**, and neither does anything that could stand in
for it:

| Required | Search | Result |
| --- | --- | --- |
| `docs/EMBER-RND-PACKAGE.md` | `glob docs/**`, `Test-Path docs\EMBER-RND-PACKAGE.md` → `False` | **MISSING** |
| the §6 experiment spec | grep `EMBER-RND`, `RND-PACKAGE`, `E13` (substring and word-bounded) across the whole repo | **0 matches** |
| the pre-registered PASS bar | grep `FormattedBidiReorder`, `getVisualOrder`, `jfrProfile`, `ObjectAllocationSample` | **0 matches** |
| an output directory | `**/findings/**` | **did not exist** (created by this report) |

Without §6 there is **no pre-registered PASS/KILL bar to state before data
collection** — and the experiment's whole discipline is that the bar is fixed before
the measurement. Inventing one after the fact would violate the mission's iron rule
(measure before concluding) and produce a number nobody agreed to in advance.

The measurement itself also needs infrastructure that is not in this repo:

- a **vanilla Minecraft 26.3 client** (an external runtime, not vendored here), and
- a JFR profile run via `--jfrProfile`, plus a harness to drive two arms
  (F3 overlay with ~30–40 debug lines; tab list with 20+ player entries) × 3
  repetitions and read `hot-methods` samples back.

## Sub-agent option (mission step 7) — unavailable

The mission's step 7 offers "use one sub-agent to set up the benchmark world while
another prepares the JFR configuration". Neither can be dispatched usefully here:

- `claude` is installed (v2.1.179) but cannot authenticate —
  `401 OAuth access token has expired`.
- `opencode` is installed (1.17.16) and **does** run read-only recon, but it is a
  general coding agent with no Minecraft runtime or JFR tooling behind it — it
  cannot produce instrument data, only more missing-document confirmation.

Parallelising the *setup* was never the blocker. The blocker is the missing spec and
the missing external client.

---

## What is needed to unblock

1. Land `docs/EMBER-RND-PACKAGE.md`, or at minimum §6: the two arms, the JFR
   configuration, and the **pre-registered** PASS/KILL threshold (the prompt cites
   a "≥5% of hot-method samples" bar — that number must be confirmed from the source
   document, not taken on trust).
2. A vanilla **Minecraft 26.3** client available to this environment, with JFR
   profiling enabled.
3. Then: run both arms ×3, record raw `hot-methods` and `ObjectAllocationSample`
   data, and only then decide PASS / KILL / INCONCLUSIVE.

Until (1) and (2) exist, the honest status is BLOCKED. A null result here would be
a perfectly good result — but it has to be a *measured* null, and there was nothing
to measure with.
