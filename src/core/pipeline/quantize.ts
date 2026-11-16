/**
 * 感知减色：网格像素 → k 个色簇 → 真实 DMC 线号。
 *
 * 五步，每一步都有明确的理由：
 *
 *   1) **去重**。面积平均后同一颜色会重复出现几万次，按 24bit RGB 去重后
 *      加权 k-means 等价于逐像素 k-means，但快一个数量级。
 *
 *   2) **OKLab 空间 k-means++**。用加权 D² 采样初始化，而不是随机选点 ——
 *      随机初始化在同一张图上两次能得到完全不同的结果，这在产品里是灾难。
 *      种子固定 + k-means++ ⇒ 同输入同输出。
 *
 *   3) **簇代表色 = 成员线性光加权平均**。不是 OKLab 质心反变换回去，
 *      因为那会得到屏幕外的颜色；加权平均是真实存在的颜色，匹配更准。
 *
 *   4) **OKLab 粗筛 top-8 → CIEDE2000 精排**。489 色全量跑 CIEDE2000 太慢，
 *      top-8 粗筛后精排既快又准。
 *
 *   5) **同码合并 + 小色归并**。两个簇可能匹配到同一个 DMC 码；占比 <
 *      minColorShare 的色会并入 ΔE00 最近的保留色 —— 这是抑制「碎片率」最有效的一步。
 */

import type { PaletteEntry } from '../types.ts';
import { ciede2000, linearRgbToLab } from '../color/cie.ts';
import { linearToOklab, srgb8ToLinear } from '../color/oklab.ts';
import type { Oklab } from '../color/oklab.ts';
import { nearestDmc } from '../palette/dmc.ts';
import type { DmcColor } from '../palette/dmc.ts';
import { assignSymbols, contrastOn } from '../symbols.ts';
import { CONFIG } from '../config.ts';

export interface QuantizeOptions {
  maxColors: number;
  seed?: number;
  minColorShare?: number;
  maxIterations?: number;
}

export interface QuantizedColor {
  dmc: DmcColor;
  symbol: string;
  /** 符号画在该色块上时应该用的颜色 */
  textColor: string;
  stitchCount: number;
  share: number;
}

export interface QuantizeResult {
  cells: Int16Array;
  palette: PaletteEntry[];
  colors: QuantizedColor[];
  iterations: number;
  /** 去重后的颜色数，用于「这张图到底有多少种颜色」提示 */
  uniqueColors: number;
  /** 加权平均 OKLab 距离，越小越像原图；用于「色数够不够」的提示 */
  meanOklabError: number;
}

