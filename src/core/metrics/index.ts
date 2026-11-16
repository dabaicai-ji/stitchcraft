/**
 * 报告装配层 —— 把 5 个指标合成一份可直接序列化的 StitchabilityReport。
 *
 * 这份 report 是「唯一真相」：
 *   - UI 用它渲染指标卡片；
 *   - 规则引擎用它生成 issues；
 *   - LLM 只能拿到它（以及 buildLLMPayload 压缩后的版本），拿不到图。
 */

import type { GridData, StitchabilityReport, ToneStats } from '../types.ts';
import { METRICS_VERSION } from '../config.ts';
import { computeComponentStats } from './components.ts';
import { computeConfusionStats } from './confusion.ts';
import type { ConfusionOptions } from './confusion.ts';
import { computeSupply } from './thread.ts';
import type { ThreadOptions } from './thread.ts';
import { computeDifficulty } from './score.ts';
import { buildIssues } from './rules.ts';

export interface BuildReportInput {
  grid: GridData;
  /** 减色前的亮度统计；没有就传 null，报告里对应字段为 null */
  tone?: ToneStats | null;
  /** 用户设定的色数上限，用于「调色板没吃满」判定 */
  maxColors?: number;
  thread?: ThreadOptions;
  confusion?: ConfusionOptions;
  confettiMax?: number;
  /** 注入时间戳，保证单测可复现 */
  now?: string;
}

export function buildStitchabilityReport(
  input: BuildReportInput,
): StitchabilityReport {
  const { grid } = input;
  const tone = input.tone ?? null;

  const { width, height, fabricCount } = grid;
  const totalCells = width * height;

  const continuity = computeComponentStats(grid, input.confettiMax);
  const confusion = computeConfusionStats(grid, input.confusion);
  const supply = computeSupply(grid, continuity.perColor, input.thread);

  const colorCount = continuity.perColor.reduce(
    (acc, p) => acc + (p.stitchCount > 0 ? 1 : 0),
    0,
  );

  const scale = {
    width,
    height,
    totalCells,
    stitchableCells: continuity.stitchableCells,
    backgroundCells: totalCells - continuity.stitchableCells,
    colorCount,
    fabricCount,
    widthCm: (width / fabricCount) * 2.54,
    heightCm: (height / fabricCount) * 2.54,
  };

  const difficulty = computeDifficulty({
    continuity,
    confusion,
    supply,
    colorCount,
  });

  const issues = buildIssues({
    scale,
    continuity,
    confusion,
    supply,
    tone,
    colorCount,
    maxColors: input.maxColors ?? colorCount,
  });

  return {
    version: METRICS_VERSION,
    generatedAt: input.now ?? new Date().toISOString(),
    scale,
    continuity,
    confusion,
    tone,
    supply,
    difficulty,
    issues,
  };
}
