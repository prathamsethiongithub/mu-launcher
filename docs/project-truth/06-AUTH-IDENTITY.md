# 06 — AUTH / IDENTITY

Current implementation as of the audited worktree. Two coexisting systems, one resolution rule.

## The two systems

### A. Legacy `AuthService` (`src/main/auth-service.ts`, 428 lines)

- **Single slot.** msmc `new Auth('select_account')` login; keeps `currentToken`/`currentProfile`/`savedRefreshToken` in memory.
- **Persisted:** `auth-session.bin` (userData; safeStorage-encrypted; `SESSION_FILE` L310–313).
- **Startup restore:** `restoreSession()` — memory token first; else reconstruct from `savedRefreshToken` via `authManager.refresh` → `minecraft.mclc()`; on failure **nulls all state and deletes the file** (L258–264) so the next `getAuthorizationForMCLC()` returns null and the UI prompts re-login (`CONFIRMED`).
- **Launch auth:** `getAuthorizationForMCLC()` (L267) → `ensureValidAuth()` refresh-if-needed → MCLC triple.
- **Role today:** fallback for pre-identity sign-ins; also the *sign-in path from the Play stage* (loop-safety, see REPORT-007).

### B. `IdentityService` (`src/main/identity-service.ts`, 580 lines)

- **Multi-account registry.** `identity.json` (accounts, activeAccountId, skin profiles — no tokens) + `identity-tokens.bin` (safeStorage-encrypted per-account sessions; absent safeStorage → warn "tokens will not persist", L552).
- **Offline accounts** are first-class: canonical `OfflinePlayer:<name>` UUID, dummy token — they launch in offline mode (online-mode servers reject them; dialog says so).
- **Session import bridge:** `importSession(profile, refreshToken, accessToken)` (L101, L259) — used when the legacy session names the same person, and by the legacy→identity convergence on Account-tab sign-in.
- **Launch auth:** `ensureValidSession()` (L321) — validates + refreshes the active account's tokens.

## THE one resolution rule (`src/main/index.ts` L165–212)

```
resolvePlayerIdentity():
  active = identityService.getActiveAccount()
  if active && (active.type === 'offline' || identityService.getSession(active.id))
      → { source: 'identity', account: active }
  if legacy AuthService.isLoggedIn() && profile
      → { source: 'legacy', profile }
  else → null   // signed out
```

`resolveLaunchAuthorization()` (L192–212) maps that to tokens:

- identity → `ensureValidSession()`; **if it throws (session exists but can't be revived) the launch fails `[E609]` — it does NOT silently fall back to legacy** (a wrong-person launch is worse than a failed launch; REPORT-007 semantics, `CONFIRMED` in source comments L197–201).
- legacy → `getAuthorizationForMCLC()`.

Consumers that resolve through the same rule: `auth-status` (L313), `get-skin` (L335), `launch-game` (L381), `launch-poc` (L435). Name, face, gate and token cannot disagree (`CONFIRMED` — single function).

## Sign-in convergence (`add-microsoft-account`, index.ts L609–635)

Account-tab sign-in **also** converges the legacy session: imports the account's refresh/access tokens into `AuthService` and sets it active (L612–630). Rationale (code comment): a legacy slot naming a *different* person than the registry's active account breaks Play/`get-skin`/launch resolution. Legacy-sync failure is logged, not fatal (L627–630).

## Removal — the resurrection guard (`remove-account`, index.ts L655–691)

The historical account-resurrection bug: removing an account left the legacy `auth-session.bin` behind; on restart `resolvePlayerIdentity` fell back to legacy and the removed account "came back".

Current defense, exactly as implemented:

1. Find the account by **id** (not position).
2. Compute `isLegacySession`: account is Microsoft, has UUID, and the legacy profile's normalized UUID (dashes stripped) matches (L659–673).
3. If yes: `auth.logout()` **first**, then **verify** `hasPersistedSession()` (L415: true only if the legacy file still exists). If the file survived → **abort removal, account intact**, error "Could not clear the saved sign-in session…" (L674–684). Clear-and-verify *before* removal — no partial states.
4. Only then `identityService.removeAccount(accountId)`; success → `notifyAuthChanged()`.

`identity-sign-out` (L765–780) applies the same UUID-match rule to also end the legacy launch session when the signed-out identity account IS the legacy session.

**Status:** the guard is `CONFIRMED` present in current source. Its runtime effectiveness is `INFERRED` (logic-traced; no runtime test in evidence for the removal path itself).

## Startup restoration / restart summary

- Identity restores registry + tokens from disk; legacy restores (or deletes) `auth-session.bin`.
- After restart: the player is whoever `resolvePlayerIdentity` says — identity active account **with a live session record**, else the legacy session, else signed out.
- An account removed yesterday stays removed **provided** the legacy clear succeeded (the guard guarantees it or blocks removal).

## Known residuals (documented, not fixed)

- `validate-session` refreshes tokens as a side effect (REPORT-006 gap #5; still current).
- Legacy→identity one-way convergence exists; identity sign-in updates both, but a legacy `auth-login` (Play stage) creates only a legacy session — picked up by resolution as `source:'legacy'` until an Account-tab sign-in converges it (REPORT-007 "Notes/remaining", still accurate).
- Token encryption backend (DPAPI vs basic) is machine-dependent safeStorage behavior — `UNKNOWN`.