/** 确定性 PRNG（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Group {
  dmc: DmcColor;
  count: number;
  members: number[];
}

export function quantizeToDmc(
  linear: Float32Array,
  srgb: Uint8ClampedArray,
  W: number,
  H: number,
  opts: QuantizeOptions,
): QuantizeResult {
  const N = W * H;
  const maxColors = Math.max(1, Math.min(opts.maxColors | 0, 40));
  const seed = opts.seed ?? CONFIG.quantize.seed;
  const minShare = opts.minColorShare ?? CONFIG.quantize.minColorShare;
  const maxIter = opts.maxIterations ?? CONFIG.quantize.maxIterations;

  /* ---------------- 1) 按 24bit 去重 ---------------- */
  const uniqOf = new Map<number, number>();
  const cellUniq = new Int32Array(N);
  const uCount = new Int32Array(N);
  const uLin = new Float32Array(N * 3);
  const uOk = new Float32Array(N * 3);
  let U = 0;

  for (let i = 0; i < N; i++) {
    const o = i * 3;
    const key = (srgb[o] << 16) | (srgb[o + 1] << 8) | srgb[o + 2];
    let idx = uniqOf.get(key);
    if (idx === undefined) {
      idx = U++;
      uniqOf.set(key, idx);
      const r = linear[o];
      const g = linear[o + 1];
      const b = linear[o + 2];
      uLin[idx * 3] = r;
      uLin[idx * 3 + 1] = g;
      uLin[idx * 3 + 2] = b;
      const ok = linearToOklab(r, g, b);
      uOk[idx * 3] = ok[0];
      uOk[idx * 3 + 1] = ok[1];
      uOk[idx * 3 + 2] = ok[2];
    }
    uCount[idx]++;
    cellUniq[i] = idx;
  }

  const k = Math.min(maxColors, U);

  /* ---------------- 2) k-means++ 初始化 ---------------- */
  const cent = new Float32Array(k * 3);
  const rand = mulberry32(seed);

  {
    let r = rand() * N;
    let chosen = 0;
    for (let i = 0; i < U; i++) {
      r -= uCount[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    cent[0] = uOk[chosen * 3];
    cent[1] = uOk[chosen * 3 + 1];
    cent[2] = uOk[chosen * 3 + 2];
  }

  const d2 = new Float64Array(U).fill(Number.POSITIVE_INFINITY);

  for (let c = 1; c < k; c++) {
    const pl = cent[(c - 1) * 3];
    const pa = cent[(c - 1) * 3 + 1];
    const pb = cent[(c - 1) * 3 + 2];
    for (let i = 0; i < U; i++) {
      const dl = uOk[i * 3] - pl;
      const da = uOk[i * 3 + 1] - pa;
      const db = uOk[i * 3 + 2] - pb;
      const d = dl * dl + da * da + db * db;
      if (d < d2[i]) d2[i] = d;
    }

    let sum = 0;
    for (let i = 0; i < U; i++) sum += uCount[i] * d2[i];

    let chosen = c % U;
    if (sum > 0) {
      let r = rand() * sum;
      for (let i = 0; i < U; i++) {
        r -= uCount[i] * d2[i];
        if (r <= 0) {
          chosen = i;
          break;
        }
      }
    }
    cent[c * 3] = uOk[chosen * 3];
    cent[c * 3 + 1] = uOk[chosen * 3 + 1];
    cent[c * 3 + 2] = uOk[chosen * 3 + 2];
  }

  /* ---------------- 3) Lloyd 迭代 ---------------- */
  const labels = new Int32Array(U).fill(-1);
  const sumW = new Float64Array(k);
  const sumL = new Float64Array(k);
  const sumA = new Float64Array(k);
  const sumB = new Float64Array(k);
  let iterations = 0;

  for (; iterations < maxIter; iterations++) {
    let changed = false;

    for (let i = 0; i < U; i++) {
      const L = uOk[i * 3];
      const A = uOk[i * 3 + 1];
      const B = uOk[i * 3 + 2];
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c++) {
        const dl = cent[c * 3] - L;
        const da = cent[c * 3 + 1] - A;
        const db = cent[c * 3 + 2] - B;
        const d = dl * dl + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }

    sumW.fill(0);
    sumL.fill(0);
    sumA.fill(0);
    sumB.fill(0);
    for (let i = 0; i < U; i++) {
      const c = labels[i];
      const w = uCount[i];
      sumW[c] += w;
      sumL[c] += uOk[i * 3] * w;
      sumA[c] += uOk[i * 3 + 1] * w;
      sumB[c] += uOk[i * 3 + 2] * w;
    }

    let empties = 0;
    for (let c = 0; c < k; c++) {
      if (sumW[c] > 0) {
        cent[c * 3] = sumL[c] / sumW[c];
        cent[c * 3 + 1] = sumA[c] / sumW[c];
        cent[c * 3 + 2] = sumB[c] / sumW[c];
      } else {
        empties++;
      }
    }

    if (!changed && empties === 0) break;

    // 空簇：搬到离自己质心最远的点，下一轮重新竞争
    if (empties > 0) {
      for (let c = 0; c < k; c++) {
        if (sumW[c] !== 0) continue;
        let worst = -1;
        let worstD = -1;
        for (let i = 0; i < U; i++) {
          const cc = labels[i];
          const dl = uOk[i * 3] - cent[cc * 3];
          const da = uOk[i * 3 + 1] - cent[cc * 3 + 1];
          const db = uOk[i * 3 + 2] - cent[cc * 3 + 2];
          const d = dl * dl + da * da + db * db;
          if (d > worstD) {
            worstD = d;
            worst = i;
          }
        }
        if (worst >= 0) {
          cent[c * 3] = uOk[worst * 3];
          cent[c * 3 + 1] = uOk[worst * 3 + 1];
          cent[c * 3 + 2] = uOk[worst * 3 + 2];
        }
      }
    }
  }

  /* ---------------- 4) 簇代表色（线性光加权平均）→ DMC ---------------- */
  const repLin = new Float32Array(k * 3);
  const repW = new Float64Array(k);
  for (let i = 0; i < U; i++) {
    const c = labels[i];
    const w = uCount[i];
    repLin[c * 3] += uLin[i * 3] * w;
    repLin[c * 3 + 1] += uLin[i * 3 + 1] * w;
    repLin[c * 3 + 2] += uLin[i * 3 + 2] * w;
    repW[c] += w;
  }

  const clusterDmc: (DmcColor | null)[] = new Array<DmcColor | null>(k).fill(null);
  const byCode = new Map<string, Group>();

  for (let c = 0; c < k; c++) {
    if (repW[c] === 0) continue;
    const r = repLin[c * 3] / repW[c];
    const g = repLin[c * 3 + 1] / repW[c];
    const b = repLin[c * 3 + 2] / repW[c];
    const lab = linearRgbToLab(r, g, b);
    const ok: Oklab = linearToOklab(r, g, b);
    const match = nearestDmc(ok, lab);
    clusterDmc[c] = match.color;

    const existing = byCode.get(match.color.code);
    if (existing) {
      existing.count += repW[c];
      existing.members.push(c);
    } else {
      byCode.set(match.color.code, {
        dmc: match.color,
        count: repW[c],
        members: [c],
      });
    }
  }

  /* ---------------- 5) 小色归并（抑制碎片） ---------------- */
  const groups: Group[] = [...byCode.values()];
  const threshold = Math.max(1, Math.round(minShare * N));

  while (groups.length > 1) {
    groups.sort((a, b) => a.count - b.count);
    const small = groups[0];
    if (small.count >= threshold) break;

    let bestIdx = 1;
    let bestDe = Number.POSITIVE_INFINITY;
    for (let j = 1; j < groups.length; j++) {
      const de = ciede2000(small.dmc.lab, groups[j].dmc.lab);
      if (de < bestDe) {
        bestDe = de;
        bestIdx = j;
      }
    }
    const target = groups[bestIdx];
    target.count += small.count;
    target.members.push(...small.members);
    groups.splice(0, 1);
  }

  groups.sort((a, b) => b.count - a.count);

  // 簇 → 最终色号下标
  const clusterToFinal = new Int32Array(k).fill(-1);
  groups.forEach((g, gi) => {
    for (const m of g.members) clusterToFinal[m] = gi;
  });

  /* ---------------- 6) 展开成格 + 组装 palette ---------------- */
  const cells = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    cells[i] = clusterToFinal[labels[cellUniq[i]]];
  }

  const symbols = assignSymbols(groups.length);
  const palette: PaletteEntry[] = [];
  const colors: QuantizedColor[] = [];

  groups.forEach((g, gi) => {
    const rgb = g.dmc.rgb;
    const lin = [srgb8ToLinear(rgb[0]), srgb8ToLinear(rgb[1]), srgb8ToLinear(rgb[2])] as const;
    palette.push({
      index: gi,
      dmcCode: g.dmc.code,
      name: g.dmc.name,
      hex: g.dmc.hex,
      lab: g.dmc.lab,
      symbol: symbols[gi],
    });
    colors.push({
      dmc: g.dmc,
      symbol: symbols[gi],
      textColor: contrastOn(lin[0], lin[1], lin[2]),
      stitchCount: g.count,
      share: g.count / N,
    });
  });

  /* ---------------- 7) 配色误差（OKLab 加权平均距离） ---------------- */
  let errSum = 0;
  for (let i = 0; i < U; i++) {
    const dmc = colors[clusterToFinal[labels[i]]].dmc.oklab;
    const dl = uOk[i * 3] - dmc[0];
    const da = uOk[i * 3 + 1] - dmc[1];
    const db = uOk[i * 3 + 2] - dmc[2];
    errSum += Math.sqrt(dl * dl + da * da + db * db) * uCount[i];
  }

  return {
    cells,
    palette,
    colors,
    iterations,
    uniqueColors: U,
    meanOklabError: N === 0 ? 0 : errSum / N,
  };
}

