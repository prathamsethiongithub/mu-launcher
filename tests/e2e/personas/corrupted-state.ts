/**
 * Persona 2 — corrupted-state: every data file in its worst legal shape.
 *
 * Seeds: worlds.json TRUNCATED mid-JSON, identity.json VALID JSON but with
 * the accounts field missing (legal parse, wrong shape), skins.json empty
 * object, a leftover identity.json.tmp (simulated crash mid-atomic-write),
 * and a pre-existing worlds.json.corrupt-1700000000000 backup.
 *
 * Expected recovery paths (verified against production code):
 *  - worlds.json: JSON.parse throws → backupCorruptRegistry() renames the
 *    file to .corrupt-<now> and migrateFromExisting() rebuilds + persists
 *    the managed world immediately (world-manager.ts:759-768, 912-921,
 *    783-792). The seeded stale .corrupt backup must still be present
 *    alongside the fresh one.
 *  - skins.json: normalizeRegistry() degrades to an empty registry in
 *    memory — the rebuild is LAZY (persisted on the next mutation only)
 *    (skin-library.ts:258-273). So assert the STUDIO renders an empty
 *    library without crashing, not an on-disk rewrite.
 *  - identity.json missing accounts: loadState() only rebuilds on a JSON
 *    parse failure — a legal JSON with a missing field passes through
 *    unvalidated (identity-service.ts:577-590). If the app survives with
 *    the Account view reachable, fine; if the view crashes, THIS test is
 *    the evidence and the fix lands as its own production commit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchTestApp, waitForText, clickButtonByText, type TestApp } from '../harness';
import { LAYOUT_AUDIT } from '../layout-audit';

export const id = 'corrupted-state';
export const description =
  '磁盘上每个数据文件都处于最坏合法形态的档案（断电/杀进程/磁盘错误的产物）。' +
  '预期：全部恢复路径触发、应用可用、布局审计干净。';

let ta: TestApp;

const seedCorruptedState = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });

  // 1. worlds.json — truncated mid-object (a power cut mid-write).
  const worlds = JSON.stringify(
    {
      schemaVersion: 1,
      activeWorldId: 'managed-mu-smp',
      worlds: [{ id: 'managed-mu-smp', name: 'Masters' }],
    },
    null,
    2,
  );
  fs.writeFileSync(path.join(dir, 'worlds.json'), worlds.slice(0, Math.floor(worlds.length / 2)));

  // 2. A stale .corrupt backup from an earlier recovery — must survive.
  fs.writeFileSync(
    path.join(dir, 'worlds.json.corrupt-1700000000000'),
    '{ this was already corrupt before this test ran',
  );

  // 3. identity.json — LEGAL JSON, wrong shape: accounts field missing.
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ sessions: {} }));

  // 4. skins.json — an empty object (registry shape violation → empty library).
  fs.writeFileSync(path.join(dir, 'skins.json'), '{}');

  // 5. A leftover .tmp from an interrupted atomic write (identity's).
  fs.writeFileSync(path.join(dir, 'identity.json.tmp'), '{"accounts":[{"id":"half-wri');

  // 6. Identity tokens absent — fine: safeStorage path treats missing as fresh.
};

export async function run(): Promise<void> {
  ta = await launchTestApp({ seed: seedCorruptedState });

  // The app must BOOT despite every file being corrupt.
  const booted = await waitForText(ta.window, 'Almost there.', 30_000) ||
    (await ta.window.evaluate(() => document.body.innerText)).length > 0;
  if (!booted) throw new Error('app did not boot on fully corrupted state');

  // ── Worlds recovery (deterministic, on disk) ──
  const dir = ta.scratchDir;
  await clickButtonByText(ta.window, 'Worlds');
  await ta.window.waitForTimeout(1_000);

  const rebuilt = fs.existsSync(path.join(dir, 'worlds.json'));
  const freshBackup = fs.readdirSync(dir).some((f) => f.startsWith('worlds.json.corrupt-') && f !== 'worlds.json.corrupt-1700000000000');
  if (!rebuilt) throw new Error('worlds.json was NOT rebuilt after corruption recovery');
  if (!freshBackup) throw new Error('no fresh .corrupt-<ts> backup written during recovery');

  const reg = JSON.parse(fs.readFileSync(path.join(dir, 'worlds.json'), 'utf-8')) as {
    schemaVersion: number;
    activeWorldId: string | null;
    worlds: { id: string; type: string; broken: boolean }[];
  };
  if (!reg.worlds.some((w) => w.type === 'managed')) {
    throw new Error(`rebuilt registry has no managed world: ${JSON.stringify(reg).slice(0, 200)}`);
  }
  const staleBackupStillThere = fs.existsSync(path.join(dir, 'worlds.json.corrupt-1700000000000'));
  if (!staleBackupStillThere) throw new Error('pre-existing stale .corrupt backup was clobbered by recovery');

  // Worlds view must render the managed world (and not lie about being broken).
  const worldsBody = await ta.window.evaluate(() => document.body.innerText);
  if (!/Masters' Union SMP/i.test(worldsBody)) {
    throw new Error(`managed world not shown after recovery. body head: ${worldsBody.slice(0, 200)}`);
  }

  // ── Identity + skins: the app must stay usable ──
  await clickButtonByText(ta.window, 'Account');
  await ta.window.waitForTimeout(800);
  const accountBody = await ta.window.evaluate(() => document.body.innerText);

  // The empty-library shelf renders (corrupt skins.json → in-memory empty
  // registry, lazy rewrite — asserted as RENDERED state, not on-disk).
  const shelfOk = accountBody.includes('add a skin') || accountBody.includes('your library');
  if (!shelfOk) {
    throw new Error(`wardrobe shelf missing on corrupt skins state. body head: ${accountBody.slice(0, 200)}`);
  }

  // Honest empty/absent account handling — known failure mode this persona
  // hunts: undefined accounts must not white-screen the view.
  if (accountBody.trim().length === 0) {
    throw new Error('Account view rendered EMPTY (white-screen) on identity.json missing accounts');
  }

  // The account IPC surface must be ALIVE, not just non-crashing: this seed's
  // identity.json is legal JSON with `accounts` missing, which used to make
  // get-accounts throw TypeError on undefined (.map) — the renderer swallowed
  // it and every account operation was silently dead. Normalization
  // (identity-state.ts) must make the real renderer API answer.
  const accounts = await ta.window.evaluate(async () => {
    const api = (window as unknown as { electronAPI?: { getAccounts?: () => Promise<unknown> } }).electronAPI;
    if (!api?.getAccounts) return 'NO_API';
    return api.getAccounts();
  });
  if (accounts === 'NO_API' || !Array.isArray(accounts)) {
    throw new Error(`getAccounts IPC broken on missing-accounts identity.json: ${JSON.stringify(accounts)?.slice(0, 120)}`);
  }

  // ── Layout law still holds on the recovery UIs ──
  const problems = await ta.window.evaluate(LAYOUT_AUDIT);
  if (problems.problems.length > 0) {
    throw new Error(`layout violations after recovery: ${JSON.stringify(problems.problems.slice(0, 8))}`);
  }
}

export async function teardown(): Promise<void> {
  if (ta) await ta.cleanup();
}
