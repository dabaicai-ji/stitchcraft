/**
 * 风格模式与「平滑降噪」的联动规则。
 *
 * 为什么需要这个：AI 插画已经做过结构简化（硬边、大色块、去纹理），
 * 再叠 0.4 的保边平滑会把五官、衣褶一起抹平——实测在 120 格上特别明显。
 * 所以 AI 插画模式默认只用 0.2，原始/像素模式沿用原来的 0.4。
 *
 * 两条边界：
 *   1) 用户手动拖过滑块，就永远不再自动改（touched=true）。
 *   2) 切回原始/像素时恢复默认，不让 0.2 残留到其他模式。
 *
 * 纯函数、零依赖，Node 可直接单测（见 scripts/itest-pixel.ts）。
 */

import type { AiStyle } from './types.ts';
import { DEFAULT_PARAMS } from '../core/pipeline/run.ts';

/** AI 插画模式下的平滑强度：AI 已简化结构，再高就糊掉五官与衣褶 */
export const AI_IMAGE_STYLIZE = 0.2;

/**
 * 切换风格模式时该用的平滑值。
 *
 * @param mode     目标风格
 * @param touched  用户是否手动调过平滑滑块
 * @param current  当前平滑值（touched 时原样返回）
 */
export function stylizeForMode(mode: AiStyle, touched: boolean, current: number): number {
  if (touched) return current;
  return mode === 'cloud' ? AI_IMAGE_STYLIZE : DEFAULT_PARAMS.stylize;
}
