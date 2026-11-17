/**
 * AI 风格化测量矩阵：3 类图 × 3 档格数 × 4 种输入 × 2 档平滑。
 *
 *   node scripts/exp-ai-matrix.ts
 *
 * 同时回答两个问题：
 *   1. AI 风格化在不同图类/不同格数下对碎片率的影响（决定默认开还是关）；
 *   2. 512² 输入的两种比例策略（压扁 vs 等比+镜像补边）哪个观感更好。
 *
 * 产出：终端表格 + .data/matrix/metrics.md + 并排对比图素材（由 Python 合成）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';
import { pixelate } from '../src/ai/pixelate.ts';
import type { PixelateParams } from '../src/ai/pixelate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, '.data/matrix');
mkdirSync(OUT, { recursive: true });

const ANIME = 512;
const GRIDS = [48, 80, 120];
const MAX_COLORS = 16;
const PIXEL: Omit<PixelateParams, 'pixelSize'> = {
  edgeThresh: 100,
  smoothRadius: 2,
  levels: 24,
};

interface ImgMeta {
  tag: string;
  width: number;
  height: number;
  raw: string;
}
const images = JSON.parse(
  readFileSync(resolve(root, '.data/ai-images.json'), 'utf8'),
) as ImgMeta[];

/* ---------------- 图像工具 ---------------- */

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
          const k = wx * wy;
          const o = (sy * sw + sx) * 4;
          r += src[o] * k;
          g += src[o + 1] * k;
          b += src[o + 2] * k;
          ws += k;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = r / ws;
      out[o + 1] = g / ws;
      out[o + 2] = b / ws;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** 镜像坐标：把 [0,size) 反射进 [0,len) */
function mirror(v: number, len: number): number {
  const period = 2 * len;
  let x = v % period;
  if (x < 0) x += period;
  return x < len ? x : period - x - 1;
}

/* ---------------- AnimeGANv2 ---------------- */

const modelPath = resolve(root, '.data/models/animeganv2_face_paint_512.onnx');
const modelBytes = new Uint8Array(readFileSync(modelPath));
const session = await ort.InferenceSession.create(modelBytes, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});

async function infer512(tensor: Float32Array): Promise<Float32Array> {
  const out = await session.run({
    input_image: new ort.Tensor('float32', tensor, [1, 3, ANIME, ANIME]),
  });
  return out.output_image.data as Float32Array;
}

function toInput(px: Uint8ClampedArray): Float32Array {
  const n = ANIME * ANIME;
  const t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    t[i] = (px[o] / 255) * 2 - 1;
    t[n + i] = (px[o + 1] / 255) * 2 - 1;
    t[2 * n + i] = (px[o + 2] / 255) * 2 - 1;
  }
  return t;
}

function fromOutput(y: Float32Array): Uint8ClampedArray {
  const n = ANIME * ANIME;
  const px = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    px[i * 4] = Math.round((y[i] * 0.5 + 0.5) * 255);
    px[i * 4 + 1] = Math.round((y[n + i] * 0.5 + 0.5) * 255);
    px[i * 4 + 2] = Math.round((y[2 * n + i] * 0.5 + 0.5) * 255);
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** 策略 A：直接压成 512×512（横向拉伸） */
async function animeSquash(rgba: Uint8ClampedArray, w: number, h: number) {
  const sq = resizeArea(rgba, w, h, ANIME, ANIME);
  const t0 = performance.now();
  const y = await infer512(toInput(sq));
  const ms = performance.now() - t0;
  return { rgba: resizeArea(fromOutput(y), ANIME, ANIME, w, h), ms };
}

/** 策略 B：等比缩放到 512 内，四周镜像补边，推理后裁回内容区 */
async function animePad(rgba: Uint8ClampedArray, w: number, h: number) {
  const k = Math.min(ANIME / w, ANIME / h);
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const content = resizeArea(rgba, w, h, cw, ch);
  const offX = Math.floor((ANIME - cw) / 2);
  const offY = Math.floor((ANIME - ch) / 2);

  const padded = new Uint8ClampedArray(ANIME * ANIME * 4);
  for (let y = 0; y < ANIME; y++) {
    const sy = mirror(y - offY, ch);
    for (let x = 0; x < ANIME; x++) {
      const sx = mirror(x - offX, cw);
      const so = (sy * cw + sx) * 4;
      const o = (y * ANIME + x) * 4;
      padded[o] = content[so];
      padded[o + 1] = content[so + 1];
      padded[o + 2] = content[so + 2];
      padded[o + 3] = 255;
    }
  }

  const t0 = performance.now();
  const y = await infer512(toInput(padded));
  const ms = performance.now() - t0;
  const styled = fromOutput(y);

  const cropped = new Uint8ClampedArray(cw * ch * 4);
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const so = ((yy + offY) * ANIME + (xx + offX)) * 4;
      const o = (yy * cw + xx) * 4;
      cropped[o] = styled[so];
      cropped[o + 1] = styled[so + 1];
      cropped[o + 2] = styled[so + 2];
      cropped[o + 3] = 255;
    }
  }
  return { rgba: resizeArea(cropped, cw, ch, w, h), ms };
}

