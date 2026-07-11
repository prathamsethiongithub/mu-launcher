import React, { useEffect, useRef } from 'react';

const AuroraBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = window.innerWidth;
    let h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
    };
    window.addEventListener('resize', resize);

    const draw = (t: number) => {
      timeRef.current = t * 0.0001;
      ctx.clearRect(0, 0, w, h);

      // Amber aurora — upper right
      const g1 = ctx.createRadialGradient(w * 0.75, h * 0.2, 0, w * 0.75, h * 0.2, w * 0.5);
      const driftX = Math.sin(t * 0.00005) * 40;
      const driftY = Math.cos(t * 0.00008) * 20;
      g1.addColorStop(0, `rgba(227, 131, 48, ${0.04 + Math.sin(t * 0.0001) * 0.01})`);
      g1.addColorStop(0.5, `rgba(227, 131, 48, ${0.02 + Math.sin(t * 0.00012 + 1) * 0.008})`);
      g1.addColorStop(1, 'rgba(227, 131, 48, 0)');
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, w, h);

      // Cyan aurora — lower left
      const g2 = ctx.createRadialGradient(w * 0.25 + driftX, h * 0.7 + driftY, 0, w * 0.25, h * 0.7, w * 0.4);
      g2.addColorStop(0, `rgba(57, 181, 215, ${0.03 + Math.sin(t * 0.00009 + 2) * 0.008})`);
      g2.addColorStop(0.6, `rgba(57, 181, 215, ${0.01 + Math.sin(t * 0.00007 + 3) * 0.005})`);
      g2.addColorStop(1, 'rgba(57, 181, 215, 0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);

      // Film grain
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const grain = (Math.random() - 0.5) * 8;
        data[i] += grain;
        data[i + 1] += grain;
        data[i + 2] += grain;
      }
      ctx.putImageData(imageData, 0, 0);

      frameRef.current = requestAnimationFrame(draw);
    };
    frameRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-0"
      style={{ mixBlendMode: 'screen' }}
    />
  );
};

export default AuroraBackground;
