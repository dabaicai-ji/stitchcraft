/**
 * 相邻色混淆（指标 2）—— 我认为这是整份报告里最「值钱」的一条。
 *
 * 逻辑：图纸上两个色号可以不同，但绣到布上由于线材光泽、灯光、纹理，
 * 肉眼根本分不出来 —— 这是定制图纸最常见的售后投诉来源。
 *
 * 做法分两步（顺序很重要）：
 *   1) 先统计「哪些色两两相邻」以及相邻多少条边（只看 4 邻接，斜角不算相邻）。
 *      先做这一步是因为 ΔE00 有三角函数和开方，对 780 个色对还好，
 *      但不该对全图每个像素边界都算一次。
 *   2) 只对**真实相邻** 且 共享边 ≥ minSharedEdges 的色对算 CIEDE2000。
 *
 * 严重度 severity = sharedEdges × (1 − ΔE00 / maxDeltaE)
 *   —— 既考虑「像不像」，也考虑「接触面多大」。两小块擦肩而过不该报警，
 *      两片大面积同色块挨着才真的会绣错。
 *
 * 复杂度：O(N + P)，N=格数，P=相邻色对数（≤ 780）。400×400 < 10ms。
 */

import { BACKGROUND } from '../types.ts';
import type { ConfusablePair, ConfusionStats, GridData } from '../types.ts';
import { ciede2000 } from '../color/cie.ts';
import { CONFIG } from '../config.ts';

export interface ConfusionOptions {
  maxDeltaE?: number;
  minSharedEdges?: number;
  /** 报告里最多保留多少对，避免 LLM payload 爆炸 */
  maxPairs?: number;
}

export function computeConfusionStats(
  grid: GridData,
  opts: ConfusionOptions = {},
): ConfusionStats {
  const maxDeltaE = opts.maxDeltaE ?? CONFIG.confusion.maxDeltaE;
  const minSharedEdges = opts.minSharedEdges ?? CONFIG.confusion.minSharedEdges;
  const maxPairs = opts.maxPairs ?? 24;

  const { width: W, height: H, cells, palette } = grid;
  const n = palette.length;
  if (n > 1024) throw new Error('palette 超过 1024 色，键编码会冲突');

  const KEY = 1024;
  const edgeMap = new Map<number, number>();
  let totalEdges = 0;

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const a = cells[i];
      if (a === BACKGROUND) continue;

      // 右邻
      if (x < W - 1) {
        const b = cells[i + 1];
        if (b !== BACKGROUND && b !== a) {
          totalEdges++;
          const key = a < b ? a * KEY + b : b * KEY + a;
          edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
        }
      }
      // 下邻
      if (y < H - 1) {
        const b = cells[i + W];
        if (b !== BACKGROUND && b !== a) {
          totalEdges++;
          const key = a < b ? a * KEY + b : b * KEY + a;
          edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const pairs: ConfusablePair[] = [];
  let severitySum = 0;

  for (const [key, sharedEdges] of edgeMap) {
    if (sharedEdges < minSharedEdges) continue;
    const a = Math.floor(key / KEY);
    const b = key % KEY;
    const dE = ciede2000(palette[a].lab, palette[b].lab);
    if (dE >= maxDeltaE) continue;

    const severity = sharedEdges * (1 - dE / maxDeltaE);
    severitySum += severity;
    pairs.push({
      a,
      b,
      dmcA: palette[a].dmcCode,
      dmcB: palette[b].dmcCode,
      deltaE00: dE,
      sharedEdges,
      severity,
    });
  }

  pairs.sort((p, q) => q.severity - p.severity);
  if (pairs.length > maxPairs) pairs.length = maxPairs;

  return {
    maxDeltaE,
    totalEdges,
    pairCount: pairs.length,
    pairs,
    severitySum,
    confusableEdgeRatio: totalEdges === 0 ? 0 : severitySum / totalEdges,
  };
}
