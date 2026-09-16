# 18 — PRODUCT INVARIANTS

Current status of each product-level invariant, with evidence. **Documented, not enforced or fixed.**

## AUTH / IDENTITY

**Invariant:** an account that has been removed must remain removed after restart and must not be resurrected through a legacy fallback session.

**Status: ENFORCED IN CURRENT SOURCE (remove path).**
- Clear-and-verify ordering in `remove-account` (index.ts L655–691): legacy session cleared first, file-existence verified, removal aborted if the file survives.
- `identity-sign-out` applies the same UUID match (L765–780).
- Resolution only falls back to legacy when the legacy session genuinely exists (L179–188) — so a *successfully cleared* legacy file cannot resurrect anyone.
- **Boundary:** the guard protects *removal*. Any new code path that writes `auth-session.bin` without the UUID convergence (R-05) would re-open the class. Token-file unreadable → tokens dropped (accounts stay, signed out) — no resurrection path found.

## PLAY

**Invariant:** the UI should represent actual launch state, not merely optimistic intent.

**Status: PARTIALLY MET.**
- Real: "Running" from `isRunning()`; errors from typed backend failures; progress from real `launch-step` events; mirror survives navigation (REPORT-001 fix).
- Optimistic residual: `launching` mirror precedes E604/E605 reply; launcher restart loses the story (only the running bit reconciles, App.tsx L105); `cancel-launch` exists but is not surfaced; post-launch exit has no return-to-idle flow.

## PROGRESS

**Invariant:** displayed progress should ultimately trace to real backend events.

**Status: MET (with documented gaps).**
- Every rendered step/percent traces to `launch-step`/`java-progress` events (08-IGNITION flow map). No fabricated percentages found in the renderer (`CONFIRMED`).
- Gaps are presentational (no global aggregation, step-level only), not truth violations.

## CHARACTER

**Invariant:** the established amber identity must remain amber.

**Status: RESTORED IN SOURCE, OWNER-ARBITRATED.**
- Palette of record (`SKIN_CONFIG`/`STAGE_LIGHT_CONFIG`, post-001-amber-restored): ambient-carried warm-neutral illumination, subordinate brand-amber key (mathematically capped ≈0.18 effective vs ambient 2.0), ignition never amplifies the key (`keyLight: 1.0` with explicit anti-regression comment).
- The rejected regime (dominant `#ffca8a` key, crushed ambient) is documented in the lab ledger (`mu-visual-history/INDEX.md`) so it cannot be reintroduced innocently.
- Final arbiter remains the owner's eye against lab screenshots (invariant #4 of the lab); numeric guards are stale-calibrated (R-09).

**Invariant:** gaze must remain intentional; body must not become cheap cursor-driven swaying; greeting/goodbye deliberate; animation lifecycle distinguishable from harness lifecycle.

**Status: ENFORCED IN CURRENT SOURCE.**
- Head-only gaze with neck clamp + planted body (PlayerDirector L758–772, design comments in code).
- One-shot greeting/goodbye timelines (WAVE_CONFIG, `settleEnd` beat).
- Harnesses drive via CDP, never patch app code (15-VERIFICATION) — app/harness lifecycles are separate by construction.

## UX (visibility of system status; match with real world; user control)

**Status: MIXED.**
- Visibility: progress events real; BUT no cancel affordance (user control gap), no post-launch exit handling, restart loses the narrative (08-IGNITION gaps table).
- Match: typed, human-readable `[Exxx]` error copy throughout (`CONFIRMED`).
- User control: remove-world/delete-backup use two-step confirms (REPORT-008 language); remove-account aborts safely rather than half-completing (06-AUTH).

## The one meta-invariant of this audit

Production code was not modified by the audit; the only writes were `docs/project-truth/**` (verified in 01-ARCHITECTURE §0 rerun and the final git check in the executive report).
