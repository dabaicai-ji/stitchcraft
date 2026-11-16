/**
 * 生成内置 DMC 色卡 TS 文件。
 *
 *   node scripts/build-dmc.ts
 *
 * 输入：.data/dmc-floss.json（CC BY 4.0，MakeBead craft-color-codes）
 * 输出：src/core/data/dmc-colors.ts
 *
 * 为什么用生成脚本而不是手抄：
 *   - 489 条数据手写必错；
 *   - 上游更新后重跑一次即可，diff 可审计；
 *   - 许可与来源声明跟着数据一起进代码，不会被后人删掉。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

interface UpstreamColor {
  code: string;
  name: string;
  hex: string;
  rgb?: [number, number, number];
}

interface UpstreamFile {
  id: string;
  brand: string;
  product: string;
  count: number;
  status?: string;
  license?: string;
  notes?: string;
  sources?: { name: string; url: string }[];
  colors: UpstreamColor[];
}

const raw = JSON.parse(
  readFileSync(resolve(root, '.data/dmc-floss.json'), 'utf8'),
) as UpstreamFile;

if (!Array.isArray(raw.colors) || raw.colors.length < 400) {
  throw new Error(`色卡数据异常：colors=${raw.colors?.length}`);
}

/** DMC 编码排序：纯数字按数值，字母前缀（B5200/Blanc/Ecru/White）排最后 */
function sortKey(code: string): string {
  const num = /^\d+$/.test(code);
  return num ? `0${code.padStart(6, '0')}` : `1${code}`;
}

const colors = [...raw.colors]
  .sort((a, b) => sortKey(a.code).localeCompare(sortKey(b.code)))
  .map((c) => {
    const hex = c.hex.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) {
      throw new Error(`非法 hex: ${c.code} ${c.hex}`);
    }
    return { code: c.code, name: c.name.trim(), hex };
  });

// 重复编码检查
const seen = new Set<string>();
for (const c of colors) {
  if (seen.has(c.code)) throw new Error(`重复编码: ${c.code}`);
  seen.add(c.code);
}

const body = colors
  .map((c) => `  { code: ${JSON.stringify(c.code)}, name: ${JSON.stringify(c.name)}, hex: '${c.hex}' },`)
  .join('\n');

const out = `/**
 * DMC 棉线色卡 —— 自动生成，请勿手改。
 *
 * 重新生成： node scripts/build-dmc.ts
 *
 * 来源   ：https://github.com/makebead/craft-color-codes
 *          （data/json/dmc-floss.json，CC BY 4.0）
 * 署名   ：MakeBead · https://makebead.com/dmc-color-chart/
 * 许可   ：CC BY 4.0 —— 可商用，但必须在产品中保留署名
 * 校验   ：上游标注 cross-checked；修正了被 Excel 损坏的 hex 串，
 *          并纠正了 DMC 309 在多个上游数据中沿袭的错值（灰褐 → #C12041）
 *
 * ⚠️ 这是社区整理的近似 sRGB 色值，不是 DMC 官方数据。
 *    不同光线 / 屏幕 / 染批会有可见偏差，用于图纸配色足够，
 *    但不要在产品文案里把它说成「官方色值」。
 *
 * 颜色数：${colors.length}
 */

export interface RawDmcColor {
  code: string;
  name: string;
  hex: string;
}

export const DMC_META = {
  count: ${colors.length},
  source: 'https://github.com/makebead/craft-color-codes',
  attribution: 'MakeBead (https://makebead.com/dmc-color-chart/)',
  license: 'CC BY 4.0',
  status: 'cross-checked',
  claim: 'community-approximated sRGB, not official DMC values',
} as const;

export const DMC_RAW: RawDmcColor[] = [
${body}
];
`;

const outDir = resolve(root, 'src/core/data');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'dmc-colors.ts'), out, 'utf8');

console.log(`写入 src/core/data/dmc-colors.ts —— ${colors.length} 色`);
console.log(`许可: ${raw.license ?? 'CC-BY-4.0'} | 状态: ${raw.status ?? 'unknown'}`);
