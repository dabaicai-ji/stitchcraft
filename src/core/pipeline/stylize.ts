/**
 * 风格化预处理：引导滤波（guided filter）保边平滑。
 *
 * 目标：消掉「绣格级噪点」——照片减色后大量 1–2 格碎块，是可绣性最大的杀手。
 * 平滑之后同一片区域会塌成更大的同色块，碎片率显著下降，而物体轮廓仍然保留。
 *
 * 关键决策：**在网格分辨率（W×H）上做，不在原图做。**
 *   - 我们要消的就是最终格子粒度的噪点，在 120×120 的格子上直接平滑，
 *     成本 14.4k 像素 < 5ms；
 *   - 如果在 1024² 原图上平滑再降采样，等于平滑完又丢掉一半信息，
 *     而且要多花 50 倍的时间。
 *
 * 为什么用引导滤波而不是高斯/双边：
 *   - 高斯不保边，会把眼睛、建筑轮廓一起糊掉；
 *   - 双边滤波在纯 TS 里是 O(N·r²)，且容易出现梯度反转；
 *   - 引导滤波是 O(N)（盒式滤波实现），保边效果接近双边，业内标准做法。
 *
 * 实现上做**交叉引导**：以亮度为引导图，分别滤波 R/G/B 三个线性光通道。
 * 比三个通道各自自引导更不容易产生色偏（RGB 的边缘位置本来就不一致）。
 */

import { linearToSrgb8 } from '../color/oklab.ts';

export interface StylizedGrid {
  /** 平滑后的线性光 RGB，长度 = W*H*3 */
  linear: Float32Array;
  /** 平滑后重新编码的 sRGB 8bit，长度 = W*H*3 */
  srgb: Uint8ClampedArray;
}

const clampIdx = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * 可分离盒式滤波（边缘复制），O(N)。
 * 结果写到 out，tmp 作为中间缓冲。
 */
function boxFilter(
  src: Float32Array,
  W: number,
  H: number,
  r: number,
  tmp: Float32Array,
  out: Float32Array,
): void {
  const win = 2 * r + 1;

  // 水平
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clampIdx(k, 0, W - 1)];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + clampIdx(x + r + 1, 0, W - 1)];
      sum -= src[row + clampIdx(x - r, 0, W - 1)];
    }
  }

  // 垂直
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clampIdx(k, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum / win;
      sum += tmp[clampIdx(y + r + 1, 0, H - 1) * W + x];
      sum -= tmp[clampIdx(y - r, 0, H - 1) * W + x];
    }
  }
}

/**
 * 单通道引导滤波：guide 为引导图，src 为待滤波通道。
 * a = cov(I,p)/(var(I)+eps)，q = mean(a)·I + mean(b)
 */
function guidedFilter(
  guide: Float32Array,
  src: Float32Array,
  W: number,
  H: number,
  r: number,
  eps: number,
): Float32Array {
  const N = W * H;
  const tmp = new Float32Array(N);
  const meanI = new Float32Array(N);
  const meanP = new Float32Array(N);
  const corrI = new Float32Array(N);
  const corrIp = new Float32Array(N);
  const prod = new Float32Array(N);

  boxFilter(guide, W, H, r, tmp, meanI);
  boxFilter(src, W, H, r, tmp, meanP);

  for (let i = 0; i < N; i++) prod[i] = guide[i] * guide[i];
  boxFilter(prod, W, H, r, tmp, corrI);

  for (let i = 0; i < N; i++) prod[i] = guide[i] * src[i];
  boxFilter(prod, W, H, r, tmp, corrIp);

  const a = new Float32Array(N);
  const b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i];
    const cov = corrIp[i] - meanI[i] * meanP[i];
    a[i] = cov / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }

  const meanA = new Float32Array(N);
  const meanB = new Float32Array(N);
  boxFilter(a, W, H, r, tmp, meanA);
  boxFilter(b, W, H, r, tmp, meanB);

  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) q[i] = meanA[i] * guide[i] + meanB[i];
  return q;
}

/**
 * @param strength 0..1。0 表示不平滑（直接返回原数组）。
 */
export function stylizeGrid(
  linear: Float32Array,
  srgb: Uint8ClampedArray,
  width: number,
  height: number,
  strength: number,
): StylizedGrid {
  if (strength <= 0) return { linear, srgb };

  // 半径 1–3 格：1 格只能吃掉椒盐噪点，3 格会开始抹掉细节
  const r = Math.max(1, Math.round(1 + strength * 2));
  // eps 控制「多大的差异算边缘」：越大越平滑，越容易糊
  const eps = 0.005 + strength * 0.02;

  const N = width * height;
  const guide = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    guide[i] =
      0.2126 * linear[i * 3] +
      0.7152 * linear[i * 3 + 1] +
      0.0722 * linear[i * 3 + 2];
  }

  const out = new Float32Array(linear.length);
  for (let ch = 0; ch < 3; ch++) {
    const src = new Float32Array(N);
    for (let i = 0; i < N; i++) src[i] = linear[i * 3 + ch];
    const q = guidedFilter(guide, src, width, height, r, eps);
    for (let i = 0; i < N; i++) {
      const v = q[i];
      out[i * 3 + ch] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  const outSrgb = new Uint8ClampedArray(N * 3);
  for (let i = 0; i < N * 3; i++) outSrgb[i] = linearToSrgb8(out[i]);

  return { linear: out, srgb: outSrgb };
}
