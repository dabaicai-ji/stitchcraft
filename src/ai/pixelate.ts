/**
 * 像素化风格 —— 纯 TS 实现，不加载 ONNX。
 *
 * 借鉴 Photo2Pixel（Jzou44/photo2pixel）的算法思路：
 *   平滑 → 按 pixelSize 下采样 → 边缘检测加黑线 → 色彩量化 → 最近邻放大
 * 但**不用它的 ONNX 运行时**：那个模型只有 23.8KB，逻辑就是卷积+下采样，
 * 为它背 14.85MB（WASM）~28.75MB（WebGPU）的 onnxruntime 完全不划算。
 *
 * 自己实现的三个额外好处：
 *   1) 块边长可以直接对齐绣格（不需要二次缩放，避免人为制造碎边）；
 *   2) 参数（块大小/边缘阈值/量化级数）能实时暴露给用户；
 *   3) 纯函数，Node 里能跑单测和标定实验。
 *
 * ⚠️ 实测结论：像素化对**碎片率是负作用**（块边界和绣格不对齐时等于制造碎边）。
 *    它只作为「观感风格」提供，别在文案里说它降碎片。
 */

export interface PixelateParams {
  /** 像素块边长（源图像素） */
  pixelSize: number;
  /** 边缘阈值 0..255，越低黑线越多（Photo2Pixel 默认 100） */
  edgeThresh: number;
  /** 下采样前平滑半径（源图像素），0 关闭 */
  smoothRadius: number;
  /** 每通道量化级数，0/1 表示不量化 */
  levels: number;
}

export const PIXEL_DEFAULTS: PixelateParams = {
  pixelSize: 8,
  edgeThresh: 100,
  smoothRadius: 2,
  levels: 24,
};

/** 可分离盒式模糊（边缘复制），作用在 RGB 上 */
function boxBlur(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  r: number,
): Uint8ClampedArray {
  if (r <= 0) return src;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const win = 2 * r + 1;
  const cl = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(row + cl(k, 0, w - 1)) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 4 + c] = sum / win;
        sum += src[(row + cl(x + r + 1, 0, w - 1)) * 4 + c];
        sum -= src[(row + cl(x - r, 0, w - 1)) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(cl(k, 0, h - 1) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = sum / win;
        sum += tmp[(cl(y + r + 1, 0, h - 1) * w + x) * 4 + c];
        sum -= tmp[(cl(y - r, 0, h - 1) * w + x) * 4 + c];
      }
    }
  }
  // alpha 直接沿用
  for (let i = 0; i < w * h; i++) {
    tmp[i * 4 + 3] = src[i * 4 + 3];
    out[i * 4 + 3] = src[i * 4 + 3];
  }
  return out;
}

/** 面积平均下采样到 gw×gh */
function downsample(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  gw: number,
  gh: number,
): Float32Array {
  const out = new Float32Array(gw * gh * 3);
  const sx = w / gw;
  const sy = h / gh;
  for (let dy = 0; dy < gh; dy++) {
    const y0 = dy * sy;
    const y1 = (dy + 1) * sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(h, Math.max(iy0 + 1, Math.ceil(y1)));
    for (let dx = 0; dx < gw; dx++) {
      const x0 = dx * sx;
      const x1 = (dx + 1) * sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(w, Math.max(ix0 + 1, Math.ceil(x1)));
      let r = 0, g = 0, b = 0, ws = 0;
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const k = wx * wy;
          const o = (y * w + x) * 4;
          r += src[o] * k;
          g += src[o + 1] * k;
          b += src[o + 2] * k;
          ws += k;
        }
      }
      const o = (dy * gw + dx) * 3;
      out[o] = r / ws;
      out[o + 1] = g / ws;
      out[o + 2] = b / ws;
    }
  }
  return out;
}

/**
 * @param rgba 源图 RGBA
 * @returns 像素化后的 RGBA（尺寸与原图相同，便于直接替换进管线）
 */
export function pixelate(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  params: PixelateParams = PIXEL_DEFAULTS,
): Uint8ClampedArray {
  const p = params;
  const ps = Math.max(1, Math.round(p.pixelSize));
  const smoothed = boxBlur(rgba, width, height, Math.max(0, Math.round(p.smoothRadius)));

  const gw = Math.max(1, Math.round(width / ps));
  const gh = Math.max(1, Math.round(height / ps));
  const grid = downsample(smoothed, width, height, gw, gh);

  // 亮度（用于边缘检测）
  const luma = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    luma[i] = 0.2126 * grid[i * 3] + 0.7152 * grid[i * 3 + 1] + 0.0722 * grid[i * 3 + 2];
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const levels = p.levels > 1 ? p.levels : 0;
  const q = (v: number): number =>
    levels ? Math.round((Math.round((v / 255) * (levels - 1)) / (levels - 1)) * 255) : v;

  const cl = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / ps));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / ps));
      const gi = gy * gw + gx;
      const o = (y * width + x) * 4;

      // Sobel（在块网格上算，黑线落在块边界，符合像素风观感）
      const g = (xx: number, yy: number): number =>
        luma[cl(yy, 0, gh - 1) * gw + cl(xx, 0, gw - 1)];
      const gxs = g(gx + 1, gy - 1) + 2 * g(gx + 1, gy) + g(gx + 1, gy + 1)
        - g(gx - 1, gy - 1) - 2 * g(gx - 1, gy) - g(gx - 1, gy + 1);
      const gys = g(gx - 1, gy + 1) + 2 * g(gx, gy + 1) + g(gx + 1, gy + 1)
        - g(gx - 1, gy - 1) - 2 * g(gx, gy - 1) - g(gx + 1, gy - 1);
      const mag = Math.hypot(gxs, gys) / 4;

      if (mag > p.edgeThresh) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
      } else {
        out[o] = q(grid[gi * 3]);
        out[o + 1] = q(grid[gi * 3 + 1]);
        out[o + 2] = q(grid[gi * 3 + 2]);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
