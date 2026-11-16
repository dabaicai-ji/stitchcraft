/**
 * 管线编排：源图 → 重采样 → 减色 → 网格 → 可绣性报告。
 *
 * 纯函数：输入像素和参数，输出可序列化的结果，不碰 DOM。
 * 这样它既能跑在 Web Worker 里，也能在 Node 里被单测直接调用。
 */

import type {
  FabricCount,
  GridData,
  StitchabilityReport,
  ToneStats,
} from '../types.ts';
import type { QuantizeResult } from './quantize.ts';
import { quantizeToDmc, suggestColorCount } from './quantize.ts';
import { resizeToGrid } from './resize.ts';
import { stylizeGrid } from './stylize.ts';
import { computeToneStats } from '../metrics/tone.ts';
import { buildStitchabilityReport } from '../metrics/index.ts';
import { CONFIG } from '../config.ts';

export interface PipelineParams {
  /** 图纸宽度（格） */
  targetWidth: number;
  /** 色数上限 */
  maxColors: number;
  fabricCount: FabricCount;
  /** 每股数 */
  strands: number;
  /** 小色归并阈值（占比） */
  minColorShare: number;
  seed: number;
  /** 保边平滑强度 0..1（0 = 关闭） */
  stylize: number;
}

export const DEFAULT_PARAMS: PipelineParams = {
  targetWidth: 120,
  maxColors: 16,
  fabricCount: 14,
  strands: 2,
  minColorShare: CONFIG.quantize.minColorShare,
  seed: CONFIG.quantize.seed,
  /**
   * 默认 0.4 —— 实测拐点（3 张真实图，120 格 / 16 色）：
   *   碎片率 12.3→3.3% / 18.8→11.6% / 22.9→5.1%
   *   再往上（0.6+）收益递减，且开始把用色数从 16 压到 12–13（细节被吃掉）。
   */
  stylize: 0.4,
};

export const GRID_MAX_DIM = 400;
export const GRID_MIN_DIM = 20;

export interface PipelineInput {
  /** 源图 RGBA */
  rgba: Uint8ClampedArray;
  srcWidth: number;
  srcHeight: number;
  params: PipelineParams;
  /** 首次出图时顺便算一次「系统推荐色数」（约 +30ms，只在换图时开） */
  suggestColors?: boolean;
  now?: string;
}

export interface PipelineTimings {
  resizeMs: number;
  stylizeMs: number;
  quantizeMs: number;
  metricsMs: number;
  totalMs: number;
}

export interface PipelineOutput {
  grid: GridData;
  report: StitchabilityReport;
  quantize: {
    colors: QuantizeResult['colors'];
    iterations: number;
    uniqueColors: number;
    meanOklabError: number;
  };
  tone: ToneStats;
  timings: PipelineTimings;
  /** 系统推荐色数（仅在 suggestColors=true 时返回） */
  suggestedColors?: number;
}

export function gridSizeFor(
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
): { width: number; height: number } {
  let width = Math.round(
    Math.max(GRID_MIN_DIM, Math.min(GRID_MAX_DIM, targetWidth)),
  );
  let height = Math.max(1, Math.round((width * srcHeight) / srcWidth));

  // 竖图会撞高度上限 → 反过来按高度定
  if (height > GRID_MAX_DIM) {
    height = GRID_MAX_DIM;
    width = Math.max(1, Math.round((height * srcWidth) / srcHeight));
  }
  return { width, height };
}

export function runPipeline(input: PipelineInput): PipelineOutput {
  const t0 = now();
  const { params } = input;
  const { width: gw, height: gh } = gridSizeFor(
    input.srcWidth,
    input.srcHeight,
    params.targetWidth,
  );

  const tResize0 = now();
  const resized = resizeToGrid(
    input.rgba,
    input.srcWidth,
    input.srcHeight,
    gw,
    gh,
  );
  const tResize1 = now();

  // 保边平滑：在网格分辨率上做，消掉绣格级噪点（碎片率的头号来源）
  const { linear, srgb } =
    params.stylize > 0
      ? stylizeGrid(resized.linear, resized.srgb, gw, gh, params.stylize)
      : resized;
  const tStylize1 = now();

  const q = quantizeToDmc(linear, srgb, gw, gh, {
    maxColors: params.maxColors,
    seed: params.seed,
    minColorShare: params.minColorShare,
  });
  const tQuant1 = now();

  // 明暗统计用「减色前、重采样后」的图：这才是真正被处理的那张图
  const rgba = new Uint8ClampedArray(gw * gh * 4);
  for (let i = 0; i < gw * gh; i++) {
    const o = i * 3;
    const p = i * 4;
    rgba[p] = srgb[o];
    rgba[p + 1] = srgb[o + 1];
    rgba[p + 2] = srgb[o + 2];
    rgba[p + 3] = 255;
  }
  const tone = computeToneStats(rgba, gw, gh);

  const grid: GridData = {
    width: gw,
    height: gh,
    cells: q.cells,
    palette: q.palette,
    fabricCount: params.fabricCount,
    strands: params.strands,
  };

  const tMetrics0 = now();
  const report = buildStitchabilityReport({
    grid,
    tone,
    maxColors: params.maxColors,
    now: input.now ?? new Date().toISOString(),
  });
  const tMetrics1 = now();

  const suggestedColors = input.suggestColors
    ? suggestColorCount(linear, srgb, gw, gh)
    : undefined;

  return {
    grid,
    report,
    quantize: {
      colors: q.colors,
      iterations: q.iterations,
      uniqueColors: q.uniqueColors,
      meanOklabError: q.meanOklabError,
    },
    tone,
    timings: {
      resizeMs: tResize1 - tResize0,
      stylizeMs: tStylize1 - tResize1,
      quantizeMs: tQuant1 - tStylize1,
      metricsMs: tMetrics1 - tMetrics0,
      totalMs: tMetrics1 - t0,
    },
    suggestedColors,
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
