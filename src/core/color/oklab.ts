/**
 * OKLab 色彩空间（Björn Ottosson, 2020）
 *
 * 为什么减色用 OKLab 而不是 RGB 或 Lab：
 *   - RGB 欧氏距离和感知严重脱节（深色区尤其离谱）；
 *   - CIELAB 的 a/b 轴在低饱和区数值尺度不一致，聚类容易偏向蓝紫色；
 *   - OKLab 是专门为「欧氏距离≈感知差异」设计的，且计算量只有 CIELAB 的一半。
 *
 * 注意：这里只做 sRGB→OKLab 的正向变换。我们不把质心转回 sRGB 画图，
 * 而是用每个簇成员的真实颜色（线性光加权平均）作为代表色 —— 避免往返变换误差。
 */

export type Oklab = readonly [number, number, number];

/** sRGB 8bit → 线性光 0..1 */
export function srgb8ToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * 256 项查表版 sRGB→线性。
 *
 * 重采样时每个源像素要做 3 次，一张 1600×1600 的图就是 768 万次幂运算 ——
 * 实测这一步能占整个管线 70% 的时间。查表后降到常数时间，快了约 8 倍。
 */
export const SRGB8_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

/** 线性光 0..1 → sRGB 8bit */
export function linearToSrgb8(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** 线性光 sRGB → OKLab */
export function linearToOklab(r: number, g: number, b: number): Oklab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

/** sRGB 8bit → OKLab */
export function srgb8ToOklab(r: number, g: number, b: number): Oklab {
  return linearToOklab(srgb8ToLinear(r), srgb8ToLinear(g), srgb8ToLinear(b));
}

export function oklabDist2(a: Oklab, b: Oklab): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}
