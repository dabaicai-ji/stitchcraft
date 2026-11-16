/**
 * 阈值标定实验：把原始指标值打出来，用于定 normalizeRatio 与星级别界。
 *
 *   node scripts/exp-calib.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const images = JSON.parse(
  readFileSync(resolve(root, '.data/images.json'), 'utf8'),
) as { tag: string; width: number; height: number }[];

console.log('图        色数  碎片%  孤岛%  似对角%  混淆边比  总边数');
for (const meta of images) {
  const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
  const rgba = new Uint8ClampedArray(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  );
  for (const k of [8, 12, 16, 24]) {
    const out = runPipeline({
      rgba,
      srcWidth: meta.width,
      srcHeight: meta.height,
      params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: k },
      now: 'T',
    });
    const r = out.report;
    console.log(
      `${meta.tag.padEnd(9)} ${String(k).padStart(3)}  ` +
        `${(r.continuity.confettiRatio * 100).toFixed(1).padStart(5)}  ` +
        `${(r.continuity.isolatedRatio * 100).toFixed(1).padStart(5)}  ` +
        `${(r.continuity.isolated4Ratio * 100).toFixed(1).padStart(6)}  ` +
        `${r.confusion.confusableEdgeRatio.toFixed(4).padStart(8)}  ` +
        `${String(r.confusion.totalEdges).padStart(7)}`,
    );
  }
}
