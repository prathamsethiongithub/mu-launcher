import React from 'react';
import { View } from '../../App';
import { FloatingDockDesktop, DockItem } from './ui/floating-dock';

interface FloatingDockNavProps {
  currentView: View;
  onNavigate: (view: View) => void;
  hasLaunchedBefore: boolean;
}

const navMap: { view: View; title: string }[] = [
  { view: 'auth', title: 'Account' },
  { view: 'play', title: 'Play' },
  { view: 'settings', title: 'Settings' },
];

const KEY_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
  </svg>
);

const PLAY_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <polygon points="6,3 20,12 6,21" />
  </svg>
);

const GEAR_ICON = (
  <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const ICON_MAP: Record<string, React.ReactNode> = {
  auth: KEY_ICON,
  play: PLAY_ICON,
  settings: GEAR_ICON,
};

/** Color for the active dock icon — uses text-mu-accent (orange) */
const ACTIVE_COLOR = '#E38330';
/** Default color for inactive icons */
const DEFAULT_COLOR = 'rgba(136, 136, 145, 0.6)';

function withColor(node: React.ReactNode, color: string): React.ReactNode {
  return React.cloneElement(node as React.ReactElement, { style: { color, stroke: color, fill: 'none' } });
}

const FloatingDockNav: React.FC<FloatingDockNavProps> = ({
  currentView,
  onNavigate,
  hasLaunchedBefore,
}) => {
  const items: DockItem[] = navMap.map(({ view, title }) => ({
    title,
    icon: withColor(ICON_MAP[view], currentView === view ? ACTIVE_COLOR : DEFAULT_COLOR),
    onClick: () => onNavigate(view),
  }));

  return (
    <div className="flex flex-col items-center gap-3 py-6 pl-3">
      {/* Ember memory marker */}
      {hasLaunchedBefore && (
        <div className="w-[4px] h-[4px] rounded-full bg-mu-primary/30 mb-1" />
      )}

      <FloatingDockDesktop
        items={items}
        activeItem={currentView}
      />
    </div>
  );
};

export default FloatingDockNav;
