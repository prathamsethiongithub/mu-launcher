import React, { useMemo } from 'react';
import { motion } from 'motion/react';

/**
 * BlurText — premium state typography (React Bits pattern, motion/react).
 *
 * Words resolve out of a soft blur, staggered — typography "transitioning
 * between states", not a motion-graphics demo. Restrained by design:
 *   animateBy words (never letters), ~8px blur (never broken), tiny 6px
 *   vertical travel, crisp end state, ~80ms stagger, design ease.
 *
 * Used ONLY for the hero state word (Authenticating → Igniting → Forging →
 * Launching → In the world.): the parent <h1> is keyed on the state string,
 * so each transition remounts this component and replays the entrance.
 * The container keeps its geometry — no layout shift, the h1's classes
 * still own size/leading/balance.
 *
 * Accessibility: the full string is exposed once via aria-label on the
 * container; the animated word spans are aria-hidden, so screen readers
 * never read a word-by-word stutter.
 *
 * prefers-reduced-motion: render the same text as a plain span in the same
 * DOM position — static, readable, no animation, no separate composition.
 */

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]; // --ease-exit

interface BlurTextProps {
  text: string;
  /** ms before the first word starts (preserves the scene's entrance beat). */
  delay?: number;
  className?: string;
  animateBy?: 'words' | 'characters';
  /** ms between consecutive segment entrances. */
  stepDuration?: number;
}

const BlurText: React.FC<BlurTextProps> = ({
  text,
  delay = 0,
  className = '',
  animateBy = 'words',
  stepDuration = 80,
}) => {
  const reduced = usePrefersReducedMotion();

  // Split keeping whitespace tokens as separate entries, so line wrapping
  // stays natural (words are inline-block; spaces remain real spaces).
  const segments = useMemo(
    () => (animateBy === 'words' ? text.split(/(\s+)/) : Array.from(text)),
    [text, animateBy],
  );

  if (reduced) {
    return <span className={className}>{text}</span>;
  }

  let wordIndex = 0;
  return (
    <span className={className} aria-label={text}>
      {segments.map((seg, i) => {
        if (seg.trim() === '') return <React.Fragment key={i}>{seg}</React.Fragment>;
        const idx = wordIndex++;
        return (
          <motion.span
            key={i}
            aria-hidden
            style={{ display: 'inline-block', willChange: 'filter, transform, opacity' }}
            initial={{ opacity: 0, y: 6, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{
              delay: delay / 1000 + idx * (stepDuration / 1000),
              duration: 0.42,
              ease: EASE,
            }}
          >
            {seg}
          </motion.span>
        );
      })}
    </span>
  );
};

export default BlurText;
