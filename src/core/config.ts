/**
 * 所有「魔法数字」集中在这里。
 *
 * ⚠️ 诚实声明：以下阈值是**工程经验值，不是行业标准**。
 * 它们必须在 20 张真实图（人像 / 宠物 / 风景 / logo / 暗部 / 高饱和 / 纯色 / 渐变）上标定，
 * 标定后改数字并升 METRICS_VERSION。不要对外宣称这是「专业可绣性模型」。
 */

export const METRICS_VERSION = '0.2.0-calibrated-3-images';

export const CONFIG = {
  /** 碎片（confetti）判定：同色 8 连通块小于该格数即为「碎片」 */
  confettiMaxComponentCells: 5,

  continuity: {
    /**
     * 全图碎片格占比。
     *
     * 这组数字不是拍脑袋：用 3 张真实图（校园照片 12.3%、游戏截图 18.8%、
     * 建筑照 22.9%，均为 120 格 / 16 色）标定，目标是让「普通照片」落在 3★，
     * 而不是一上来就 5★。第一版阈值（8% / 15%）让所有照片都判 4–5 星，
     * 分数完全失去区分度。
     *
     * ⚠️ 仍然只是初步标定，需要 20+ 张真实图才能定稿。
     */
    warnConfettiRatio: 0.12,
    /** 25% 时一张图仍被判「偏多」，20% 才更像真正的劝退线 */
    blockConfettiRatio: 0.2,
    /** 孤立单针占比（8 邻域无同色） */
    warnIsolatedRatio: 0.03,
    blockIsolatedRatio: 0.08,
    /** 仅对角相连（4 邻域无同色）占比：棋盘格病理，绣起来极其痛苦 */
    warnIsolated4Ratio: 0.08,
  },

  confusion: {
    /**
     * CIEDE2000 低于此值视为「绣到布上肉眼难分辨」。
     * 参考：ΔE00 < 2 几乎不可察觉；2~5 并排可辨；但绣布有纹理、线有光泽、
     * 光照随时间变化，所以 < 6 就值得警告。这是保守工程取值。
     */
    maxDeltaE: 6,
    /** 共享边数低于此值不入报告，避免偶然相邻制造噪音 */
    minSharedEdges: 5,
    /**
     * confusableEdgeRatio 达到该值时混淆项计满分。
     *
     * 实测（3 张图 × 4 档色数）：正常情况的混淆边比在 0.000–0.041，
     * 只有调色板真的撞了近似色才会窜到 0.076。原来取 0.05 会让一张图
     * 直接把混淆项顶到 100%，换成 0.08 后既保留告警灵敏度又不再饱和。
     */
    normalizeRatio: 0.08,
  },

  tone: {
    shadowThreshold: 0.05,
    highlightThreshold: 0.95,
    warnClipRatio: 0.15,
  },

  thread: {
    /** 背面走线 + 起收针损耗系数 */
    waste: 0.3,
    /** 一束 DMC = 8m */
    skeinLengthMm: 8000,
    /** 采购安全系数，宁可多买 */
    safety: 1.0,
    /** 单束参考价（元），可由 UI 覆盖 */
    skeinPrice: 8,
    /** 低于该格数的色 → 仍要买整束，标记「单束陷阱」 */
    oneSkeinTrapStitches: 120,
  },

  score: {
    // 只基于指标 1（噪点）、2（混淆）、4（采购）三项加权 —— 按你的要求
    wNoise: 0.45,
    wConfusion: 0.3,
    wSupply: 0.25,
    /** 色数归一化区间 */
    colorRange: [4, 40],
    /** 束数归一化参考值 */
    skeinRef: 40,
    /** 难度 0..1 → 1..5 星的分界 */
    starBreaks: [0.2, 0.4, 0.6, 0.8],
    starLabels: ['入门', '轻松', '进阶', '硬核', '劝退'],
  },

  scale: {
    warnStitchableCells: 30000,
    /** 实际用色数低于 maxColors 的该比例 → 「调色板没吃满」 */
    colorCollapseRatio: 0.5,
    warnColorCount: 24,
  },

  quantize: {
    /** 占比低于此值的颜色在图纸上并入最近的已用色（抑制碎片） */
    minColorShare: 0.002,
    /** k-means 迭代上限 */
    maxIterations: 16,
    /** 默认随机种子，保证同一张图同一参数结果可复现 */
    seed: 1,
  },
} as const;
