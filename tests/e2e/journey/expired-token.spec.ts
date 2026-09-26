/**
 * Journey hunt #2 — THE EXPIRED-TOKEN RETURNING VETERAN.
 *
 * Storage-model fact this hunt audited (real finding): validateSession
 * judges expiry against the ENCRYPTED token store (identity-tokens.bin,
 * safeStorage), NOT the identity.json sessions metadata — the JSON field is
 * decorative for the expiry decision. So the veteran is seeded by minting
 * tokens through the REAL addMicrosoftAccount path while the main process
 * clock is shifted back, making the token store carry an expiresAt that is
 * already ~3 days past. Zero production change, zero hand-rolled files.
 *
 * Contracts, all exercised through the REAL validate-session IPC:
 *   1. Refresh path (msmc chain canned → succeeds): silent
 *      re-authentication — { valid: true }, fast (no spinner).
 *   2. Dead refresh token (msmc chain rejects): an HONEST human verdict —
 *      "Session expired. Please sign in again." — never a dead wall, never
 *      an infinite spinner, never a crash, never a fake success.
 *   3. Cold restart: the stored expired session is judged the same way on
 *      the next boot, and a working refresh revives it silently.
 */

import { test, expect } from 'playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchTestApp, type TestApp } from '../harness';
import { installMsmcCannedChain, shiftMainClock, JOURNEY_VETERAN } from './lib';

const EXPIRED_AGO_MS = 3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000; // 3d2h back
const HONEST_MESSAGE = 'Session expired. Please sign in again.';
const RESOLVE_CEILING_MS = 10_000;

/** Boot with the canned chain, mint the veteran through the REAL IPC while
 *  the main clock is shifted back (tokens born already-expired), restore. */
async function bootMintExpiredVeteran(mode: 'refresh-ok' | 'refresh-fail'): Promise<TestApp & { accountId: string }> {
  const ta = await launchTestApp({
    onLaunched: async (app) => {
      await installMsmcCannedChain(app, mode);
    },
  });

  // Mint with a back-dated clock: updateSession stamps
  // expiresAt = (now − 3d2h) + 24h → expired ~2 days ago on disk.
  await shiftMainClock(ta.app, -EXPIRED_AGO_MS);
  const minted = await ta.window.evaluate(async () => {
    return window.electronAPI.addMicrosoftAccount();
  });
  await shiftMainClock(ta.app, 0);

  if (!minted?.success || !minted.account) {
    await ta.cleanup();
    throw new Error(`addMicrosoftAccount (canned chain) failed: ${JSON.stringify(minted)}`);
  }
  if (minted.account.uuid !== JOURNEY_VETERAN.uuid) {
    await ta.cleanup();
    throw new Error(`unexpected minted profile: ${JSON.stringify(minted.account)}`);
  }
  return { ...ta, accountId: minted.account.id };
}

// ── Contract 1: expired token + working refresh → silent re-auth ──────────

test('journey #2a: expired token, refresh works → silent re-auth, no wall', async () => {
  const ta = await bootMintExpiredVeteran('refresh-ok');
  try {
    const t0 = Date.now();
    const verdict = await ta.window.evaluate(async (id: string) => {
      return window.electronAPI.validateSession(id);
    }, ta.accountId);
    const elapsed = Date.now() - t0;

    expect(verdict, 'expired-token + working refresh must re-auth silently').toEqual({ valid: true });
    expect(elapsed, 'validate must resolve fast — never a spinner').toBeLessThan(RESOLVE_CEILING_MS);

    // The veteran still owns a session (refresh persisted through the real
    // saveTokens path — updateSession rewrote the encrypted store).
    const accounts = (await ta.window.evaluate(async () =>
      window.electronAPI.getAccounts(),
    )) as Array<{ id: string; hasSession: boolean }>;
    expect(accounts.find((a) => a.id === ta.accountId)?.hasSession).toBe(true);
  } finally {
    await ta.cleanup();
  }
});

// ── Contract 2: expired token + dead refresh → honest verdict ─────────────

test('journey #2b: expired token, refresh dead → honest verdict, no crash, no hang', async () => {
  const ta = await bootMintExpiredVeteran('refresh-fail');
  try {
    const t0 = Date.now();
    const verdict = await ta.window.evaluate(async (id: string) => {
      return window.electronAPI.validateSession(id);
    }, ta.accountId);
    const elapsed = Date.now() - t0;

    expect(verdict.valid, 'dead refresh must NOT be reported valid').toBe(false);
    expect(verdict.error ?? '', 'the verdict speaks human').toContain(HONEST_MESSAGE);
    expect(elapsed, 'the honest verdict must arrive — never a hang').toBeLessThan(RESOLVE_CEILING_MS);

    // The renderer stays alive and the launcher stays healthy: accounts IPC
    // still answers (no dead wall), the window still renders.
    const accounts = await ta.window.evaluate(async () => window.electronAPI.getAccounts());
    expect(Array.isArray(accounts)).toBe(true);
    const body = await ta.window.evaluate(() => document.body.innerText);
    expect(body.length, 'renderer still renders').toBeGreaterThan(0);
  } finally {
    await ta.cleanup();
  }
});

// ── Contract 3: the returned veteran survives a COLD RESTART ──────────────

test('journey #2c: cold restart with a stored expired session → refresh revives it silently', async () => {
  // Boot 1: mint the expired veteran through the REAL addMicrosoftAccount IPC
  // (canned chain + back-dated clock), then die. The CALLER-OWNED scratchDir
  // (identity.json + identity-tokens.bin) must survive cleanup — passing it
  // as userDataDir flips harness ownership, so cleanup kills the app but
  // never wipes the profile. Wiping here would make the "cold restart" a
  // fresh boot with nothing stored — the journey's whole point.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-journey-token-'));
  const first = await launchTestApp({
    userDataDir: scratchDir,
    onLaunched: async (app) => {
      await installMsmcCannedChain(app, 'refresh-fail');
    },
  });
  let accountId = '';
  try {
    // Mint on the back-dated clock — tokens are born already-expired on disk.
    await shiftMainClock(first.app, -EXPIRED_AGO_MS);
    const minted = (await first.window.evaluate(async () =>
      window.electronAPI.addMicrosoftAccount())) as {
      success: boolean;
      account?: { id: string; uuid: string };
      error?: string;
    };
    await shiftMainClock(first.app, 0);
    if (!minted?.success || !minted.account) {
      throw new Error(`boot-1 mint failed: ${JSON.stringify(minted)}`);
    }
    expect(minted.account.uuid).toBe(JOURNEY_VETERAN.uuid);
    accountId = minted.account.id;
  } finally {
    await first.cleanup();
  }

  // Boot 2: same profile, fresh process — refresh works this time. seed:()
  // EMPTY on purpose: the harness default would overwrite the veteran's
  // identity.json with its offline seed, erasing the stored session.
  const ta = await launchTestApp({
    userDataDir: scratchDir,
    seed: () => { /* the stored veteran profile IS the seed */ },
    onLaunched: async (app) => {
      await installMsmcCannedChain(app, 'refresh-ok');
    },
  });
  try {
    const verdict = await ta.window.evaluate(async (id: string) => {
      return window.electronAPI.validateSession(id);
    }, accountId);
    expect(verdict).toEqual({ valid: true });

    const accounts = (await ta.window.evaluate(async () =>
      window.electronAPI.getAccounts(),
    )) as Array<{ uuid: string; hasSession: boolean }>;
    expect(accounts.find((a) => a.uuid === JOURNEY_VETERAN.uuid)?.hasSession).toBe(true);
  } finally {
    await ta.cleanup();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
