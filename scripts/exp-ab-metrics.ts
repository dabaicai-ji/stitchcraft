/**
 * A/B 双档指标对比：同一张人像，源图 / A（极简）/ B（标准），120 / 200 格。
 *
 *   python .data/to-raw-ab.py        # 先把 a.jpg / b.jpg 转成 raw
 *   node scripts/exp-ab-metrics.ts   # 再跑本脚本
 *
 * 输出：色数 / 碎片率 / 孤岛率 / 混淆边比 / 难度，外加细节密度。
 * 平滑用 AI 插画模式的真实默认 0.2。
 *
 * 预期（这才是 A/B 存在的理由）：
 *   A 更少色、更少碎片、更难触发告警——「更好绣」
 *   B 更多色、更多细节、更碎——「更清晰」
 * 如果实测两者几乎一样，说明提示词没拉开差距，这个功能就该重新设计。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_IMAGE_STYLIZE } from '../src/ai/stylizeMode.ts';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AB = resolve(root, '.data/ab');

interface RawMeta {
  width: number;
  height: number;
}
const metas = JSON.parse(readFileSync(resolve(AB, 'raw-meta.json'), 'utf8')) as Record<
  string,
  RawMeta
>;

function load(tag: string): { rgba: Uint8ClampedArray; width: number; height: number } {
  const m = metas[tag];
  if (!m) throw new Error(`raw-meta.json 里没有 ${tag}，先跑 python .data/to-raw-ab.py`);
  const buf = readFileSync(resolve(AB, `${tag}.raw`));
  const expect = m.width * m.height * 4;
  if (buf.length !== expect) throw new Error(`${tag}.raw 尺寸不符：${buf.length} vs ${expect}`);
  return {
    rgba: new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)),
    width: m.width,
    height: m.height,
  };
}

/** 源图（裁剪前的人像）作为参考基线：各图按自己的尺寸走管线，互不影响 */
const images = { src: load('src'), a: load('a'), b: load('b') };

interface Row {
  tag: string;
  grid: string;
  colors: number;
  /** 可绣格数：留白不计。A 的优势主要体现在这里（背景纯白 → 不绣） */
  stitchable: number;
  /** 背景（留白）占比 */
  blank: number;
  confetti: number;
  isolated: number;
  confusable: number;
  stars: number;
  score: number;
}

function run(tag: string, img: ReturnType<typeof load>, targetWidth: number): Row {
  const out = runPipeline({
    rgba: img.rgba,
    srcWidth: img.width,
    srcHeight: img.height,
    params: { ...DEFAULT_PARAMS, targetWidth, maxColors: 16, stylize: AI_IMAGE_STYLIZE },
    now: '2026-11-23T00:00:00.000Z',
  });
  const r = out.report;
  const total = out.grid.width * out.grid.height;
  const stitchable = r.scale.stitchableCells;
  return {
    tag,
    grid: `${out.grid.width}×${out.grid.height}`,
    colors: out.grid.palette.length,
    stitchable,
    blank: total > 0 ? 1 - stitchable / total : 0,
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
  console.log('  版本      网格         色数   可绣格    留白    碎片率   孤岛率   混淆边比   难度');
  console.log('  ' + '─'.repeat(82));
  for (const r of rows) {
    console.log(
      `  ${r.tag.padEnd(8)}  ${r.grid.padEnd(11)}  ${String(r.colors).padStart(3)}   ` +
        `${String(r.stitchable).padStart(6)}  ${pct(r.blank).padStart(6)}  ` +
        `${pct(r.confetti).padStart(6)}  ${pct(r.isolated).padStart(6)}  ` +
        `${pct(r.confusable).padStart(7)}   ${r.stars}★ ${r.score.toFixed(2)}`,
    );
  }
}

/** 与构图无关的细节密度：16×16 块内亮度标准差超阈值的块占比 */
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

console.log('\n── 细节密度（16×16 块中有纹理的占比，越高细节越多）──');
for (const tag of ['src', 'a', 'b'] as const) {
  const label = { src: '源图', a: 'A 极简', b: 'B 标准' }[tag];
  console.log(`  ${tag.padEnd(4)} ${label.padEnd(8)} ${(detailDensity(images[tag]) * 100).toFixed(1)}%`);
}

console.log(`\n── A/B 对比（16 色，平滑 ${AI_IMAGE_STYLIZE}）──`);
for (const width of [120, 200]) {
  const rows = (['src', 'a', 'b'] as const).map((tag) => run(tag, images[tag], width));
  table(`【${width} 格】`, rows);
}

/* ---------- 差异判定：A 应更好绣、B 应更清晰 ---------- */
console.log('\n── A/B 差异是否成立（这才是双档的意义）──');
{
  const at = (tag: 'src' | 'a' | 'b', w: number): Row => run(tag, images[tag], w);
  const a120 = at('a', 120);
  const b120 = at('b', 120);

  const fewerColors = a120.colors < b120.colors;
  const fewerStitches = a120.stitchable < b120.stitchable;
  const moreBlank = a120.blank > b120.blank;

  console.log(`  可绣格数：A ${a120.stitchable} vs B ${b120.stitchable} → ${fewerStitches ? 'A 少针 ✓' : '未拉开 ✗'}`);
  console.log(`  留白占比：A ${pct(a120.blank)} vs B ${pct(b120.blank)} → ${moreBlank ? 'A 背景更干净 ✓' : '未拉开 ✗'}`);
  console.log(`  色数：A ${a120.colors} vs B ${b120.colors} → ${fewerColors ? 'A 更少 ✓' : '未拉开 ✗'}`);
  console.log(`  碎片率：A ${pct(a120.confetti)} vs B ${pct(b120.confetti)} → ${a120.confetti < b120.confetti ? 'A 更低 ✓' : 'B 更低'}`);
  console.log(`  混淆边比：A ${pct(a120.confusable)} vs B ${pct(b120.confusable)} → ${a120.confusable < b120.confusable ? 'A 更少 ✓' : 'B 更少'}`);

  const ok = fewerStitches || moreBlank || fewerColors;
  console.log(
    ok
      ? '\n  → A 的优势落在「少绣、少色、背景干净」，不在碎片率——这是留白带来的，如实报告'
      : '\n  → 三项都没拉开：提示词没起作用，需要重新设计 A/B',
  );
}
