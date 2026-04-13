import { useEffect, useRef, type MutableRefObject } from "react";
import "./voiceOrb.css";

type Particle = { x: number; y: number; z: number; phase: number };

function fibonacciSphere(n: number, radius: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1 || 1);
    const inc = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - t * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * inc;
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;
    out.push({
      x: x * radius,
      y: y * radius,
      z: z * radius,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return out;
}

type Props = {
  analyserRef: MutableRefObject<AnalyserNode | null>;
  onCancel: () => void;
};

export function VoiceOrbOverlay({ analyserRef, onCancel }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const freqRef = useRef(new Uint8Array(128));
  const particlesRef = useRef(fibonacciSphere(420, 1));
  const dimsRef = useRef({ w: 0, h: 0 });

  useEffect(() => {
    const panel = panelRef.current;
    const canvas = canvasRef.current;
    if (!panel || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
    const syncCanvasSize = () => {
      const w = panel.clientWidth;
      const h = panel.clientHeight;
      dimsRef.current = { w, h };
      canvas.width = Math.floor(Math.max(1, w) * dpr);
      canvas.height = Math.floor(Math.max(1, h) * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    syncCanvasSize();
    const ro = new ResizeObserver(() => syncCanvasSize());
    ro.observe(panel);

    const particles = particlesRef.current;
    let raf = 0;

    const frame = () => {
      const { w, h } = dimsRef.current;
      if (w < 8 || h < 8) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const cx = w * 0.5;
      const cy = h * 0.42;
      const analyser = analyserRef.current;
      let energy = 0;
      if (analyser) {
        const buf = freqRef.current;
        const n = Math.min(buf.length, analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buf.subarray(0, n));
        let sum = 0;
        const bands = Math.min(36, n);
        for (let i = 0; i < bands; i++) sum += buf[i] ?? 0;
        energy = sum / (bands * 255);
      } else {
        energy = 0.08 + Math.sin(performance.now() * 0.002) * 0.04;
      }

      ctx.fillStyle = "#050508";
      ctx.fillRect(0, 0, w, h);

      const t = performance.now() * 0.001;
      const breath = 0.92 + 0.08 * Math.sin(t * 1.4);
      const baseR = (Math.min(w, h) * 0.14 + energy * Math.min(w, h) * 0.22) * breath;
      const cosY = Math.cos(t * 0.35);
      const sinY = Math.sin(t * 0.35);

      const cosX = Math.cos(t * 0.22);
      const sinX = Math.sin(t * 0.22);

      const sorted: { sx: number; sy: number; zr: number; a: number }[] = [];

      for (const p of particles) {
        let x = p.x * baseR;
        let y = p.y * baseR * (1 + energy * 0.35);
        let z = p.z * baseR;

        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        x = x1;
        z = z1;

        const y2 = y * cosX - z * sinX;
        const z2 = y * sinX + z * cosX;
        y = y2;
        z = z2;

        const pulse =
          1 + energy * 0.5 * Math.sin(t * 6 + p.phase + energy * 8);
        const sx = cx + x * pulse;
        const sy = cy + y * pulse;
        const zr = z / (baseR + 0.001);
        const a = 0.25 + energy * 0.65 + (zr + 1) * 0.12;
        sorted.push({ sx, sy, zr, a: Math.min(1, Math.max(0.15, a)) });
      }

      sorted.sort((a, b) => a.zr - b.zr);

      for (const { sx, sy, a } of sorted) {
        const r = 1.2 + energy * 5 + a * 1.5;
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3);
        g.addColorStop(0, `rgba(255,236,160,${a * 0.95})`);
        g.addColorStop(0.4, `rgba(251,219,100,${a * 0.55})`);
        g.addColorStop(1, "rgba(251,219,100,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      const ringR = baseR * (1.15 + energy * 0.4);
      ctx.strokeStyle = `rgba(251,219,100,${0.2 + energy * 0.45})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, ringR, ringR * 0.36, t * 0.2, 0, Math.PI * 2);
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyserRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      ref={panelRef}
      className="voice-orb-panel"
      role="dialog"
      aria-label="Voice capture"
    >
      <canvas ref={canvasRef} className="voice-orb-canvas" />
      <div className="voice-orb-chrome">
        <p className="voice-orb-title">Voice</p>
        <p className="voice-orb-hint">
          Continuous: pause to send each line · Mic pauses while Jarvis replies ·{" "}
          <kbd>Esc</kbd> ends voice mode
        </p>
        <button type="button" className="voice-orb-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
