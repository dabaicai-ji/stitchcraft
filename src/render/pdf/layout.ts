/**
 * 分页计算。
 *
 * 十字绣图纸的分页有个硬约束：**页边界必须落在 10 格线上**，否则用户按页
 * 拼接时区块参考线会错位，整张图就对不齐了。所以每页格数要向下取整到 10 的倍数。
 *
 * 4.5mm 格 = 12.756pt：
 *   A4 可用宽 539.3pt → 42 格 → 取 40
 *   A4 可用高 737.9pt → 57 格 → 取 50
 *
 * 彩色全景有两档策略：
 *   - 整图缩到一页后格边长 ≥ 1.2mm → 单页全景（120×79 约 1.58mm，够看）
 *   - 低于 1.2mm（超大图）→ 按 40×50 分页铺彩色，不再缩成一片糊
 *
 * ⚠️ 页面是**先排清单再渲染**的。以前是渲染时 `pageIndex++` 递增，
 *    插入彩色页会让后面所有页码和索引矩阵错位 —— 清单模式从根上避免这个问题。
 */

export const PAGE = { width: 595.276, height: 841.89 } as const;
export const MARGIN = 28;
/** 正文单元格：4.5mm */
export const CELL = (4.5 * 72) / 25.4;
/** 整图缩到一页时允许的最小格边长：低于此值色块会糊成色带，改为分页 */
export const MIN_COLOR_CELL = (1.2 * 72) / 25.4;
/**
 * 单页彩色全景的格边长上限。
 *
 * 注意不能沿用正文的 4.5mm：小图纸（比如 24×16）如果只画 4.5mm 格，
 * 会缩在页面左上角一小块，而且永远够不到「格 ≥ 6mm 才印色号」的门槛 ——
 * 那个功能就成了死代码。允许放大到 12mm，小图纸才能铺满、色号才有意义。
 */
export const MAX_COLOR_CELL = (12 * 72) / 25.4;
/** 彩色格内印 DMC 色号的最小格边长：4.5mm 格里塞 4 位色号需要 <3.5pt，不可读 */
export const MIN_CODE_CELL = (6 * 72) / 25.4;
export const HEADER_H = 30;
export const FOOTER_H = 18;

export const USABLE_W = PAGE.width - MARGIN * 2;
export const USABLE_H = PAGE.height - MARGIN * 2 - HEADER_H - FOOTER_H;

export type PageKind = 'overview' | 'color' | 'chart' | 'threads';

export interface PageSpec {
  kind: PageKind;
  /** 该页左上角对应的格坐标 */
  colStart: number;
  rowStart: number;
  cols: number;
  rows: number;
  /** 格边长（pt） */
  cell: number;
}

export interface PagePlan {
  colsPerPage: number;
  rowsPerPage: number;
  pagesX: number;
  pagesY: number;
  /** 符号正文页数 */
  chartPages: number;
  /** 彩色页是否单页全景 */
  colorSingle: boolean;
  /** 彩色页格边长（pt） */
  colorCell: number;
  colorPages: number;
  totalPages: number;
  /** 完整页面清单，渲染按这个走 */
  pages: PageSpec[];
}

export function planPages(width: number, height: number): PagePlan {
  const colsPerPage = Math.max(10, Math.floor(USABLE_W / CELL / 10) * 10);
  const rowsPerPage = Math.max(10, Math.floor(USABLE_H / CELL / 10) * 10);

  const pagesX = Math.max(1, Math.ceil(width / colsPerPage));
  const pagesY = Math.max(1, Math.ceil(height / rowsPerPage));
  const chartPages = pagesX * pagesY;

  // 单页全景能缩到多大
  const singleCell = Math.min(MAX_COLOR_CELL, USABLE_W / width, USABLE_H / height);
  const colorSingle = singleCell >= MIN_COLOR_CELL;
  const colorCell = colorSingle ? singleCell : CELL;

  const pages: PageSpec[] = [{ kind: 'overview', colStart: 0, rowStart: 0, cols: width, rows: height, cell: CELL }];

  if (colorSingle) {
    pages.push({ kind: 'color', colStart: 0, rowStart: 0, cols: width, rows: height, cell: singleCell });
  } else {
    for (let py = 0; py < pagesY; py++) {
      for (let px = 0; px < pagesX; px++) {
        const colStart = px * colsPerPage;
        const rowStart = py * rowsPerPage;
        pages.push({
          kind: 'color',
          colStart,
          rowStart,
          cols: Math.min(width, colStart + colsPerPage) - colStart,
          rows: Math.min(height, rowStart + rowsPerPage) - rowStart,
          cell: CELL,
        });
      }
    }
  }

  for (let py = 0; py < pagesY; py++) {
    for (let px = 0; px < pagesX; px++) {
      const colStart = px * colsPerPage;
      const rowStart = py * rowsPerPage;
      pages.push({
        kind: 'chart',
        colStart,
        rowStart,
        cols: Math.min(width, colStart + colsPerPage) - colStart,
        rows: Math.min(height, rowStart + rowsPerPage) - rowStart,
        cell: CELL,
      });
    }
  }

  pages.push({ kind: 'threads', colStart: 0, rowStart: 0, cols: width, rows: height, cell: CELL });

  const colorPages = colorSingle ? 1 : chartPages;

  return {
    colsPerPage,
    rowsPerPage,
    pagesX,
    pagesY,
    chartPages,
    colorSingle,
    colorCell,
    colorPages,
    totalPages: pages.length,
    pages,
  };
}
