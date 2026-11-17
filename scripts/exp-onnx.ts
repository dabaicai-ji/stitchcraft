/**
 * 一次性实验：核实 AnimeGANv2 ONNX 的真实输入输出形状与推理耗时。
 *
 *   node scripts/exp-onnx.ts
 *
 * 目的不是接入，而是把「模型选型」从印象变成数字：
 *   - 输入是不是固定 512、能不能吃别的尺寸（全卷积网络通常可以）
 *   - 输出形状与数值范围（是不是 [-1,1] 或 [0,1]）
 *   - WASM 后端下一次推理多久（用来判断 WebGPU 是否值得那 29MB wasm）
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelPath = resolve(root, '.data/models/animeganv2_face_paint_512.onnx');

const ort = await import('onnxruntime-web');

const bytes = new Uint8Array(readFileSync(modelPath));
console.log(`模型 ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);

const t0 = performance.now();
const session = await ort.InferenceSession.create(bytes, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
console.log(`加载耗时 ${(performance.now() - t0).toFixed(0)} ms`);

console.log('输入:', session.inputNames);
console.log('输出:', session.outputNames);

// 元数据不是所有版本都公开，拿得到就打出来
const anySession = session as unknown as {
  inputMetadata?: unknown;
  outputMetadata?: unknown;
};
if (anySession.inputMetadata) {
  console.log('inputMetadata:', JSON.stringify(anySession.inputMetadata));
}
if (anySession.outputMetadata) {
  console.log('outputMetadata:', JSON.stringify(anySession.outputMetadata));
}

async function bench(size: number): Promise<void> {
  const n = 3 * size * size;
  const data = new Float32Array(n);
  // 填个中间灰，避免全 0 触发某些算子的极端路径
  for (let i = 0; i < n; i++) data[i] = 0.5;
  const tensor = new ort.Tensor('float32', data, [1, 3, size, size]);

  try {
    const t = performance.now();
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const ms = performance.now() - t;
    const o = out[session.outputNames[0]];
    const arr = o.data as Float32Array;
    let min = Infinity;
    let max = -Infinity;
    for (const v of arr) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    console.log(
      `  ${size}×${size}: ${ms.toFixed(0)} ms · 输出 ${o.dims.join('×')} · 范围 [${min.toFixed(2)}, ${max.toFixed(2)}]`,
    );
  } catch (err) {
    console.log(`  ${size}×${size}: ✗ ${(err as Error).message}`);
  }
}

console.log('推理（WASM 后端）:');
for (const size of [256, 512, 768]) {
  await bench(size);
}
