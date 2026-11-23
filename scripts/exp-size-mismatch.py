"""
一次性实验：复现并验证「云端图尺寸与源图尺寸不一致 → 网格糊图」这个 bug。

背景（用户实测）：点选云端候选后处理结果是糊的；同一张图手动下载再上传则正常。

做法：
  bug     : AI 图（1024×1024）的 RGBA 原样喂给管线，却声明源尺寸 512×512
            → 管线按 512 的 stride 读 1024 的行 → 每行错位
  fixed   : AI 图 cover 缩放到 512×512（即 src/ai/cloud.ts decodeToRgba 的 target 路径）
  manual  : 原图 512×512 直接进管线（等价于走 UploadZone 手动上传）

三个 raw 都由这里产出，再由 exp-size-mismatch.ts 跑 runPipeline 对比。

跑法： python scripts/exp-size-mismatch.py
"""

from pathlib import Path
from PIL import Image
import json

root = Path(__file__).resolve().parent.parent
data = root / ".data"
out = data / "size-mismatch"
out.mkdir(parents=True, exist_ok=True)

# 统一转 RGBA：管线吃的是 4 通道，PIL 默认 RGB 会产出 3 通道 → 长度对不上
src = Image.open(data / "src-portrait.jpg").convert("RGBA")      # 512×512
ai = Image.open(data / "prompt-compare/v3.jpg").convert("RGBA")  # 1024×1024

print(f"源图 {src.size}   AI 图 {ai.size}")

# 1) manual：源图原样
manual = src
manual.convert("RGB").save(out / "manual.jpg", quality=92)
(out / "manual.raw").write_bytes(manual.tobytes())

# 2) fixed：AI 图 cover 缩放到源图尺寸（与 decodeToRgba(target) 等价）
tw, th = src.size
scale = max(tw / ai.width, th / ai.height)
dw, dh = round(ai.width * scale), round(ai.height * scale)
fixed = Image.new("RGB", (tw, th))
resized = ai.resize((dw, dh), Image.LANCZOS).convert("RGB")
fixed.paste(resized, ((tw - dw) // 2, (th - dh) // 2))
fixed_rgba = fixed.convert("RGBA")
fixed.convert("RGB").save(out / "fixed.jpg", quality=92)
(out / "fixed.raw").write_bytes(fixed_rgba.tobytes())

# 3) bug：AI 图原样（1024×1024），由 Runner 声明成 512×512 去读
ai.convert("RGB").save(out / "bug.jpg", quality=92)
(out / "bug.raw").write_bytes(ai.tobytes())

meta = {
    "source": {"w": src.width, "h": src.height},
    "ai": {"w": ai.width, "h": ai.height},
    "cases": [
        {"name": "manual", "raw": "manual.raw", "declaredW": src.width, "declaredH": src.height},
        {"name": "fixed", "raw": "fixed.raw", "declaredW": src.width, "declaredH": src.height},
        {"name": "bug", "raw": "bug.raw", "declaredW": src.width, "declaredH": src.height},
    ],
}
(out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
print(f"写出 {out}：{', '.join(sorted(p.name for p in out.iterdir()))}")
