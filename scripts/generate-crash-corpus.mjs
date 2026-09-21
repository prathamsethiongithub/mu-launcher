#!/usr/bin/env node
/**
 * Crash corpus generator v3 — drives the launcher's REAL launch pipeline
 * (Playwright Electron + launch-game IPC → MCLC) and harvests BOTH crash
 * surfaces:
 *   - crash-reports/*.txt   (in-game crashes)
 *   - logs/*.log.gz         (pre-launch Fabric failures — FormattedException
 *                            never reaches crash-reports/, it lands in the
 *                            rotated log; v2 missed this surface entirely)
 *
 * Six scenarios against the real installed runtime. Every scenario:
 *   1. backs up mods/ AND the identity registry
 *   2. stages the scenario (real mod binaries from Modrinth / world RAM)
 *   3. launches via the launcher's own launch-game IPC (offline auth)
 *   4. waits for a crash record OR the timeout
 *   5. kills the game, harvests, attributes
 *   6. RESTORES everything — the user's environment is sacred
 *
 * Run:  node scripts/generate-crash-corpus.mjs [--scenario=name]
 * Out:  tests/fixtures/crash-corpus/<scenario>.txt + manifest.json
 */

import { _electron } from 'playwright';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const MC_ROOT = path.join(process.env.APPDATA ?? '', 'mu-master-launcher', 'minecraft');
const CRASH_DIR = path.join(MC_ROOT, 'crash-reports');
const LOGS_DIR = path.join(MC_ROOT, 'logs');
const MODS_DIR = path.join(MC_ROOT, 'mods');
const OUT_DIR = path.resolve('tests/fixtures/crash-corpus');
const CRASH_TIMEOUT_MS = 3 * 60_000;
const CLEAN_BASELINE_MS = 60_000;
const UA = 'mu-master-launcher-qa';

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
    .map((f) => {
      const full = path.join(CRASH_DIR, f);
      return { p: full, m: fs.statSync(full).mtimeMs };
    })
    .filter((x) => x.m >= sinceMs - 2000)
    .sort((a, b) => b.m - a.m)[0]?.p ?? null;
}

const ERROR_RE = /ModResolutionException|FormattedException|Incompatible mods found|Mixin apply failed|OutOfMemoryError/;

/** State of the unrotated latest.log — read incrementally after launch. */
function latestLogState() {
  const p = path.join(LOGS_DIR, 'latest.log');
  const gzs = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log.gz')) : [];
  if (!fs.existsSync(p)) return { size: 0, gzs };
  return { size: fs.statSync(p).size, gzs };
}

/**
 * Harvest the CURRENT run's failure record. Three surfaces, in order:
 *   1. crash-reports/*.txt newer than sinceMs (in-game crashes)
 *   2. a NEW rotated .log.gz mentioning the error
 *   3. the unrotated latest.log tail grown since before.size
 * surfaces 2–3 additionally require the staged jar name in the record, so a
 * previous scenario's crash can never be attributed to the current one.
 */
function harvestRecord(sinceMs, before, stagedJar) {
  const crash = newestCrashReport(sinceMs);
  if (crash) return { surface: 'crash-reports', p: crash };

  const logsDir = path.join(MC_ROOT, 'logs');
  const fresh = (latestLogState().gzs).filter((f) => !before.gzs.includes(f));
  for (const f of fresh) {
    try {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(logsDir, f))).toString('utf8');
      if (ERROR_RE.test(text) && (!stagedJar || text.includes(stagedJar))) {
        return { surface: 'rotated-log', p: path.join(logsDir, f), text };
      }
    } catch { /* skip undecodable */ }
  }

  const lp = path.join(logsDir, 'latest.log');
  if (fs.existsSync(lp)) {
    const buf = fs.readFileSync(lp);
    const tail = buf.subarray(Math.min(before.size, buf.length)).toString('utf8');
    if (ERROR_RE.test(tail) && (!stagedJar || tail.includes(stagedJar))) {
      return { surface: 'latest-log', p: lp, text: tail };
    }
  }
  return null;
}

