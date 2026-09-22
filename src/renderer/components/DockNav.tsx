import React from 'react';
import { View } from '../App';

interface DockNavProps {
  currentView: View;
  onNavigate: (view: View) => void;
}

/**
 * Segmented rail: four nouns on one elevated surface.
 * Order: Play · Worlds · Account · Setup (act, places, person, machine).
 * Never amber — the ember is reserved for the primary action (Law 1).
 *
 * Overflow law: the rail lives IN FLOW (Layout's bottom slot reserves its
 * height) — it used to be `fixed bottom-16`, a layer outside layout that
 * every view's content could flow under: measured at 900x600 the Play CTA
 * (bottom 545) was covered by the dock band (top 492), hit-testing to the
 * Account tab. In flow, nothing can ever intersect it at any window size.
 */
const ITEMS: { id: View; label: string; icon: React.ReactNode }[] = [
  {
    id: 'play',
    label: 'Play',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <polygon points="7,4 20,12 7,20" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'worlds',
    label: 'Worlds',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <rect x="13" y="3" width="8" height="8" rx="2" />
        <rect x="3" y="13" width="18" height="8" rx="2" />
      </svg>
    ),
  },
  {
    id: 'auth',
    label: 'Account',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c1.2-3.2 3.8-5 7-5s5.8 1.8 7 5" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Setup',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
        <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
        <circle cx="16" cy="8" r="2" />
        <circle cx="8" cy="16" r="2" />
      </svg>
    ),
  },
];

const DockNav: React.FC<DockNavProps> = ({ currentView, onNavigate }) => {
  return (
    <nav className="flex items-center">
      <div className="glass flex items-center gap-0.5 rounded-full p-1">
        {ITEMS.map(({ id, label, icon }) => {
          const active = currentView === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-medium transition-colors duration-micro ease-exit ${
                active ? 'bg-white/[0.07] text-ink' : 'text-dim hover:bg-white/[0.03] hover:text-ink'
              }`}
            >
              {icon}
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default DockNav;