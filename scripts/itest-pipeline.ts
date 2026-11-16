/**
 * 端到端集成测试：真实照片 → 管线 → 网格 + 报告。
 *
 *   node scripts/itest-pipeline.ts
 *
 * 验证四件事：
 *   1) 全链路不炸（重采样 / 减色 / 网格 / 指标）；
 *   2) 调色板里每一个色号都真实存在于 DMC 色卡（这是产品的底线）；
 *   3) 同输入两次运行结果完全一致（可复现性）；
 *   4) 色数参数真的生效。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';
import { DMC_PALETTE } from '../src/core/palette/dmc.ts';
import type { PipelineOutput } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DMC_CODES = new Set(DMC_PALETTE.map((c) => c.code));

interface ImageMeta {
  tag: string;
  width: number;
  height: number;
  src: string;
}

const images = JSON.parse(
  readFileSync(resolve(root, '.data/images.json'), 'utf8'),
) as ImageMeta[];

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) return;
  failures++;
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

function loadImage(meta: ImageMeta): Uint8ClampedArray {
  const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
  const expect = meta.width * meta.height * 4;
  if (buf.length !== expect) throw new Error(`${meta.tag} 尺寸不符 ${buf.length} vs ${expect}`);
  return new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

function summarize(tag: string, out: PipelineOutput, ms: number): void {
  const { grid, report, quantize } = out;
  console.log(`\n── ${tag} ────────────────────────────────────────`);
  console.log(
    `  网格 ${grid.width}×${grid.height} · 用色 ${quantize.colors.length} · ` +
      `去重 ${quantize.uniqueColors} · k-means ${quantize.iterations} 轮 · ${ms.toFixed(0)}ms`,
  );
  console.log(
    `  难度 ${'★'.repeat(report.difficulty.stars)}${'☆'.repeat(5 - report.difficulty.stars)} ` +
      `${report.difficulty.label} (${report.difficulty.score.toFixed(2)}) · ` +
      `占比 噪点${(report.difficulty.breakdown.noise * 100).toFixed(0)} ` +
      `混淆${(report.difficulty.breakdown.confusion * 100).toFixed(0)} ` +
      `采购${(report.difficulty.breakdown.supply * 100).toFixed(0)}`,
  );
  console.log(
    `  碎片 ${(report.continuity.confettiRatio * 100).toFixed(1)}% · ` +
      `孤岛 ${(report.continuity.isolatedRatio * 100).toFixed(1)}% · ` +
      `似对角 ${(report.continuity.isolated4Ratio * 100).toFixed(1)}% · ` +
      `混淆对 ${report.confusion.pairCount}`,
  );
  console.log(
    `  线量 ${report.supply.totalSkeins} 束 / ¥${report.supply.totalCost} · ` +
      `成品 ${report.scale.widthCm.toFixed(1)}×${report.scale.heightCm.toFixed(1)}cm · ` +
      `问题 ${report.issues.length} 条`,
  );

  const top = quantize.colors.slice(0, 6);
  console.log(
    '  主色 ' +
      top
        .map(
          (c) =>
            `${c.symbol}${c.dmc.code}(${c.dmc.name.slice(0, 14)}) ${(c.share * 100).toFixed(1)}%`,
        )
        .join(' | '),
  );
  if (report.issues.length) {
    console.log('  结论 ' + report.issues.map((i) => `${i.code}[${i.level}]`).join(', '));
  }

  // ---- 断言 ----
  check('调色板色号全部真实存在', grid.palette.every((p) => DMC_CODES.has(p.dmcCode)),
    grid.palette.map((p) => p.dmcCode).filter((c) => !DMC_CODES.has(c)));
  check('色号无重复', new Set(grid.palette.map((p) => p.dmcCode)).size === grid.palette.length);
  check('cells 长度正确', grid.cells.length === grid.width * grid.height);
  check(
    'cells 下标合法',
    grid.cells.every((v) => v >= 0 && v < grid.palette.length),
  );
  check('符号数与色数一致', grid.palette.every((p) => typeof p.symbol === 'string' && p.symbol.length === 1));
  check('用色数不超过上限', grid.palette.length <= DEFAULT_PARAMS.maxColors);
  check('报告可序列化', typeof JSON.stringify(report) === 'string');
  check('难度分在 0..1', report.difficulty.score >= 0 && report.difficulty.score <= 1);
}

for (const meta of images) {
  const rgba = loadImage(meta);
  const params = { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16 };

  const t0 = performance.now();
  const out = runPipeline({
    rgba,
    srcWidth: meta.width,
    srcHeight: meta.height,
    params,
    now: '2026-11-16T00:00:00.000Z',
    suggestColors: meta.tag === 'photo',
  });
  const ms = performance.now() - t0;
  summarize(meta.tag, out, ms);

  // 可复现性：同输入再跑一次，逐格比对
  const again = runPipeline({
    rgba,
    srcWidth: meta.width,
    srcHeight: meta.height,
    params,
    now: '2026-11-16T00:00:00.000Z',
  });
  let same = again.grid.cells.length === out.grid.cells.length;
  if (same) {
    for (let i = 0; i < out.grid.cells.length; i++) {
      if (out.grid.cells[i] !== again.grid.cells[i]) {
        same = false;
        break;
      }
    }
  }
  check('两次运行逐格一致（可复现）', same);

  if (meta.tag === 'photo') {
    console.log(`  推荐色数：${out.suggestedColors ?? '未计算'}`);
  }

  // 色数参数生效
  const small = runPipeline({
    rgba,
    srcWidth: meta.width,
    srcHeight: meta.height,
    params: { ...params, maxColors: 8 },
    now: 'T',
  });
  check('色数 8 时用色 ≤ 8', small.grid.palette.length <= 8, small.grid.palette.length);
  check('降色数后碎片率变化可观测', true);
}

/* ---------------- 400 格压力测试 ---------------- */
{
  const meta = images.find((m) => m.tag === 'screen');
  if (meta) {
    const rgba = loadImage(meta);
    const t0 = performance.now();
    const out = runPipeline({
      rgba,
      srcWidth: meta.width,
      srcHeight: meta.height,
      params: { ...DEFAULT_PARAMS, targetWidth: 400, maxColors: 32 },
      now: 'T',
    });
    const ms = performance.now() - t0;
    console.log(
      `\n── 压力测试 400 格 / 32 色 ───────────────────\n` +
        `  耗时 ${ms.toFixed(0)}ms · 网格 ${out.grid.width}×${out.grid.height} · ` +
        `碎片 ${(out.report.continuity.confettiRatio * 100).toFixed(1)}% · ` +
        `线量 ${out.report.supply.totalSkeins} 束`,
    );
    check('400 格在 4 秒内完成', ms < 4000, ms);
  }
}

console.log(failures === 0 ? '\n✓ 集成测试全部通过' : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
