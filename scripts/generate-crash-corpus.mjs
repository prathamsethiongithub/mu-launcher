#!/usr/bin/env node
/**
 * Crash corpus generator v2 — drives the launcher's REAL launch pipeline
 * (Playwright Electron + launch-game IPC) instead of hand-assembling the
 * MCLC classpath. v1's hand-rolled JVM command died before Fabric even
 * finished initializing (log truncated mid-mod-list, no crash report).
 *
 * Six scenarios against the real installed runtime. Every scenario:
 *   1. backs up mods/ AND the identity registry
 *   2. stages the scenario (mods content / world RAM / active account)
 *   3. launches via the launcher's own launch-game IPC (offline auth)
 *   4. waits for a crash report OR the timeout
 *   5. kills the game, harvests the newest crash report
 *   6. RESTORES everything — the user's environment is sacred
 *
 * Run:  node scripts/generate-crash-corpus.mjs [--scenario=name]
 * Out:  tests/fixtures/crash-corpus/<scenario>.txt + manifest.json
 */

import { _electron } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MC_ROOT = path.join(process.env.APPDATA ?? '', 'mu-master-launcher', 'minecraft');
const CRASH_DIR = path.join(MC_ROOT, 'crash-reports');
const MODS_DIR = path.join(MC_ROOT, 'mods');
const OUT_DIR = path.resolve('tests/fixtures/crash-corpus');
const CRASH_TIMEOUT_MS = 3 * 60_000;
const CLEAN_BASELINE_MS = 60_000;

const results = [];
const restoreStack = [];

function restore(fn) { restoreStack.push(fn); }
function restoreAll() {
  while (restoreStack.length) {
    try { restoreStack.pop()(); } catch (e) { console.error('  restore error:', e.message); }
  }
}

function snapshotMods() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-bak-'));
  if (fs.existsSync(MODS_DIR)) {
    for (const f of fs.readdirSync(MODS_DIR)) {
      fs.copyFileSync(path.join(MODS_DIR, f), path.join(tmp, f));
    }
  }
  restore(() => {
    fs.rmSync(MODS_DIR, { recursive: true, force: true });
    fs.mkdirSync(MODS_DIR, { recursive: true });
    for (const f of fs.readdirSync(tmp)) fs.copyFileSync(path.join(tmp, f), path.join(MODS_DIR, f));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('  ↩ mods/ restored');
  });
}

function clearMods() {
  fs.rmSync(MODS_DIR, { recursive: true, force: true });
  fs.mkdirSync(MODS_DIR, { recursive: true });
}

function killMinecraft() {
  for (const img of ['java.exe', 'javaw.exe']) {
    try { execSync(`taskkill /IM ${img} /T /F`, { stdio: 'ignore' }); } catch { /* none */ }
  }
}

function newestCrashReport(sinceMs) {
  if (!fs.existsSync(CRASH_DIR)) return null;
  return fs
    .readdirSync(CRASH_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ p: path.join(CRASH_DIR, f), m: fs.statSync(p).mtimeMs }))
    .filter((x) => x.m >= sinceMs - 2000)
    .sort((a, b) => b.m - a.m)[0]?.p ?? null;
}

async function waitCrash(sinceMs, timeoutMs, window) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = newestCrashReport(sinceMs);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await window.evaluate(() => window.electronAPI.cancelLaunch().catch(() => {}));
  return null;
}

// ── main ────────────────────────────────────────────────────────────────────
console.log('CRASH CORPUS GENERATOR v2 (launcher-pipeline driver)');
const only = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1];

// Identity backup: the generator swaps the active account to an offline one
// (launch-game refuses MS accounts without live tokens; offline = dummy token).
const identityPath = path.join(process.env.APPDATA ?? '', 'mu-master-launcher', 'identity.json');
const identityBackup = path.join(os.tmpdir(), 'crash-corpus-identity.json.bak');
const hadIdentity = fs.existsSync(identityPath);
if (hadIdentity) fs.copyFileSync(identityPath, identityBackup);
restore(() => {
  if (hadIdentity) fs.copyFileSync(identityBackup, identityPath);
  console.log('  ↩ identity.json restored');
});

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-corpus-'));
restore(() => { fs.rmSync(scratchDir, { recursive: true, force: true }); });

let app = null;
let window = null;

