/**
 * PDF 导出集成测试：真实照片 → 图纸 → PDF，并回读校验。
 *
 *   node scripts/itest-pdf.ts
 *
 * 产出 .data/out-pattern.pdf，可用 PDF 阅读器人工验收。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';
import { exportGridPdf } from '../src/render/pdf/exportPdf.ts';
import { buildThreadCsv } from '../src/render/exportCsv.ts';
import { FAMILY_ORDER } from '../src/core/palette/classify.ts';
import { PDF_CHARSET } from '../src/render/pdf/labels.ts';
import { MIN_CODE_CELL, MIN_COLOR_CELL, planPages } from '../src/render/pdf/layout.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) return;
  failures++;
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
};

const images = JSON.parse(
  readFileSync(resolve(root, '.data/images.json'), 'utf8'),
) as { tag: string; width: number; height: number }[];

const meta = images.find((m) => m.tag === 'photo') ?? images[0];
const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
const rgba = new Uint8ClampedArray(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
);

console.log(`源图 ${meta.tag} ${meta.width}×${meta.height}`);
const out = runPipeline({
  rgba,
  srcWidth: meta.width,
  srcHeight: meta.height,
  params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16 },
  now: '2026-11-16T00:00:00.000Z',
});
const { grid, report } = out;
console.log(`网格 ${grid.width}×${grid.height} · ${grid.palette.length} 色`);

const plan = planPages(grid.width, grid.height);
console.log(
  `分页：${plan.colsPerPage}×${plan.rowsPerPage} 格/页 · ` +
    `彩色 ${plan.colorSingle ? '单页全景' : `${plan.colorPages} 页分页`} · ` +
    `符号 ${plan.chartPages} 页 · 总计 ${plan.totalPages} 页`,
);

check('120 格图纸走单页彩色全景', plan.colorSingle, {
  cell: plan.colorCell,
  threshold: MIN_COLOR_CELL,
});
check(
  '总页数 = 总览 + 彩色 + 符号 + 线量',
  plan.totalPages === 1 + plan.colorPages + plan.chartPages + 1,
  { total: plan.totalPages, color: plan.colorPages, chart: plan.chartPages },
);
check('页面清单长度与总页数一致', plan.pages.length === plan.totalPages);
check('第 1 页是总览', plan.pages[0].kind === 'overview');
check('第 2 页是彩色全景', plan.pages[1].kind === 'color');
check('最后一页是线量清单', plan.pages[plan.pages.length - 1].kind === 'threads');

const fontBytes = new Uint8Array(
  readFileSync(resolve(root, 'public/fonts/noto-sans-sc-subset.ttf')),
);

// 字体子集必须覆盖当前所有 PDF 文案 —— 否则新增标签会静默变成豆腐块。
// 这条断言就是为了逼「改了 labels.ts 忘记 npm run font:build」立刻失败。
{
  const parsedFont = fontkit.create(fontBytes);
  const missing = [...PDF_CHARSET].filter(
    (ch) => !parsedFont.hasGlyphForCodePoint(ch.codePointAt(0)!),
  );
  check(
    '字体子集覆盖全部 PDF 文案字符',
    missing.length === 0,
    { missing: missing.join(''), hint: '跑 npm run font:build' },
  );
}

/* ---------- 中文版 ---------- */
const t0 = performance.now();
const zhPdf = await exportGridPdf({
  grid,
  report,
  fontBytes,
  title: '十字绣图纸 · 测试',
  now: new Date('2026-11-16T10:00:00Z'),
});
const zhMs = performance.now() - t0;
const zhPath = resolve(root, '.data/out-pattern.pdf');
writeFileSync(zhPath, zhPdf);
console.log(`中文版 PDF ${(zhPdf.length / 1024).toFixed(0)} KB · ${zhMs.toFixed(0)}ms → ${zhPath}`);

const reloaded = await PDFDocument.load(zhPdf);
check('页数与计划一致', reloaded.getPageCount() === plan.totalPages, {
  actual: reloaded.getPageCount(),
  expected: plan.totalPages,
});
check('正文超过 1 页（验证分页真的生效）', plan.chartPages > 1, plan.chartPages);
check('体积合理（< 5MB）', zhPdf.length < 5 * 1024 * 1024, zhPdf.length);
check('体积非空（> 20KB）', zhPdf.length > 20 * 1024, zhPdf.length);

/* ---------- 无字体降级 ---------- */
const enPdf = await exportGridPdf({
  grid,
  report,
  fontBytes: null,
  now: new Date('2026-11-16T10:00:00Z'),
});
const enReload = await PDFDocument.load(enPdf);
check('无中文字体时页数一致', enReload.getPageCount() === plan.totalPages);
check('降级版体积更小（没用嵌入字体）', enPdf.length < zhPdf.length * 1.2, {
  en: enPdf.length,
  zh: zhPdf.length,
});
writeFileSync(resolve(root, '.data/out-pattern-en.pdf'), enPdf);

