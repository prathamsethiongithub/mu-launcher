/**
 * Oracle corpus validation — the crash corpus is ground truth; this test
 * asserts the Oracle attributes each real (or synthetic-surface) record
 * correctly. Uses the exported pure functions from crash-diagnostic.ts.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectReason, detectModName } from '../src/main/crash-diagnostic';

const CORPUS = path.resolve('tests/fixtures/crash-corpus');

interface CorpusEntry {
  scenario: string;
  crashed: boolean;
  file: string | null;
  asExpected: boolean;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'),
) as { scenarios: CorpusEntry[] };

describe('oracle vs crash corpus', () => {
  for (const entry of manifest.scenarios) {
    if (!entry.file) {
      it(`[${entry.scenario}] no harvestable crash file — recorded honestly, oracle N/A`, () => {
        // These scenarios DID run (v2 drives the real pipeline); their crash
        // surface either produced no report within the window (oom: 512 MB
        // held; version-mismatch: surface not yet captured) or the run was
        // intentionally clean (clean-baseline). The manifest records reality.
        expect(entry.crashed).toBe(false);
      });
      continue;
    }

    const head = fs.readFileSync(path.join(CORPUS, entry.file), 'utf8').slice(0, 5000);

    it(`[${entry.scenario}] oracle attributes the failure`, () => {
      const reason = detectReason(head);
      const modName = detectModName(head);
      // A crashed record MUST yield a reason (that is the Oracle's core job).
      expect(reason, 'reason must be detected from the corpus record').toBeTruthy();
      // Pre-launch Fabric failures surface as resolution errors.
      if (/ModResolutionException/.test(head)) {
        expect(reason).toMatch(/Mod resolution|Mod discovery|Missing|Caused/i);
      }
      if (/Mixin apply failed/.test(head)) {
        expect(reason).toMatch(/Mixin apply failed/i);
      }
      // modName is best-effort; if found it must not be a vanilla package.
      if (modName) {
        expect(modName.toLowerCase()).not.toMatch(/^(minecraft|java|mojang|fabric)$/);
      }
      expect(entry.asExpected).toBe(true);
    });
  }

  it('corpus manifest exists and carries scenarios', () => {
    expect(manifest.scenarios.length).toBeGreaterThanOrEqual(6);
  });
});
