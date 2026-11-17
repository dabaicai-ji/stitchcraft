/** 一次性实验：核实 Photo2Pixel ONNX 的输入输出（用于判断是否值得引入 ORT）。 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = new Uint8Array(readFileSync(resolve(root, '.data/models/photo2pixel.onnx')));
console.log(`模型 ${(bytes.length / 1024).toFixed(1)} KB`);

const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
const meta = s as unknown as { inputMetadata?: unknown; outputMetadata?: unknown };
console.log('inputs :', JSON.stringify(meta.inputMetadata ?? s.inputNames));
console.log('outputs:', JSON.stringify(meta.outputMetadata ?? s.outputNames));
