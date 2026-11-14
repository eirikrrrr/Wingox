// The WinGox wordmark, drawn from our own 5x7 bitmap font (pixelfont.json) as
// crisp SVG cells: "Win" in the ink color, "Gox" in the accent, then the
// blinking block cursor. Colors come from the theme tokens, so it follows the
// theme; `cell` is the size of one pixel in CSS px (keep it an integer).
import font from "./pixelfont.json";

const glyphs = font.glyphs as Record<string, string[]>;
const H = font.height;

type Run = { text: string; className: string };
const RUNS: Run[] = [
  { text: "Win", className: "fill-ink" },
  { text: "Gox", className: "fill-accent" },
];

export function PixelLogo({ cell = 3, cursor = true }: { cell?: number; cursor?: boolean }) {
  const rects: { x: number; y: number; cls: string }[] = [];
  let col = 0;
  for (const run of RUNS) {
    for (const ch of run.text) {
      const g = glyphs[ch];
      g.forEach((row, y) => [...row].forEach((c, x) => { if (c === "X") rects.push({ x: col + x, y, cls: run.className }); }));
      col += g[0].length + 1;
    }
  }
  const cursorX = col + 1; // one extra gap before the cursor
  const width = cursor ? cursorX + 3 : col - 1;
  return (
    <svg role="img" aria-label="WinGox" width={width * cell} height={H * cell}
      viewBox={`0 0 ${width} ${H}`} shapeRendering="crispEdges" className="block">
      {rects.map((r) => <rect key={`${r.x}.${r.y}`} x={r.x} y={r.y} width={1} height={1} className={r.cls} />)}
      {cursor && <rect x={cursorX} y={0} width={3} height={H} className="wx-cursor fill-accent" />}
    </svg>
  );
}

