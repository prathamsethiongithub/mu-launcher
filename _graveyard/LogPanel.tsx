import React, { useEffect, useRef, useState } from 'react';

interface LogEntry {
  id: number;
  text: string;
  timestamp: string;
}

const SAMPLE_LOGS: LogEntry[] = [
  { id: 1, text: 'Server status: online', timestamp: '00:00' },
  { id: 2, text: 'Session restored for prathammmm', timestamp: '00:01' },
  { id: 3, text: 'Telemetry: 127 players', timestamp: '00:02' },
  { id: 4, text: 'World data loaded', timestamp: '00:03' },
  { id: 5, text: 'Connection established', timestamp: '00:04' },
];

const LogPanel: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>(SAMPLE_LOGS);
  const counterRef = useRef(5);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      counterRef.current++;
      const msgs = [
        'Heartbeat OK',
        'Chunk loaded at spawn',
        'Player count updated',
        'Server tick: 20.0',
        'Backup verified',
      ];
      const entry: LogEntry = {
        id: counterRef.current,
        text: msgs[Math.floor(Math.random() * msgs.length)],
        timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      };
      setLogs((prev) => [...prev.slice(-50), entry]);
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="glass-card p-4 h-full flex flex-col">
      <div className="text-[11px] font-medium text-mu-muted uppercase tracking-[0.15em] mb-3 shrink-0">
        Activity
      </div>

      <div className="flex-1 overflow-hidden relative">
        <div className="absolute inset-0 overflow-y-auto scrollbar-thin"
             style={{ maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)' }}>
          <div className="space-y-1.5">
            {logs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-2 animate-fade-in"
                style={{ animationDelay: '0ms', animationDuration: '300ms' }}
              >
                <span className="text-[10px] text-[#555557] font-mono shrink-0 mt-[2px]">
                  {log.timestamp}
                </span>
                <span className="text-[12px] text-mu-muted/80 leading-snug">
                  {log.text}
                </span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default LogPanel;
