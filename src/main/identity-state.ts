/**
 * Pure identity-state normalizer — the deterministic counterpart to
 * identity.json's power-cut taxonomy (see personas/corrupted-state.ts).
 *
 * loadState() accepted any parseable JSON verbatim. A legal-JSON-but-wrong-
 * shape file (`{"sessions": {}}` — accounts field missing) left
 * `state.accounts === undefined`, so every account IPC (get-accounts →
 * .map at index.ts:1326) threw TypeError forever, the renderer silently
 * swallowed it, and saveState() wrote `{accounts: undefined}` back out —
 * the malformed file stuck permanently. Unlike world-manager and
 * skin-library (which recover to a known-good state), identity let an
 * illegal shape stick.
 *
 * Extraction follows the 18-TRUST-REPAIR-LOG convention: pure decisions are
 * exported and unit-tested; the fs/safeStorage-bound parts stay class state.
 */
import type { Account, Session, IdentityState } from '../shared/types';

const isSessionLike = (s: unknown): s is Session =>
  typeof s === 'object' &&
  s !== null &&
  typeof (s as Session).accountId === 'string';

/**
 * Coerce a parsed identity.json payload into a guaranteed-shape
 * IdentityState. Non-conforming parts are DROPPED (never guessed):
 * missing/non-array accounts → [], sessions entries without an accountId
 * string → removed, activeAccountId pointing nowhere → cleared. A valid
 * file passes through untouched (same reference semantics, no churn).
 */
export function normalizeIdentityState(raw: unknown): IdentityState {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<IdentityState>;

  const accounts: Account[] = Array.isArray(source.accounts)
    ? source.accounts.filter(
        (a): a is Account =>
          typeof a === 'object' && a !== null && typeof a.id === 'string' && typeof a.username === 'string',
      )
    : [];

  const sessions: Record<string, Session> = {};
  if (typeof source.sessions === 'object' && source.sessions !== null) {
    for (const [id, session] of Object.entries(source.sessions)) {
      if (isSessionLike(session)) sessions[id] = session;
    }
  }

  const activeAccountId =
    typeof source.activeAccountId === 'string' && accounts.some((a) => a.id === source.activeAccountId)
      ? source.activeAccountId
      : undefined;

  return { accounts, sessions, activeAccountId };
}
