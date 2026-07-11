import React from 'react';
import { View } from '../App';

interface IconSidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  hasLaunchedBefore: boolean;
}

const items: { view: View; icon: string; label: string }[] = [
  { view: 'auth', icon: 'key', label: 'Account' },
  { view: 'play', icon: 'play', label: 'Play' },
  { view: 'settings', icon: 'gear', label: 'Settings' },
];

const ICONS: Record<string, React.FC<{ active: boolean }>> = {
  key: ({ active }) => (
    <svg className={active ? 'text-mu-primary' : 'text-mu-muted/50'} width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  ),
  play: ({ active }) => (
    <svg className={active ? 'text-mu-primary' : 'text-mu-muted/50'} width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <polygon points="6,3 20,12 6,21" fill={active ? '#ffbc13' : 'none'} stroke="currentColor" />
    </svg>
  ),
  gear: ({ active }) => (
    <svg className={active ? 'text-mu-primary' : 'text-mu-muted/50'} width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

const IconSidebar: React.FC<IconSidebarProps> = ({ currentView, onNavigate, hasLaunchedBefore }) => {
  return (
    <div className="w-[48px] bg-[rgba(20,20,22,0.3)] border-r border-[rgba(255,255,255,0.04)] flex flex-col items-center py-4 gap-3 shrink-0">
      {/* Ember indicator */}
      {hasLaunchedBefore && (
        <div className="w-[4px] h-[4px] rounded-full bg-mu-primary/30 mb-1" />
      )}

      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = currentView === item.view;
        return (
          <button
            key={item.view}
            onClick={() => onNavigate(item.view)}
            className="group relative w-9 h-9 flex items-center justify-center rounded-lg hover:bg-[rgba(255,255,255,0.04)] transition-colors duration-200"
            title={item.label}
          >
            <Icon active={active} />
            {/* Tooltip */}
            <span className="absolute left-full ml-2 px-2 py-1 rounded-md bg-[#141416] border border-[rgba(255,255,255,0.06)] text-[11px] text-mu-muted whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none z-50">
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default IconSidebar;
