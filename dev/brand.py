#!/usr/bin/env python3
"""Generate the WinGox brand assets from src/brand/pixelfont.json.

The app mark is a 16x16 pixel-art tile: "WG" (W in ink, G in the accent) over
a cursor bar, on a dark tile with stepped corners and a 1-pixel ring. Because
it is drawn on a 16-cell grid, it stays crisp at 16/32 px and scales up to
1024 px by whole multiples.

Outputs:
  src-tauri/icons/source.png   1024x1024, the input for `npm run tauri icon`
  public/favicon.svg           the same mark as SVG for the web build

It then runs `npm run tauri icon` on source.png (desktop sizes only: the
Android/iOS sets are removed) and redraws the small PNGs and the Windows .ico
with nearest-neighbour scaling, so the pixels stay sharp (Tauri smooths them).

Usage: python3 dev/brand.py
"""
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FONT = json.loads((ROOT / "src/brand/pixelfont.json").read_text())
G = FONT["glyphs"]

# the dark theme's tokens (src/index.css)
BG, RING, INK, ACCENT = "#12161b", "#323b44", "#d9dee4", "#4ade80"
N = 16


def mark() -> dict[tuple[int, int], str]:
    """cell (x, y) -> color for the 16x16 icon"""
    cells: dict[tuple[int, int], str] = {}
    cut = {(0, 0), (1, 0), (0, 1)}  # stepped corner, mirrored to the 4 corners
    corners = {(x if a else N - 1 - x, y if b else N - 1 - y) for x, y in cut for a in (0, 1) for b in (0, 1)}
    for y in range(N):
        for x in range(N):
            if (x, y) in corners:
                continue
            edge = x == 0 or y == 0 or x == N - 1 or y == N - 1 or (x, y) in {
                (1, 1), (N - 2, 1), (1, N - 2), (N - 2, N - 2)}
            cells[(x, y)] = RING if edge else BG

    def put(ch: str, ox: int, oy: int, color: str) -> None:
        for y, row in enumerate(G[ch]):
            for x, c in enumerate(row):
                if c == "X":
                    cells[(ox + x, oy + y)] = color

    put("W", 2, 3, INK)
    put("G", 9, 3, ACCENT)
    for x in range(2, 6):
        for y in (11, 12):
            cells[(x, y)] = ACCENT
    return cells


def svg(cells: dict[tuple[int, int], str], w: int, h: int) -> str:
    rects = "".join(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{c}"/>' for (x, y), c in sorted(cells.items()))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" shape-rendering="crispEdges">'
            f"{rects}</svg>\n")


def main() -> None:
    cells = mark()
    scale = 1024 // N
    img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    for (x, y), c in cells.items():
        img.paste(Image.new("RGBA", (scale, scale), c), (x * scale, y * scale))
    out = ROOT / "src-tauri/icons/source.png"
    img.save(out)

    (ROOT / "public").mkdir(exist_ok=True)
    (ROOT / "public/favicon.svg").write_text(svg(cells, N, N))

    icons = ROOT / "src-tauri/icons"
    subprocess.run(["npm", "run", "--silent", "tauri", "icon", str(out)], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL)
    for d in ("android", "ios"):
        shutil.rmtree(icons / d, ignore_errors=True)
    sharp = lambda px: img.resize((px, px), Image.NEAREST)
    for name, px in (("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256),
                     ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44)):
        sharp(px).save(icons / name)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    sharp(256).save(icons / "icon.ico", sizes=[(s, s) for s in sizes],
                    append_images=[sharp(s) for s in sizes[:-1]])
    print(f"wrote {out.relative_to(ROOT)}, public/favicon.svg")


if __name__ == "__main__":
    main()
