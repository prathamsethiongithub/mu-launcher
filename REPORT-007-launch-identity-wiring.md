# REPORT-007 — Launch Wired to IdentityService

**Date:** 2026-07-11 · **Status:** Shipped, verified · **Closes:** REPORT-006 gap #1

## What changed

Switching the active account now changes who actually plays. Previously
`launch-game` always authenticated through the legacy `AuthService`, so the
Account screen's Switch action changed your face but not your launch token.

## Design: one resolution rule

A single main-process function, `resolvePlayerIdentity()`
(`src/main/index.ts`), answers "who is the player":

1. **Identity active account**, if it can actually play — an offline account,
   or a Microsoft account with a live session (`getSession` present).
2. Otherwise the **legacy AuthService session** (so pre-identity sign-ins keep
   working untouched).
3. Otherwise **null** → signed out.

Four consumers resolve through it, so name, face, gate, and token can never
disagree:

| Surface | Behavior |
|---|---|
| `auth-status` | Play stage's gate + greeting name the resolved player |
| `get-skin` | Hero renders the resolved player's skin (offline → default look, never borrows a skin) |
| `launch-game` | `resolveLaunchAuthorization()` → identity: `IdentityService.ensureValidSession()` (validates + refreshes tokens); legacy: `getAuthorizationForMCLC()` (unchanged) |
| `launch-poc` | Same resolution |

No changes to `launch-service.ts` — `ensureValidSession()` already returns the
exact `{ access_token, uuid, name }` contract that `launchWithFabric` expects,
for both Microsoft (real token) and offline (dummy token, canonical
`OfflinePlayer:` UUID) accounts. The renderer is untouched except one line of
Account-screen copy, now true: *"The active account enters the world when you
press Play."*

## Failure semantics (no silent wrong-person launches)

- Active identity session **exists but can't be revived** (refresh fails /
  tokens revoked): launch fails with `[E609] <reason> (Account screen → Sign
  in)` through the existing launch-error UI. It does NOT silently fall back
  to the legacy session — that could launch as a different person.
- Active identity account **signed out** (no session record): resolution falls
  through to legacy coherently — hero, name, and launch all show the legacy
  player. With no legacy session either, everything reads signed-out and the
  Play button becomes "Sign in".
- Loop-safety: signing in from the Play stage creates a legacy session, which
  the resolution picks up — the gate can never demand a sign-in that the
  resolution then ignores.
- Every launch logs `[launch] Launching as "<name>" (identity/<type> |
  legacy session)` for supportability.

## Verification

- `tsc --noEmit`: 0 errors · ESLint: 0 errors in touched files ·
  `npm run build`: clean.
- Boot smoke: app starts, legacy session restores, no identity/skin/launch
  errors on boot.
- Full launch not exercised in-session (starts a real game download/process);
  first manual launch will print the `[launch] Launching as` line — check it
  names the expected account.

## Notes / remaining

- Offline accounts launch in offline mode; online-mode servers (the SMP)
  will reject them server-side — expected, and the offline dialog says so.
- Legacy → identity token bridging (one sign-in updating both stores) remains
  open; harmless now that resolution prefers identity only when it's live.
- `validateSession` refreshes only when the stored expiry has passed; a
  server-side revocation inside the 24h window surfaces in-game rather than
  at launch (same behavior as the legacy path).
