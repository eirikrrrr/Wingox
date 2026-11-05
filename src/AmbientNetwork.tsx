import { useEffect, useRef } from "react";

/**
 * A quiet, elegant background: a few dozen points drift and, when near, link
 * with faint lines — a living network behind the app. It takes its colour from
 * the current theme's accent and holds still when the viewer prefers less
 * motion. Cheap: one canvas, ~48 points, capped frame rate.
 */
export function AmbientNetwork() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const c = ctx; // non-null, keeps its type inside the animation closures
    const cv = canvas;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const accent = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim() || "#4ade80";

    const COUNT = 48;
    const nodes = Array.from({ length: COUNT }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00018,
      vy: (Math.random() - 0.5) * 0.00018,
      r: 0.6 + Math.random() * 1.4,
    }));

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = cv.clientWidth;
      height = cv.clientHeight;
      cv.width = Math.floor(width * dpr);
      cv.height = Math.floor(height * dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const LINK = 150; // px within which two nodes link
    let raf = 0;
    let last = 0;

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      if (now - last < 1000 / 30) return; // cap at ~30fps
      last = now;

      const color = accent();
      c.clearRect(0, 0, width, height);

      for (const n of nodes) {
        if (!reduced) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < 0 || n.x > 1) n.vx *= -1;
          if (n.y < 0 || n.y > 1) n.vy *= -1;
        }
      }

      // links
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const ax = a.x * width;
        const ay = a.y * height;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const bx = b.x * width;
          const by = b.y * height;
          const d = Math.hypot(ax - bx, ay - by);
          if (d < LINK) {
            c.strokeStyle = color;
            c.globalAlpha = (1 - d / LINK) * 0.1;
            c.lineWidth = 1;
            c.beginPath();
            c.moveTo(ax, ay);
            c.lineTo(bx, by);
            c.stroke();
          }
        }
      }

      // nodes
      c.globalAlpha = 0.5;
      c.fillStyle = color;
      for (const n of nodes) {
        c.beginPath();
        c.arc(n.x * width, n.y * height, n.r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;

      if (reduced) cancelAnimationFrame(raf); // draw once, then rest
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full opacity-70"
    />
  );
}
