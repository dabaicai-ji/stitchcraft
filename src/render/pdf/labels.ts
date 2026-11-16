/**
 * PDF 里用到的全部中文标签。
 *
 * 这个对象有两个用途：
 *   1) 页面绘制时取文案；
 *   2) 构建设置里把它的所有字符拿去子集化字体 —— 新增文案会自动进子集，
 *      不会出现「代码里加了个字，PDF 上变成豆腐块」。
 */

export const PDF_ZH = {
  title: '十字绣图纸',
  overview: '图纸总览',
  legend: '配色图例',
  pageMap: '页码索引',
  colorOverview: '彩色全景',
  colorChart: '彩色全图',
  colorNote: '彩色页仅供配色核对与位置对照，施工请按符号页',
  threadList: '线量清单',
  metrics: '可绣性报告',
  page: '第',
  of: '/',
  pages: '页',
  cols: '列',
  rows: '行',
  symbol: '符号',
  code: '色号',
  colorName: '颜色',
  stitches: '格数',
  skeins: '束数',
  total: '合计',
  fabric: '布种',
  strands: '股',
  size: '成品尺寸',
  gridSize: '图纸格数',
  colorCount: '用色',
  difficulty: '难度',
  confetti: '碎片率',
  isolated: '孤岛率',
  confusable: '混淆色对',
  generated: '生成于',
  blockNote: '粗线每 10 格一区块，行列号从 1 开始',
  threadNote: '线量为几何估算（含背面走线损耗），建议按此采购并留余量',
  sourceNote: '色卡数据：MakeBead craft-color-codes，CC BY 4.0，非 DMC 官方色值',
  noBackground: '留白',
  star: '星',
  starLabels: '入门轻松进阶硬核劝退',
} as const;

export type PdfLabelKey = keyof typeof PDF_ZH;

/**
 * 子集化字符集：中文标签去重 + 常用 ASCII。
 * 加粗等宽符号（A–Z a–z 0–9）必须全部包含，因为图纸格子里的符号来自这里。
 */
export const PDF_CHARSET = ((): string => {
  const zh = Object.values(PDF_ZH).join('');
  const ascii =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
    ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  // × 用于「120 × 68」，必须显式加入（不在 ASCII 区）
  const extra = '×';
  return [...new Set((zh + ascii + extra).split(''))].join('');
})();

/** 没有中文字体时的降级文案（纯 ASCII，用 Helvetica 也能画） */
export const PDF_EN: Record<PdfLabelKey, string> = {
  title: 'Cross Stitch Chart',
  overview: 'Overview',
  legend: 'Color Legend',
  pageMap: 'Page Map',
  colorOverview: 'Color Overview',
  colorChart: 'Color Chart',
  colorNote: 'Color pages are for palette checking and position reference; stitch from symbol pages',
  threadList: 'Thread List',
  metrics: 'Stitchability',
  page: 'Page',
  of: '/',
  pages: 'pages',
  cols: 'Cols',
  rows: 'Rows',
  symbol: 'Sym',
  code: 'DMC',
  colorName: 'Color',
  stitches: 'Stitches',
  skeins: 'Skeins',
  total: 'Total',
  fabric: 'Fabric',
  strands: 'strands',
  size: 'Size',
  gridSize: 'Grid',
  colorCount: 'Colors',
  difficulty: 'Difficulty',
  confetti: 'Confetti',
  isolated: 'Isolated',
  confusable: 'Confusable',
  generated: 'Generated',
  blockNote: 'Heavy lines every 10 cells; row/col numbers start at 1',
  threadNote: 'Estimate includes ~30% loss for carrying thread; buy with margin',
  sourceNote: 'Floss data: MakeBead craft-color-codes, CC BY 4.0, not official DMC values',
  noBackground: 'blank',
  star: 'stars',
  starLabels: 'Beginner Easy Advanced Hardcore Discouraging',
};
