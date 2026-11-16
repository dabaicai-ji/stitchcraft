/**
 * PDF 图纸导出。
 *
 * 页面顺序（由 layout.ts 的清单决定，渲染只负责逐页画）：
 *   1. 总览页    参数摘要 + 配色图例 + 页码索引
 *   2. 彩色页    单页全景（小图纸）或 40×50 分页（超大图纸）
 *   3..N 符号页  每页 40×50 格，10 格粗线、行列坐标、每格一个符号
 *   N+1 线量页   清单 + 可绣性摘要 + 数据署名
 *
 * 三个踩过坑之后定下来的做法：
 *
 *   ① 符号页只画符号不铺色块 —— 打印省墨、黑白可用；彩色感由彩色页负责。
 *   ② 页边界强制落在 10 格线（见 layout.ts），否则跨页拼接会错位。
 *   ③ **逐字符定位绘制**。PDF 字符间距理论上来自字体 /W 宽度表，但实测
 *      LibreOffice 会忽略 /W 用 /DW=1000，导致数字被画成「2 1 . 8」。
 *      单字符 drawText 没有串内步进，位置完全由我们给出，任何阅读器都一致。
 *
 * 字体：构建期子集化 + 运行时 subset:false（pdf-lib 自带 subset 对 CFF 字体会丢字形）。
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { GridData, StitchabilityReport } from '../../core/types.ts';
import { parseHex } from '../../core/color/cie.ts';
import { PDF_CHARSET, PDF_EN, PDF_ZH } from './labels.ts';
import type { PdfLabelKey } from './labels.ts';
import {
  CELL,
  FOOTER_H,
  HEADER_H,
  MARGIN,
  MIN_CODE_CELL,
  PAGE,
  USABLE_H,
  USABLE_W,
  planPages,
} from './layout.ts';
import type { PageSpec } from './layout.ts';

export interface PdfExportInput {
  grid: GridData;
  report: StitchabilityReport;
  /** 中文字体子集字节；null → 降级为英文标签 */
  fontBytes: Uint8Array | null;
  title?: string;
  /** 彩色页格子里印 DMC 色号（仅格边长 ≥ 6mm 时生效） */
  includeCodes?: boolean;
  now?: Date;
}

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.45, 0.45, 0.45);
const LIGHT = rgb(0.72, 0.72, 0.72);

function hexRgb(hex: string): RGB {
  const [r, g, b] = parseHex(hex);
  return rgb(r / 255, g / 255, b / 255);
}

/** 在色块上写字时的对比色（按 gamma 编码亮度判断） */
function textOn(hex: string): RGB {
  const [r, g, b] = parseHex(hex);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return y > 148 ? rgb(0, 0, 0) : rgb(1, 1, 1);
}

const ALLOWED_CHARS = new Set(PDF_CHARSET.split(''));

