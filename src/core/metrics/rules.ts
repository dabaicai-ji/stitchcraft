/**
 * 规则引擎 —— 可绣性结论的唯一来源。
 *
 * 架构上的关键决定：**建议由代码产生，不是由 LLM 产生。**
 * LLM 拿到的 issues 已经是「结论 + 证据 + 可选参数补丁」，
 * 它唯一的自由是决定怎么把这几句话说顺。这样：
 *   - DeepSeek 挂了 / 超时 / 被限流，产品依然完整；
 *   - 不会出现「模型编了一个不存在的指标」；
 *   - 每条建议都能一键 apply（paramPatch），闭环到重跑管线。
 */

import type {
  ComponentStats,
  ConfusionStats,
  Issue,
  ScaleStats,
  SupplyStats,
  ToneStats,
} from '../types.ts';
import { CONFIG } from '../config.ts';

export interface RuleInput {
  scale: ScaleStats;
  continuity: ComponentStats;
  confusion: ConfusionStats;
  supply: SupplyStats;
  tone: ToneStats | null;
  colorCount: number;
  /** 用户设定的最大色数上限，用于判定「调色板没吃满」 */
  maxColors: number;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const LEVEL_ORDER: Record<Issue['level'], number> = { block: 0, warn: 1, info: 2 };

export function buildIssues(input: RuleInput): Issue[] {
  const { scale, continuity: cf, confusion: co, supply: sp, tone, colorCount } = input;
  const issues: Issue[] = [];

  /* ---------------- 指标 1：碎片 ---------------- */
  if (cf.confettiRatio >= CONFIG.continuity.blockConfettiRatio) {
    issues.push({
      code: 'HIGH_CONFETTI',
      level: 'block',
      evidence: {
        confettiRatio: cf.confettiRatio,
        confettiCells: cf.confettiCells,
        stitchableCells: cf.stitchableCells,
      },
      suggestion:
        `碎片率 ${pct(cf.confettiRatio)}，即 ${cf.confettiCells} 格落在 1–4 格的同色小块里。` +
        `绣的时候要不停起针收针，背面全是线头，实际耗时大约是图纸格子数的 2 倍以上。` +
        `建议把色数从 ${colorCount} 降到 ${Math.max(8, Math.round(colorCount * 0.7))} 度一下。`,
      paramPatch: { maxColors: Math.max(8, Math.round(colorCount * 0.7)) },
    });
  } else if (cf.confettiRatio >= CONFIG.continuity.warnConfettiRatio) {
    issues.push({
      code: 'HIGH_CONFETTI',
      level: 'warn',
      evidence: { confettiRatio: cf.confettiRatio, confettiCells: cf.confettiCells },
      suggestion:
        `碎片率 ${pct(cf.confettiRatio)}，偏多但还能接受。` +
        `想更省事可以把色数再降 3–5 个；想更细腻就保持现状。`,
      paramPatch: { maxColors: Math.max(8, colorCount - 3) },
    });
  }

  if (cf.isolatedRatio >= CONFIG.continuity.warnIsolatedRatio) {
    issues.push({
      code: 'HIGH_ISOLATED',
      level: cf.isolatedRatio >= CONFIG.continuity.blockIsolatedRatio ? 'block' : 'warn',
      evidence: {
        isolatedRatio: cf.isolatedRatio,
        isolatedCells: cf.isolatedCells,
      },
      suggestion:
        `有 ${cf.isolatedCells} 格（${pct(cf.isolatedRatio)}）周围 8 格没有任何同色，是完全孤立的单针。` +
        `单针必须单独起针收针，是最费工的部分。可以把「最小色占比」调高一点，让这些零星色并进邻近色。`,
      paramPatch: { minColorShare: 0.004 },
    });
  }

  // 4 邻域孤立 ≫ 8 邻域孤立 → 说明大量格子只靠对角相连（棋盘格病理）
  if (
    cf.isolated4Ratio >= CONFIG.continuity.warnIsolated4Ratio &&
    cf.isolated4Ratio > cf.isolatedRatio * 4
  ) {
    issues.push({
      code: 'DIAGONAL_ONLY_TISSUE',
      level: 'warn',
      evidence: {
        isolated4Ratio: cf.isolated4Ratio,
        isolatedRatio: cf.isolatedRatio,
      },
      suggestion:
        `有 ${pct(cf.isolated4Ratio)} 的格子只和同色**对角相连**。从画面上看是连着的，` +
        `但下针时要沿对角线走，背面会多出大量斜向走线。减一两档色数或做轻微平滑可以消除。`,
      paramPatch: { maxColors: Math.max(8, colorCount - 4) },
    });
  }

  /* ---------------- 指标 2：混淆色 ---------------- */
  const topPairs = co.pairs.slice(0, 3);
  for (const p of topPairs) {
    issues.push({
      code: 'CONFUSABLE_PAIR',
      level: p.deltaE00 < co.maxDeltaE * 0.5 ? 'block' : 'warn',
      evidence: {
        dmcA: p.dmcA,
        dmcB: p.dmcB,
        deltaE00: Math.round(p.deltaE00 * 100) / 100,
        sharedEdges: p.sharedEdges,
      },
      suggestion:
        `DMC ${p.dmcA} 和 DMC ${p.dmcB} 色差只有 ${p.deltaE00.toFixed(1)}（低于 ${co.maxDeltaE} 的安全线），` +
        `而且有 ${p.sharedEdges} 条边直接相邻 —— 绣到布上这两种线几乎分不出来，非常容易绣错位置。` +
        `建议换掉其中一个，或者把色数降下来让它们合并。`,
      paramPatch: { maxColors: Math.max(8, colorCount - 4) },
    });
  }

  /* ---------------- 指标 6：明暗溢出 ---------------- */
  if (tone) {
    const shadow = tone.shadowClipRatio;
    const high = tone.highlightClipRatio;
    const limit = CONFIG.tone.warnClipRatio;
    if (shadow >= limit || high >= limit) {
      issues.push({
        code: 'TONE_CLIPPED',
        level: 'warn',
        evidence: {
          shadowClipRatio: Math.round(shadow * 1000) / 1000,
          highlightClipRatio: Math.round(high * 1000) / 1000,
          meanLuma: Math.round(tone.meanLuma * 1000) / 1000,
        },
        suggestion:
          `原图有 ${pct(shadow)} 的像素暗到 5% 亮度以下` +
          (high > limit ? `，${pct(high)} 亮到 95% 以上` : '') +
          `。减色后这些区域会被压成一块死黑/死白，细节全部丢失，调任何参数都救不回来。` +
          `建议换一张曝光更正常的照片，或先在修图软件里提亮。`,
      });
    }
  }

  /* ---------------- 其他工程性提示 ---------------- */
  if (colorCount >= CONFIG.scale.warnColorCount) {
    issues.push({
      code: 'TOO_MANY_COLORS',
      level: 'warn',
      evidence: { colorCount },
      suggestion:
        `${colorCount} 种色号意味着要买 ${sp.totalSkeins} 束线，换线频繁且成本不低。` +
        `多数照片类图纸 12–18 色就是甜点区，再高收益递减。`,
      paramPatch: { maxColors: 16 },
    });
  }

  if (
    input.maxColors > 0 &&
    colorCount < input.maxColors * CONFIG.scale.colorCollapseRatio
  ) {
    issues.push({
      code: 'COLOR_COLLAPSE',
      level: 'info',
      evidence: { colorCount, maxColors: input.maxColors },
      suggestion:
        `你把色数上限设成了 ${input.maxColors}，但实际只用到 ${colorCount} 色 —— ` +
        `说明这张图的颜色本来就少（或者被合并掉了）。调高上限不会增加细节，不用白试。`,
    });
  }

  if (sp.oneSkeinTrap.length > 0 && colorCount > 8) {
    issues.push({
      code: 'ONE_SKEIN_TRAP',
      level: 'info',
      evidence: {
        trapCount: sp.oneSkeinTrap.length,
        stitchThreshold: CONFIG.thread.oneSkeinTrapStitches,
      },
      suggestion:
        `有 ${sp.oneSkeinTrap.length} 个色号用料不到 ${CONFIG.thread.oneSkeinTrapStitches} 格，` +
        `却各要买一整束。合并掉这些零星色，采购成本能直接降一档。`,
      paramPatch: { minColorShare: 0.004 },
    });
  }

  if (scale.stitchableCells >= CONFIG.scale.warnStitchableCells) {
    issues.push({
      code: 'HUGE_PROJECT',
      level: 'warn',
      evidence: {
        stitchableCells: scale.stitchableCells,
        widthCm: Math.round(scale.widthCm * 10) / 10,
        heightCm: Math.round(scale.heightCm * 10) / 10,
      },
      suggestion:
        `${scale.stitchableCells} 格、成品约 ${scale.widthCm.toFixed(1)}×${scale.heightCm.toFixed(1)}cm，` +
        `这已经是个长期项目了。按熟练者每小时 200 格算，需要 ${Math.round(
          scale.stitchableCells / 200,
        )} 小时，建议先做小样。`,
      paramPatch: { targetWidth: 150 },
    });
  }

  issues.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return issues;
}
