/**
 * 指标引擎自测 —— 无测试框架依赖，node 原生跑 TS。
 *
 *   node scripts/selftest.ts
 *
 * 覆盖：CIEDE2000 标准数据、连通域边界（同色/棋盘格/孤立针）、
 *       混淆对检测、线量公式、明暗直方图、难度星映射、LLM payload 防幻觉。
 */

import type { GridData, Lab, PaletteEntry } from '../src/core/types.ts';
import { BACKGROUND } from '../src/core/types.ts';
import { ciede2000, srgbToLab } from '../src/core/color/cie.ts';
import { computeComponentStats } from '../src/core/metrics/components.ts';
import { computeToneStats } from '../src/core/metrics/tone.ts';
import { pathMmPerStitchPerStrand } from '../src/core/metrics/thread.ts';
import { buildStitchabilityReport } from '../src/core/metrics/index.ts';
import {
  auditNarrative,
  buildLLMPayload,
  collectAllowedNumbers,
} from '../src/core/llm/payload.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

function near(name: string, actual: number, expected: number, tol: number): void {
  check(name, Math.abs(actual - expected) <= tol, { actual, expected, tol });
}

/* ------------------------------------------------------------------ */
/* 构造工具                                                            */
/* ------------------------------------------------------------------ */

function makePalette(hexes: string[]): PaletteEntry[] {
  return hexes.map((hex, i) => ({
    index: i,
    dmcCode: String(310 + i),
    name: `color${i}`,
    hex,
    lab: srgbToLab(hex) as Lab,
    symbol: String.fromCharCode(65 + i),
  }));
}

function makeGrid(
  w: number,
  h: number,
  hexes: string[],
  paint: (x: number, y: number) => number,
): GridData {
  const cells = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) cells[y * w + x] = paint(x, y);
  }
  return { width: w, height: h, cells, palette: makePalette(hexes), fabricCount: 14, strands: 2 };
}

/* ------------------------------------------------------------------ */
/* 1. CIEDE2000 对照 Sharma (2005) 标准数据                            */
/* ------------------------------------------------------------------ */

const sharma: { a: Lab; b: Lab; de: number }[] = [
  { a: [50, 2.6772, -79.7751], b: [50, 0, -82.7485], de: 2.0425 },
  { a: [50, 3.1571, -77.2803], b: [50, 0, -82.7485], de: 2.8615 },
  { a: [50, 2.8361, -74.02], b: [50, 0, -82.7485], de: 3.4412 },
  { a: [50, -1.3802, -84.2814], b: [50, 0, -82.7485], de: 1.0 },
  { a: [50, 0, 0], b: [50, -1, 2], de: 2.3669 },
  { a: [50, 2.49, -0.001], b: [50, -2.49, 0.0009], de: 7.1792 },
  { a: [50, -0.001, 2.49], b: [50, 0.0009, -2.49], de: 4.8045 },
  { a: [50, 2.5, 0], b: [73, 25, -18], de: 27.1492 },
  { a: [50, 2.5, 0], b: [61, -5, 29], de: 22.8977 },
  { a: [50, 2.5, 0], b: [56, -27, -3], de: 31.903 },
  { a: [50, 2.5, 0], b: [58, 24, 15], de: 19.4535 },
  { a: [50, 2.5, 0], b: [50, 3.1736, 0.5854], de: 1.0 },
];

for (const [i, t] of sharma.entries()) {
  near(`CIEDE2000 Sharma#${i + 1}`, ciede2000(t.a, t.b), t.de, 1e-4);
}

/* ------------------------------------------------------------------ */
/* 2. 同色大块                                                         */
/* ------------------------------------------------------------------ */

{
  const g = makeGrid(8, 8, ['#7f7f7f'], () => 0);
  const c = computeComponentStats(g);
  check('同色: stitchable=64', c.stitchableCells === 64, c.stitchableCells);
  check('同色: isolated=0', c.isolatedCells === 0, c.isolatedCells);
  check('同色: 1 个连通块', c.componentCount === 1, c.componentCount);
  check('同色: maxComponentShare=1', c.maxComponentShare === 1, c.maxComponentShare);
  check('同色: perColor 格数=64', c.perColor[0].stitchCount === 64, c.perColor[0].stitchCount);
}