export async function exportGridPdf(input: PdfExportInput): Promise<Uint8Array> {
  const { grid, report } = input;
  const hasZh = input.fontBytes !== null;
  const includeCodes = input.includeCodes ?? false;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const font: PDFFont = input.fontBytes
    ? await doc.embedFont(input.fontBytes, { subset: false })
    : await doc.embedFont(StandardFonts.Helvetica);

  const t = (k: PdfLabelKey): string => (hasZh ? PDF_ZH[k] : PDF_EN[k]);

  const plan = planPages(grid.width, grid.height);
  const now = input.now ?? new Date();
  const firstChartPage = 2 + plan.colorPages;
  const colorPageRange =
    plan.colorPages === 1 ? '2' : `2-${1 + plan.colorPages}`;

  /* ---------------- 文字绘制工具（逐字符定位） ---------------- */

  const widthCache = new Map<string, number>();
  const charWidth = (ch: string, size: number): number => {
    const key = `${ch}@${size}`;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = font.widthOfTextAtSize(ch, size);
      widthCache.set(key, w);
    }
    return w;
  };

  const measure = (text: string, size: number): number => {
    let w = 0;
    for (const ch of text) w += charWidth(ch, size);
    return w;
  };

  const draw = (
    page: PDFPage,
    text: string,
    x: number,
    y: number,
    size: number,
    color: RGB = BLACK,
  ): number => {
    let cx = x;
    for (const ch of text) {
      page.drawText(ch, { x: cx, y, size, font, color });
      cx += charWidth(ch, size);
    }
    return cx - x;
  };

  const drawRight = (page: PDFPage, text: string, right: number, y: number, size: number, color = GRAY) =>
    draw(page, text, right - measure(text, size), y, size, color);

  const drawCenter = (page: PDFPage, text: string, center: number, y: number, size: number, color = BLACK) =>
    draw(page, text, center - measure(text, size) / 2, y, size, color);

  /** 过滤掉字体里没有的字符，避免豆腐块 */
  const sanitize = (s: string, fallback: string): string => {
    if (!hasZh) return fallback;
    const out = [...s].filter((ch) => ALLOWED_CHARS.has(ch)).join('');
    return out.trim() ? out : fallback;
  };

  const title = sanitize(input.title ?? '', t('title'));

  /* ---------------- 页眉 / 页脚 ---------------- */

  const drawChrome = (
    page: PDFPage,
    pageIndex: number,
    heading: string,
    range?: string,
    footer?: string,
  ): void => {
    const top = PAGE.height - MARGIN;
    draw(page, heading, MARGIN, top - 8, 9);
    if (range) drawCenter(page, range, PAGE.width / 2, top - 8, 8.5, GRAY);
    drawRight(page, `${t('page')} ${pageIndex} ${t('of')} ${plan.totalPages} ${t('pages')}`, PAGE.width - MARGIN, top - 8, 8.5);

    page.drawLine({ start: { x: MARGIN, y: top - 14 }, end: { x: PAGE.width - MARGIN, y: top - 14 }, thickness: 0.5, color: LIGHT });
    page.drawLine({ start: { x: MARGIN, y: MARGIN + FOOTER_H - 6 }, end: { x: PAGE.width - MARGIN, y: MARGIN + FOOTER_H - 6 }, thickness: 0.5, color: LIGHT });
    draw(page, footer ?? t('blockNote'), MARGIN, MARGIN, 6.5, GRAY);
  };

  /* ---------------- 1. 总览页 ---------------- */

  const drawOverview = (pageIndex: number): void => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    drawChrome(page, pageIndex, title);

    let y = PAGE.height - MARGIN - 40;
    draw(page, t('overview'), MARGIN, y, 16);
    y -= 22;

    const starLabel = report.difficulty.label;
    const rows: [string, string][] = [
      [t('gridSize'), `${grid.width} × ${grid.height}`],
      [t('size'), `${report.scale.widthCm.toFixed(1)} × ${report.scale.heightCm.toFixed(1)} cm`],
      [t('fabric'), `${grid.fabricCount} ct`],
      [t('strands'), `${grid.strands} ${hasZh ? PDF_ZH.strands : ''}`.trim()],
      [t('colorCount'), `${report.scale.colorCount}`],
      [t('difficulty'), `${report.difficulty.stars} ${t('star')} ${hasZh ? starLabel : ''}`.trim()],
      [t('generated'), now.toISOString().slice(0, 16).replace('T', ' ')],
    ];
    for (const [k, v] of rows) {
      draw(page, `${k}:`, MARGIN, y, 8.5, GRAY);
      draw(page, v, MARGIN + 70, y, 9);
      y -= 13;
    }

    /* ---- 配色图例 ---- */
    y -= 14;
    draw(page, t('legend'), MARGIN, y, 11);
    y -= 14;

    const colors = grid.palette;
    const twoCol = colors.length > 10;
    const colX = twoCol ? [MARGIN, PAGE.width / 2 + 6] : [MARGIN];
    const rowsPerCol = twoCol ? Math.ceil(colors.length / 2) : colors.length;
    const startY = y;

    colors.forEach((c, i) => {
      const col = twoCol ? Math.floor(i / rowsPerCol) : 0;
      const row = twoCol ? i % rowsPerCol : i;
      const x = colX[col];
      const ry = startY - row * 14;

      page.drawRectangle({
        x,
        y: ry - 2,
        width: 10,
        height: 10,
        color: hexRgb(c.hex),
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 0.4,
      });
      draw(page, c.symbol, x + 15, ry, 9);
      draw(page, c.dmcCode, x + 27, ry, 8.5);
      const name = c.name.length > 20 ? `${c.name.slice(0, 19)}...` : c.name;
      draw(page, name, x + 57, ry, 7.5, GRAY);
      const used = report.supply.perColor.find((u) => u.dmcCode === c.dmcCode);
      const cnt = `${used?.stitchCount ?? 0}`;
      drawRight(page, cnt, twoCol ? colX[col] + 190 : PAGE.width - MARGIN, ry, 7.5);
    });

    /* ---- 页码索引（正文页） + 彩色页提示 ---- */
    y = startY - rowsPerCol * 14 - 18;
    draw(page, t('pageMap'), MARGIN, y, 11);
    y -= 16;

    const boxW = 34;
    const boxH = 20;
    const gap = 4;
    for (let py = 0; py < plan.pagesY; py++) {
      for (let px = 0; px < plan.pagesX; px++) {
        // 页码要跳过前面的总览页和彩色页
        const n = firstChartPage + py * plan.pagesX + px;
        const bx = MARGIN + px * (boxW + gap);
        const by = y - py * (boxH + gap);
        page.drawRectangle({ x: bx, y: by - boxH, width: boxW, height: boxH, borderColor: LIGHT, borderWidth: 0.5 });
        drawCenter(page, String(n), bx + boxW / 2, by - boxH / 2 - 3, 9);
      }
    }

    const colorLabel = `${t(plan.colorSingle ? 'colorOverview' : 'colorChart')}: ${colorPageRange}`;
    draw(page, colorLabel, MARGIN + plan.pagesX * (boxW + gap) + 8, y - 10, 8, GRAY);
  };

  /* ---------------- 2. 彩色页 ---------------- */

  const drawColor = (spec: PageSpec, pageIndex: number): void => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const single = plan.colorSingle;

    const range = single
      ? `${grid.width} × ${grid.height}`
      : `${t('cols')} ${spec.colStart + 1}-${spec.colStart + spec.cols}  ${t('rows')} ${spec.rowStart + 1}-${spec.rowStart + spec.rows}`;
    drawChrome(page, pageIndex, t(single ? 'colorOverview' : 'colorChart'), range, t('colorNote'));

    const cell = spec.cell;
    const totalW = spec.cols * cell;
    const totalH = spec.rows * cell;

    // 单页全景居中；分页彩色贴左上（和符号页位置一致，方便对照）
    const x0 = single ? MARGIN + (USABLE_W - totalW) / 2 : MARGIN;
    const usableTop = PAGE.height - MARGIN - HEADER_H;
    const yTop = single ? usableTop - (USABLE_H - totalH) / 2 : usableTop;

    // 色块（+0.25pt 轻微外扩，避免打印机把格缝渲染成白线）
    for (let r = 0; r < spec.rows; r++) {
      const rowOff = (spec.rowStart + r) * grid.width;
      const y = yTop - (r + 1) * cell;
      for (let c = 0; c < spec.cols; c++) {
        const idx = grid.cells[rowOff + spec.colStart + c];
        page.drawRectangle({
          x: x0 + c * cell,
          y,
          width: cell + 0.25,
          height: cell + 0.25,
          color: idx < 0 ? rgb(1, 1, 1) : hexRgb(grid.palette[idx].hex),
        });
      }
    }

    // DMC 色号（可选）：只有格子够大、色号够短才印，否则放弃
    if (includeCodes && cell >= MIN_CODE_CELL) {
      const size = Math.min(cell * 0.34, 9);
      for (let r = 0; r < spec.rows; r++) {
        const rowOff = (spec.rowStart + r) * grid.width;
        const cy = yTop - (r + 0.5) * cell;
        for (let c = 0; c < spec.cols; c++) {
          const idx = grid.cells[rowOff + spec.colStart + c];
          if (idx < 0) continue;
          const entry = grid.palette[idx];
          if (entry.dmcCode.length > 4) continue;
          draw(
            page,
            entry.dmcCode,
            x0 + (c + 0.5) * cell - measure(entry.dmcCode, size) / 2,
            cy - size * 0.35,
            size,
            textOn(entry.hex),
          );
        }
      }
    }

    // 10 格粗线
    const heavy = single ? 0.55 : 0.9;
    for (let c = 0; c <= spec.cols; c++) {
      if ((spec.colStart + c) % 10 !== 0) continue;
      const x = x0 + c * cell;
      page.drawLine({ start: { x, y: yTop }, end: { x, y: yTop - totalH }, thickness: heavy, color: BLACK });
    }
    for (let r = 0; r <= spec.rows; r++) {
      if ((spec.rowStart + r) % 10 !== 0) continue;
      const y = yTop - r * cell;
      page.drawLine({ start: { x: x0, y }, end: { x: x0 + totalW, y }, thickness: heavy, color: BLACK });
    }

    // 坐标（每 10 格一个，空间够才标）
    if (cell * 10 >= 20) {
      for (let c = 0; c <= spec.cols; c++) {
        const g = spec.colStart + c;
        if (g % 10 !== 0) continue;
        drawCenter(page, String(g + 1), x0 + c * cell, yTop + 3, 6, GRAY);
      }
      for (let r = 0; r <= spec.rows; r++) {
        const g = spec.rowStart + r;
        if (g % 10 !== 0) continue;
        drawRight(page, String(g + 1), x0 - 3, yTop - r * cell - 2, 6, GRAY);
      }
    }

    page.drawRectangle({
      x: x0,
      y: yTop - totalH,
      width: totalW,
      height: totalH,
      borderColor: BLACK,
      borderWidth: single ? 0.8 : 1.1,
    });
  };

  /* ---------------- 3. 符号页 ---------------- */

  const drawChart = (spec: PageSpec, pageIndex: number): void => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    const range = `${t('cols')} ${spec.colStart + 1}-${spec.colStart + spec.cols}  ${t('rows')} ${spec.rowStart + 1}-${spec.rowStart + spec.rows}`;
    drawChrome(page, pageIndex, title, range);

    const x0 = MARGIN;
    const yTop = PAGE.height - MARGIN - HEADER_H;
    const w = spec.cols * CELL;
    const h = spec.rows * CELL;

    for (let c = 0; c <= spec.cols; c++) {
      const x = x0 + c * CELL;
      page.drawLine({ start: { x, y: yTop }, end: { x, y: yTop - h }, thickness: 0.2, color: LIGHT });
    }
    for (let r = 0; r <= spec.rows; r++) {
      const y = yTop - r * CELL;
      page.drawLine({ start: { x: x0, y }, end: { x: x0 + w, y }, thickness: 0.2, color: LIGHT });
    }

    for (let c = 0; c <= spec.cols; c++) {
      if ((spec.colStart + c) % 10 !== 0) continue;
      const x = x0 + c * CELL;
      page.drawLine({ start: { x, y: yTop }, end: { x, y: yTop - h }, thickness: 0.9, color: BLACK });
    }
    for (let r = 0; r <= spec.rows; r++) {
      if ((spec.rowStart + r) % 10 !== 0) continue;
      const y = yTop - r * CELL;
      page.drawLine({ start: { x: x0, y }, end: { x: x0 + w, y }, thickness: 0.9, color: BLACK });
    }

    for (let c = 0; c <= spec.cols; c++) {
      const g = spec.colStart + c;
      if (g % 10 !== 0) continue;
      drawCenter(page, String(g + 1), x0 + c * CELL, yTop + 3, 6, GRAY);
    }
    for (let r = 0; r <= spec.rows; r++) {
      const g = spec.rowStart + r;
      if (g % 10 !== 0) continue;
      drawRight(page, String(g + 1), MARGIN - 4, yTop - r * CELL - 2, 6, GRAY);
    }

    const symSize = CELL * 0.56;
    const midOffset = CELL / 2 - symSize * 0.35;
    for (let r = 0; r < spec.rows; r++) {
      const rowOff = (spec.rowStart + r) * grid.width;
      const cy = yTop - r * CELL;
      for (let c = 0; c < spec.cols; c++) {
        const idx = grid.cells[rowOff + spec.colStart + c];
        if (idx < 0) continue;
        const sym = grid.palette[idx].symbol;
        page.drawText(sym, {
          x: x0 + c * CELL + (CELL - charWidth(sym, symSize)) / 2,
          y: cy - CELL + midOffset,
          size: symSize,
          font,
          color: BLACK,
        });
      }
    }

    page.drawRectangle({ x: x0, y: yTop - h, width: w, height: h, borderColor: BLACK, borderWidth: 1.1 });
  };

  /* ---------------- 4. 线量页 ---------------- */

  const drawThreads = (pageIndex: number): void => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    drawChrome(page, pageIndex, title);

    let y = PAGE.height - MARGIN - 40;
    draw(page, t('threadList'), MARGIN, y, 16);
    y -= 24;

    const colSym = MARGIN;
    const colCode = MARGIN + 28;
    const colName = MARGIN + 78;
    const colStitchesRight = PAGE.width - MARGIN - 80;
    const colSkeinsRight = PAGE.width - MARGIN;

    const headerCols: [string, number, 'left' | 'right'][] = [
      [t('symbol'), colSym, 'left'],
      [t('code'), colCode, 'left'],
      [t('colorName'), colName, 'left'],
      [t('stitches'), colStitchesRight, 'right'],
      [t('skeins'), colSkeinsRight, 'right'],
    ];
    for (const [label, x, align] of headerCols) {
      if (align === 'right') drawRight(page, label, x, y, 7.5);
      else draw(page, label, x, y, 7.5, GRAY);
    }
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness: 0.5, color: GRAY });
    y -= 12;

    const minRowY = MARGIN + FOOTER_H + 30;
    for (const u of report.supply.perColor) {
      if (y < minRowY) break;
      draw(page, u.symbol, colSym, y, 8.5);
      draw(page, u.dmcCode, colCode, y, 8.5);
      const name = u.name.length > 26 ? `${u.name.slice(0, 25)}...` : u.name;
      draw(page, name, colName, y, 7.5, GRAY);
      drawRight(page, String(u.stitchCount), colStitchesRight, y, 8, BLACK);
      drawRight(page, String(u.skeins), colSkeinsRight, y, 8, BLACK);
      y -= 15;
    }

    y -= 4;
    page.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: PAGE.width - MARGIN, y: y + 10 }, thickness: 0.5, color: GRAY });
    draw(
      page,
      `${t('total')}: ${report.supply.totalStitches} / ${report.supply.totalSkeins} / ${report.supply.totalCost}`,
      MARGIN,
      y,
      9,
    );

    y -= 34;
    draw(page, t('metrics'), MARGIN, y, 12);
    y -= 16;

    const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
    const metricRows: [string, string][] = [
      [t('difficulty'), `${report.difficulty.stars} / 5`],
      [t('confetti'), pct(report.continuity.confettiRatio)],
      [t('isolated'), pct(report.continuity.isolatedRatio)],
      [t('confusable'), `${report.confusion.pairCount}`],
    ];
    for (const [k, v] of metricRows) {
      draw(page, `${k}:`, MARGIN, y, 8.5, GRAY);
      draw(page, v, MARGIN + 70, y, 9);
      y -= 14;
    }

    const noteY = MARGIN + FOOTER_H + 6;
    draw(page, t('threadNote'), MARGIN, noteY + 12, 7, GRAY);
    draw(page, t('sourceNote'), MARGIN, noteY, 7, GRAY);
  };

  /* ---------------- 按清单渲染 ---------------- */

  plan.pages.forEach((spec, i) => {
    const pageIndex = i + 1;
    switch (spec.kind) {
      case 'overview':
        drawOverview(pageIndex);
        break;
      case 'color':
        drawColor(spec, pageIndex);
        break;
      case 'chart':
        drawChart(spec, pageIndex);
        break;
      case 'threads':
        drawThreads(pageIndex);
        break;
    }
  });

  return await doc.save();
}
