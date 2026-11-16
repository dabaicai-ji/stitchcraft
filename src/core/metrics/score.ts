/**
 * 难度评分（指标 5）—— 只用你指定的 1 / 2 / 4 三项加权。
 *
 * 为什么不用黑箱：
 *   用户看到的必须是一个**能被解释的分数**。「3 星」如果说不清是哪一项拉高的，
 *   用户下次就不会信。所以每个子项都是 0..1 的归一化值，并且原样返回到 breakdown 里。
 *
 * 三项含义：
 *   noise     —— 绣起来费不费手（孤岛针 + 碎片块，反复起收针）
 *   confusion —— 会不会绣错（相邻色太像）
 *   supply    —— 买起来贵不贵（色数 + 总束数）
 *
 * ⚠️ 已知局限：真实难度里「总格数」其实是最强驱动项，但你没有把它选进指标集，
 *    所以我按你的要求没有把它加进公式。stitchableCells 仍留在报告里，
 *    score() 预留了接入位；标定后建议改为 4 项加权（见文末注释）。
 */

import type {
  ComponentStats,
  ConfusionStats,
  DifficultyResult,
  SupplyStats,
} from '../types.ts';
import { CONFIG } from '../config.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface DifficultyInput {
  continuity: ComponentStats;
  confusion: ConfusionStats;
  supply: SupplyStats;
  colorCount: number;
}

export function computeDifficulty(input: DifficultyInput): DifficultyResult {
  const { continuity: cf, confusion: co, supply: sp, colorCount } = input;
  const s = CONFIG.score;

  // ---- 1) 噪点项 ----
  const noise =
    0.5 * clamp01(cf.isolatedRatio / CONFIG.continuity.blockIsolatedRatio) +
    0.5 * clamp01(cf.confettiRatio / CONFIG.continuity.blockConfettiRatio);

  // ---- 2) 混淆项 ----
  const confusion = clamp01(
    co.confusableEdgeRatio / CONFIG.confusion.normalizeRatio,
  );

  // ---- 4) 采购项 ----
  const [lo, hi] = s.colorRange;
  const colorTerm = clamp01((colorCount - lo) / (hi - lo));
  const skeinTerm = clamp01(sp.totalSkeins / s.skeinRef);
  const supply = 0.6 * colorTerm + 0.4 * skeinTerm;

  const score = clamp01(
    s.wNoise * noise + s.wConfusion * confusion + s.wSupply * supply,
  );

  const breaks = s.starBreaks;
  let stars = 5;
  for (let i = 0; i < breaks.length; i++) {
    if (score < breaks[i]) {
      stars = i + 1;
      break;
    }
  }

  const label = s.starLabels[stars - 1] ?? '未知';

  return {
    stars,
    label,
    score,
    breakdown: {
      noise: round3(noise),
      confusion: round3(confusion),
      supply: round3(supply),
    },
  };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/*
 * 标定后的建议公式（4 项，等你确认再加）：
 *
 *   scale = clamp01(Math.log10(stitchableCells / 5000) / Math.log10(30000 / 5000))
 *   score = 0.30*noise + 0.20*confusion + 0.20*supply + 0.30*scale
 */
