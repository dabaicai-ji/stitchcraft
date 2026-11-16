/**
 * 色系 / 角色分类 —— 让线量清单能直接拿去淘宝批量买线。
 *
 * 色系：在 OKLCH 里按色相分桶。用 OKLCH 而不是 HSL，是因为 HSL 的色相
 *       和感知不一致（黄绿区特别挤，蓝紫区分不开），分出来的组会反直觉。
 *
 * 角色：按该色在图纸里的占比分三档。这个比色系更实用 ——
 *       「主色只有 3 个但占 60% 格子」，买线时主色可以直接买整包。
 */

import { srgb8ToOklab } from '../color/oklab.ts';
import { parseHex } from '../color/cie.ts';

export type ColorFamily =
  | '白'
  | '灰'
  | '黑'
  | '棕'
  | '红'
  | '橙'
  | '黄'
  | '绿'
  | '青'
  | '蓝'
  | '紫'
  | '粉';

export type ColorRole = '主色' | '辅色' | '点缀';

/** 极浅无彩色 → 白 */
const NEAR_WHITE_L = 0.88;

export function classifyFamily(hex: string): ColorFamily {
  const [r, g, b] = parseHex(hex);
  const [L, a, bb] = srgb8ToOklab(r, g, b);
  const c = Math.hypot(a, bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;

  const warm = h >= 25 && h < 105; // 橙黄褐带
  const pinkish = h < 25 || h >= 315; // 红粉带

  // 1) 真正的无彩色
  if (c < 0.018) {
    if (L >= NEAR_WHITE_L) return '白';
    if (L <= 0.22) return '黑';
    return '灰';
  }

  // 2) 高明度低彩度暖色：米色 / 驼色 / 浅莲 —— 采购上归棕系
  //    浅冷色不在这里收口，让它继续走色相分桶（淡蓝算蓝、淡紫算紫）
  if (c < 0.062 && L >= 0.78) {
    if (warm) return '棕';
    if (pinkish) return '粉';
  }

  // 3) 暗橙黄 = 棕（Coffee Brown / Golden Olive 这类）
  if (L < 0.55 && warm) return '棕';

  // 4) 高明度红粉 = 粉（Dusty Rose 这类，色相上和红几乎重合）
  if (L >= 0.8 && pinkish) return '粉';

  // 5) 低彩度：暖色算棕、冷蓝绿保留冷色，其余算灰
  //    （淡罂粟蓝和米灰的 chroma 一样低，靠色相才分得开）
  if (c < 0.05) {
    if (warm) return '棕';
    if (h >= 165 && h < 300) return h < 215 ? '青' : '蓝';
    return '灰';
  }

  // 6) 有彩色按色相分桶
  if (h < 20 || h >= 340) return '红';
  if (h < 50) return '橙';
  if (h < 105) return '黄';
  if (h < 165) return '绿';
  if (h < 215) return '青';
  if (h < 275) return '蓝';
  if (h < 335) return '紫';
  return '粉';
}

/**
 * 角色：按占比分档。
 *   主色 ≥ 10%：一束肯定不够，通常要 2 束以上，可直接按盒买
 *   辅色 3%–10%
 *   点缀 < 3%：只买一束，剩下多半会浪费
 */
export function classifyRole(share: number): ColorRole {
  if (share >= 0.1) return '主色';
  if (share >= 0.03) return '辅色';
  return '点缀';
}

/** 采购分组名：色系 + 用途，方便按组下单 */
export function purchaseGroup(family: ColorFamily): string {
  switch (family) {
    case '白':
    case '灰':
    case '黑':
      return '中性色系';
    case '棕':
      return '大地色系';
    case '红':
    case '橙':
    case '粉':
      return '暖色系';
    case '黄':
      return '黄色系';
    case '绿':
    case '青':
      return '冷绿色系';
    case '蓝':
    case '紫':
      return '冷蓝色系';
  }
}

/** 稳定的色系排序，避免每次导出顺序跳动 */
export const FAMILY_ORDER: ColorFamily[] = [
  '白',
  '灰',
  '黑',
  '棕',
  '红',
  '橙',
  '黄',
  '绿',
  '青',
  '蓝',
  '紫',
  '粉',
];
