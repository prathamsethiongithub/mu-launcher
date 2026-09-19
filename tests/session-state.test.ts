import { describe, expect, it } from 'vitest';
import { isSessionExpired, removalCleanupScope, sessionDecision } from '../src/main/identity-service';

/**
 * Test 3 — session state machine (identity-service.ts), pure decisions only.
 * Covers: expiry judgement (equality, just-past, far-future, missing), the
 * offline/microsoft branch selector, and the remove-path guard scope.
 * fs/safeStorage-bound parts of IdentityService (loadState/saveTokens/
 * refreshMicrosoftSession) are NOT covered — they are class state, not pure
 * logic, and would require Electron mocks, which the brief forbids. Recorded
 * in 18-TRUST-REPAIR-LOG.md.
 */

describe('isSessionExpired', () => {
  const expiresAt = '2026-01-01T00:00:00.000Z';
  const session = { expiresAt };
  const expiryMs = new Date(expiresAt).getTime();

  it('null/undefined session → not expired (nothing to judge)', () => {
    expect(isSessionExpired(null, Date.now())).toBe(false);
    expect(isSessionExpired(undefined, Date.now())).toBe(false);
  });

  it('session without expiresAt → not expired', () => {
    expect(isSessionExpired({}, Date.now())).toBe(false);
  });

  it('exactly at expiry → expired (equality counts)', () => {
    expect(isSessionExpired(session, expiryMs)).toBe(true);
  });

  it('one ms past expiry → expired', () => {
    expect(isSessionExpired(session, expiryMs + 1)).toBe(true);
  });

  it('one ms before expiry → not expired', () => {
    expect(isSessionExpired(session, expiryMs - 1)).toBe(false);
  });

  it('far in the future → not expired; far in the past → expired', () => {
    expect(isSessionExpired(session, expiryMs + 1000 * 60 * 60 * 24 * 365)).toBe(true);
    expect(isSessionExpired(session, expiryMs - 1000 * 60 * 60 * 24 * 365)).toBe(false);
  });

  it('现状如此: unparseable expiresAt → NaN comparison → NOT expired', () => {
    // new Date('garbage').getTime() is NaN; `now >= NaN` is false, so a
    // corrupt timestamp silently reads as "session still valid". Harmless in
    // practice (writes always use toISOString) but worth pinning down.
    expect(isSessionExpired({ expiresAt: 'garbage' }, Date.now())).toBe(false);
  });
});

describe('sessionDecision', () => {
  it('offline accounts are always valid, regardless of stored session', () => {
    expect(sessionDecision('offline', null)).toEqual({ valid: true });
    expect(sessionDecision('offline', undefined)).toEqual({ valid: true });
    expect(sessionDecision('offline', { refreshToken: undefined })).toEqual({ valid: true });
  });

  it('microsoft without a session → sign-in required', () => {
    expect(sessionDecision('microsoft', null)).toEqual({
      valid: false,
      error: 'No session tokens. Please sign in again.',
    });
    expect(sessionDecision('microsoft', undefined)).toEqual({
      valid: false,
      error: 'No session tokens. Please sign in again.',
    });
  });

  it('microsoft with a session but no refresh token → sign-in required', () => {
    expect(sessionDecision('microsoft', {})).toEqual({
      valid: false,
      error: 'No session tokens. Please sign in again.',
    });
    expect(sessionDecision('microsoft', { refreshToken: undefined })).toEqual({
      valid: false,
      error: 'No session tokens. Please sign in again.',
    });
  });

  it('microsoft with a refresh token → valid (refreshability is the criterion)', () => {
    expect(sessionDecision('microsoft', { refreshToken: 'r' })).toEqual({ valid: true });
  });
});

describe('removalCleanupScope', () => {
  it('a matched account clears both session stores and reassigns active', () => {
    expect(removalCleanupScope('acc-1')).toEqual({
      deleteStateSession: true,
      deleteEncryptedToken: true,
      reassignActive: true,
    });
  });

  it('an unmatched id (null) clears nothing and reassigns nothing', () => {
    expect(removalCleanupScope(null)).toEqual({
      deleteStateSession: false,
      deleteEncryptedToken: false,
      reassignActive: false,
    });
  });
});
