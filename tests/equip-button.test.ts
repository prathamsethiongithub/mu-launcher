// tests/equip-button.test.ts — the four-state equip ceremony machine.

import { describe, expect, it } from 'vitest';
import { equipButtonKind } from '../src/shared/studio-ritual';

const base = {
  previewed: true,
  heroMissing: false,
  isActiveSkin: false,
  canWearCustom: true,
  phase: 'idle' as const,
};

describe('equipButtonKind', () => {
  it('idle: a previewed, unequipped, wearable skin earns the amber button', () => {
    expect(equipButtonKind(base).kind).toBe('idle');
  });

  it('busy and dissolving outrank everything else about the skin', () => {
    expect(equipButtonKind({ ...base, phase: 'busy' }).kind).toBe('busy');
    expect(equipButtonKind({ ...base, phase: 'dissolving' }).kind).toBe('dissolving');
    // even when the skin already reads as active
    expect(
      equipButtonKind({ ...base, isActiveSkin: true, phase: 'busy' }).kind,
    ).toBe('busy');
  });

  it('an already-active skin shows fine text, never a second amber button', () => {
    expect(equipButtonKind({ ...base, isActiveSkin: true }).kind).toBe('wearing');
  });

  it('offline accounts get the disabled kind with its reason slot', () => {
    expect(
      equipButtonKind({ ...base, canWearCustom: false }).kind,
    ).toBe('disabled-offline');
    // busy still wins: the request was already accepted before sign-out
    expect(
      equipButtonKind({ ...base, canWearCustom: false, phase: 'busy' }).kind,
    ).toBe('busy');
  });

  it('a missing library file can never be equipped', () => {
    expect(equipButtonKind({ ...base, heroMissing: true }).kind).toBe('missing');
    expect(
      equipButtonKind({ ...base, heroMissing: true, isActiveSkin: true }).kind,
    ).toBe('missing');
  });

  it('not previewing = the hero wears the account skin: no button unless stale', () => {
    expect(equipButtonKind({ ...base, previewed: false, isActiveSkin: true }).kind).toBe('wearing');
    // preview reset while wearingHash is still settling → stay idle, no flash of "wearing"
    expect(equipButtonKind({ ...base, previewed: false, isActiveSkin: false }).kind).toBe('idle');
  });
});
