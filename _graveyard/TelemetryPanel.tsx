import React from 'react';

interface TelemetryPanelProps {
  isOnline: boolean;
  playerCount: number;
}

const TelemetryPanel: React.FC<TelemetryPanelProps> = ({ isOnline, playerCount }) => {
  return (
    <div className="glass-card p-4 space-y-3">
      {/* Player count */}
      <div>
        <div className="text-[10px] text-mu-muted uppercase tracking-[0.1em] mb-0.5">Players</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[26px] font-semibold text-mu-primary tabular-nums leading-none">
            {isOnline ? playerCount : '—'}
          </span>
          <span className="text-[10px] text-mu-muted">online</span>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-mu-success' : 'bg-mu-muted/40'}`} />
        <span className="text-mu-muted">{isOnline ? 'Online' : 'Offline'}</span>
      </div>
    </div>
  );
};

export default TelemetryPanel;
