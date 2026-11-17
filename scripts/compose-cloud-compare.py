"""把横评结果拼成一张对比图：顶部原图，下面每家一行 x 3 张。

    python scripts/compose-cloud-compare.py
    python scripts/compose-cloud-compare.py --image=landscape

读 .data/cloud-compare/manifest.json，输出 .data/cloud-compare/compare-<image>.png
"""

import argparse
import json
import os

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(".data", "cloud-compare")
GAP = 10
MARGIN = 16
LABEL_H = 24
CELL_W = 400
CELL_H = 300

PROVIDER_ORDER = ["ark", "dashscope", "siliconflow"]
PROVIDER_LABEL = {
    "ark": "ARK - Seedream 4.0",
    "dashscope": "DashScope - wanx2.1-imageedit",
    "siliconflow": "SiliconFlow - Qwen-Image-Edit",
}
SRC = {
    "pet": os.path.join(".data", "src-pet.jpg"),
    "portrait": os.path.join(".data", "src-portrait.jpg"),
    "landscape": os.path.join(
        "..", "..", "dufe-ppt", "assets", "raw", "dufe_official_1.jpg"
    ),
}


def fit(im: Image.Image, w: int, h: int) -> Image.Image:
    k = min(w / im.width, h / im.height)
    return im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="pet")
    args = ap.parse_args()

    with open(os.path.join(OUT, "manifest.json"), encoding="utf-8") as f:
        rows = [r for r in json.load(f) if r.get("image") == args.image]

    providers = [p for p in PROVIDER_ORDER if any(r["provider"] == p for r in rows)]
    if not providers:
        raise SystemExit(f"manifest 里没有 image={args.image} 的结果")

    cols = 3
    grid_w = cols * CELL_W + (cols - 1) * GAP
    width = grid_w + MARGIN * 2

    src_path = SRC[args.image]
    original = Image.open(src_path).convert("RGB")
    top_h = min(int(grid_w * original.height / original.width), 420)
    top = fit(original, grid_w, top_h)

    row_h = CELL_H + LABEL_H
    height = MARGIN + top.height + LABEL_H + GAP + len(providers) * (row_h + GAP) + MARGIN

    canvas = Image.new("RGB", (width, height), (22, 24, 28))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()

    canvas.paste(top, (MARGIN, MARGIN))
    draw.text((MARGIN, MARGIN + top.height + 6), f"ORIGINAL - {args.image}", fill=(200, 210, 225), font=font)

    y = MARGIN + top.height + LABEL_H + GAP
    for provider in providers:
        items = [r for r in rows if r["provider"] == provider]
        draw.text((MARGIN, y - 15), PROVIDER_LABEL.get(provider, provider), fill=(120, 200, 255), font=font)
        for i in range(cols):
            x = MARGIN + i * (CELL_W + GAP)
            cell = Image.new("RGB", (CELL_W, CELL_H), (32, 35, 42))
            item = items[i] if i < len(items) else None
            ok = bool(item and item.get("ok") and item.get("file"))
            path = os.path.join(OUT, item["file"]) if ok else ""
            if ok and os.path.exists(path):
                im = Image.open(path).convert("RGB")
                thumb = fit(im, CELL_W, CELL_H)
                cell.paste(thumb, ((CELL_W - thumb.width) // 2, (CELL_H - thumb.height) // 2))
            else:
                msg = (item or {}).get("error", "no result")
                ImageDraw.Draw(cell).text((8, 8), f"#{i + 1} FAILED", fill=(255, 120, 120), font=font)
                ImageDraw.Draw(cell).text((8, 26), str(msg)[:70], fill=(200, 120, 120), font=font)
            canvas.paste(cell, (x, y))
        y += row_h + GAP

    path = os.path.join(OUT, f"compare-{args.image}.png")
    canvas.save(path)
    print(f"{canvas.width}x{canvas.height} -> {path}")


if __name__ == "__main__":
    main()
