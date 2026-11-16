/**
 * DeepSeek 代理核心 —— 用 Web 标准 Request / Response 编写，一份代码跑三处：
 *
 *   本地 dev / preview : vite.config.ts 里的 Node 适配层
 *   Vercel             : api/insight.ts（Edge Runtime）
 *   Netlify            : netlify/edge-functions/insight.ts
 *
 * 为什么不用 Node 的 req/res 直接写：那样就只能跑在 Node 上，
 * 静态托管平台的 Edge Runtime（V8 isolate / Deno）里没有这些对象。
 *
 * 代理职责：
 *   1) 校验请求体（形状 / 长度），挡住被滥用的超大 prompt；
 *   2) 用自己的 Key 转发，锁定 model / max_tokens / temperature；
 *   3) 把上游 SSE 归一化成 `data: {"d":"..."}` + `data: [DONE]`，
 *      前端不必知道上游长什么样，换模型也不用改客户端。
 */

const MAX_BODY = 64 * 1024;
const MAX_TOKENS = 700;
const UPSTREAM = 'https://api.deepseek.com/chat/completions';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('messages 必须是非空数组');
  if (raw.length > 8) throw new Error('消息条数过多');

  return raw.map((m) => {
    const msg = m as Partial<ChatMessage>;
    if (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant') {
      throw new Error('非法 role');
    }
    if (typeof msg.content !== 'string' || msg.content.length === 0) {
      throw new Error('content 必须是非空字符串');
    }
    if (msg.content.length > 8000) throw new Error('单条消息过长');
    return { role: msg.role, content: msg.content };
  });
}

/** 把 OpenAI 风格的 SSE 转成我们的极简帧格式 */
function transformUpstream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      let buffer = '';
      let sentAny = false;

      const emit = (payload: string): void => {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      };

      try {
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
              if (!data) continue;
              if (data === '[DONE]') {
                emit('[DONE]');
                sentAny = true;
                continue;
              }
              try {
                const parsed = JSON.parse(data) as {
                  choices?: { delta?: { content?: string } }[];
                };
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  emit(JSON.stringify({ d: delta }));
                  sentAny = true;
                }
              } catch {
                // 上游偶发的非 JSON 行，忽略
              }
            }
          }
        }
        if (!sentAny) emit(JSON.stringify({ d: '' }));
        emit('[DONE]');
      } catch (err) {
        emit(
          JSON.stringify({
            error: `流中断：${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        emit('[DONE]');
      } finally {
        controller.close();
      }
    },
  });
}

export async function handleInsight(
  request: Request,
  apiKey: string | undefined,
): Promise<Response> {
  // 健康检查：前端据此显示「Key 已就绪 / 未配置」，不消耗 token
  if (request.method === 'GET') {
    return jsonResponse(200, { configured: Boolean(apiKey) });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: '只支持 GET（健康检查）/ POST（生成解读）' });
  }
  if (!apiKey) {
    return jsonResponse(503, {
      error:
        'DEEPSEEK_API_KEY 未配置。本地请在 stitchcraft/.env.local 写入；部署请在平台的环境变量里设置。',
    });
  }

  let messages: ChatMessage[];
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('请求体过大');
    const parsed = JSON.parse(text) as { messages?: unknown };
    messages = parseMessages(parsed.messages);
  } catch (err) {
    return jsonResponse(400, {
      error: err instanceof Error ? err.message : '请求体解析失败',
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    });
  } catch (err) {
    return jsonResponse(502, {
      error: `无法连接 DeepSeek：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return jsonResponse(upstream.status || 502, {
      error: `DeepSeek 返回 ${upstream.status}`,
      detail: detail.slice(0, 400),
    });
  }

  return new Response(transformUpstream(upstream.body), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
