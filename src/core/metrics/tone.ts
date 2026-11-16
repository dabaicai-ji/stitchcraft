/**
 * 明暗溢出（指标 6）
 *
 * 目的：在减色之前先判断这张图有没有「本来就没救」的亮度问题。
 * 减色会把色彩压成 N 个色阶，如果源图 30% 像素已经暗到 <5 亮度，
 * 减色后就是一整块死黑 —— 换任何参数都救不回来，必须提示用户先换图或先调曝光。
 *
 * 口径说明（重要）：
 *   用 **gamma 编码后的相对亮度**（0.2126R′ + 0.7152G′ + 0.0722B′），
 *   而不是线性光亮度。原因：用户和设计师对「<5% 亮度」的直觉是基于
 *   sRGB 数值的（#0d0d0d 就是 5%）。用线性光会让阈值全部错位。
 *   这就是一个刻意的、有代价的取舍，已记录在此。
 *
 * 复杂度：O(P)，P=像素数。1024×1024 ≈ 1M 像素，< 8ms。
 */

import type { ToneStats } from '../types.ts';
import { CONFIG } from '../config.ts';

export interface ToneOptions {
  shadowThreshold?: number;
  highlightThreshold?: number;
}

/**
 * @param rgba 长度 = width*height*4 的 RGBA 数据（ImageData.data 即可）
 */
export function computeToneStats(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: ToneOptions = {},
): ToneStats {
  const shadowT = opts.shadowThreshold ?? CONFIG.tone.shadowThreshold;
  const highlightT = opts.highlightThreshold ?? CONFIG.tone.highlightThreshold;

  const px = width * height;
  if (rgba.length < px * 4) {
    throw new Error(`rgba 长度不足: ${rgba.length} < ${px * 4}`);
  }

  const histogram = new Array<number>(256).fill(0);
  let counted = 0;
  let sum = 0;
  let shadow = 0;
  let highlight = 0;

  for (let p = 0, o = 0; p < px; p++, o += 4) {
    // 透明像素（PNG 挖空）不参与亮度统计，否则会假装成纯黑
    if (rgba[o + 3] < 8) continue;

    const luma =
      (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;

    histogram[Math.min(255, Math.max(0, Math.round(luma * 255)))]++;
    counted++;
    sum += luma;
    if (luma < shadowT) shadow++;
    if (luma > highlightT) highlight++;
  }

  if (counted === 0) {
    return {
      meanLuma: 0,
      shadowClipRatio: 0,
      highlightClipRatio: 0,
      p05: 0,
      p95: 0,
      histogram,
    };
  }

  // 分位数：在直方图上累计，避免对 P 个像素再排序一次
  const percentile = (q: number): number => {
    const target = q * counted;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += histogram[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };

  return {
    meanLuma: sum / counted,
    shadowClipRatio: shadow / counted,
    highlightClipRatio: highlight / counted,
    p05: percentile(0.05),
    p95: percentile(0.95),
    histogram,
  };
}
