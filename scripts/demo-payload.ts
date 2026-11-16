/**
 * 演示：构造一张「大致像照片」的中等复杂图纸，跑完整指标管线，
 * 打印给 DeepSeek 的 payload，并测一下大网格耗时。
 *
 *   node scripts/demo-payload.ts
 */

import type { GridData, Lab, PaletteEntry, ToneStats } from '../src/core/types.ts';
import { srgbToLab } from '../src/core/color/cie.ts';
import { buildStitchabilityReport } from '../src/core/metrics/index.ts';
import { computeToneStats } from '../src/core/metrics/tone.ts';
import { buildLLMPayload } from '../src/core/llm/payload.ts';

/** 确定性伪随机，保证每次输出一致 */
let seed = 123456789;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const HEXES = [
  '#1a1a1a', '#3d3d3d', '#6b5b4e', '#8f7a63', '#b59a7d', '#d9c2a3',
  '#e8dcc8', '#f4efe6', '#2b4a6f', '#2c4b70', '#4f7d9e', '#7fb0c4',
  '#5b7a45', '#8fae6b',
];

function makePalette(): PaletteEntry[] {
  return HEXES.map((hex, i) => ({
    index: i,
    dmcCode: ['310', '3799', '3371', '433', '437', '738', '822', '3865',
              '823', '824', '931', '932', '936', '937'][i] ?? String(i),
    name: `DMC ${i}`,
    hex,
    lab: srgbToLab(hex) as Lab,
    symbol: String.fromCharCode(65 + (i % 26)),
  }));
}

/** 斜向色带 + 3% 噪点：模拟「一张照片被压成 14 色」的典型形态 */
function makeGrid(w: number, h: number): GridData {
  const cells = new Int16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wave = Math.sin(x / 14) * 2.2 + Math.sin(y / 19) * 1.8;
      let idx = Math.floor(((x / w) * 9 + (y / h) * 4 + wave) % 14);
      if (idx < 0) idx += 14;
      if (rand() < 0.03) idx = Math.floor(rand() * 14);
      cells[y * w + x] = idx;
    }
  }
  return { width: w, height: h, cells, palette: makePalette(), fabricCount: 14, strands: 2 };
}

/** 造一张左上 22% 像素接近纯黑的图，用来触发明暗溢出预警 */
function makeDarkImage(): ToneStats {
  const w = 80;
  const h = 80;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i - x) / w;
    const dark = x < 38 && y < 38;
    const v = dark ? 4 : 40 + Math.round(140 * ((x + y) / (w + h)));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return computeToneStats(rgba, w, h);
}

/* ---------------- 主流程 ---------------- */

const grid = makeGrid(120, 120);
const tone = makeDarkImage();
const report = buildStitchabilityReport({ grid, tone, maxColors: 14, now: '2026-11-16T10:00:00.000Z' });
const payload = buildLLMPayload(report);

console.log('=== 人类可读摘要 ===');
console.log(
  `尺寸 ${report.scale.width}×${report.scale.height} 格 / ` +
    `${report.scale.widthCm.toFixed(1)}×${report.scale.heightCm.toFixed(1)}cm / ` +
    `${report.scale.colorCount} 色`,
);
console.log(`难度 ${report.difficulty.stars}★ ${report.difficulty.label} (${report.difficulty.score})`);
console.log(
  `孤岛 ${(report.continuity.isolatedRatio * 100).toFixed(2)}% · ` +
    `碎片 ${(report.continuity.confettiRatio * 100).toFixed(2)}% · ` +
    `仅对角 ${(report.continuity.isolated4Ratio * 100).toFixed(2)}%`,
);
console.log(
  `混淆对 ${report.confusion.pairCount} · ` +
    `线量 ${report.supply.totalSkeins} 束 / ¥${report.supply.totalCost}`,
);
console.log(`问题 ${report.issues.length} 条: ${report.issues.map((i) => `${i.code}[${i.level}]`).join(', ')}`);

console.log(`\n=== 给 DeepSeek 的 payload (${JSON.stringify(payload).length} 字节) ===`);
console.log(JSON.stringify(payload, null, 2));

/* ---------------- 性能 ---------------- */

console.log('\n=== 性能（400×400 = 160k 格，24 色） ===');
const bigPalette = Array.from({ length: 24 }, (_, i) => ({
  index: i,
  dmcCode: String(100 + i),
  name: `c${i}`,
  hex: `#${(i * 10).toString(16).padStart(2, '0')}7a4c`,
  lab: srgbToLab(`#${(i * 10).toString(16).padStart(2, '0')}7a4c`) as Lab,
  symbol: String.fromCharCode(65 + (i % 26)),
}));
const big = new Int16Array(400 * 400);
for (let i = 0; i < big.length; i++) big[i] = Math.floor(rand() * 24);
const bigGrid: GridData = {
  width: 400,
  height: 400,
  cells: big,
  palette: bigPalette,
  fabricCount: 14,
  strands: 2,
};

// 预热
buildStitchabilityReport({ grid: bigGrid, tone: null, now: 'T' });
const t0 = performance.now();
const bigReport = buildStitchabilityReport({ grid: bigGrid, tone: null, now: 'T' });
const t1 = performance.now();
console.log(`全量指标 ${(t1 - t0).toFixed(1)}ms（含最坏情况：随机图 → 碎片与混淆对极多）`);
console.log(
  `碎片 ${(bigReport.continuity.confettiRatio * 100).toFixed(1)}% · ` +
    `连通块 ${bigReport.continuity.componentCount} · ` +
    `混淆对 ${bigReport.confusion.pairCount}`,
);