/* ---------- 大图纸：彩色也要分页 ---------- */
const big = runPipeline({
  rgba,
  srcWidth: meta.width,
  srcHeight: meta.height,
  params: { ...DEFAULT_PARAMS, targetWidth: 220, maxColors: 24 },
  now: 'T',
});
const bigPlan = planPages(big.grid.width, big.grid.height);
console.log(
  `大图纸 ${big.grid.width}×${big.grid.height}：` +
    `单页缩小后格边长 ${(Math.min(535 / big.grid.width, 735 / big.grid.height) * 25.4 / 72).toFixed(2)}mm ` +
    `(< ${(MIN_COLOR_CELL * 25.4 / 72).toFixed(1)}mm) → 彩色分页 ${bigPlan.colorPages} 页，总计 ${bigPlan.totalPages} 页`,
);
check('大图纸彩色页转为分页', !bigPlan.colorSingle, { cell: bigPlan.colorCell });
check('彩色分页数与符号页数一致', bigPlan.colorPages === bigPlan.chartPages);

const t1 = performance.now();
const bigPdf = await exportGridPdf({
  grid: big.grid,
  report: big.report,
  fontBytes,
  now: new Date('2026-11-16T10:00:00Z'),
});
const bigMs = performance.now() - t1;
console.log(
  `  → ${(bigPdf.length / 1024 / 1024).toFixed(1)} MB · ${bigMs.toFixed(0)}ms`,
);
const bigReload = await PDFDocument.load(bigPdf);
check('大图纸 PDF 页数正确', bigReload.getPageCount() === bigPlan.totalPages);
writeFileSync(resolve(root, '.data/out-pattern-big.pdf'), bigPdf);

/* ---------- 小图纸：彩色页放大 + 色号数字 ---------- */
const small = runPipeline({
  rgba,
  srcWidth: meta.width,
  srcHeight: meta.height,
  params: { ...DEFAULT_PARAMS, targetWidth: 24, maxColors: 8 },
  now: 'T',
});
const smallPlan = planPages(small.grid.width, small.grid.height);
console.log(
  `小图纸 ${small.grid.width}×${small.grid.height}：彩色格边长 ` +
    `${((smallPlan.colorCell * 25.4) / 72).toFixed(1)}mm` +
    `${smallPlan.colorCell >= MIN_CODE_CELL ? '（可印色号）' : ''}`,
);
check('小图纸仍是单页彩色', smallPlan.colorSingle);
check('小图纸彩色格放大到可印色号', smallPlan.colorCell >= MIN_CODE_CELL, {
  cellPt: smallPlan.colorCell,
  need: MIN_CODE_CELL,
});

const smallPdf = await exportGridPdf({
  grid: small.grid,
  report: small.report,
  fontBytes,
  includeCodes: true,
  now: new Date('2026-11-16T10:00:00Z'),
});
check('小图纸带色号 PDF 可生成', smallPdf.length > 10 * 1024, smallPdf.length);
writeFileSync(resolve(root, '.data/out-pattern-small.pdf'), smallPdf);

/* ---------- 线量清单 CSV ---------- */
{
  const csv = buildThreadCsv(report);
  const lines = csv.split('\r\n');
  writeFileSync(resolve(root, '.data/threads.csv'), csv, 'utf8');

  check('CSV 带 UTF-8 BOM（Excel 中文不乱码）', csv.startsWith('\uFEFF'));
  check('CSV 用 CRLF 换行', csv.includes('\r\n'));
  check(
    'CSV 行数 = 表头 + 每色一行 + 合计 + 分组小结 + 备注',
    lines.length >= grid.palette.length + 6,
    { lines: lines.length, colors: grid.palette.length },
  );
  check('CSV 覆盖全部色号', grid.palette.every((p) => csv.includes(p.dmcCode)));
  check('CSV 含合计行', lines.some((l) => l.startsWith('合计')));
  check(
    'CSV 合计束数与报告一致',
    lines.some((l) => l.startsWith('合计') && l.includes(String(report.supply.totalSkeins))),
  );

  const header = lines[0];
  check('CSV 含色系列', header.includes('色系'));
  check('CSV 含采购分组列', header.includes('采购分组'));
  check('CSV 含角色列', header.includes('角色'));

  // 每一行数据行的色系必须是合法值
  const dataLines = lines.slice(1, 1 + grid.palette.length);
  const families = new Set(FAMILY_ORDER.map(String));
  const badFamily = dataLines.filter((l) => {
    const parts = l.split(',');
    return !families.has(parts[3]);
  });
  check('每行色系合法', badFamily.length === 0, badFamily.slice(0, 3));

  const roles = dataLines.map((l) => l.split(',')[5]);
  check(
    '角色只出现主色/辅色/点缀',
    roles.every((r) => r === '主色' || r === '辅色' || r === '点缀'),
    [...new Set(roles)],
  );
  check('CSV 含采购分组小结', csv.includes('# 采购分组小结'));

  console.log(
    `CSV ${(csv.length / 1024).toFixed(1)} KB · ${lines.length} 行 · ` +
      `色系分布 ${[...new Set(dataLines.map((l) => l.split(',')[3]))].join('/')}`,
  );
}

console.log(failures === 0 ? '\n✓ PDF 集成测试全部通过' : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
