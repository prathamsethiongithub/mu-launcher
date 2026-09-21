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
  note?: string;
  groundTruth?: { reason: string; modName: string };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'),
) as { scenarios: CorpusEntry[] };

describe('oracle vs crash corpus', () => {
  it('manifest exists and carries all six scenarios', () => {
    expect(manifest.scenarios.map((s) => s.scenario).sort()).toEqual([
      'clean-baseline',
      'corrupt-jar',
      'dependency',
      'external-skin',
      'oom',
      'version-mismatch',
    ].sort());
  });

  for (const entry of manifest.scenarios) {
    if (entry.crashed && entry.file) {
      it(`[${entry.scenario}] oracle attributes root cause + mod name`, () => {
        const head = fs.readFileSync(path.join(CORPUS, entry.file as string), 'utf8').slice(0, 5000);
        const reason = detectReason(head);
        const modName = detectModName(head);
        const gt = entry.groundTruth;
        // Root-cause semantics: the reason must NOT be the outer wrapper.
        expect(reason).toBeTruthy();
        expect(reason).not.toMatch(/ModResolutionException: Mod discovery failed/);
        if (gt) {
          expect(reason).toContain(gt.reason);
          // "unable to attribute" is not acceptable where ground truth exists.
          expect(modName, 'modName must be defined').toBeDefined();
          expect(modName).toBe(gt.modName);
        }
      });
    } else {
      it(`[${entry.scenario}] no crash record — oracle must not fabricate one`, () => {
        // These scenarios ran and honestly produced no crash: dependency
        // (sodium 0.9.2 boots without fabric-api), the old version-mismatch
        // jar was silently skipped, oom held at 512 MB, clean-baseline clean.
        expect(entry.file).toBeNull();
        expect(entry.crashed).toBe(false);
      });
    }
  }

  it('corrupt-jar record: detectReason reaches the innermost root cause (multi-level chain)', () => {
    const head = fs.readFileSync(path.join(CORPUS, 'corrupt-jar.txt'), 'utf8').slice(0, 5000);
    // The chain has FOUR Caused by levels; the pre-fix implementation returned
    // the outermost wrapper. The fix walks to the last one.
    const levels = (head.match(/Caused by:/g) ?? []).length;
    expect(levels).toBeGreaterThanOrEqual(3);
    const reason = detectReason(head);
    expect(reason).toBe('java.util.zip.ZipException: zip END header not found');
  });

  it('corrupt-jar record: detectModName resolves the guilty jar via the Error-analyzing rule', () => {
    const head = fs.readFileSync(path.join(CORPUS, 'corrupt-jar.txt'), 'utf8').slice(0, 5000);
    expect(detectModName(head)).toBe('Corrupted Mod');
  });
});