/* ------------------------------------------------------------------ */
/* 3. 棋盘格：8 邻接看似连通，实为最痛苦的绣法                          */
/* ------------------------------------------------------------------ */

{
  const g = makeGrid(8, 8, ['#000000', '#ffffff'], (x, y) => (x + y) % 2);
  const c = computeComponentStats(g);
  check('棋盘: 每色 1 个 8-连通块', c.componentCount === 2, c.componentCount);
  check('棋盘: 8 邻接孤岛=0（会漏报！）', c.isolatedCells === 0, c.isolatedCells);
  check('棋盘: 4 邻接孤岛=64（抓住病理）', c.isolated4Cells === 64, c.isolated4Cells);
  near('棋盘: isolated4Ratio=1', c.isolated4Ratio, 1, 1e-9);

  const rep = buildStitchabilityReport({ grid: g, tone: null, now: 'T' });
  check(
    '棋盘: 触发 DIAGONAL_ONLY_TISSUE',
    rep.issues.some((i) => i.code === 'DIAGONAL_ONLY_TISSUE'),
    rep.issues.map((i) => i.code),
  );
}

/* ------------------------------------------------------------------ */
/* 4. 孤立单针 + 留白剔除                                               */
/* ------------------------------------------------------------------ */

{
  const g = makeGrid(16, 16, ['#101010', '#f0f0f0'], (x, y) => (x === 8 && y === 8 ? 1 : 0));
  const c = computeComponentStats(g);
  check('孤针: isolated=1', c.isolatedCells === 1, c.isolatedCells);
  check('孤针: confetti=1', c.confettiCells === 1, c.confettiCells);
  check('孤针: 两个色', c.perColor.filter((p) => p.stitchCount > 0).length === 2);

  const rep = buildStitchabilityReport({ grid: g, tone: null, now: 'T' });
  check('孤针: 单束陷阱被记录', rep.supply.oneSkeinTrap.length === 1, rep.supply.oneSkeinTrap);

  // 留白：左上 4x4 不绣
  const g2 = makeGrid(8, 8, ['#101010'], (x, y) => (x < 4 && y < 4 ? BACKGROUND : 0));
  const rep2 = buildStitchabilityReport({ grid: g2, tone: null, now: 'T' });
  check('留白: totalCells=64', rep2.scale.totalCells === 64, rep2.scale.totalCells);
  check('留白: backgroundCells=16', rep2.scale.backgroundCells === 16, rep2.scale.backgroundCells);
  check('留白: stitchable=48', rep2.scale.stitchableCells === 48, rep2.scale.stitchableCells);
}

/* ------------------------------------------------------------------ */
/* 5. 混淆色对                                                         */
/* ------------------------------------------------------------------ */

{
  const g = makeGrid(16, 16, ['#000000', '#0a0a0a'], (x) => (x < 8 ? 0 : 1));
  const rep = buildStitchabilityReport({ grid: g, tone: null, now: 'T' });
  const pair = rep.confusion.pairs[0];
  check('混淆: 检出 1 对', rep.confusion.pairs.length === 1, rep.confusion.pairs.length);
  check('混淆: 共享边=16', pair?.sharedEdges === 16, pair?.sharedEdges);
  check('混淆: ΔE00 低于阈值', (pair?.deltaE00 ?? 99) < 6, pair?.deltaE00);
  check(
    '混淆: 触发 CONFUSABLE_PAIR',
    rep.issues.some((i) => i.code === 'CONFUSABLE_PAIR'),
    rep.issues.map((i) => i.code),
  );
}

/* ------------------------------------------------------------------ */
/* 6. 线量公式                                                         */
/* ------------------------------------------------------------------ */

