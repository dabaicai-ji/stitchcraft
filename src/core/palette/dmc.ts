/**
 * DMC 线号目录：把生成的数据文件变成可查询、可匹配的色卡。
 *
 * 匹配策略（和 Step 1 的减色接得上）：
 *   1) 用 OKLab 欧氏距离在 489 色里粗筛出 top-8 候选；
 *   2) 再用 CIEDE2000 在 CIELAB 下重排取最优。
 *
 * 为什么不直接全量跑 CIEDE2000：它带三角函数和开方，是 OKLab 距离的 10 倍慢。
 * 粗筛 + 精排能在保证精度的同时把开销压到可忽略（32 个质心 × 489 色 < 2ms）。
 */

import { DMC_RAW, DMC_META } from '../data/dmc-colors.ts';
import type { RawDmcColor } from '../data/dmc-colors.ts';
import { ciede2000, linearRgbToLab } from '../color/cie.ts';
import { linearToOklab, srgb8ToLinear } from '../color/oklab.ts';
import type { Oklab } from '../color/oklab.ts';
import type { Lab } from '../types.ts';

export { DMC_META };
export type { RawDmcColor };

export interface DmcColor {
  code: string;
  name: string;
  hex: string;
  rgb: readonly [number, number, number];
  lab: Lab;
  oklab: Oklab;
}

export interface DmcMatch {
  color: DmcColor;
  deltaE00: number;
  /** OKLab 距离，用于粗筛与诊断 */
  oklabDist: number;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** 489 色全量，启动时一次性预算好 Lab / OKLab（约 1ms） */
export const DMC_PALETTE: DmcColor[] = DMC_RAW.map((c: RawDmcColor) => {
  const rgb = hexToRgb(c.hex);
  const lin = [
    srgb8ToLinear(rgb[0]),
    srgb8ToLinear(rgb[1]),
    srgb8ToLinear(rgb[2]),
  ] as const;
  return {
    code: c.code,
    name: c.name,
    hex: c.hex,
    rgb,
    lab: linearRgbToLab(lin[0], lin[1], lin[2]),
    oklab: linearToOklab(lin[0], lin[1], lin[2]),
  };
});

export const DMC_BY_CODE = new Map<string, DmcColor>(
  DMC_PALETTE.map((c) => [c.code, c]),
);

/** 预计算 OKLab 三元组，避免匹配时反复取对象属性 */
const OKLAB_L = new Float32Array(DMC_PALETTE.length);
const OKLAB_A = new Float32Array(DMC_PALETTE.length);
const OKLAB_B = new Float32Array(DMC_PALETTE.length);
for (let i = 0; i < DMC_PALETTE.length; i++) {
  OKLAB_L[i] = DMC_PALETTE[i].oklab[0];
  OKLAB_A[i] = DMC_PALETTE[i].oklab[1];
  OKLAB_B[i] = DMC_PALETTE[i].oklab[2];
}

/** 粗筛候选数 */
const CANDIDATES = 8;

/**
 * 把一个颜色匹配到最近的、真实可买的 DMC 线号。
 *
 * @param oklab 待匹配颜色的 OKLab
 * @param lab   同一颜色的 CIELAB（用于精排）
 */
export function nearestDmc(oklab: Oklab, lab: Lab): DmcMatch {
  const n = DMC_PALETTE.length;
  const dist = new Float32Array(n);
  const [L, A, B] = oklab;

  for (let i = 0; i < n; i++) {
    const dl = OKLAB_L[i] - L;
    const da = OKLAB_A[i] - A;
    const db = OKLAB_B[i] - B;
    dist[i] = dl * dl + da * da + db * db;
  }

  // 取 top-8 下标（局部插入排序，避免全量 sort）
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    let pos = idx.length;
    while (pos > 0 && dist[idx[pos - 1]] > d) pos--;
    if (pos < CANDIDATES) {
      idx.splice(pos, 0, i);
      if (idx.length > CANDIDATES) idx.pop();
    }
  }

  let best = idx[0];
  let bestDe = Number.POSITIVE_INFINITY;
  for (const i of idx) {
    const de = ciede2000(lab, DMC_PALETTE[i].lab);
    if (de < bestDe) {
      bestDe = de;
      best = i;
    }
  }

  return {
    color: DMC_PALETTE[best],
    deltaE00: bestDe,
    oklabDist: Math.sqrt(dist[best]),
  };
}

/** 纯 CIEDE2000 匹配（用于小色合并时找「最近的已用色」） */
export function nearestDmcByLab(lab: Lab): DmcMatch {
  let best = 0;
  let bestDe = Number.POSITIVE_INFINITY;
  for (let i = 0; i < DMC_PALETTE.length; i++) {
    const de = ciede2000(lab, DMC_PALETTE[i].lab);
    if (de < bestDe) {
      bestDe = de;
      best = i;
    }
  }
  return {
    color: DMC_PALETTE[best],
    deltaE00: bestDe,
    oklabDist: 0,
  };
}
