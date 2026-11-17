/**
 * 把 onnxruntime-web 的 wasm 产物复制到 public/ort/。
 *
 *   node scripts/copy-ort-wasm.ts
 *
 * 实测（onnxruntime-web@1.31.1，解包各 bundle 得到）——**两个后端用的不是同一个二进制**：
 *   import 'onnxruntime-web/webgpu' → ort-wasm-simd-threaded.asyncify.wasm  28.75 MB
 *   import 'onnxruntime-web/wasm'   → ort-wasm-simd-threaded.wasm           14.85 MB
 * 所以两个都必须复制；只复制 jsep（默认包的）会导致 WebGPU/WASM 双双 404。
 *
 * 脚本末尾会做**自检**：从 bundle 源码里抽出它引用的 wasm 文件名，
 * 断言都已被复制。ORT 升级换二进制时会直接报错，而不是线上 404。
 *
 * public/ort/ 不进 git（.gitignore），由 npm run build 的 prebuild 钩子生成。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(root, 'node_modules/onnxruntime-web/dist')
const outDir = resolve(root, 'public/ort')

if (!existsSync(distDir)) {
  console.error(`找不到 onnxruntime-web/dist，先 npm install。路径：${distDir}`)
  process.exit(1)
}

/** 两个后端各一份 wasm + 对应的 loader mjs */
const FILES = [
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
]

mkdirSync(outDir, { recursive: true })

let total = 0
for (const file of FILES) {
  const from = resolve(distDir, file)
  if (!existsSync(from)) {
    console.error(`✗ 缺少 ${file}（onnxruntime-web 版本可能变了）`)
    process.exit(1)
  }
  copyFileSync(from, resolve(outDir, file))
  total += statSync(from).size
  console.log(`  ${file}  ${(statSync(from).size / 1024 / 1024).toFixed(2)} MB`)
}
console.log(`已复制 ${FILES.length} 个文件到 public/ort/，合计 ${(total / 1024 / 1024).toFixed(1)} MB`)

/* ---------- 自检：bundle 引用的 wasm 必须都在 ---------- */
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
  const src = readFileSync(path, 'utf8')
  const ok = src.includes(expect) && existsSync(resolve(outDir, expect))
  console.log(`  ${ok ? '✓' : '✗'} ${file} → ${expect}`)
  if (!ok) failed = true
}

if (failed) {
  console.error('✗ wasm 自检失败：ORT bundle 引用的二进制不在 public/ort/，线上会 404')
  process.exit(1)
}

console.log('✓ wasm 自检通过：两个 bundle 引用的二进制都已就位')
