/**
 * 参数敏感性实验：小色归并阈值 minColorShare 对碎片率/色数的影响。
 * 用来决定默认值，而不是拍脑袋。
 *
 *   node scripts/exp-mincolorshare.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const images = JSON.parse(
  readFileSync(resolve(root, '.data/images.json'), 'utf8'),
) as { tag: string; width: number; height: number }[];

const shares = [0.001, 0.002, 0.004, 0.008, 0.015];

for (const meta of images) {
  const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
  const rgba = new Uint8ClampedArray(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  );

  console.log(`\n${meta.tag}  (120 格 / 16 色)`);
  console.log('  share   色数   碎片%   孤岛%   似对角%  难度  线量');
  for (const share of shares) {
    const t0 = performance.now();
    const out = runPipeline({
      rgba,
      srcWidth: meta.width,
      srcHeight: meta.height,
      params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16, minColorShare: share },
      now: 'T',
    });
    const ms = performance.now() - t0;
    const r = out.report;
    console.log(
      `  ${share.toFixed(3)}   ${String(out.grid.palette.length).padStart(2)}   ` +
        `${(r.continuity.confettiRatio * 100).toFixed(1).padStart(5)}   ` +
        `${(r.continuity.isolatedRatio * 100).toFixed(1).padStart(5)}   ` +
        `${(r.continuity.isolated4Ratio * 100).toFixed(1).padStart(6)}   ` +
        `${r.difficulty.stars}★    ${String(r.supply.totalSkeins).padStart(3)}  (${ms.toFixed(0)}ms)`,
    );
  }
}
