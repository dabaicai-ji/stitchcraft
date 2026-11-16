/**
 * 生成 PDF 用的中文字体子集。
 *
 *   node scripts/build-font-subset.ts
 *
 * 输入：.data/NotoSansSC-Regular.otf（SIL OFL 1.1，可再分发）
 * 输出：public/fonts/noto-sans-sc-subset.ttf
 *
 * 为什么必须在构建期做：
 *   pdf-lib 自带的 subset:true 对 CFF 轮廓字体会把字形抽坏 —— 实测生成的 PDF
 *   渲染出来是**空白**。所以改成「预子集化 + 运行时 subset:false」。
 *   子集以 PDF_CHARSET 为准，新增中文文案会自动进子集。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';
import fontkit from '@pdf-lib/fontkit';
import { PDF_CHARSET } from '../src/render/pdf/labels.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, '.data/NotoSansSC-Regular.otf');
const OUT_DIR = resolve(root, 'public/fonts');
const OUT = resolve(OUT_DIR, 'noto-sans-sc-subset.ttf');

if (!existsSync(SRC)) {
  console.error(`缺少源字体: ${SRC}`);
  console.error('下载（SIL OFL 1.1）：');
  console.error(
    '  https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
  );
  process.exit(1);
}

const src = readFileSync(SRC);
console.log(`源字体 ${(src.length / 1024 / 1024).toFixed(2)} MB`);

const subset = await subsetFont(src, PDF_CHARSET, { targetFormat: 'sfnt' });

// 逐字符校验：子集里必须每个字符都有字形，否则 PDF 上会出现豆腐块
const parsed = fontkit.create(subset);
const missing: string[] = [];
for (const ch of PDF_CHARSET) {
  const cp = ch.codePointAt(0)!;
  if (!parsed.hasGlyphForCodePoint(cp)) missing.push(ch);
}

if (missing.length > 0) {
  console.error(`✗ 子集缺少 ${missing.length} 个字形: ${JSON.stringify(missing.slice(0, 40).join(''))}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, subset);

console.log(
  `写入 public/fonts/noto-sans-sc-subset.ttf —— ${(subset.length / 1024).toFixed(1)} KB，` +
    `${PDF_CHARSET.length} 个字符全部有字形`,
);
