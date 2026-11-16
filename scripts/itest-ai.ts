/**
 * AI 解读端到端测试（会真实消耗 token，约一次 1.5k）。
 *
 *   node scripts/itest-ai.ts [port]
 *
 * 需要 dev server 已启动且 .env.local 配了 DEEPSEEK_API_KEY。
 * 验证：代理连通 → 流式输出 → 数字防幻觉校验 → 参数补丁解析。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, runPipeline } from '../src/core/pipeline/run.ts';
import {
  auditNarrative,
  buildLLMPayload,
  collectAllowedNumbers,
} from '../src/core/llm/payload.ts';
import { buildMessages } from '../src/llm/prompt.ts';
import { extractPatch } from '../src/llm/patch.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.argv[2] ?? '5183';
const base = `http://localhost:${port}/api/insight`;

const meta = (
  JSON.parse(readFileSync(resolve(root, '.data/images.json'), 'utf8')) as {
    tag: string;
    width: number;
    height: number;
  }[]
).find((m) => m.tag === 'photo')!;

const buf = readFileSync(resolve(root, `.data/${meta.tag}.raw`));
const rgba = new Uint8ClampedArray(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
);
const out = runPipeline({
  rgba,
  srcWidth: meta.width,
  srcHeight: meta.height,
  params: { ...DEFAULT_PARAMS, targetWidth: 120, maxColors: 16 },
  now: '2026-11-16T00:00:00.000Z',
});

const payload = buildLLMPayload(out.report);
const messages = buildMessages(payload, '');
console.log(`payload ${JSON.stringify(payload).length} 字节 · ${payload.issueCount ?? ''}`);

/* ---------- 健康检查 ---------- */
const health = await fetch(base, { method: 'GET' });
const healthBody = (await health.json()) as { configured?: boolean };
console.log(`健康检查: ${health.status} configured=${healthBody.configured}`);
if (!healthBody.configured) {
  console.error('✗ 代理没有读到 Key，检查 .env.local 后重启 dev server');
  process.exit(1);
}

/* ---------- 流式生成 ---------- */
const t0 = performance.now();
const res = await fetch(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages }),
});
console.log(`POST ${res.status} · ${res.headers.get('content-type')}`);

if (!res.ok) {
  console.error('✗ 请求失败:', await res.text());
  process.exit(1);
}

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
let full = '';
let frames = 0;

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
      const frame = JSON.parse(data) as { d?: string };
      if (frame.d) {
        full += frame.d;
        frames++;
      }
    }
  }
}

const ms = performance.now() - t0;
console.log(`\n${frames} 帧 · ${full.length} 字 · ${ms.toFixed(0)}ms`);
console.log('--- 模型输出 ---');
console.log(full);
console.log('--- 输出结束 ---\n');

/* ---------- 校验 ---------- */
const allowed = collectAllowedNumbers(payload);
const audit = auditNarrative(full, allowed);
console.log(
  audit.ok
    ? `✓ 数字校验通过（${audit.checked} 个数字全部有出处）`
    : `⚠ ${audit.unknown.length}/${audit.checked} 个数字无出处：${audit.unknown.slice(0, 8).join(', ')}`,
);

const patch = extractPatch(full);
console.log(patch ? `✓ 解析到参数补丁: ${JSON.stringify(patch)}` : '· 未给出参数补丁');

const checks: [string, boolean][] = [
  ['拿到流式输出', full.length > 50],
  ['包含结论段落', full.includes('结论') || full.length > 100],
  ['未输出代码块乱码', !full.includes('```json\n{') || patch !== null],
];
let failures = 0;
for (const [name, ok] of checks) {
  if (!ok) {
    failures++;
    console.log(`✗ ${name}`);
  }
}
console.log(failures === 0 ? '\n✓ AI 链路端到端通过' : `\n✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
