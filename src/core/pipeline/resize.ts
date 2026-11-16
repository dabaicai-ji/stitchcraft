/**
 * 重采样：源图 → 目标网格分辨率。
 *
 * 这一部最容易写错，也最容易毁掉整个图纸：
 *
 *   ① 必须在**线性光**下做面积平均。
 *      直接对 sRGB 数值取平均，亮部会被系统性压暗（例如黑白交界处出现灰边、
 *      高光细节整片消失）。这是 90% 的实现会踩的坑。
 *
 *   ② 用「盒式面积加权」而不是最近邻/双线性。
 *      最近邻会丢像素导致噪点爆炸（→ 碎片率飙升）；
 *      双线性会引入中间色，让减色匹配到不存在的 DMC 色号。
 *
 * 复杂度 O(W·H·(源像素/格))，400 格时约 100 万次乘加。
 */

import { SRGB8_TO_LINEAR, linearToSrgb8 } from '../color/oklab.ts';

export interface ResizeResult {
  /** 每格线性光 RGB，长度 = W*H*3 */
  linear: Float32Array;
  /** 每格 sRGB 8bit，长度 = W*H*3 */
  srgb: Uint8ClampedArray;
}

/**
 * @param src RGBA 源像素（长度 = sw*sh*4）
 */
export function resizeToGrid(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  W: number,
  H: number,
): ResizeResult {
  const linear = new Float32Array(W * H * 3);
  const srgb = new Uint8ClampedArray(W * H * 3);

  const scaleX = sw / W;
  const scaleY = sh / H;

  for (let ty = 0; ty < H; ty++) {
    const sy0 = ty * scaleY;
    const sy1 = (ty + 1) * scaleY;
    // 上采样时（scale<1）保证至少覆盖 1 个源像素，否则权重全为 0
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(sh, Math.max(iy0 + 1, Math.ceil(sy1)));

    for (let tx = 0; tx < W; tx++) {
      const sx0 = tx * scaleX;
      const sx1 = (tx + 1) * scaleX;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(sw, Math.max(ix0 + 1, Math.ceil(sx1)));

      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;

      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        const rowOff = sy * sw;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const o = (rowOff + sx) * 4;

          // 透明像素（PNG 挖空）合成到白底，否则会变成「黑色」绣格
          const a = src[o + 3] / 255;
          const inv = 1 - a;
          r += (SRGB8_TO_LINEAR[src[o]] * a + inv) * wgt;
          g += (SRGB8_TO_LINEAR[src[o + 1]] * a + inv) * wgt;
          b += (SRGB8_TO_LINEAR[src[o + 2]] * a + inv) * wgt;
          wsum += wgt;
        }
      }

      const i = (ty * W + tx) * 3;
      if (wsum > 0) {
        r /= wsum;
        g /= wsum;
        b /= wsum;
      }

      linear[i] = r;
      linear[i + 1] = g;
      linear[i + 2] = b;
      srgb[i] = linearToSrgb8(r);
      srgb[i + 1] = linearToSrgb8(g);
      srgb[i + 2] = linearToSrgb8(b);
    }
  }

  return { linear, srgb };
}
