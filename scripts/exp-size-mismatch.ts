/**
 * 尺寸错位 bug 的本地验证（配合 exp-size-mismatch.py 生成的 raw）。
 *
 *   python scripts/exp-size-mismatch.py     # 先生成 .data/size-mismatch/*.raw
 *   node scripts/exp-size-mismatch.ts       # 再跑管线对比
 *
 * 三组输入，120 与 200 格各跑一次：
 *   manual  原图直接进管线（等价手动上传）
 *   fixed   AI 图 cover 缩放到源尺寸（修复后的 pick 路径）
 *   bug     AI 图原样喂给管线、却声明成源尺寸（修复前的行为）
 *
 * 除了指标，还把每组网格导出成 JSON，供 Python 渲染成图做肉眼对比。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = resolve(root, '.data/size-mismatch')

interface Case {
  name: string
  raw: string
  declaredW: number
  declaredH: number
}

const meta = JSON.parse(readFileSync(resolve(dir, 'meta.json'), 'utf8')) as {
  source: { w: number; h: number }
  ai: { w: number; h: number }
  cases: Case[]
}

const GRIDS = [120, 200]
const rows: string[] = []
const exportGrids: Record<string, unknown> = {}

for (const gridW of GRIDS) {
  for (const c of meta.cases) {
    const buf = readFileSync(resolve(dir, c.raw))
    const rgba = new Uint8ClampedArray(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    )

    // 与 src/lib/workerClient.ts 的入口断言同一条判据
    const expected = c.declaredW * c.declaredH * 4
    const sane = rgba.length === expected
    if (!sane) {
      console.log(
        `[断言会拦住] ${c.name}: rgba.length=${rgba.length} != ${expected}` +
          `（${c.declaredW}×${c.declaredH}×4）→ 真实浏览器里这里会直接抛错`,
      )
    }

    const out = runPipeline({
      rgba,
      srcWidth: c.declaredW,
      srcHeight: c.declaredH,
      params: { ...DEFAULT_PARAMS, targetWidth: gridW, maxColors: 16, stylize: 0.2 },
      now: '2026-11-23T00:00:00.000Z',
    })

    const r = out.report
    rows.push(
      `${gridW}\t${c.name}\t${(r.continuity.confettiRatio * 100).toFixed(1)}%\t` +
        `${(r.continuity.isolatedRatio * 100).toFixed(1)}%\t` +
        `${(r.confusion.confusableEdgeRatio * 100).toFixed(1)}%\t` +
        `${r.scale.colorCount}\t${r.difficulty.stars}★\t${r.difficulty.score.toFixed(2)}`,
    )

    exportGrids[`${gridW}-${c.name}`] = {
      width: out.grid.width,
      height: out.grid.height,
      cells: Array.from(out.grid.cells),
      palette: out.grid.palette.map((p) => ({ hex: p.hex, dmc: p.dmcCode })),
    }
  }
}

console.log('\n格数\t输入\t碎片率\t孤岛率\t混淆边比\t用色\t难度')
for (const row of rows) console.log(row)

// 差异量化：fixed 与 manual 的碎片率差，bug 与 fixed 的差距
const metrics = rows.map((row) => {
  const [g, name, confetti, isolated, confusion, colors, stars, score] = row.split('\t')
  return { g: Number(g), name, confetti, isolated, confusion, colors, stars, score }
})
for (const g of GRIDS) {
  const get = (name: string) => metrics.find((m) => m.g === g && m.name === name)!
  const f = get('fixed')
  const m = get('manual')
  const b = get('bug')
  console.log(
    `\n${g} 格：fixed 与 manual 碎片率差 ` +
      `${(Math.abs(parseFloat(f.confetti) - parseFloat(m.confetti))).toFixed(1)} 个百分点` +
      `；bug 与 fixed 差 ` +
      `${(Math.abs(parseFloat(b.confetti) - parseFloat(f.confetti))).toFixed(1)} 个百分点`,
  )
}

writeFileSync(resolve(dir, 'grids.json'), JSON.stringify(exportGrids), 'utf8')
writeFileSync(resolve(dir, 'metrics.txt'), rows.join('\n'), 'utf8')
console.log('\n写出 grids.json / metrics.txt')
