/**
 * SSE 流式客户端。
 *
 * 只认自家代理的两种帧：
 *   data: {"d":"增量文本"}
 *   data: [DONE]
 * 这样上游用哪家模型、什么格式，客户端都不用改。
 */

import type { ChatMessage } from './prompt.ts';

export class InsightError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'InsightError';
    this.status = status;
  }
}

export async function streamInsight(
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<string> {
  const res = await fetch('/api/insight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // 保留默认文案
    }
    throw new InsightError(message, res.status);
  }

  if (!res.body) throw new InsightError('响应没有内容', res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');

      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const frame = JSON.parse(data) as { d?: string; error?: string };
          if (frame.error) throw new Error(frame.error);
          if (frame.d) {
            full += frame.d;
            onDelta(frame.d);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('流中断')) throw err;
          // 单帧解析失败不影响整体
        }
      }
    }
  }

  return full;
}
