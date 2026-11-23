/**
 * 提示词改版的指标对比：同一张人像，旧 / 新提示词，120 / 200 格。
 *
 *   python .data/to-raw-compare.py      # 先把三张图转成 raw
 *   node scripts/exp-prompt-metrics.ts  # 再跑本脚本
 *
 * 输出：碎片率 / 孤岛率 / 混淆边比 / 色数 / 难度（1–5 星）对比表。
 * 平滑强度用 AI 插画模式的真实默认 0.2，并附 0.4 作对照（说明为什么要降）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_IMAGE_STYLIZE } from '../src/ai/stylizeMode.ts';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';
import type { PipelineOutput } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(root, '.data/prompt-compare');

interface RawMeta {
  width: number;
  height: number;
}
const metas = JSON.parse(readFileSync(resolve(DIR, 'raw-meta.json'), 'utf8')) as Record<
  string,
  RawMeta
>;

function load(tag: string): { rgba: Uint8ClampedArray; width: number; height: number } {
  const m = metas[tag];
  if (!m) throw new Error(`raw-meta.json 里没有 ${tag}，先跑 python .data/to-raw-compare.py`);
  const buf = readFileSync(resolve(DIR, `${tag}.raw`));
  const expect = m.width * m.height * 4;
  if (buf.length !== expect) throw new Error(`${tag}.raw 尺寸不符：${buf.length} vs ${expect}`);
  return {
    rgba: new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
    width: m.width,
    height: m.height,
  };
}

interface Row {
  tag: string;
  grid: string;
  colors: number;
  confetti: number;
  isolated: number;
  confusable: number;
  stars: number;
  score: number;
}

function run(tag: string, img: ReturnType<typeof load>, targetWidth: number, stylize: number): Row {
  const out = runPipeline({
    rgba: img.rgba,
    srcWidth: img.width,
    srcHeight: img.height,
    params: { ...DEFAULT_PARAMS, targetWidth, maxColors: 16, stylize },
    now: '2026-11-23T00:00:00.000Z',
  });
  const r: PipelineOutput['report'] = out.report;
  return {
    tag,
    grid: `${out.grid.width}×${out.grid.height}`,
    colors: out.grid.palette.length,
    confetti: r.continuity.confettiRatio,
    isolated: r.continuity.isolatedRatio,
    confusable: r.confusion.confusableEdgeRatio,
    stars: r.difficulty.stars,
    score: r.difficulty.score,
  };
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function table(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  console.log('  版本    网格        色数   碎片率   孤岛率   混淆边比   难度');
  console.log('  ' + '─'.repeat(62));
  for (const r of rows) {
    console.log(
      `  ${r.tag.padEnd(6)}  ${r.grid.padEnd(10)}  ${String(r.colors).padStart(3)}   ` +
        `${pct(r.confetti).padStart(6)}  ${pct(r.isolated).padStart(6)}  ` +
        `${pct(r.confusable).padStart(7)}   ${r.stars}★ ${r.score.toFixed(2)}`,
    );
  }
}

const images = { src: load('src'), old: load('old'), new: load('new') };

/* ---------- 与构图无关的判据：细节密度 ---------- */

/**
 * 为什么最终用「细节密度」而不是区域色差：
 *   前两次尝试的空间判据（全图相关性、固定坐标口罩检测、中央区域色差）全部
 *   被一个事实否掉——**新版提示词重新构图了**（人物缩小、留白增加）。
 *   源图/旧图人物占满画面，新图人物只占中间一块，于是「中央区域」在不同版本里
 *   指向不同的东西，任何固定坐标的比较都会失真。
 *
 * 细节密度是全局统计（16×16 块内亮度标准差超阈值的块占比），与构图位置无关：
 *   人物被简化成大片平涂 → 密度下降；人物细节保留 → 密度接近源图。
 * 它能说明「有没有被简化」，但说明不了「口罩还在不在」——那是语义判断，
 * 只能靠肉眼（见 compare.jpg）。这一点如实写进结论，不假装指标能替代眼睛。
 */
function detailDensity(img: ReturnType<typeof load>, block = 16, stdThreshold = 10): number {
  let detailed = 0;
  let total = 0;
  for (let by = 0; by + block <= img.height; by += block) {
    for (let bx = 0; bx + block <= img.width; bx += block) {
      let sum = 0;
      let sum2 = 0;
      const n = block * block;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          const o = (y * img.width + x) * 4;
          const l = 0.2126 * img.rgba[o] + 0.7152 * img.rgba[o + 1] + 0.0722 * img.rgba[o + 2];
          sum += l;
          sum2 += l * l;
        }
      }
      const mean = sum / n;
      const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      total++;
      if (std > stdThreshold) detailed++;
    }
  }
  return total > 0 ? detailed / total : 0;
}

console.log('\n── 与构图无关的判据：细节密度（16×16 块中有纹理的占比）──');
{
  const rows = (['src', 'old', 'new'] as const).map((tag) => ({
    tag,
    d: detailDensity(images[tag]),
  }));
  for (const r of rows) console.log(`  ${r.tag.padEnd(4)} ${(r.d * 100).toFixed(1)}%`);
  const [src, old, neu] = rows.map((r) => r.d);
  console.log(`  → 旧提示词相对源图丢失 ${((src - old) * 100).toFixed(1)} 个百分点`);
  console.log(`  → 新提示词相对源图丢失 ${((src - neu) * 100).toFixed(1)} 个百分点`);
  console.log(
    neu > old
      ? '  → 新版保留了更多细节（被简化得更轻），与肉眼「人物完整」一致'
      : '  → ⚠ 新版细节反而更少',
  );
}

console.log('── 提示词改版对比（同一张人像，16 色）─────────────────');
console.log(`  AI 插画模式平滑 = ${AI_IMAGE_STYLIZE}（本次主表）；0.4 作对照`);

for (const width of [120, 200]) {
  const rows = (['src', 'old', 'new'] as const).map((tag) =>
    run(tag, images[tag], width, AI_IMAGE_STYLIZE),
  );
  table(`【${width} 格 · 平滑 ${AI_IMAGE_STYLIZE}】`, rows);
}

// 对照：如果沿用旧的 0.4
console.log('\n── 对照：沿用旧的平滑 0.4（说明为什么 AI 模式要降到 0.2）──');
for (const width of [120, 200]) {
  const rows = (['old', 'new'] as const).map((tag) => run(tag, images[tag], width, 0.4));
  table(`【${width} 格 · 平滑 0.4】`, rows);
}