/* ---------------- 跑矩阵 ---------------- */

interface Row {
  tag: string;
  grid: number;
  variant: string;
  stylize: number;
  confetti: number;
  isolated: number;
  colors: number;
  stars: number;
}

const rows: Row[] = [];
const panels: { tag: string; label: string; file: string; width: number; height: number }[] = [];

for (const meta of images) {
  const buf = readFileSync(resolve(root, '.data', meta.raw));
  const original = new Uint8ClampedArray(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  );
  console.log(`\n=== ${meta.tag} ${meta.width}×${meta.height} ===`);

  const squash = await animeSquash(original, meta.width, meta.height);
  const pad = await animePad(original, meta.width, meta.height);
  console.log(`  推理耗时：压扁 ${squash.ms.toFixed(0)}ms · 等比 ${pad.ms.toFixed(0)}ms`);

  const variants: { name: string; rgba: Uint8ClampedArray }[] = [
    { name: '原始', rgba: original },
    { name: '卡通-压扁', rgba: squash.rgba },
    { name: '卡通-等比', rgba: pad.rgba },
  ];

  for (const gw of GRIDS) {
    const pix = pixelate(original, meta.width, meta.height, {
      ...PIXEL,
      pixelSize: Math.max(2, Math.round(meta.width / gw)),
    });
    const list = [...variants, { name: '像素-TS', rgba: pix }];

    for (const v of list) {
      for (const stylize of [0, 0.4]) {
        const rep = runPipeline({
          rgba: v.rgba,
          srcWidth: meta.width,
          srcHeight: meta.height,
          params: {
            ...DEFAULT_PARAMS,
            targetWidth: gw,
            maxColors: MAX_COLORS,
            stylize,
          },
          now: 'T',
        }).report;
        rows.push({
          tag: meta.tag,
          grid: gw,
          variant: v.name,
          stylize,
          confetti: rep.continuity.confettiRatio,
          isolated: rep.continuity.isolatedRatio,
          colors: rep.scale.colorCount,
          stars: rep.difficulty.stars,
        });
      }
    }
  }

  /* 并排图素材（第 120 格那一档的像素化用于展示） */
  const pix120 = pixelate(original, meta.width, meta.height, {
    ...PIXEL,
    pixelSize: Math.max(2, Math.round(meta.width / 120)),
  });
  const panelSet: [string, Uint8ClampedArray][] = [
    ['original', original],
    ['anime-squash', squash.rgba],
    ['anime-pad', pad.rgba],
    ['pixel-ts', pix120],
  ];
  for (const [label, px] of panelSet) {
    const file = `${meta.tag}-${label}.raw`;
    writeFileSync(resolve(OUT, file), px);
    panels.push({ tag: meta.tag, label, file, width: meta.width, height: meta.height });
  }
}

writeFileSync(resolve(OUT, 'panels.json'), JSON.stringify(panels, null, 2));

/* ---------------- 输出表格 ---------------- */

const lines: string[] = [];
lines.push('# AI 风格化测量矩阵', '');
lines.push(`格数 ${GRIDS.join('/')} · 色数 ${MAX_COLORS} · 平滑 0 与 0.4 · 3 类图`, '');
lines.push('| 图 | 格数 | 输入 | 平滑 | 碎片% | 孤岛% | 用色 | 难度 |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${r.tag} | ${r.grid} | ${r.variant} | ${r.stylize} | ` +
      `${(r.confetti * 100).toFixed(1)} | ${(r.isolated * 100).toFixed(1)} | ` +
      `${r.colors} | ${r.stars}★ |`,
  );
}
const md = lines.join('\n');
writeFileSync(resolve(OUT, 'metrics.md'), md, 'utf8');

// 终端只打「平滑 0.4」这个产品实际会用的档位
for (const tag of images.map((i) => i.tag)) {
  console.log(`\n${tag} — 碎片率（平滑 0.4，产品默认）`);
  console.log('  输入         ' + GRIDS.map((g) => `${g}格`.padStart(7)).join(''));
  const names = [...new Set(rows.filter((r) => r.tag === tag).map((r) => r.variant))];
  for (const name of names) {
    const cells = GRIDS.map((g) => {
      const r = rows.find((x) => x.tag === tag && x.grid === g && x.variant === name && x.stylize === 0.4);
      return r ? `${(r.confetti * 100).toFixed(1)}%`.padStart(7) : '      -';
    });
    console.log('  ' + name.padEnd(12) + cells.join(''));
  }
}

console.log(`\n明细写入 .data/matrix/metrics.md（${rows.length} 行）`);
