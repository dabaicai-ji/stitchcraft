/**
 * 线量 / 采购估算（指标 4）
 *
 * 采用**几何法**，不是抄「一束约 1000 格」的民间经验值，因为那个数字算不通：
 *
 *   14ct Aida：1 格 = 25.4/14 = 1.814mm 见方
 *   一个十字 = 两条对角线 = 2 × 1.814 × √2 ≈ 5.13mm（每股走这么长）
 *   2 股并绣 → 每格消耗一束的「长度」= 2 × 5.13 = 10.26mm
 *   加 30% 背面走线/起收针损耗 → 13.3mm
 *   一束 8000mm → 8000 / 13.3 ≈ 600 格
 *
 * 「1000 格」的说法要么漏算了双股，要么把「6 股拆开各算一遍」了。
 * 我这里取保守值：宁可让用户多买一束，也不能绣到一半断线。
 * 该系数（waste）预留为可配置常量，等你用真实作品标定后替换。
 *
 * 复杂度：O(C)，C=色数（≤40）。可忽略。
 */

import type {
  FabricCount,
  GridData,
  PerColorComponents,
  SupplyStats,
  ThreadUsage,
} from '../types.ts';
import { CONFIG } from '../config.ts';

export interface ThreadOptions {
  /** 背面走线 + 起收针损耗 */
  waste?: number;
  skeinLengthMm?: number;
  safety?: number;
  skeinPrice?: number;
  oneSkeinTrapStitches?: number;
}

/** 单格单股走线长度（mm） */
export function pathMmPerStitchPerStrand(
  fabricCount: FabricCount,
  waste: number = CONFIG.thread.waste,
): number {
  return 2 * (25.4 / fabricCount) * Math.SQRT2 * (1 + waste);
}

export function computeSupply(
  grid: GridData,
  perColor: PerColorComponents[],
  opts: ThreadOptions = {},
): SupplyStats {
  const waste = opts.waste ?? CONFIG.thread.waste;
  const skeinLengthMm = opts.skeinLengthMm ?? CONFIG.thread.skeinLengthMm;
  const safety = opts.safety ?? CONFIG.thread.safety;
  const skeinPrice = opts.skeinPrice ?? CONFIG.thread.skeinPrice;
  const trapStitches =
    opts.oneSkeinTrapStitches ?? CONFIG.thread.oneSkeinTrapStitches;

  const pathPerStrand = pathMmPerStitchPerStrand(grid.fabricCount, waste);
  const perStitchMm = pathPerStrand * grid.strands;
  const stitchesPerSkein = Math.floor(skeinLengthMm / perStitchMm);

  const usage: ThreadUsage[] = [];
  let totalSkeins = 0;
  let totalStitches = 0;

  for (const pc of perColor) {
    if (pc.stitchCount <= 0) continue;
    const entry = grid.palette[pc.paletteIndex];
    const raw = (pc.stitchCount * perStitchMm * safety) / skeinLengthMm;
    const skeins = Math.max(1, Math.ceil(raw));
    const cost = skeins * skeinPrice;

    totalSkeins += skeins;
    totalStitches += pc.stitchCount;

    usage.push({
      paletteIndex: pc.paletteIndex,
      dmcCode: entry.dmcCode,
      name: entry.name,
      hex: entry.hex,
      symbol: entry.symbol,
      stitchCount: pc.stitchCount,
      stitchesPerSkein,
      skeins,
      cost,
    });
  }

  // 按格数降序，方便用户先绣大块
  usage.sort((a, b) => b.stitchCount - a.stitchCount);

  const oneSkeinTrap = usage
    .filter((u) => u.stitchCount < trapStitches)
    .map((u) => ({
      dmcCode: u.dmcCode,
      stitchCount: u.stitchCount,
      skeins: u.skeins,
      cost: u.cost,
    }));

  return {
    fabricCount: grid.fabricCount,
    strands: grid.strands,
    pathMmPerStitchPerStrand: pathPerStrand,
    perStitchMm,
    totalStitches,
    totalSkeins,
    totalCost: totalSkeins * skeinPrice,
    perColor: usage,
    oneSkeinTrap,
  };
}
