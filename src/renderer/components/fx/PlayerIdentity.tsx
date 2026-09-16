import React, { memo, useEffect, useState } from 'react';
import SkinViewerCanvas from './SkinViewerCanvas';

/**
 * The identity object — the signed-in player's skin, staged in the
 * world-beacon's light. Thin wrapper around SkinViewerCanvas that
 * fetches the active player's skin through the existing getSkin bridge.
 *
 * While the fetch is in flight the viewer stays hidden (undefined — Steve
 * must never flash as a loading placeholder). When getSkin resolves:
 * custom skin → custom; null (no skin / offline / fetch failed) → the
 * viewer's bundled default Steve. The fallback is display-only.
 *
 * Public API preserved: { energetic?: boolean }
 */

interface PlayerIdentityProps {
  energetic?: boolean;
}

interface ResolvedSkin {
  url: string | null;
  model: 'slim' | 'default';
}

const PlayerIdentity: React.FC<PlayerIdentityProps> = ({ energetic = false }) => {
  const [skin, setSkin] = useState<ResolvedSkin | null>(null);

  useEffect(() => {
    if (typeof window.electronAPI?.getSkin !== 'function') {
      console.warn('[player-identity] getSkin bridge missing');
      setSkin({ url: null, model: 'default' }); // no bridge → default look
      return;
    }

    let cancelled = false;
    window.electronAPI
      .getSkin()
      .then((result) => {
        if (cancelled) return;
        setSkin({ url: result?.dataUrl ?? null, model: result?.model ?? 'default' });
      })
      .catch((err) => {
        console.warn('[player-identity] skin render failed:', err);
        if (!cancelled) setSkin({ url: null, model: 'default' });
      });

    return () => { cancelled = true; };
  }, []);

  return (
    <SkinViewerCanvas
      skinUrl={skin ? skin.url : undefined}
      model={skin?.model ?? 'default'}
      energetic={energetic}
    />
  );
};

export default memo(PlayerIdentity);