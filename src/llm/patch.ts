/**
 * 白名单参数补丁：把模型建议的「调参」限制在一个可校验、可夹紧的集合里。
 *
 * 这是「LLM 只读指标 + 白名单调参」架构的落地点：
 *   - 模型输出什么键都行，不在白名单里的一律丢弃；
 *   - 数值一律 clamp 到合法区间，不会因为模型说 maxColors=999 把管线跑崩；
 *   - 应用前还要用户点一下，模型不能自己改参数。
 */

import type { PipelineParams } from '../core/pipeline/run.ts';

type NumericKey = 'maxColors' | 'targetWidth' | 'stylize' | 'minColorShare' | 'strands';

const NUM_LIMITS: Record<NumericKey, [number, number]> = {
  maxColors: [4, 40],
  targetWidth: [40, 400],
  stylize: [0, 1],
  minColorShare: [0, 0.05],
  strands: [1, 3],
};

const INT_KEYS: NumericKey[] = ['maxColors', 'targetWidth', 'strands'];

export function sanitizePatch(raw: unknown): Partial<PipelineParams> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'fabricCount') {
      const n = Number(value);
      if (n === 14 || n === 16 || n === 18) out.fabricCount = n;
      continue;
    }
    if (!(key in NUM_LIMITS)) continue;
    const k = key as NumericKey;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const [lo, hi] = NUM_LIMITS[k];
    let v = Math.min(hi, Math.max(lo, n));
    if (INT_KEYS.includes(k)) v = Math.round(v);
    out[k] = v;
  }

  return out as Partial<PipelineParams>;
}

/** 从模型输出里抽出最后一个 ```json 代码块并清洗 */
export function extractPatch(text: string): Partial<PipelineParams> | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;

  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i][1].trim());
      const patch = sanitizePatch(parsed);
      if (Object.keys(patch).length > 0) return patch;
    } catch {
      // 这个块不是合法 JSON，继续找上一个
    }
  }
  return null;
}

/** 把补丁转成人能看的一行（用于 UI 展示） */
export function describePatch(patch: Partial<PipelineParams>): string {
  const parts: string[] = [];
  if (patch.maxColors !== undefined) parts.push(`色数 ${patch.maxColors}`);
  if (patch.targetWidth !== undefined) parts.push(`图纸宽 ${patch.targetWidth} 格`);
  if (patch.stylize !== undefined) parts.push(`平滑 ${Math.round(patch.stylize * 100)}%`);
  if (patch.minColorShare !== undefined) parts.push(`小色阈值 ${(patch.minColorShare * 100).toFixed(1)}%`);
  if (patch.strands !== undefined) parts.push(`${patch.strands} 股`);
  if (patch.fabricCount !== undefined) parts.push(`${patch.fabricCount} ct`);
  return parts.join(' · ');
}
