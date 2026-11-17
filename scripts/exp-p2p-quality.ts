/**
 * 一次性实验：Photo2Pixel ONNX 的输出是否可用，以及它对碎片率的影响。
 *
 * 这个模型只有 23.8KB 且输入形状动态，理论上比 AnimeGANv2 更适合「合并碎块」。
 * 关键未知量是 rgb 的归一化范围（0..1 还是 0..255），这里两种都跑一遍看哪个正常。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
      let r = 0, g = 0, b = 0, ws = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (sy * sw + sx) * 4;
          r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w; ws += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = r / ws; out[o + 1] = g / ws; out[o + 2] = b / ws; out[o + 3] = 255;
    }
  }
  return out;
}

const meta = (
  JSON.parse(readFileSync(resolve(root, '.data/images.json'), 'utf8')) as {
    tag: string; width: number; height: number;
  }[]
).find((m) => m.tag === 'photo')!;
const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
const rgba = new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));

const bytes = new Uint8Array(readFileSync(resolve(root, '.data/models/photo2pixel.onnx')));
const session = await ort.InferenceSession.create(bytes, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});

const W = 240;
const H = Math.round((W * meta.height) / meta.width);
const small = resizeArea(rgba, meta.width, meta.height, W, H);
const n = W * H;

for (const scale of [1, 255] as const) {
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = small[i * 4] / scale;
    input[n + i] = small[i * 4 + 1] / scale;
    input[2 * n + i] = small[i * 4 + 2] / scale;
  }

  const t = performance.now();
  const out = await session.run({
    rgb: new ort.Tensor('float32', input, [1, 3, H, W]),
    param_kernel_size: new ort.Tensor('int64', BigInt64Array.from([10n]), []),
    param_pixel_size: new ort.Tensor('int64', BigInt64Array.from([2n]), []),
    param_edge_thresh: new ort.Tensor('float32', Float32Array.from([100]), []),
  });
  const ms = performance.now() - t;
  const o = out.output;
  const arr = o.data as Float32Array;
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  console.log(`归一化 /${scale}: ${ms.toFixed(0)}ms · 输出 ${o.dims.join('×')} · 范围 [${min.toFixed(2)}, ${max.toFixed(2)}]`);

  if (scale === 1) {
    const outH = o.dims[2];
    const outW = o.dims[3];
    const on = outW * outH;
    const r = new Uint8ClampedArray(on * 4);
    for (let i = 0; i < on; i++) {
      r[i * 4] = Math.round(arr[i] * 255);
      r[i * 4 + 1] = Math.round(arr[on + i] * 255);
      r[i * 4 + 2] = Math.round(arr[2 * on + i] * 255);
      r[i * 4 + 3] = 255;
    }
    const full = resizeArea(r, outW, outH, meta.width, meta.height);
    writeFileSync(resolve(root, '.data/ai-pixel.raw'), full);

    console.log('\n管线对比（120 格 / 16 色）');
    for (const [name, img] of [['原始', rgba], ['像素化', full]] as const) {
      for (const s of [0, 0.4]) {
        const rep = runPipeline({
          rgba: img, srcWidth: meta.width, srcHeight: meta.height,
          params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16, stylize: s },
          now: 'T',
        }).report;
        console.log(
          `  ${name.padEnd(6)} stylize=${s}  碎片 ${(rep.continuity.confettiRatio * 100).toFixed(1)}%  ` +
            `孤岛 ${(rep.continuity.isolatedRatio * 100).toFixed(1)}%  用色 ${rep.scale.colorCount}  ${rep.difficulty.stars}★`,
        );
      }
    }
  }
}
