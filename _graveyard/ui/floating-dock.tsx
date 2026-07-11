'use client';

import React, { useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from 'motion/react';

export interface DockItem {
  title: string;
  icon: React.ReactNode;
  onClick?: () => void;
}

interface FloatingDockProps {
  items: DockItem[];
  activeItem?: string;
  desktopClassName?: string;
}

export const FloatingDockDesktop: React.FC<{
  items: DockItem[];
  activeItem?: string;
  className?: string;
}> = ({ items, activeItem, className }) => {
  const mouseY = useMotionValue(Infinity);

  return (
    <motion.div
      onMouseMove={(e) => mouseY.set(e.pageY)}
      onMouseLeave={() => mouseY.set(Infinity)}
      className={cn(
        'flex-col items-center gap-5 rounded-2xl px-3 py-6',
        'bg-[rgba(20,20,22,0.6)] backdrop-blur-2xl',
        'border border-[rgba(255,255,255,0.04)]',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]',
        className
      )}
    >
      {items.map((item) => (
        <IconContainer
          key={item.title}
          mouseY={mouseY}
          active={activeItem === item.title.toLowerCase()}
          {...item}
        />
      ))}
    </motion.div>
  );
};

function IconContainer({
  mouseY,
  title,
  icon,
  onClick,
  active,
}: {
  mouseY: ReturnType<typeof useMotionValue>;
  title: string;
  icon: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);

  const distance = useTransform(mouseY, (val) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { y: 0, height: 0 };
    return val - bounds.y - bounds.height / 2;
  });

  const sizeTransform = useTransform(distance, [-150, 0, 150], [40, 72, 40]);
  const iconSizeTransform = useTransform(distance, [-150, 0, 150], [18, 32, 18]);

  const width = useSpring(sizeTransform, {
    mass: 0.3,
    stiffness: 300,
    damping: 20,
  });
  const height = useSpring(sizeTransform, {
    mass: 0.3,
    stiffness: 300,
    damping: 20,
  });

  const iconWidth = useSpring(iconSizeTransform, {
    mass: 0.3,
    stiffness: 300,
    damping: 20,
  });
  const iconHeight = useSpring(iconSizeTransform, {
    mass: 0.3,
    stiffness: 300,
    damping: 20,
  });

  return (
    <button
      ref={ref}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative flex items-center justify-center rounded-full transition-shadow duration-300 outline-none focus-visible:ring-2 focus-visible:ring-mu-primary/50"
      style={{
        background: active
          ? 'radial-gradient(circle at 50% 40%, rgba(255,188,19,0.2), rgba(255,188,19,0.05))'
          : 'rgba(255,255,255,0.04)',
        border: active
          ? '1px solid rgba(255,188,19,0.15)'
          : '1px solid rgba(255,255,255,0.04)',
        boxShadow: active
          ? '0 0 12px rgba(255,188,19,0.15)'
          : hovered
            ? '0 0 20px rgba(255,188,19,0.10)'
            : 'none',
      }}
    >
      <motion.div
        style={{ width, height }}
        className="flex items-center justify-center rounded-full"
      >
        <motion.div
          style={{ width: iconWidth, height: iconHeight }}
          className="flex items-center justify-center"
        >
          {icon}
        </motion.div>
      </motion.div>

      {/* Tooltip */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -2 }}
            className="absolute left-full ml-3 w-fit rounded-lg border border-[rgba(255,255,255,0.06)] bg-[rgba(20,20,22,0.95)] backdrop-blur-xl px-3 py-1.5 text-[12px] text-mu-muted whitespace-nowrap pointer-events-none"
          >
            {title}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active indicator bar */}
      {active && (
        <motion.div
          layoutId="dock-active"
          className="absolute -left-[9px] w-[3px] h-[20px] rounded-full bg-mu-primary"
          style={{ boxShadow: '0 0 6px rgba(255,188,19,0.4)' }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        />
      )}
    </button>
  );
}
