/**
 * Oracle Recovery mapping — the decision table, as tests.
 *
 * Ground rules under test:
 *   - the decision table rows (mod match × update availability, OOM,
 *     undefined) produce exactly the documented action sets;
 *   - an undefined attribution NEVER yields a repair action;
 *   - a mod the launcher cannot see in mods/ never earns a repair button;
 *   - OOM detection shares crash-diagnostic's OOM reason as fact source;
 *   - matching survives case/punctuation/version-tail noise.
 */

import { describe, expect, it } from 'vitest';
import {
  attributionConfidence,
  canonicalModKey,
  findMatchedMod,
  isOomReason,
  mapDiagnosisToActions,
  modNameMatchesFile,
  unmatchedModNote,
} from '../src/shared/oracle-recovery';
import { detectReason } from '../src/main/crash-diagnostic';

// ── canonicalModKey ──────────────────────────────────────────────────────────

describe('canonicalModKey', () => {
  it('collapses case, punctuation and separators', () => {
    expect(canonicalModKey('Sodium')).toBe('sodium');
    expect(canonicalModKey('sodium-extra')).toBe('sodiumextra');
    expect(canonicalModKey('sodium extra')).toBe('sodiumextra');
    expect(canonicalModKey('  Sodium_Extra  ')).toBe('sodiumextra');
  });

  it('keeps digits (version tails stay distinguishable)', () => {
    expect(canonicalModKey('corrupted-mod-1.0.jar')).toBe('corruptedmod10jar');
  });
});

// ── modNameMatchesFile ───────────────────────────────────────────────────────

describe('modNameMatchesFile', () => {
  const file = { filename: 'sodium-0.5.3.jar', displayName: 'Sodium' };

  it('matches on canonical equality', () => {
    expect(modNameMatchesFile('Sodium', file)).toBe(true);
    expect(modNameMatchesFile('sodium', file)).toBe(true);
  });

  it('matches when the file carries a version tail', () => {
    expect(modNameMatchesFile('sodium', { filename: 'sodium-0.5.3.jar', displayName: 'sodium-0.5.3' })).toBe(true);
  });

  it('matches substring containment (corrupt-jar shape)', () => {
    // Oracle prettifies the jar path → "Corrupted Mod"; the file is
    // "corrupted-mod-1.0.jar" — containment in both directions.
    expect(
      modNameMatchesFile('Corrupted Mod', { filename: 'corrupted-mod-1.0.jar', displayName: 'corrupted-mod-1.0' }),
    ).toBe(true);
  });

  it('refuses a too-vague diagnosis name (honesty floor)', () => {
    expect(modNameMatchesFile('Mo', file)).toBe(false);
    expect(modNameMatchesFile('ab', { filename: 'abc.jar', displayName: 'abc' })).toBe(false);
  });

  it('never matches an unrelated file', () => {
    expect(modNameMatchesFile('sodium', { filename: 'lithium-2.1.jar', displayName: 'Lithium' })).toBe(false);
  });
});

// ── isOomReason — same fact source as crash-diagnostic ───────────────────────

describe('isOomReason', () => {
  it('recognizes the exact OOM reason crash-diagnostic produces', () => {
    // The shared fact source: the reason string the Oracle itself emits.
    const oomReason = detectReason(
      'java.lang.OutOfMemoryError: Java heap space\n\tat java.base/java.lang.Thread.run(Unknown Source)',
    );
    expect(oomReason).toContain('OutOfMemoryError');
    expect(isOomReason(oomReason ?? undefined)).toBe(true);
  });

  it('rejects non-OOM reasons and undefined', () => {
    expect(isOomReason('Mixin apply failed')).toBe(false);
    expect(isOomReason('Unknown crash')).toBe(false);
    expect(isOomReason(undefined)).toBe(false);
  });
});

// ── attributionConfidence — the cascade ──────────────────────────────────────

describe('attributionConfidence', () => {
  it('specific mod name is high', () => {
    expect(attributionConfidence({ modName: 'Sodium', reason: 'Mixin apply failed' })).toBe('high');
  });

  it('OOM without a name is low', () => {
    expect(
      attributionConfidence({ reason: 'Out of memory (java.lang.OutOfMemoryError)' }),
    ).toBe('low');
  });

  it('undefined is unknown — never repairable', () => {
    expect(attributionConfidence({})).toBe('unknown');
    expect(attributionConfidence({ reason: 'Unknown crash' })).toBe('unknown');
  });
});

// ── mapDiagnosisToActions — the decision table ───────────────────────────────

