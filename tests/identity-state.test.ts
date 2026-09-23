import { describe, expect, it } from 'vitest';
import { normalizeIdentityState } from '../src/main/identity-state';

/**
 * Identity-state normalization (identity-state.ts), pure decisions only.
 * Contract: legal-JSON-wrong-shape identity.json must coerce to a
 * guaranteed IdentityState so getAccounts() can never return undefined.
 * Discovered by the corrupted-state persona (tests/e2e/personas/
 * corrupted-state.ts); fs/safeStorage-bound loadState itself stays
 * class state (no Electron mocks, per the 18-TRUST-REPAIR-LOG convention).
 */

const validAccount = {
  id: 'a1',
  type: 'offline' as const,
  username: 'tester',
  uuid: '99999999-9999-3999-8999-999999999999',
  createdAt: '2026-09-01T12:00:00.000Z',
  lastUsedAt: '2026-09-01T12:00:00.000Z',
};

describe('normalizeIdentityState', () => {
  it('a fully valid state passes through untouched', () => {
    const state = {
      accounts: [validAccount],
      activeAccountId: 'a1',
      sessions: { a1: { accountId: 'a1', authenticated: true, lastValidatedAt: '2026-09-01T12:00:00.000Z' } },
    };
    const out = normalizeIdentityState(state);
    expect(out.accounts).toEqual([validAccount]);
    expect(out.activeAccountId).toBe('a1');
    expect(Object.keys(out.sessions)).toEqual(['a1']);
  });

  it('legal JSON with missing accounts → empty accounts (the sticky-file bug)', () => {
    const out = normalizeIdentityState({ sessions: {} });
    expect(out.accounts).toEqual([]);
    expect(out.activeAccountId).toBeUndefined();
  });

  it('non-object payloads → fresh empty state', () => {
    for (const raw of [null, undefined, 42, 'str', []]) {
      const out = normalizeIdentityState(raw);
      expect(out.accounts).toEqual([]);
      expect(out.sessions).toEqual({});
      expect(out.activeAccountId).toBeUndefined();
    }
  });

  it('malformed account entries are dropped, valid ones kept', () => {
    const out = normalizeIdentityState({
      accounts: [validAccount, { id: 'no-username' }, null, 'garbage', 7],
    });
    expect(out.accounts).toEqual([validAccount]);
  });

  it('sessions entries without an accountId string are dropped', () => {
    const out = normalizeIdentityState({
      accounts: [validAccount],
      sessions: { a1: { accountId: 'a1' }, broken: { authenticated: true }, worse: null },
    });
    expect(Object.keys(out.sessions)).toEqual(['a1']);
  });

  it('activeAccountId pointing at a dropped account is cleared', () => {
    const out = normalizeIdentityState({ activeAccountId: 'ghost', sessions: {} });
    expect(out.activeAccountId).toBeUndefined();
  });

  it('accounts not an array → empty', () => {
    const out = normalizeIdentityState({ accounts: { a: validAccount } });
    expect(out.accounts).toEqual([]);
  });
});
