/**
 * 一次性实验：验证 AnimeGANv2 的预处理假设，并量化「AI 风格化对碎片率的实际收益」。
 *
 *   node scripts/exp-ai-quality.ts
 *
 * 回答三个问题：
 *   1. 按官方样例的 [-1,1] 归一化跑出来的图是否正常（不是灰片/过曝）？
 *   2. 风格化后，现有管线的碎片率降多少？
 *   3. 已经有 stylize=0.4 的前提下，AI 还能带来多少增量？（这才是要不要做的关键）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANIME_SIZE = 512;

/** 面积平均缩放（RGBA，sRGB 空间，够用即可） */
function resizeArea(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = (dy * sh) / dh;
    const y1 = ((dy + 1) * sh) / dh;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.max(iy0 + 1, Math.ceil(y1)));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = (dx * sw) / dw;
      const x1 = ((dx + 1) * sw) / dw;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.max(ix0 + 1, Math.ceil(x1)));
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (sy * sw + sx) * 4;
          r += src[o] * w;
          g += src[o + 1] * w;
          b += src[o + 2] * w;
          wsum += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = r / wsum;
      out[o + 1] = g / wsum;
      out[o + 2] = b / wsum;
      out[o + 3] = 255;
    }
  }
  return out;
}

const meta = (
  JSON.parse(readFileSync(resolve(root, '.data/images.json'), 'utf8')) as {
    tag: string;
    width: number;
    height: number;
  }[]
).find((m) => m.tag === 'photo')!;
const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
const rgba = new Uint8ClampedArray(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
);
console.log(`源图 ${meta.tag} ${meta.width}×${meta.height}`);

/* ---------- 1. 预处理（官方样例约定）---------- */
const sq = resizeArea(rgba, meta.width, meta.height, ANIME_SIZE, ANIME_SIZE);
const n = ANIME_SIZE * ANIME_SIZE;
const input = new Float32Array(3 * n);
for (let i = 0; i < n; i++) {
  const o = i * 4;
  input[i] = (sq[o] / 255) * 2 - 1;
  input[n + i] = (sq[o + 1] / 255) * 2 - 1;
  input[2 * n + i] = (sq[o + 2] / 255) * 2 - 1;
}

/* ---------- 2. 推理 ---------- */
const bytes = new Uint8Array(readFileSync(resolve(root, '.data/models/animeganv2_face_paint_512.onnx')));
const session = await ort.InferenceSession.create(bytes, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});

const t0 = performance.now();
const out = await session.run({
  input_image: new ort.Tensor('float32', input, [1, 3, ANIME_SIZE, ANIME_SIZE]),
});
const inferMs = performance.now() - t0;
const y = out.output_image.data as Float32Array;

/* ---------- 3. 后处理 ---------- */
const styled512 = new Uint8ClampedArray(n * 4);
let min = Infinity, max = -Infinity, acc = 0;
for (let i = 0; i < n; i++) {
  for (let c = 0; c < 3; c++) {
    const v = y[c * n + i];
    if (v < min) min = v;
    if (v > max) max = v;
    acc += v;
    styled512[i * 4 + c] = Math.round((v * 0.5 + 0.5) * 255);
  }
  styled512[i * 4 + 3] = 255;
}
console.log(
  `推理 ${inferMs.toFixed(0)}ms · 输出范围 [${min.toFixed(2)}, ${max.toFixed(2)}] · 均值 ${(acc / (3 * n)).toFixed(2)}`,
);

const styled = resizeArea(styled512, ANIME_SIZE, ANIME_SIZE, meta.width, meta.height);

// 显著性检查：如果输出近乎单色，说明归一化或通道顺序错了
const uniq = new Set<number>();
for (let i = 0; i < styled.length; i += 4 * 97) {
  uniq.add((styled[i] << 16) | (styled[i + 1] << 8) | styled[i + 2]);
}
console.log(`采样到的不同颜色数：${uniq.size}（太少说明预处理有问题）`);

writeFileSync(resolve(root, '.data/ai-styled.raw'), styled);
writeFileSync(resolve(root, '.data/ai-original.raw'), rgba);

/* ---------- 4. 碎片率对比 ---------- */
console.log('\n管线对比（120 格 / 16 色）');
console.log('  输入         stylize   碎片%   孤岛%   用色   难度');
for (const [name, img] of [
  ['原始', rgba],
  ['AI 卡通化', styled],
] as const) {
  for (const s of [0, 0.4]) {
    const r = runPipeline({
      rgba: img,
      srcWidth: meta.width,
      srcHeight: meta.height,
      params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16, stylize: s },
      now: 'T',
    }).report;
    console.log(
      `  ${name.padEnd(10)}  ${String(s).padEnd(6)}   ` +
        `${(r.continuity.confettiRatio * 100).toFixed(1).padStart(5)}   ` +
        `${(r.continuity.isolatedRatio * 100).toFixed(1).padStart(5)}   ` +
        `${String(r.scale.colorCount).padStart(3)}    ${r.difficulty.stars}★`,
    );
  }
}
