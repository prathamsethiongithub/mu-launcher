# REPORT-008 — Product-Design Audit (Play · Worlds · Account · Setup)

**Date:** 2026-07-11 · **Lens:** Apple HIG, Linear, Arc, Raycast · **Rule:** remove, never add
**Status:** 14 changes shipped · 3 proposals deliberately not shipped · gates green

The audit's yardstick was EMBER's own written laws (DESIGN.md): one flame per
screen · type carries state · no amber on nav/labels/icons · honest data only
· micro-labels 11px. Most findings were places where the implementation had
drifted from its own constitution.

## Shipped (all subtractions or demotions)

| # | View | Change |
|---|---|---|
| 1 | Dock | Removed the permanent ember dot on Play ("has launched before") — a non-actionable signal in the launcher's one reserved color, violating "no amber on nav" |
| 2 | Chrome | Removed dead props (`currentView`/`onNavigate`/`hasLaunchedBefore`) from Layout, `hasLaunchedBefore` from DockNav, and the entire ember-count plumbing from App |
| 3 | Play | Rail reduced 4 → 3 facts: dropped "4 GB" (machine tuning, now lives only in Setup). Rail reads what · on-what · where |
| 4 | Play | Single-world eyebrow now names the place (world name), not the server address the rail already shows — never the same fact twice on one stage |
| 5 | Worlds | Health "Warning" recolored ember → dim. Ember means "primary action", never caution — a second meaning dilutes the launcher's one signal |
| 6 | Worlds + Account | Active-row icons no longer ember-stroked. Selection = the ember rail alone (was 4 concurrent signals: rail + icon + name + chip) |
| 7 | All shelves | Chip spec unified: 10px/600/UPPERCASE/0.14em (was 8px, 9px, 10px variants); Managed/Microsoft chips demoted ember → dim/faint per "no amber on labels" |
| 8 | Worlds | Row meta: dropped backup count (duplicate — the menu label already shows "Backups (N)"); capitalized "fabric"; ≤4 facts rule commented in place |
| 9 | Switcher | Active row tint ember → neutral; the ember dot is the popover's one mark. Loader capitalized; 9px mono → 10px |
| 10 | Account | UUID removed from rows (internal identifier; also kills the "No UUID" negative state). Meta = one human fact: Last used / Added date |
| 11 | Account | Signed-out "Sign in" row action demoted ember → quiet (Law 1: it could co-exist with the studio's ember CTA); studio meta dropped constant "· 64×64"; "Arm style" label now uses the standard microlabel |
| 12 | Setup | Manifest is now live: World/Minecraft/Mod loader/Memory/Server read from the active world (`—` when unknown); "Mods & packs" says "Yours to manage" for personal worlds. The hardcoded rows lied whenever a personal world was active |
| 13 | New World | Removed "· Recommended" from the non-default Fabric card (the default must be the recommendation — HIG); dropped "4 GB allocated" footnote; title 28 → 24px to match the offline dialog |
| 14 | DESIGN.md | Type scale extended with the roles the product actually uses: Row title 15/600, Chip 10/600 (never ember), Dialog title 24/700, Row meta mono-10 ≤4 facts |

## Deliberately NOT shipped

- **Merging "Add Microsoft account · Add offline"** into one affordance — needs a menu (a new control). Both are already faint 13px; acceptable weight.
- **Removing the × from dialogs** (Cancel exists) — would demand an Escape handler to keep HIG-expected dismissal; net-zero simplification.
- **Backups' ember "Restore" confirm** — defensible as the transient moment's primary action; left as-is.

## Strengths confirmed (no change)

Empty states across all four nouns are already honest and warm; Setup's
no-fake-controls stance; Worlds' overflow menu is progressive disclosure done
right (management hidden until asked, personal worlds only); the hairline
shelf language is consistent across Worlds/Account; the stage/shelf vertical
rhythm (Play + Setup centered statements, Worlds + Account top-aligned
shelves) is a coherent 2×2 system.

## Verification

`tsc --noEmit` 0 errors · ESLint 0 errors in touched files · `npm run build` clean.
