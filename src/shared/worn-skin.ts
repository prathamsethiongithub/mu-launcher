/**
 * Worn-skin resolution — the pure heart of the mirror fix (19-IDENTITY-STUDIO §5.2).
 *
 * The Studio hero previously rendered bundled Steve whenever no card was
 * previewed, even while the chip read "worn skin" and the shelf underlined a
 * matching entry (the amber mark ran on the wearingHash from
 * 'skins-wearing-hash', but the hero texture was never resolved). This module
 * keeps every decision pure so the browser only executes its verdicts.
 *
 * Tri-state contract (AGENT-HANDBOOK trap #2, inherited verbatim):
 *   undefined — still resolving → the hero renders nothing (Steve never flashes)
 *   null      — confirmed no custom skin → bundled Steve, honestly
 *   string    — a resolved skin data URL (library bytes or worn texture)
 */

export interface WornSkinInputs {
  /** True while any precondition of the resolve is still in flight. */
  resolving: boolean;
  /**
   * sha1 (hex) of the bytes the account is actually wearing — the honesty
   * anchor from 'skins-wearing-hash'. null = not yet known or none worn.
   */
  wearingHash: string | null;
  /** The account's worn texture as a data URL, resolved cache-first. */
  wornDataUrl: string | null;
  /** The account's arm model as reported by the skin-service path. */
  wornModel: 'classic' | 'slim' | null;
  /** The wardrobe. */
  skins: ReadonlyArray<{ id: string; hash: string; dataUrl: string | null }>;
}

export interface WornSkinVerdict {
  /** undefined = resolving · null = confirmed no custom skin · string = data URL. */
  url: string | null | undefined;
  /** Arm model for the hero viewer (only meaningful when url is a string). */
  model: 'classic' | 'slim' | null;
  /**
   * The library entry whose bytes the hero is showing. Non-null ⇒ the hero
   * wears library bytes (amber underline stays truthful via the same hash).
   */
  entry: { id: string; hash: string; dataUrl: string | null } | null;
  /** True when the worn texture comes from outside the library (mirror banner). */
  fromOutsideEmber: boolean;
}

/**
 * Resolve what the non-preview hero must show.
 *
 * Precedence:
 * 1. resolving → undefined (wait, never flash Steve)
 * 2. no worn texture → null (confirmed no custom skin → bundled Steve)
 * 3. worn hash matches a library entry → that entry's dataUrl (guaranteed
 *    equal to wornDataUrl: both are the same sha1-verified bytes)
 * 4. otherwise → the real worn texture + outside-ember banner
 */
export function resolveWornSkin(inputs: WornSkinInputs): WornSkinVerdict {
  if (inputs.resolving) {
    return { url: undefined, model: null, entry: null, fromOutsideEmber: false };
  }

  if (!inputs.wornDataUrl) {
    return { url: null, model: null, entry: null, fromOutsideEmber: false };
  }

  const entry = inputs.wearingHash
    ? inputs.skins.find((s) => s.hash === inputs.wearingHash) ?? null
    : null;

  if (entry) {
    // Prefer the entry's own dataUrl (it is the exact bytes the hash names).
    return { url: entry.dataUrl, model: inputs.wornModel, entry, fromOutsideEmber: false };
  }

  return {
    url: inputs.wornDataUrl,
    model: inputs.wornModel,
    entry: null,
    fromOutsideEmber: true,
  };
}
