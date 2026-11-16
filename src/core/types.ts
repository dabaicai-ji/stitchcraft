/**
 * 十字绣图纸 —— 数据契约
 *
 * 设计原则：
 *  1) 本目录下所有模块都是纯函数，不碰 DOM、不碰网络、可被 Node 直接跑单测。
 *  2) 指标全部由 GridData 确定性推导；同一份 GridData 永远得到同一份报告。
 *  3) 这份报告（JSON）是 DeepSeek 唯一能看到的东西 —— 看不到图，也看不到像素。
 */

export type FabricCount = 14 | 16 | 18;

/** 网格中「留白 / 不绣」哨兵值。任何指标统计都必须先剔除它。 */
export const BACKGROUND = -1;

/** CIELAB（D65, 2°） */
export type Lab = readonly [number, number, number];

export interface PaletteEntry {
  /** 必须等于它在 GridData.palette 中的下标，且 0..n-1 连续 */
  index: number;
  /** DMC 色号，如 "310" / "B5200" */
  dmcCode: string;
  /** DMC 名称，如 "Black" */
  name: string;
  /** sRGB 十六进制，如 "#000000" */
  hex: string;
  /** 预计算好的 CIELAB，用于 CIEDE2000 */
  lab: Lab;
  /** 图纸上的符号 */
  symbol: string;
}

export interface GridData {
  width: number;
  height: number;
  /** 行优先，长度 = width * height；每格是 palette 下标，BACKGROUND 表示留白 */
  cells: Int16Array;
  palette: PaletteEntry[];
  fabricCount: FabricCount;
  /** 每股数，14ct 常用 2 股 */
  strands: number;
}

/** 来自「减色前」的目标分辨率图像，用于评估源图明暗是否已经塌掉 */
export interface ToneStats {
  /** 0..1 的相对亮度均值 */
  meanLuma: number;
  /** 亮度 < shadowThreshold 的像素占比 */
  shadowClipRatio: number;
  /** 亮度 > highlightThreshold 的像素占比 */
  highlightClipRatio: number;
  /** 5% / 95% 分位亮度，用于看动态范围 */
  p05: number;
  p95: number;
  /** 256 bins */
  histogram: number[];
}

export interface PerColorComponents {
  paletteIndex: number;
  stitchCount: number;
  componentCount: number;
  largestComponent: number;
  /** 该色中落在碎片连通块内的格数 */
  confettiCells: number;
}

export interface ComponentStats {
  /** 非留白格总数 */
  stitchableCells: number;
  /** 8 邻域内没有任何同色格 → 真正孤立的单针 */
  isolatedCells: number;
  isolatedRatio: number;
  /** 4 邻域内没有任何同色格 → 包含「仅对角相连」的棋盘格病理 */
  isolated4Cells: number;
  isolated4Ratio: number;
  /** 落在 size < maxComponentCells 的连通块内的格数 */
  confettiCells: number;
  confettiRatio: number;
  componentCount: number;
  maxComponentSize: number;
  maxComponentShare: number;
  meanComponentSize: number;
  perColor: PerColorComponents[];
}

export interface ConfusablePair {
  a: number;
  b: number;
  dmcA: string;
  dmcB: string;
  deltaE00: number;
  /** 两色在网格上共享的 4 邻接边数 */
  sharedEdges: number;
  /** sharedEdges * (1 - deltaE00 / maxDeltaE) */
  severity: number;
}

export interface ConfusionStats {
  maxDeltaE: number;
  /** 网格内所有 4 邻接边的总数（不含留白边） */
  totalEdges: number;
  pairCount: number;
  pairs: ConfusablePair[];
  /** Σ severity，单位=边 */
  severitySum: number;
  /** severitySum / totalEdges，0..1；难度分直接用这个 */
  confusableEdgeRatio: number;
}

export interface ThreadUsage {
  paletteIndex: number;
  dmcCode: string;
  name: string;
  hex: string;
  symbol: string;
  stitchCount: number;
  /** 单束可绣格数（几何估算） */
  stitchesPerSkein: number;
  skeins: number;
  cost: number;
}

export interface SupplyStats {
  fabricCount: FabricCount;
  strands: number;
  /** 每格每股走线长度 mm */
  pathMmPerStitchPerStrand: number;
  /** 每格总耗线 mm（含全部股数与损耗） */
  perStitchMm: number;
  totalStitches: number;
  totalSkeins: number;
  totalCost: number;
  perColor: ThreadUsage[];
  /** 格数很少但照样得买整束的色号 */
  oneSkeinTrap: { dmcCode: string; stitchCount: number; skeins: number; cost: number }[];
}

export type IssueLevel = 'block' | 'warn' | 'info';

export type IssueCode =
  | 'HIGH_CONFETTI'
  | 'HIGH_ISOLATED'
  | 'DIAGONAL_ONLY_TISSUE'
  | 'CONFUSABLE_PAIR'
  | 'TONE_CLIPPED'
  | 'TOO_MANY_COLORS'
  | 'COLOR_COLLAPSE'
  | 'ONE_SKEIN_TRAP'
  | 'HUGE_PROJECT';

/** LLM 唯一被允许修改的参数集合（白名单，全部 clamp） */
export interface ParamPatch {
  targetWidth?: number;
  maxColors?: number;
  fabricCount?: FabricCount;
  dither?: number;
  minColorShare?: number;
  edgePreserve?: number;
  smoothing?: number;
  contrast?: number;
  saturation?: number;
}

export interface Issue {
  code: IssueCode;
  level: IssueLevel;
  /** 引用到的具体数字，报告中出现数字必须来自这里或 report 本身 */
  evidence: Record<string, number | string>;
  /** 固定模板文案，不是 LLM 生成的 */
  suggestion: string;
  /** 可一键应用的参数补丁 */
  paramPatch?: ParamPatch;
}

export interface DifficultyResult {
  /** 1..5 */
  stars: number;
  label: string;
  /** 0..1 连续分 */
  score: number;
  breakdown: {
    /** 0..1 噪点项（孤岛 + 碎片） */
    noise: number;
    /** 0..1 混淆项（相邻色 ΔE00） */
    confusion: number;
    /** 0..1 采购项（色数 + 束数） */
    supply: number;
  };
}

export interface ScaleStats {
  width: number;
  height: number;
  totalCells: number;
  stitchableCells: number;
  backgroundCells: number;
  colorCount: number;
  fabricCount: FabricCount;
  widthCm: number;
  heightCm: number;
}

export interface StitchabilityReport {
  /** 指标算法版本；改阈值必须升版本，否则历史报告无法复现 */
  version: string;
  generatedAt: string;
  scale: ScaleStats;
  continuity: ComponentStats;
  confusion: ConfusionStats;
  tone: ToneStats | null;
  supply: SupplyStats;
  difficulty: DifficultyResult;
  issues: Issue[];
}
