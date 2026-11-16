/**
 * 把指标报告压成给 DeepSeek 的 JSON，并提供「数字防幻觉」校验。
 *
 * 三条铁律：
 *   1) 只传数字和结论，不传图、不传像素、不传原始 RGB。
 *   2) 所有数值保留 2–4 位小数，压缩 prompt 长度（一份完整报告压缩后 < 2KB）。
 *   3) 模型输出里出现的每个数字，都必须能在 payload 里找到出处（含百分比形式）。
 *      校验失败 → 前端直接丢弃该段并回退到规则文案，不展示。
 */

import type { StitchabilityReport } from '../types.ts';

const r0 = (v: number): number => Math.round(v);
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

export interface LLMPayload {
  [key: string]: unknown;
}

export function buildLLMPayload(report: StitchabilityReport): LLMPayload {
  const { scale: s, continuity: c, confusion: f, tone: t, supply: sp, difficulty: d } = report;

  return {
    metricsVersion: report.version,
    canvas: {
      stitchesWide: s.width,
      stitchesHigh: s.height,
      totalCells: s.totalCells,
      stitchableCells: s.stitchableCells,
      backgroundCells: s.backgroundCells,
      colorCount: s.colorCount,
      fabricCount: s.fabricCount,
      physicalCm: [r1(s.widthCm), r1(s.heightCm)],
    },
    noise: {
      isolatedCells: c.isolatedCells,
      isolatedRatio: r4(c.isolatedRatio),
      diagonalOnlyCells: c.isolated4Cells,
      diagonalOnlyRatio: r4(c.isolated4Ratio),
      confettiCells: c.confettiCells,
      confettiRatio: r4(c.confettiRatio),
      componentCount: c.componentCount,
      maxComponentShare: r4(c.maxComponentShare),
      meanComponentSize: r1(c.meanComponentSize),
    },
    confusion: {
      thresholdDeltaE: f.maxDeltaE,
      pairCount: f.pairCount,
      confusableEdgeRatio: r4(f.confusableEdgeRatio),
      pairs: f.pairs.map((p) => ({
        dmcA: p.dmcA,
        dmcB: p.dmcB,
        deltaE00: r1(p.deltaE00),
        sharedEdges: p.sharedEdges,
      })),
    },
    supply: {
      strands: sp.strands,
      perStitchMm: r2(sp.perStitchMm),
      stitchesPerSkein: sp.perColor[0]?.stitchesPerSkein ?? 0,
      totalSkeins: sp.totalSkeins,
      totalCost: r0(sp.totalCost),
      byColor: sp.perColor.map((u) => ({
        dmcCode: u.dmcCode,
        name: u.name,
        stitchCount: u.stitchCount,
        skeins: u.skeins,
        cost: u.cost,
      })),
      oneSkeinTrap: sp.oneSkeinTrap.map((u) => ({
        dmcCode: u.dmcCode,
        stitchCount: u.stitchCount,
        cost: u.cost,
      })),
    },
    tone: t
      ? {
          meanLuma: r3(t.meanLuma),
          p05: r3(t.p05),
          p95: r3(t.p95),
          shadowClipRatio: r3(t.shadowClipRatio),
          highlightClipRatio: r3(t.highlightClipRatio),
        }
      : null,
    difficulty: {
      stars: d.stars,
      label: d.label,
      score: r3(d.score),
      breakdown: d.breakdown,
    },
    issues: report.issues.map((i) => ({
      code: i.code,
      level: i.level,
      evidence: i.evidence,
      suggestion: i.suggestion,
      paramPatch: i.paramPatch ?? null,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 数字防幻觉                                                          */
/* ------------------------------------------------------------------ */

const NUM_RE = /-?\d+(?:\.\d+)?/g;

/**
 * 收集 payload 里所有「合法数字」。
 * 注意：**字符串里的数字也要收** —— 因为建议文案本身带数字（如「每小时 200 格」），
 * 模型复述这些数字是合法的，不该被判成幻觉。
 */
export function collectAllowedNumbers(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(value);
  } else if (typeof value === 'string') {
    for (const m of value.matchAll(NUM_RE)) out.add(Number(m[0]));
  } else if (Array.isArray(value)) {
    for (const v of value) collectAllowedNumbers(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectAllowedNumbers(v, out);
    }
  }
  return out;
}

export interface AuditResult {
  ok: boolean;
  checked: number;
  unknown: number[];
}

/**
 * 校验模型输出里的数字是否都有出处。
 * 允许三种表达：原值、百分比（×100）、千分比（×1000）。
 * 这是启发式筛查，不是证明；但它能拦住「编了 37% 碎片率」这类致命错误。
 */
export function auditNarrative(
  text: string,
  allowed: Set<number>,
  extraAllowed: number[] = [],
): AuditResult {
  const ok = new Set<number>(allowed);
  for (const n of extraAllowed) ok.add(n);

  const unknown: number[] = [];
  let checked = 0;

  for (const m of text.matchAll(NUM_RE)) {
    const n = Number(m[0]);
    checked++;
    let found = false;
    for (const a of ok) {
      if (Math.abs(n - a) <= 0.051) { found = true; break; }
      if (Math.abs(n - a * 100) <= 0.6) { found = true; break; }
      if (Math.abs(n - a * 1000) <= 6) { found = true; break; }
    }
    if (!found) unknown.push(n);
  }

  return { ok: unknown.length === 0, checked, unknown };
}
