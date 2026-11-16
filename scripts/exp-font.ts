/**
 * 排查：为什么子集字体的中文没渲染出来。
 * 产出 4 个变体 PDF，逐个渲染对比。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ZH = '十字绣图纸第页共列行符号色号名称格数束合计';

async function make(
  name: string,
  opts: { fontBytes?: Uint8Array; subset?: boolean; useHelvetica?: boolean },
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([595, 842]);

  if (opts.useHelvetica) {
    const f = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('SANITY ASCII 12345', { x: 40, y: 780, size: 20, font: f, color: rgb(0, 0, 0) });
  }

  if (opts.fontBytes) {
    try {
      const f = await pdf.embedFont(opts.fontBytes, { subset: opts.subset ?? false });
      page.drawText(ZH, { x: 40, y: 740, size: 20, font: f, color: rgb(0, 0, 0) });
      page.drawText('ABC 310 1440', { x: 40, y: 700, size: 12, font: f, color: rgb(0, 0, 0) });
      console.log(`  ${name}: 字体嵌入成功`);
    } catch (e) {
      console.log(`  ${name}: ✗ 嵌入失败 ${(e as Error).message}`);
      return;
    }
  }

  const bytes = await pdf.save();
  writeFileSync(resolve(root, `.data/probe-${name}.pdf`), bytes);
  console.log(`  ${name}: ${(bytes.length / 1024).toFixed(1)} KB`);
}

const full = readFileSync(resolve(root, '.data/NotoSansSC-Regular.otf'));
const subSfnt = await subsetFont(full, ZH + 'ABC0123456789 ', { targetFormat: 'sfnt' });

console.log('变体：');
await make('0-sanity', { useHelvetica: true });
await make('1-sub-nosubset', { fontBytes: subSfnt, subset: false });
await make('2-sub-subset', { fontBytes: subSfnt, subset: true });
await make('3-full-subset', { fontBytes: full, subset: true });
await make('4-full-nosubset', { fontBytes: full, subset: false });
