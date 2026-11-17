/**
 * ORT 运行时校验（不复制文件）。
 *
 *   node scripts/copy-ort-wasm.ts   # prebuild 会调用
 *
 * 历史：这个脚本原本把 wasm 复制到 public/ort/，但实测发现 Vite 打包时
 * 已经会把 ORT bundle 里的 `new URL("<wasm>", import.meta.url)` 改写成
 * 带哈希的 /assets/*.wasm —— 两处都留会让部署体积翻倍（41.7MB + 43.6MB）。
 *
 * 现在只做**校验**：
 *   1) onnxruntime-web 的两个 wasm 二进制存在；
 *   2) 我们实际用到的两个 bundle 引用的正是它们（ORT 升级换二进制时立刻报错）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(root, 'node_modules/onnxruntime-web/dist')

if (!existsSync(distDir)) {
  console.error(`找不到 onnxruntime-web/dist，先 npm install。路径：${distDir}`)
  process.exit(1)
}

const BINARIES = ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm']
for (const file of BINARIES) {
  if (!existsSync(resolve(distDir, file))) {
    console.error(`✗ 缺少 ${file}（onnxruntime-web 版本可能变了）`)
    process.exit(1)
  }
}

const bundles = [
  { file: 'ort.webgpu.bundle.min.mjs', expect: 'ort-wasm-simd-threaded.asyncify.wasm' },
  { file: 'ort.wasm.bundle.min.mjs', expect: 'ort-wasm-simd-threaded.wasm' },
]

let failed = false
for (const { file, expect } of bundles) {
  const path = resolve(distDir, file)
  if (!existsSync(path)) {
    console.error(`✗ 找不到 bundle ${file}`)
    failed = true
    continue
  }
  const ok = readFileSync(path, 'utf8').includes(expect)
  console.log(`  ${ok ? '✓' : '✗'} ${file} → ${expect}`)
  if (!ok) failed = true
}

if (failed) {
  console.error('✗ wasm 校验失败：bundle 引用的二进制与预期不一致')
  process.exit(1)
}
console.log('✓ ORT wasm 校验通过（运行时由 Vite 打包为 /assets/*.wasm，不进 public/）')
