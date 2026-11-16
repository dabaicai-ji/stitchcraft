/**
 * 线量清单 CSV 导出。
 *
 * 面向「拿着去淘宝批量买线」的场景，所以除了基础数量还给了两个分组维度：
 *   - 色系 / 采购分组：同色系一起下单，减少店铺和运费
 *   - 角色：主色 ≥10%、辅色 3–10%、点缀 <3%，决定「整包买」还是「买一束」
 *
 * 格式细节：
 *   - 表头 + 每色一行 + 合计行在最上面，Excel 可直接排序筛选；
 *   - 备注和分组小结放在最后，用 `#` 前缀，不混进数据区；
 *   - UTF-8 BOM：不加的话中文在 Windows Excel 里会变乱码（最常见的导出翻车点）；
 *   - CRLF 换行，Excel 的默认预期。
 */

import type { StitchabilityReport } from '../core/types.ts';
import {
  FAMILY_ORDER,
  classifyFamily,
  classifyRole,
  purchaseGroup,
} from '../core/palette/classify.ts';
import type { ColorFamily } from '../core/palette/classify.ts';

/** RFC 4180 转义：含逗号/引号/换行的字段用双引号包裹，内部引号翻倍 */
function esc(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface FamilyAgg {
  colors: number;
  stitches: number;
  skeins: number;
  cost: number;
}

export function buildThreadCsv(report: StitchabilityReport): string {
  const { supply, scale } = report;
  const totalStitches = supply.totalStitches || 1;

  const rows: (string | number)[][] = [
    [
      '符号',
      '色号',
      '颜色名',
      '色系',
      '采购分组',
      '角色',
      'HEX',
      '格数',
      '占比%',
      '束数',
      '预计成本',
    ],
  ];

  const agg = new Map<ColorFamily, FamilyAgg>();

  for (const u of supply.perColor) {
    const share = u.stitchCount / totalStitches;
    const family = classifyFamily(u.hex);
    const role = classifyRole(share);

    rows.push([
      u.symbol,
      u.dmcCode,
      u.name,
      family,
      purchaseGroup(family),
      role,
      u.hex,
      u.stitchCount,
      (share * 100).toFixed(1),
      u.skeins,
      u.cost,
    ]);

    const a = agg.get(family) ?? { colors: 0, stitches: 0, skeins: 0, cost: 0 };
    a.colors++;
    a.stitches += u.stitchCount;
    a.skeins += u.skeins;
    a.cost += u.cost;
    agg.set(family, a);
  }

  rows.push([
    '合计',
    '',
    '',
    '',
    '',
    '',
    '',
    supply.totalStitches,
    '100.0',
    supply.totalSkeins,
    supply.totalCost,
  ]);

  /* ---- 分组小结：按色系批量采购用 ---- */
  const summary: (string | number)[][] = [
    [''],
    ['# 采购分组小结'],
    ['# 色系', '色数', '格数', '束数', '成本'],
  ];
  for (const family of FAMILY_ORDER) {
    const a = agg.get(family);
    if (!a) continue;
    summary.push([`# ${family}`, a.colors, a.stitches, a.skeins, a.cost]);
  }

  const notes: (string | number)[][] = [
    [''],
    ['# 图纸', `${scale.width} x ${scale.height} 格`],
    ['# 布种', `${supply.fabricCount} ct / ${supply.strands} 股`],
    ['# 成品尺寸', `${scale.widthCm.toFixed(1)} x ${scale.heightCm.toFixed(1)} cm`],
    ['# 每格耗线', `${supply.perStitchMm.toFixed(2)} mm（含背面走线损耗）`],
    ['# 一束可绣', `${supply.perColor[0]?.stitchesPerSkein ?? 0} 格`],
    ['# 角色定义', '主色 ≥10% · 辅色 3–10% · 点缀 <3%'],
    ['# 色系说明', '按 OKLCH 色相自动分组，棕/黄、粉/红交界为近似判断'],
    ['# 说明', '线量为几何估算，建议按此采购并留余量'],
    [
      '# 色卡',
      'MakeBead craft-color-codes (CC BY 4.0)，社区近似 sRGB，非 DMC 官方色值',
    ],
  ];

  const lines: string[] = [];
  for (const row of [...rows, ...summary, ...notes]) {
    lines.push(row.map(esc).join(','));
  }

  // BOM + CRLF：Excel 兼容性组合
  return `\uFEFF${lines.join('\r\n')}`;
}

/** 触发浏览器下载 */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