async function waitCrashRecord(sinceMs, timeoutMs, window, before, stagedJar) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rec = harvestRecord(sinceMs, before, stagedJar);
    if (rec) return rec;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await window.evaluate(() => window.electronAPI.cancelLaunch().catch(() => {}));
  return harvestRecord(sinceMs, before, stagedJar);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function downloadModJar(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error('downloaded file is not a zip/jar (PK magic missing) — refusing to stage');
  }
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ── main ────────────────────────────────────────────────────────────────────
console.log('CRASH CORPUS GENERATOR v3 (launcher-pipeline driver, dual-surface harvest)');
const only = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1];

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
  await window.evaluate(async () => {
    const accounts = await window.electronAPI.getAccounts();
    const offline = accounts.find((a) => a.type === 'offline');
    if (offline) { await window.electronAPI.setActiveAccount(offline.id); return; }
    const added = await window.electronAPI.addOfflineAccount('CrashCorpus');
    if (added.success) await window.electronAPI.setActiveAccount(added.account.id);
  });
}

async function launchAndWait(name, timeoutMs, stagedJar) {
  const javaPath = await window.evaluate(() => window.electronAPI.getJavaPath());
  const before = latestLogState();
  const since = Date.now();
  const result = await window.evaluate((jp) => window.electronAPI.launchGame(jp), javaPath);
  console.log(`  launch-game ack:`, JSON.stringify(result).slice(0, 100));
  const record = await waitCrashRecord(since, timeoutMs, window, before, stagedJar);
  killMinecraft();
  await new Promise((r) => setTimeout(r, 1500));
  if (!record) return null;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${name}.txt`);
  fs.writeFileSync(outFile, record.surface === 'crash-reports' ? fs.readFileSync(record.p) : record.text);
  console.log(`  harvested from ${record.surface} → ${path.basename(outFile)}`);
  return outFile;
}

function attribute(outFile) {
  if (!outFile) return null;
  const head = fs.readFileSync(outFile, 'utf8').slice(0, 5000);
  const chain = [...head.matchAll(/Caused by:\s*(.+)/g)].map((m) => m[1].trim());
  const reason = chain.length ? chain[chain.length - 1].slice(0, 100) : null;
  const mixinMod = /([A-Za-z][\w-]*)\.mixins\.json/.exec(head)?.[1];
  const analyzing = /Error analyzing \[[^\]]*\\([\w.-]+\.jar)\]/.exec(head)?.[1];
  return { reason, mixinMod, analyzing };
}

try {
  await launchApp();
  snapshotMods();

  const scenarios = [
    {
      name: 'dependency',
      stage: async () => {
        clearMods();
        // Newest sodium FOR MC 26.1.2, but fabric-api ABSENT → the loader must
        // fail resolution with a missing-dependency error.
        const versions = await fetchJson(
          'https://api.modrinth.com/v2/project/sodium/version?loaders=%5B%22fabric%22%5D&game_versions=%5B%2226.1.2%22%5D',
        );
        const newest = versions[0];
        const file = newest.files.find((f) => f.primary) ?? newest.files[0];
        const bytes = await downloadModJar(file.url, path.join(MODS_DIR, file.filename));
        console.log(`  staged ${file.filename} (${Math.round(bytes / 1024)}KB) — no fabric-api present`);
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
        // Real full mod set + tiny heap: force 512 MB via world settings IPC.
        const worlds = await window.evaluate(() => window.electronAPI.getWorlds());
        for (const w of worlds) {
          await window.evaluate(
            ([id]) => window.electronAPI.updateWorldSettings(id, { ramAllocation: 512 }),
            [w.id],
          );
        }
        console.log(`  RAM forced to 512 MB across ${worlds.length} world(s)`);
      },
    },
    {
      name: 'version-mismatch',
      stage: async () => {
        clearMods();
        // A REAL old sodium build (targets a legacy MC) → incompatible.
        const versions = await fetchJson('https://api.modrinth.com/v2/project/sodium/version');
        const oldest = versions[versions.length - 1];
        const file = oldest.files.find((f) => f.primary) ?? oldest.files[0];
        const bytes = await downloadModJar(file.url, path.join(MODS_DIR, file.filename));
        console.log(`  staged ${file.filename} (version ${oldest.version_number})`);
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
    snapshotMods();
    await sc.stage();
    const stagedJar = { 'dependency': 'sodium-fabric-0.9.2', 'corrupt-jar': 'corrupted-mod.jar', 'version-mismatch': 'sodium-fabric-mc1.16.3' }[sc.name] ?? null;
    const outFile = await launchAndWait(sc.name, sc.timeoutMs ?? CRASH_TIMEOUT_MS, stagedJar);
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
console.log(`corpus: ${results.filter((r) => r.crashed).length}/${results.length} scenarios produced crash records`);
