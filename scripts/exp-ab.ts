/**
 * A/B 双档真调实验：同一张人像，A（极简 ≤8 色）与 B（标准 ≤16 色）各调一次。
 *
 *   node scripts/exp-ab.ts
 *
 * 成本：0.4 元（新号免费额度内）。
 *
 * 为什么走 handleAiStyle + runCloudTask 而不是直接打 ARK：
 *   这是**产品代码路径**——A/B 两套提示词、并行两路、候选结构、缓存键分离
 *   全在这一层。直连 ARK 只能证明上游能出图，证明不了我们的链路。
 *
 * 产物：
 *   .data/ab/a.jpg / b.jpg        两张候选原图
 *   .data/ab/meta.json            尺寸、耗时、字节数、提示词全文
 *
 * 之后用 python .data/to-raw-ab.py 转成管线能吃的 RGBA，再跑指标对比。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPT_A,
  PROMPT_B,
  SLOT_META,
  handleAiStyle,
  runCloudTask,
  seedreamSize,
} from '../api/_lib/aiStyle.ts';
import type { AiStyleDeps } from '../api/_lib/aiStyle.ts';
import { MemoryTaskStore } from '../api/_lib/taskStore.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, '.data/ab');
mkdirSync(OUT, { recursive: true });

function loadEnvLocal(): Record<string, string> {
  const p = resolve(root, '.env.local');
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const apiKey = loadEnvLocal().ARK_API_KEY;
if (!apiKey) {
  console.error('✗ .env.local 里没有 ARK_API_KEY');
  process.exit(1);
}

const srcPath = resolve(root, '.data/src-portrait.jpg');
const srcBuf = readFileSync(srcPath);
const base64 = srcBuf.toString('base64');
// 输入图指纹（前端 baseKey 的等价物）：服务端只按它派生 A/B 各自的缓存键
const baseKey = createHash('sha256').update(`cloud|input|${base64}`).digest('hex');
const size = seedreamSize(512, 512);

console.log(`输入：src-portrait.jpg ${(srcBuf.length / 1024).toFixed(0)}KB → 请求尺寸 ${size}`);
console.log(`A（${SLOT_META.a.hint}）：${PROMPT_A}`);
console.log(`B（${SLOT_META.b.hint}）：${PROMPT_B}\n`);

const store = new MemoryTaskStore();
const deps: AiStyleDeps = {
  apiKey,
  store,
  // 本地没有 background function：直接在进程内跑，语义与线上一致
  launch: (id) => runCloudTask(id, deps),
};

const t0 = performance.now();
const submitRes = await handleAiStyle(
  new Request('http://localhost/api/ai-style', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64, key: baseKey, width: 512, height: 512 }),
  }),
  deps,
);
const submitted = (await submitRes.json()) as { taskId?: string; error?: string };
if (!submitted.taskId) {
  console.error(`✗ 提交失败：${submitRes.status} ${submitted.error ?? ''}`);
  process.exit(1);
}
console.log(`提交 ${submitRes.status} · taskId=${submitted.taskId}`);

// 轮询到终态
let status: Record<string, unknown> = {};
for (;;) {
  const res = await handleAiStyle(
    new Request(`http://localhost/api/ai-style?taskId=${submitted.taskId}`, { method: 'GET' }),
    deps,
  );
  status = (await res.json()) as Record<string, unknown>;
  const st = String(status.status);
  if (st === 'done' || st === 'partial' || st === 'failed') break;
  if (performance.now() - t0 > 90_000) {
    console.error(`✗ 轮询超时（${st}）`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
  process.stdout.write('.');
}
const totalMs = performance.now() - t0;
console.log(`\n任务 ${String(status.status)} · 端到端 ${(totalMs / 1000).toFixed(1)}s`);

const candidates = (status.candidates ?? []) as {
  id: string;
  slot: 'a' | 'b';
  label: string;
  hint: string;
  ok: boolean;
  image?: string;
  bytes?: number;
  upstreamMs?: number;
  error?: string;
}[];

if (candidates.length === 0) {
  console.error(`✗ 没有候选返回：${String(status.error ?? '')}`);
  process.exit(1);
}

const meta: Record<string, unknown> = {
  input: 'src-portrait.jpg',
  size,
  totalMs: Math.round(totalMs),
  taskId: submitted.taskId,
  prompts: { a: PROMPT_A, b: PROMPT_B },
  candidates: [],
};

for (const c of candidates) {
  if (!c.ok || !c.image) {
    console.log(`  ${c.label} 失败：${c.error ?? ''}`);
    continue;
  }
  const b64 = c.image.replace(/^data:[^,]+,/, '');
  const buf = Buffer.from(b64, 'base64');
  const file = resolve(OUT, `${c.slot}.jpg`);
  writeFileSync(file, buf);
  console.log(
    `  ${c.label}（${c.hint}）${(c.upstreamMs ?? 0) / 1000}s · ${(buf.length / 1024).toFixed(0)}KB → ${c.slot}.jpg`,
  );
  (meta.candidates as unknown[]).push({
    slot: c.slot,
    label: c.label,
    hint: c.hint,
    file: `${c.slot}.jpg`,
    bytes: buf.length,
    upstreamMs: c.upstreamMs ?? 0,
  });
}

writeFileSync(resolve(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
console.log(`\n产物：.data/ab/（${(meta.candidates as unknown[]).length} 张）`);
console.log('下一步：python .data/to-raw-ab.py && node scripts/exp-ab-metrics.ts');
