"""
把 exp-size-mismatch.ts 导出的网格渲染成图，肉眼对比「糊 vs 不糊」。

重点：指标是骗人的——错位后的 bug 图碎片率反而更低（大面积重复色块看起来更"好绣"）。
真正能区分的是图面，所以必须画出来看。

跑法： python scripts/render-size-mismatch.py
"""

from pathlib import Path
from PIL import Image
import json

root = Path(__file__).resolve().parent.parent
dir_ = root / ".data" / "size-mismatch"
grids = json.loads((dir_ / "grids.json").read_text(encoding="utf-8"))
metrics = {}
for line in (dir_ / "metrics.txt").read_text(encoding="utf-8").splitlines():
    g, name, confetti, isolated, confusion, colors, stars, score = line.split("\t")
    metrics[(g, name)] = dict(confetti=confetti, isolated=isolated, confusion=confusion)

CASES = ["manual", "fixed", "bug"]
LABELS = {"manual": "手动上传", "fixed": "点选后（修复）", "bug": "点选后（错位 bug）"}
CELL = 4
GAP = 16


def render(g: int, name: str) -> Image.Image:
    data = grids[f"{g}-{name}"]
    w, h = data["width"], data["height"]
    pal = data["palette"]
    cells = data["cells"]
    img = Image.new("RGB", (w * CELL, h * CELL), "white")
    px = img.load()
    for y in range(h):
        for x in range(w):
            idx = cells[y * w + x]
            if idx < 0:
                r = g_ = b = 255
            else:
                hx = pal[idx]["hex"].lstrip("#")
                r, g_, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
            for dy in range(CELL):
                for dx in range(CELL):
                    px[x * CELL + dx, y * CELL + dy] = (r, g_, b)
    return img


for g in (120, 200):
    tiles = [render(g, name) for name in CASES]
    tw = tiles[0].width
    th = tiles[0].height
    canvas = Image.new("RGB", (tw * 3 + GAP * 2, th), "white")
    for i, tile in enumerate(tiles):
        canvas.paste(tile, (i * (tw + GAP), 0))
    out = dir_ / f"compare-{g}.png"
    canvas.save(out)
    print(f"{out.name}: {canvas.size}  " + " | ".join(
        f"{LABELS[c]} 碎片{metrics[(str(g), c)]['confetti']} 混淆{metrics[(str(g), c)]['confusion']}"
        for c in CASES
    ))