describe('mapDiagnosisToActions — decision table', () => {
  const matchedMod = { filename: 'sodium-0.5.3.jar', displayName: 'Sodium', enabled: true };

  it('row 1: named mod, matched, update available → update + remove + console', () => {
    const actions = mapDiagnosisToActions(
      { modName: 'Sodium', reason: 'Mixin apply failed' },
      {
        mods: [matchedMod],
        updates: [{
          filename: 'sodium-0.5.3.jar',
          modId: 'sodium',
          downloadUrl: 'https://cdn.modrinth.com/x.jar',
          newFilename: 'sodium-0.6.0.jar',
        }],
      },
    );
    expect(actions.map((a) => a.id)).toEqual(['update-mod', 'remove-mod', 'open-console']);
    expect(actions[0].label).toBe('update sodium');
    expect(actions[1].label).toBe('remove it instead');
    expect(actions.every((a) => a.confidence === 'high')).toBe(true);
  });

  it('row 2: named mod, matched, no update → remove + console', () => {
    const actions = mapDiagnosisToActions(
      { modName: 'Sodium', reason: 'Mixin apply failed' },
      { mods: [matchedMod], updates: [] },
    );
    expect(actions.map((a) => a.id)).toEqual(['remove-mod', 'open-console']);
    expect(actions[0].label).toBe('remove it');
  });

  it('row 3: named mod, NOT installed → console only (honest)', () => {
    const actions = mapDiagnosisToActions(
      { modName: 'Some External Mod', reason: 'Mixin apply failed' },
      { mods: [matchedMod], updates: [] },
    );
    expect(actions.map((a) => a.id)).toEqual(['open-console']);
  });

  it('row 4: OOM reason → adjust-memory + console', () => {
    const actions = mapDiagnosisToActions(
      { reason: 'Out of memory (java.lang.OutOfMemoryError)' },
      { mods: [matchedMod], updates: [] },
    );
    expect(actions.map((a) => a.id)).toEqual(['adjust-memory', 'open-console']);
    expect(actions[0].label).toBe('give it more memory');
    expect(actions[0].confidence).toBe('low');
  });

  it('row 5: undefined attribution → console only, NEVER a repair action', () => {
    expect(mapDiagnosisToActions({}, { mods: [matchedMod] })).toEqual([
      { id: 'open-console', label: 'show evidence', confidence: 'high', diagnosis: {} },
    ]);
    // Reason present but unattributed — same outcome.
    expect(
      mapDiagnosisToActions({ reason: 'Unknown crash' }, { mods: [matchedMod] }).map((a) => a.id),
    ).toEqual(['open-console']);
  });

  it('mod actions carry the execution handle (filename)', () => {
    const actions = mapDiagnosisToActions(
      { modName: 'Sodium', reason: 'Mixin apply failed' },
      { mods: [matchedMod], updates: [] },
    );
    expect(actions[0].filename).toBe('sodium-0.5.3.jar');
  });

  it('empty context never throws and still yields the console fallback', () => {
    expect(mapDiagnosisToActions({ modName: 'Sodium' }).map((a) => a.id)).toEqual(['open-console']);
  });
});

// ── matching via the update checker's identity resolution ────────────────────

describe('findMatchedMod', () => {
  it('prefers the update list when it names the mod', () => {
    const mods = [
      { filename: 'sodium-0.5.3.jar', displayName: 'Sodium', enabled: true },
      { filename: 'sodiumextra-1.0.jar', displayName: 'Sodium Extra', enabled: true },
    ];
    const hit = findMatchedMod('Sodium Extra', {
      mods,
      updates: [{ filename: 'sodiumextra-1.0.jar', modId: 'sodium-extra', downloadUrl: 'u', newFilename: 'n' }],
    });
    expect(hit?.file.filename).toBe('sodiumextra-1.0.jar');
    expect(hit?.update?.modId).toBe('sodium-extra');
  });

  it('prefers enabled mods over disabled duplicates', () => {
    const hit = findMatchedMod('Sodium', {
      mods: [
        { filename: 'sodium.jar.disabled', displayName: 'Sodium', enabled: false },
        { filename: 'sodium-0.5.3.jar', displayName: 'Sodium', enabled: true },
      ],
    });
    expect(hit?.file.filename).toBe('sodium-0.5.3.jar');
  });

  it('returns null when nothing matches', () => {
    expect(findMatchedMod('Sodium', { mods: [{ filename: 'lithium.jar', displayName: 'Lithium' }] })).toBeNull();
    expect(findMatchedMod('Sodium', {})).toBeNull();
  });
});

// ── unmatchedModNote — the honest external-source line ───────────────────────

describe('unmatchedModNote', () => {
  it('returns the honest note for an uninstalled mod', () => {
    expect(
      unmatchedModNote({ modName: 'Some External Mod' }, { mods: [] }),
    ).toBe("some external mod isn't installed here — this launcher can't fix it. details in the console.");
  });

  it('returns null when matched or unnamed', () => {
    expect(
      unmatchedModNote({ modName: 'Sodium' }, { mods: [{ filename: 'sodium.jar', displayName: 'Sodium' }] }),
    ).toBeNull();
    expect(unmatchedModNote({}, {})).toBeNull();
  });
});
