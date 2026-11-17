/**
 * 把 onnxruntime-web 的 wasm 产物复制到 public/ort/。
 *
 *   node scripts/copy-ort-wasm.ts          # 只复制 WebGPU 版（jsep）
 *   node scripts/copy-ort-wasm.ts --all    # 连纯 WASM 版一起复制
 *
 * 体积（实测自 onnxruntime-web@1.31.1）：
 *   ort-wasm-simd-threaded.jsep.wasm   29.52 MB   ← WebGPU / WebNN 用
 *   ort-wasm-simd-threaded.wasm        14.85 MB   ← 纯 WASM
 *   对比模型本身 8.20 MB —— 运行时比模型还大，所以只在用户开启 AI 时才加载。
 *
 * 这些文件不进 git（.gitignore 已忽略 public/ort/），
 * 由 `npm run build` 前的 prebuild 钩子自动生成。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'node_modules/onnxruntime-web/dist');
const outDir = resolve(root, 'public/ort');

if (!existsSync(srcDir)) {
  console.error(`找不到 onnxruntime-web/dist，先 npm install。路径：${srcDir}`);
  process.exit(1);
}

const all = process.argv.includes('--all');

const files = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];
if (all) {
  files.push('ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs');
}

mkdirSync(outDir, { recursive: true });

let total = 0;
for (const file of files) {
  const from = resolve(srcDir, file);
  if (!existsSync(from)) {
    console.warn(`跳过（不存在）：${file}`);
    continue;
  }
  copyFileSync(from, resolve(outDir, file));
  total += 1;
}

console.log(`已复制 ${total} 个 ORT 运行时文件到 public/ort/`);
