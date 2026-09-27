/**
 * Capture README screenshots from the REAL app.
 *
 * Boots the compiled Electron app (out/main/index.js) on a throwaway user-data
 * dir seeded with an offline account and one already-played world, then writes
 * docs/screenshots/*.png. Dev tool only — playwright is already a devDependency,
 * nothing is added to the runtime, and no production file is touched.
 *
 * Usage: npm run build && node scripts/capture-screenshots.mjs
 */

import { _electron } from 'playwright';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const outDir = path.resolve('docs/screenshots');
fs.mkdirSync(outDir, { recursive: true });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-shot-'));
const iso = new Date().toISOString();

fs.writeFileSync(
  path.join(scratch, 'identity.json'),
  JSON.stringify(
    {
      accounts: [
        {
          id: 'shot',
          type: 'offline',
          username: 'ember',
          uuid: '99999999-9999-3999-8999-999999999999',
          createdAt: iso,
          lastUsedAt: iso,
        },
      ],
      activeAccountId: 'shot',
      sessions: { shot: { accountId: 'shot', authenticated: true, lastValidatedAt: iso } },
    },
    null,
    2,
  ),
);

// lastPlayedAt is set so the first-boot expectation line is NOT in the shot —
// the screenshot shows the steady state, not the onboarding moment.
fs.writeFileSync(
  path.join(scratch, 'worlds.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      activeWorldId: 'shot-world',
      worlds: [
        {
          id: 'shot-world',
          name: 'Ember SMP',
          type: 'managed',
          version: '26.1.2',
          loader: 'fabric',
          loaderVersion: '0.19.3',
          rootPath: '{userData}/minecraft',
          assignedServer: null,
          mods: [],
          resourcePacks: [],
          ramAllocation: 4096,
          resolution: null,
          javaPath: null,
          iconPath: null,
          createdAt: 0,
          lastPlayedAt: Date.now(),
          imported: false,
          broken: false,
        },
      ],
    },
    null,
    2,
  ),
);

const app = await _electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${scratch}`],
  timeout: 40_000,
});

let window = null;
const t0 = Date.now();
while (Date.now() - t0 < 35_000) {
  for (const w of app.windows()) {
    if (/renderer[\\/]index\.html/.test(w.url())) {
      window = w;
      break;
    }
  }
  if (window) break;
  await new Promise((r) => setTimeout(r, 400));
}
if (!window) throw new Error('main window never appeared');
await window.waitForLoadState('domcontentloaded');

// Let the hero settle (WebGL warm-up + auth check + world load).
await window.waitForTimeout(8_000);
await window.screenshot({ path: path.join(outDir, 'play.png') });
console.log('wrote docs/screenshots/play.png');

// Worlds view — keep-alive nav, so a click is enough.
const clicked = await window.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Worlds');
  if (!btn) return false;
  btn.click();
  return true;
});
if (clicked) {
  await window.waitForTimeout(4_000);
  await window.screenshot({ path: path.join(outDir, 'worlds.png') });
  console.log('wrote docs/screenshots/worlds.png');
}

await app.close().catch(() => {});
fs.rmSync(scratch, { recursive: true, force: true });