/**
 * 「系统推荐色数」：在去重颜色上做肘部探测。
 *
 * 做法：对 k ∈ {6, 10, 14, 18, 22, 26} 各跑一遍（样本上限 4000，固定种子），
 * 取「再增加 4 色，误差改善不足 8%」的第一个 k。
 * 这是可解释的规则，不是拍脑袋的常数 —— 用户问「为什么推荐 14 色」时能回答。
 */
export function suggestColorCount(
  linear: Float32Array,
  srgb: Uint8ClampedArray,
  W: number,
  H: number,
): number {
  const N = W * H;
  // 均匀抽样，最多 4000 个样本
  const stride = Math.max(1, Math.floor(N / 4000));
  const sampleLin = new Float32Array(Math.ceil(N / stride) * 3);
  const sampleSrgb = new Uint8ClampedArray(Math.ceil(N / stride) * 3);
  let n = 0;
  for (let i = 0; i < N; i += stride) {
    const o = i * 3;
    sampleLin[n * 3] = linear[o];
    sampleLin[n * 3 + 1] = linear[o + 1];
    sampleLin[n * 3 + 2] = linear[o + 2];
    sampleSrgb[n * 3] = srgb[o];
    sampleSrgb[n * 3 + 1] = srgb[o + 1];
    sampleSrgb[n * 3 + 2] = srgb[o + 2];
    n++;
  }

  const candidates = [6, 10, 14, 18, 22, 26];
  const errors: number[] = [];
  for (const k of candidates) {
    const r = quantizeToDmc(sampleLin, sampleSrgb, n, 1, {
      maxColors: k,
      seed: 7,
      minColorShare: 0,
      maxIterations: 10,
    });
    errors.push(r.meanOklabError);
  }

  for (let i = 1; i < candidates.length; i++) {
    const prev = errors[i - 1];
    const cur = errors[i];
    // 从上一个候选加到当前候选，误差改善不足 8% → 上一个就是肘部
    const gain = prev === 0 ? 1 : (prev - cur) / prev;
    if (gain < 0.08) return candidates[i - 1];
  }
  return candidates[candidates.length - 1];
}
