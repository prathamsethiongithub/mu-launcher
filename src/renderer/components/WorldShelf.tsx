import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The World Shelf — an interactive 3D shelf of world cards.
 *
 * The scene itself lives in `public/shelf/shelf.html`: the canonical ThreeUI
 * CompleteShelfLandingPage renderer with its hardcover objects replaced by
 * card objects and its static book list replaced by this postMessage
 * contract. See docs/world-shelf/PROVENANCE.md.
 *
 *   parent → shelf   { type: 'worlds', worlds }   rebuild the shelf
 *                    { type: 'pause' }            stop the render loop
 *                    { type: 'resume' }           restart it
 *   shelf → parent   { type: 'shelf-ready' }      the renderer has booted
 *                    { type: 'world-selected', worldId }
 *                    { type: 'play-requested', worldId }
 */

export interface ShelfWorld {
  id: string;
  title: string;
  subtitle: string;
  /** No screenshot capture exists in Ember; the shelf draws a colour field. */
  coverImage: string | null;
  accentColor: string | null;
  metadata: {
    version: string;
    loader: string;
    ram: number;
    /** "sodium · lithium + 5 more" — derived from the world's enabled mods. */
    modSummary: string;
    lastPlayed: string;
    server: string | null;
    deck: string;
  };
  serverStatus: 'online' | 'offline' | 'none';
  isActive: boolean;
}

interface WorldShelfProps {
  worlds: ShelfWorld[];
  onSelectWorld?: (worldId: string) => void;
  onPlayWorld?: (worldId: string) => void;
  /** False while the Worlds view is hidden — the shelf parks its render loop. */
  active?: boolean;
  className?: string;
  /** Rendered over the shelf; used for empty states and the manage toggle. */
  children?: React.ReactNode;
}

const ACCENT_HUES = [18, 34, 46, 96, 150, 188, 214, 258, 292, 330];

/** FNV-1a, matching the shelf's own hash so a world keeps one colour. */
function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** The accent a world's card uses. Nothing is stored: the id decides. */
export function worldAccent(id: string): string {
  const seed = hashSeed(id);
  const hue = ACCENT_HUES[seed % ACCENT_HUES.length];
  const lightness = 40 + ((seed >>> 8) % 3) * 5;
  return `hsl(${hue} 34% ${lightness}%)`;
}

/** "sodium · lithium + 5 more" from a world's enabled mod list. */
export function modStackSummary(names: string[]): string {
  if (names.length === 0) return 'No mods';
  const shown = names.slice(0, 2).join(' · ');
  const rest = names.length - 2;
  return rest > 0 ? `${shown} + ${rest} more` : shown;
}

const WorldShelf: React.FC<WorldShelfProps> = ({
  worlds,
  onSelectWorld,
  onPlayWorld,
  active = true,
  className,
  children,
}) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  // Callbacks live in refs so the message listener never has to be rebound
  // (and never goes stale between renders).
  const selectRef = useRef(onSelectWorld);
  const playRef = useRef(onPlayWorld);
  selectRef.current = onSelectWorld;
  playRef.current = onPlayWorld;

  const post = useCallback((payload: unknown) => {
    frameRef.current?.contentWindow?.postMessage(payload, '*');
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the shelf frame may drive this component.
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; worldId?: string } | null;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'shelf-ready') {
        setReady(true);
        return;
      }
      if (data.type === 'world-selected' && data.worldId) {
        selectRef.current?.(data.worldId);
        return;
      }
      if (data.type === 'play-requested' && data.worldId) {
        playRef.current?.(data.worldId);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Send worlds on boot and whenever the list changes.
  useEffect(() => {
    if (!ready) return;
    post({ type: 'worlds', worlds });
  }, [ready, worlds, post]);

  // Park the render loop while the view is hidden — the same discipline
  // PlayView uses, so a backgrounded shelf costs nothing.
  useEffect(() => {
    if (!ready) return;
    post({ type: active ? 'resume' : 'pause' });
  }, [ready, active, post]);

  return (
    // h-full/w-full by default: the shelf fills whatever box it is given. A
    // zero-height wrapper collapses the frame's viewport, and the card anchor
    // maths has nothing to project against.
    <div className={`relative h-full w-full ${className || ''}`}>
      <iframe
        ref={frameRef}
        src="./shelf/shelf.html"
        title="World shelf"
        className="absolute inset-0 h-full w-full border-0"
        // No sandbox attribute on purpose: a sandboxed frame gets an opaque
        // origin, which would block its own same-origin module imports
        // (three.js r165 is vendored beside it). The document is first-party,
        // ships with `connect-src 'none'`, and the browser window itself runs
        // with sandbox: true.
      />
      {children && <div className="pointer-events-none absolute inset-0">{children}</div>}
    </div>
  );
};

export default WorldShelf;
