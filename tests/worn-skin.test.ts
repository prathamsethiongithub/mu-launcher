import { describe, expect, it } from 'vitest';
import { resolveWornSkin } from '../src/shared/worn-skin';

const ENTRY_A = { id: 'a', hash: 'hash-a', dataUrl: 'data:image/png;base64,AAA' };
const ENTRY_B = { id: 'b', hash: 'hash-b', dataUrl: 'data:image/png;base64,BBB' };
const WORN = 'data:image/png;base64,OUT';

const base = {
  resolving: false,
  wearingHash: 'hash-a' as string | null,
  wornDataUrl: ENTRY_A.dataUrl,
  wornModel: 'slim' as 'classic' | 'slim' | null,
  skins: [ENTRY_A, ENTRY_B],
};

describe('resolveWornSkin', () => {
  it('resolving → undefined (hero renders nothing, Steve never flashes)', () => {
    const v = resolveWornSkin({ ...base, resolving: true });
    expect(v.url).toBeUndefined();
    expect(v.entry).toBeNull();
    expect(v.fromOutsideEmber).toBe(false);
  });

  it('no worn texture → null = confirmed no custom skin (honest Steve)', () => {
    const v = resolveWornSkin({ ...base, wornDataUrl: null, wornModel: null, wearingHash: null });
    expect(v.url).toBeNull();
    expect(v.entry).toBeNull();
    expect(v.fromOutsideEmber).toBe(false);
  });

  it('worn hash matches a library entry → that entry’s dataUrl wins', () => {
    const v = resolveWornSkin(base);
    expect(v.url).toBe(ENTRY_A.dataUrl);
    expect(v.entry).toBe(ENTRY_A);
    expect(v.model).toBe('slim');
    expect(v.fromOutsideEmber).toBe(false);
  });

  it('worn hash matches an entry whose file is missing → still that entry (no outside-ember lie)', () => {
    const missing = { id: 'a', hash: 'hash-a', dataUrl: null };
    const v = resolveWornSkin({ ...base, skins: [missing, ENTRY_B], wornDataUrl: WORN });
    expect(v.entry).toBe(missing);
    expect(v.fromOutsideEmber).toBe(false);
  });

  it('worn skin from outside ember → real texture + banner flag', () => {
    // hash-out names the worn bytes but is not in the library.
    const v = resolveWornSkin({ ...base, wearingHash: 'hash-out', wornDataUrl: WORN, wornModel: 'classic' });
    expect(v.url).toBe(WORN);
    expect(v.entry).toBeNull();
    expect(v.model).toBe('classic');
    expect(v.fromOutsideEmber).toBe(true);
  });

  it('worn texture known but hash unknown → outside ember (hash is the truth anchor)', () => {
    const v = resolveWornSkin({ ...base, wearingHash: null });
    expect(v.url).toBe(ENTRY_A.dataUrl);
    expect(v.entry).toBeNull();
    expect(v.fromOutsideEmber).toBe(true);
  });

  it('empty library with a worn skin → outside ember', () => {
    const v = resolveWornSkin({ ...base, skins: [] });
    expect(v.url).toBe(ENTRY_A.dataUrl);
    expect(v.fromOutsideEmber).toBe(true);
  });
});
