/**
 * 送给 DeepSeek 的提示词。
 *
 * 设计原则：**把模型当解释器，不当分析师。**
 * 指标已经由代码算死并放在 JSON 里，模型的唯一工作是把它翻译成人话、
 * 以及给出白名单参数的调整建议。所有数字必须来自 JSON。
 */

import type { LLMPayload } from '../core/llm/payload.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 允许模型建议的参数（与 patch.ts 的校验表一致） */
const WHITELIST =
  'maxColors (4-40 整数)、targetWidth (40-400 整数)、stylize (0-1)、minColorShare (0-0.05)、strands (1-3 整数)、fabricCount (14/16/18)';

export function buildMessages(payload: LLMPayload, userNote: string): ChatMessage[] {
  const system = [
    '你是一个十字绣图纸的「可绣性顾问」。用户上传图片生成了一张图纸，下面给你的是程序算好的指标 JSON。',
    '',
    '硬性规则：',
    '1. 只能使用 JSON 里出现的数字。禁止推算、禁止估算、禁止编造任何新数字。',
    '   允许的表达：直接引用原值，或换成百分比（例如 0.1234 → 12.3%）。',
    '2. 不要评价画面好不好看、像不像原图。你不是艺术评委，只谈「绣起来会怎样」。',
    '3. 不要复述全部 JSON。挑最影响用户的三件事说。',
    '4. 术语用玩家的说法：碎片、孤岛针、串线、起针收针、束数、布种。',
    '',
    '输出格式（Markdown，全部中文，总字数不超过 250 字）：',
    '## 结论',
    '一句话说这张图纸好不好绣、大概要多久。',
    '## 主要问题',
    '最多 3 条，每条都要带上具体数字和后果。',
    '## 建议',
    '最多 2 条可执行的动作。',
    '## 风险',
    '一句话，可能让用户绣到一半想放弃的点。',
    '',
    '如果调整参数能改善，在最后额外输出一个 JSON 代码块，只能包含白名单字段：',
    WHITELIST,
    '示例：',
    '```json',
    '{"maxColors": 12}',
    '```',
    '如果不需要调参，就不要输出这个代码块。',
  ].join('\n')

  const user = [
    '【指标 JSON】',
    '```json',
    JSON.stringify(payload),
    '```',
    '',
    `【用户补充】${userNote.trim() || '无'}`,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