{
  const path = pathMmPerStitchPerStrand(14);
  near('线量: 14ct 每格每股 ≈6.671mm', path, 6.6713, 1e-3);

  const g = makeGrid(10, 10, ['#123456'], () => 0);
  const rep = buildStitchabilityReport({ grid: g, tone: null, now: 'T' });
  check('线量: 一束≈599 格', rep.supply.perColor[0].stitchesPerSkein === 599, rep.supply.perColor[0].stitchesPerSkein);
  check('线量: 100 格要 1 束', rep.supply.totalSkeins === 1, rep.supply.totalSkeins);
  check('线量: 单色不算陷阱汇总>8色', rep.supply.oneSkeinTrap.length === 1);

  const g2 = makeGrid(40, 40, ['#123456'], () => 0);
  const rep2 = buildStitchabilityReport({ grid: g2, tone: null, now: 'T' });
  check('线量: 1600 格要 3 束', rep2.supply.totalSkeins === 3, rep2.supply.totalSkeins);
}

/* ------------------------------------------------------------------ */
/* 7. 明暗直方图                                                       */
/* ------------------------------------------------------------------ */

{
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  // 前两像素纯黑，后两像素纯白
  const px = [
    [0, 0, 0],
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 255],
  ];
  for (let i = 0; i < 4; i++) {
    rgba[i * 4] = px[i][0];
    rgba[i * 4 + 1] = px[i][1];
    rgba[i * 4 + 2] = px[i][2];
    rgba[i * 4 + 3] = 255;
  }
  const t = computeToneStats(rgba, 2, 2);
  near('明暗: 暗部占比=.5', t.shadowClipRatio, 0.5, 1e-9);
  near('明暗: 亮部占比=.5', t.highlightClipRatio, 0.5, 1e-9);
  near('明暗: 均值=.5', t.meanLuma, 0.5, 1e-9);
  check('明暗: 256 桶', t.histogram.length === 256, t.histogram.length);
}

/* ------------------------------------------------------------------ */
/* 8. 难度星映射                                                       */
/* ------------------------------------------------------------------ */

{
  const g = makeGrid(40, 40, ['#336699'], () => 0);
  const rep = buildStitchabilityReport({ grid: g, tone: null, now: 'T' });
  check('难度: 干净单色=1 星', rep.difficulty.stars === 1, rep.difficulty);
  check('难度: 分项齐全', typeof rep.difficulty.breakdown.noise === 'number');
  check('难度: 分数 0..1', rep.difficulty.score >= 0 && rep.difficulty.score <= 1);
}

/* ------------------------------------------------------------------ */
/* 9. LLM payload 与数字防幻觉                                        */
/* ------------------------------------------------------------------ */

{
  const g = makeGrid(16, 16, ['#000000', '#0a0a0a'], (x) => (x < 8 ? 0 : 1));
  const rep = buildStitchabilityReport({ grid: g, tone: null, now: 'T' });
  const payload = buildLLMPayload(rep);
  const allowed = collectAllowedNumbers(payload);

  check('payload: 可 JSON 序列化', typeof JSON.stringify(payload) === 'string');
  check('payload: 无 TypedArray 泄漏', !JSON.stringify(payload).includes('cells'));

  const pair = (payload.confusion as any).pairs[0];
  const good = `DMC ${pair.dmcA} 与 DMC ${pair.dmcB} 色差 ${pair.deltaE00}，相邻 ${pair.sharedEdges} 条边。`;
  check('防幻觉: 引用真实数字通过', auditNarrative(good, allowed).ok, auditNarrative(good, allowed));

  const bad = '这张图的碎片率高达 37.5%，建议降到 3 色。';
  check('防幻觉: 编造数字被拦下', !auditNarrative(bad, allowed).ok, auditNarrative(bad, allowed));

  const pctText = `碎片率 ${(rep.continuity.confettiRatio * 100).toFixed(1)}%。`;
  check('防幻觉: 百分比形式放行', auditNarrative(pctText, allowed).ok, { pctText, r: auditNarrative(pctText, allowed) });
}

/* ------------------------------------------------------------------ */

console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log(`失败 ${fail}:`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
} else {
  console.log('✓ 全部通过');
}
