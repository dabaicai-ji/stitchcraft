/**
 * 像素风格化端到端测试（纯 Node，0 依赖、不联网、不需要模型）。
 *
 *   node scripts/itest-pixel.ts
 *
 * 验证五件事：
 *   1) pixelate() 保持尺寸与 RGBA 长度，且同输入逐字节可复现；
 *   2) 块化真的发生：唯一色数显著下降，抽样块的块内颜色一致（边缘黑线块除外）；
 *   3) 像素化结果能直接进现有管线，输出的色号全部真实存在于 DMC 色卡；
 *   4) 指标与规则照常产出（碎片率是如实计算，不承诺更好）；
 *   5) 顺带打印处理耗时（只记录，不做阈值断言，避免机器差异导致假红）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixelate } from '../src/ai/pixelate.ts';
import type { PixelateParams } from '../src/ai/pixelate.ts';
import { AI_IMAGE_STYLIZE, stylizeForMode } from '../src/ai/stylizeMode.ts';
import { DMC_PALETTE } from '../src/core/palette/dmc.ts';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface ImageMeta {
  tag: string;
  width: number;
  height: number;
}

const metas = JSON.parse(
  readFileSync(resolve(root, '.data/images.json'), 'utf8'),
) as ImageMeta[];
const meta = metas.find((m) => m.tag === 'photo') ?? metas[0];
if (!meta) {
  console.error('✗ .data/images.json 里没有可用图片');
  process.exit(1);
}

const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
const expect = meta.width * meta.height * 4;
if (buf.length !== expect) {
  console.error(`✗ ${meta.tag}.raw 尺寸不符：${buf.length} vs ${expect}`);
  process.exit(1);
}
const rgba = new Uint8ClampedArray(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
);

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) return;
  failures++;
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

/* ---------------- 1. 像素化本身 ---------------- */

const GRID_W = 120;
// 与 ai.worker.ts 的 derivePixelSize 同一条公式：块边长对齐一个绣格
const pixelSize = Math.max(1, Math.round(meta.width / GRID_W));
const params: PixelateParams = {
  pixelSize,
  edgeThresh: 100,
  smoothRadius: 2,
  levels: 24,
};

const t0 = performance.now();
const out = pixelate(rgba, meta.width, meta.height, params);
const ms = performance.now() - t0;

console.log('── 像素化 ──────────────────────────────────────────');
console.log(
  `  源图 ${meta.width}×${meta.height} · 块边长 ${pixelSize}px · ${ms.toFixed(0)}ms`,
);

check('输出长度 = w×h×4', out.length === meta.width * meta.height * 4, out.length);

const again = pixelate(rgba, meta.width, meta.height, params);
let identical = out.length === again.length;
if (identical) {
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== again[i]) {
      identical = false;
      break;
    }
  }
}
check('两次运行逐字节一致（可复现）', identical);

function uniqueColors(a: Uint8ClampedArray): number {
  const set = new Set<number>();
  for (let i = 0; i < a.length; i += 4) {
    set.add((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]);
  }
  return set.size;
}
const before = uniqueColors(rgba);
const after = uniqueColors(out);
console.log(`  唯一色：${before} → ${after}`);
check('块化后唯一色数下降', after < before, { before, after });

/* ---------------- 2. 块内一致性（抽样） ---------------- */

let seed = 12345;
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const gw = Math.floor(meta.width / pixelSize);
const gh = Math.floor(meta.height / pixelSize);

let checkedBlocks = 0;
let inconsistent = 0;
for (let n = 0; n < 400; n++) {
  const bx = Math.floor(rand() * Math.max(1, gw - 1));
  const by = Math.floor(rand() * Math.max(1, gh - 1));
  const x0 = bx * pixelSize;
  const y0 = by * pixelSize;

  let r = -1;
  let g = -1;
  let b = -1;
  let same = 0;
  let total = 0;
  let hasEdge = false;

  for (let y = y0; y < y0 + pixelSize && y < meta.height; y++) {
    for (let x = x0; x < x0 + pixelSize && x < meta.width; x++) {
      const o = (y * meta.width + x) * 4;
      total++;
      if (out[o] === 0 && out[o + 1] === 0 && out[o + 2] === 0) hasEdge = true;
      if (r < 0) {
        r = out[o];
        g = out[o + 1];
        b = out[o + 2];
      }
      if (out[o] === r && out[o + 1] === g && out[o + 2] === b) same++;
    }
  }

  if (hasEdge) continue; // 边缘块本来就含黑线，不参与判定
  checkedBlocks++;
  if (same !== total) inconsistent++;
}
check('块内颜色一致（抽样，排除边缘块）', checkedBlocks > 100 && inconsistent === 0, {
  checkedBlocks,
  inconsistent,
});

/* ---------------- 3. 下游管线不受影响 ---------------- */

const DMC_CODES = new Set(DMC_PALETTE.map((c) => c.code));
const out2 = runPipeline({
  rgba: out,
  srcWidth: meta.width,
  srcHeight: meta.height,
  params: { ...DEFAULT_PARAMS, targetWidth: GRID_W, maxColors: 16 },
  now: '2026-11-17T00:00:00.000Z',
});

console.log('\n── 像素化 → 现有管线 ──────────────────────────────');
console.log(
  `  网格 ${out2.grid.width}×${out2.grid.height} · 用色 ${out2.grid.palette.length} · ` +
    `碎片 ${(out2.report.continuity.confettiRatio * 100).toFixed(1)}% · ` +
    `难度 ${out2.report.difficulty.stars}★ · 线量 ${out2.report.supply.totalSkeins} 束`,
);

check(
  '色号全部真实存在',
  out2.grid.palette.every((p) => DMC_CODES.has(p.dmcCode)),
  out2.grid.palette.map((p) => p.dmcCode).filter((c) => !DMC_CODES.has(c)),
);
check('cells 长度正确', out2.grid.cells.length === out2.grid.width * out2.grid.height);
check(
  'cells 下标合法',
  out2.grid.cells.every((v) => v >= 0 && v < out2.grid.palette.length),
);
check('用色数不超过上限', out2.grid.palette.length <= DEFAULT_PARAMS.maxColors);
check('碎片率在 0..1', out2.report.continuity.confettiRatio >= 0 && out2.report.continuity.confettiRatio <= 1);
check('报告可序列化', typeof JSON.stringify(out2.report) === 'string');

/* ---------------- 4. 风格模式 ↔ 平滑降噪联动 ---------------- */

console.log('\n── 平滑降噪按模式联动 ────────────────────────────');
console.log(
  `  AI 插画 ${AI_IMAGE_STYLIZE} · 原始/像素 ${DEFAULT_PARAMS.stylize} · ` +
    `切到 AI 插画 → ${stylizeForMode('cloud', false, DEFAULT_PARAMS.stylize)}`,
);

check('AI 插画模式默认降到 0.2', stylizeForMode('cloud', false, 0.4) === 0.2);
check('原始模式沿用默认 0.4', stylizeForMode('none', false, 0.2) === DEFAULT_PARAMS.stylize);
check('像素模式沿用默认 0.4', stylizeForMode('pixel', false, 0.2) === DEFAULT_PARAMS.stylize);
check('用户手动调过则不覆盖', stylizeForMode('cloud', true, 0.8) === 0.8);
check('AI 插画常量就是 0.2', AI_IMAGE_STYLIZE === 0.2);

console.log(failures === 0 ? '\n✓ 像素风格化测试全部通过' : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