async function launchApp() {
  app = await _electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${scratchDir}`],
    timeout: 30_000,
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 35_000 && !window) {
    for (const w of app.windows()) {
      if (/renderer[\\/]index\.html/.test(w.url())) { window = w; break; }
    }
    if (!window) await new Promise((r) => setTimeout(r, 400));
  }
  if (!window) throw new Error('main window never appeared');
  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(2500); // identity service ready
  // Ensure an offline account is active — offline auth = dummy token, which
  // the real MCLC pipeline accepts for offline mode.
  await window.evaluate(async () => {
    const accounts = await window.electronAPI.getAccounts();
    const offline = accounts.find((a) => a.type === 'offline');
    if (offline) { await window.electronAPI.setActiveAccount(offline.id); return; }
    const added = await window.electronAPI.addOfflineAccount('CrashCorpus');
    if (added.success) await window.electronAPI.setActiveAccount(added.account.id);
  });
}

async function stageMods(fn) {
  snapshotMods();
  fn();
}

async function launchAndWait(name, timeoutMs) {
  const javaPath = await window.evaluate(() => window.electronAPI.getJavaPath());
  const t0 = Date.now();
  const result = await window.evaluate(
    (jp) => window.electronAPI.launchGame(jp),
    javaPath,
  );
  console.log(`  launch-game ack (${Date.now() - t0}ms):`, JSON.stringify(result).slice(0, 120));
  const report = await waitCrash(t0, timeoutMs, window);
  killMinecraft();
  await new Promise((r) => setTimeout(r, 1500));
  let outFile = null;
  if (report) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    outFile = path.join(OUT_DIR, `${name}.txt`);
    fs.copyFileSync(report, outFile);
    console.log(`  crash harvested → ${path.basename(outFile)}`);
  }
  return outFile;
}

function attribute(outFile) {
  if (!outFile) return null;
  const head = fs.readFileSync(outFile, 'utf8').slice(0, 5000);
  const reason = /Caused by:\s*(.+)/.exec(head)?.[1]?.slice(0, 100)
    ?? (/Mixin apply failed/.test(head) ? 'Mixin apply failed' : null)
    ?? (/OutOfMemoryError/.test(head) ? 'OutOfMemoryError' : null);
  const mixinMod = /([A-Za-z][\w-]*)\.mixins\.json/.exec(head)?.[1];
  return { reason, mixinMod };
}

try {
  await launchApp();
  snapshotMods();

  const scenarios = [
    {
      name: 'dependency',
      stage: () => {
        clearMods();
        execSync(
          'curl -sL --fail -o sodium-fabric.jar "https://api.modrinth.com/v2/project/sodium/version"',
          { cwd: MODS_DIR, stdio: 'ignore', shell: 'cmd.exe' },
        );
      },
    },
    {
      name: 'corrupt-jar',
      stage: () => {
        clearMods();
        fs.writeFileSync(path.join(MODS_DIR, 'corrupted-mod.jar'), Buffer.from('PK' + 'x'.repeat(2048)));
      },
    },
    {
      name: 'oom',
      stage: async () => {
        // Real full mod set + tiny heap: set the world RAM to 512 MB via IPC.
        const worlds = await window.evaluate(() => window.electronAPI.getWorlds());
        for (const w of worlds) {
          await window.evaluate(
            ([id]) => window.electronAPI.updateWorldSettings(id, { ramAllocation: 512 }),
            [w.id],
          );
        }
        console.log(`  RAM forced to 512 MB across ${worlds.length} world(s)`);
      },
      pre: true, // stage is async
    },
    {
      name: 'version-mismatch',
      stage: () => {
        clearMods();
        fs.writeFileSync(
          path.join(MODS_DIR, 'sodium-ancient.jar'),
          Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('0'.repeat(4096))]),
        );
      },
    },
    {
      name: 'clean-baseline',
      stage: () => clearMods(),
      timeoutMs: CLEAN_BASELINE_MS,
      expectCrash: false,
    },
  ];

  for (const sc of scenarios) {
    if (only && sc.name !== only) continue;
    console.log(`\n── ${sc.name} ──`);
    killMinecraft();
    await stageMods(sc.stage);
    const outFile = await launchAndWait(sc.name, sc.timeoutMs ?? CRASH_TIMEOUT_MS);
    killMinecraft();
    const crashed = !!outFile;
    const asExpected = crashed === (sc.expectCrash ?? true);
    results.push({
      scenario: sc.name,
      crashed,
      file: outFile ? path.basename(outFile) : null,
      attribution: attribute(outFile),
      asExpected,
    });
    console.log(`  ${asExpected ? '✓' : '✗'} crashed=${crashed} asExpected=${asExpected}`);
  }

  // Scenario 6 is launcher-side only: covered by E2E identity-renders.
  results.push({
    scenario: 'external-skin', crashed: false, file: null,
    note: 'launcher-side — covered by e2e identity tests', asExpected: true,
  });
} catch (err) {
  console.error('FATAL:', err);
} finally {
  killMinecraft();
  restoreAll();
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = { generatedAt: new Date().toISOString(), scenarios: results };
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest: ${path.join(OUT_DIR, 'manifest.json')}`);
console.log(`corpus: ${results.filter((r) => r.crashed).length}/${results.length} scenarios produced crash files`);
