import React, { useEffect, useRef, useState } from 'react';

interface CrucibleProps {
  isOnline: boolean;
  isLaunching: boolean;
}

const Crucible: React.FC<CrucibleProps> = ({ isOnline, isLaunching }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const playerDots = useRef<{ x: number; y: number; phase: number; speed: number }[]>([]);
  const pulseRef = useRef(0);

  // Generate random player dots
  useEffect(() => {
    playerDots.current = Array.from({ length: 5 }, () => ({
      x: Math.random() * 160,
      y: Math.random() * 160,
      phase: Math.random() * Math.PI * 2,
      speed: 0.2 + Math.random() * 0.3,
    }));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = (t: number) => {
      ctx.clearRect(0, 0, 160, 160);

      // Background cavern
      const bg = ctx.createRadialGradient(80, 80, 0, 80, 80, 80);
      bg.addColorStop(0, '#1A1814');
      bg.addColorStop(0.6, '#12110E');
      bg.addColorStop(1, '#090909');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 160, 160);

      // Subtle terrain noise
      for (let i = 0; i < 80; i++) {
        const x = Math.random() * 160;
        const y = Math.random() * 160;
        const s = 2 + Math.random() * 6;
        ctx.fillStyle = `rgba(255, 188, 19, ${0.015 + Math.random() * 0.02})`;
        ctx.fillRect(x, y, s, s);
      }

      // World pulse ring
      if (isOnline) {
        pulseRef.current = (pulseRef.current + 0.003) % (Math.PI * 2);
        const pulseRadius = 30 + Math.sin(pulseRef.current) * 5;
        const pulseOpacity = 0.08 + Math.sin(pulseRef.current) * 0.04;
        ctx.beginPath();
        ctx.arc(80, 80, pulseRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 188, 19, ${pulseOpacity})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Player dots
      playerDots.current.forEach((dot) => {
        const dx = Math.sin(t * 0.001 * dot.speed + dot.phase) * 20;
        const dy = Math.cos(t * 0.001 * dot.speed + dot.phase) * 20;
        const px = 80 + dx;
        const py = 80 + dy;
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = isOnline ? 'rgba(255, 188, 19, 0.7)' : 'rgba(255, 255, 255, 0.15)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = isOnline ? 'rgba(255, 188, 19, 0.1)' : 'transparent';
        ctx.fill();
      });

      // Offline overlay
      if (!isOnline) {
        ctx.fillStyle = 'rgba(9, 9, 9, 0.5)';
        ctx.fillRect(0, 0, 160, 160);
        ctx.fillStyle = 'rgba(136, 136, 145, 0.3)';
        ctx.font = '10px GO, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('OFFLINE', 80, 85);
      }

      frameRef.current = requestAnimationFrame(draw);
    };
    frameRef.current = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(frameRef.current);
  }, [isOnline]);

  return (
    <div className="relative w-[280px] h-[280px] mx-auto mb-8">
      {/* Outer glow */}
      <div
        className={`absolute inset-0 rounded-full transition-all duration-1000 ${
          isLaunching
            ? 'shadow-[0_0_80px_rgba(255,188,19,0.3)]'
            : isOnline
              ? 'shadow-crucible'
              : 'shadow-none'
        }`}
      />

      {/* Crucible rim — layered ellipses */}
      <div className="absolute inset-0 rounded-full bg-gradient-to-b from-[rgba(255,188,19,0.06)] to-transparent" />
      <div
        className="absolute inset-[2px] rounded-full"
        style={{
          background: 'radial-gradient(ellipse at 50% 40%, rgba(255,188,19,0.04) 0%, transparent 60%)',
          border: '1px solid rgba(255, 188, 19, 0.08)',
          boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.4)',
        }}
      />

      {/* Inner ring */}
      <div className="absolute inset-[12px] rounded-full border border-[rgba(255,188,19,0.04)]" />

      {/* Canvas map */}
      <canvas
        ref={canvasRef}
        width={160}
        height={160}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
      />

      {/* Rim highlight */}
      <div className="absolute top-0 left-[20%] right-[20%] h-[1px] bg-gradient-to-r from-transparent via-[rgba(255,188,19,0.15)] to-transparent rounded-full" />
    </div>
  );
};

export default Crucible;
