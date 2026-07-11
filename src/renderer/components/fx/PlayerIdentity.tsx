import React, { memo, useEffect, useState } from 'react';
import SkinViewerCanvas from './SkinViewerCanvas';

/**
 * The identity object — the signed-in player's skin, staged in the
 * world-beacon's light. Thin wrapper around SkinViewerCanvas that
 * fetches the active player's skin through the existing getSkin bridge.
 *
 * Public API preserved: { energetic?: boolean }
 */

interface PlayerIdentityProps {
  energetic?: boolean;
}

const PlayerIdentity: React.FC<PlayerIdentityProps> = ({ energetic = false }) => {
  const [skinUrl, setSkinUrl] = useState<string | null>(null);
  const [model, setModel] = useState<'slim' | 'default'>('default');

  useEffect(() => {
    if (typeof window.electronAPI?.getSkin !== 'function') {
      console.warn('[player-identity] getSkin bridge missing');
      return;
    }

    let cancelled = false;
    window.electronAPI
      .getSkin()
      .then((skin) => {
        if (cancelled || !skin) return;
        setSkinUrl(skin.dataUrl);
        setModel(skin.model);
      })
      .catch((err) => {
        console.warn('[player-identity] skin render failed:', err);
      });

    return () => { cancelled = true; };
  }, []);

  return (
    <SkinViewerCanvas
      skinUrl={skinUrl}
      model={model}
      energetic={energetic}
    />
  );
};

export default memo(PlayerIdentity);