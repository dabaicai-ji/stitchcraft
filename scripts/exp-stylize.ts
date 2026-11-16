/**
 * 风格化强度标定实验：用真实图看「碎片率 vs 细节保留」的权衡。
 *
 *   node scripts/exp-stylize.ts
 *
 * 目标不是找「最好看」的，而是找**碎片率显著下降、色数不塌**的拐点。
 * COLOR_COLLAPSE（用色数低于上限的一半）是过度平滑的信号。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const images = JSON.parse(
  readFileSync(resolve(root, '.data/images.json'), 'utf8'),
) as { tag: string; width: number; height: number }[];

const strengths = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

for (const meta of images) {
  const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
  const rgba = new Uint8ClampedArray(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  );

  console.log(`\n${meta.tag}  (120 格 / 16 色)`);
  console.log('  强度   碎片%   孤岛%   用色   难度   平滑ms   合计ms');
  for (const s of strengths) {
    const t0 = performance.now();
    const out = runPipeline({
      rgba,
      srcWidth: meta.width,
      srcHeight: meta.height,
      params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16, stylize: s },
      now: 'T',
    });
    const total = performance.now() - t0;
    const r = out.report;
    console.log(
      `  ${s.toFixed(1)}   ${(r.continuity.confettiRatio * 100).toFixed(1).padStart(5)}   ` +
        `${(r.continuity.isolatedRatio * 100).toFixed(1).padStart(5)}   ` +
        `${String(out.grid.palette.length).padStart(3)}   ` +
        `${r.difficulty.stars}★    ` +
        `${out.timings.stylizeMs.toFixed(1).padStart(5)}   ${total.toFixed(0).padStart(5)}`,
    );
  }
}

/* 400 格压力测试 */
{
  const meta = images.find((m) => m.tag === 'screen');
  if (meta) {
    const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
    const rgba = new Uint8ClampedArray(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    );
    const out = runPipeline({
      rgba,
      srcWidth: meta.width,
      srcHeight: meta.height,
      params: { ...DEFAULT_PARAMS, targetWidth: 400, maxColors: 32, stylize: 0.4 },
      now: 'T',
    });
    console.log(
      `\n400 格压力测试（stylize=0.4）：平滑 ${out.timings.stylizeMs.toFixed(0)}ms，` +
        `合计 ${out.timings.totalMs.toFixed(0)}ms，碎片 ${(out.report.continuity.confettiRatio * 100).toFixed(1)}%`,
    );
  }
}
