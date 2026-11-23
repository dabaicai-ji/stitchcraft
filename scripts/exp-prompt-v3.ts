/**
 * 提示词 V3（三段式）真调实验：同一张人像，走产品代码路径调一次。
 *
 *   node scripts/exp-prompt-v3.ts
 *
 * 成本：0.2 元（新号免费额度内）。
 *
 * 为什么走 handleAiStyle + runCloudTask 而不是直接打 ARK：
 *   V1/V2 已经证明「提示词 → 出图」这条路通；V3 要验证的是**当前产品代码**
 *   在改完 CLOUD_PROMPT 之后仍然端到端正确（含尺寸、鉴权、回流解 base64）。
 *   直连 ARK 只能证明上游能出图，证明不了我们的链路。
 *
 * 产物：.data/prompt-compare/v3.jpg，并把本次结果追加进 meta.json。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOUD_PROMPT,
  handleAiStyle,
  runCloudTask,
  seedreamSize,
} from '../api/_lib/aiStyle.ts';
import type { AiStyleDeps } from '../api/_lib/aiStyle.ts';
import { MemoryTaskStore } from '../api/_lib/taskStore.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, '.data/prompt-compare');
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
const size = seedreamSize(512, 512);

console.log(`输入：src-portrait.jpg ${(srcBuf.length / 1024).toFixed(0)}KB → 请求尺寸 ${size}`);
console.log('提示词：');
for (const line of CLOUD_PROMPT.split('\n')) console.log(`  ${line}`);
console.log('');

const store = new MemoryTaskStore();
const deps: AiStyleDeps = {
  apiKey,
  store,
  launch: (id: string) => {
    void runCloudTask(id, deps);
  },
  mock: null,
};

const t0 = Date.now();
const submitRes = await handleAiStyle(
  new Request('http://localhost/api/ai-style', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-id': 'prompt-v3' },
    body: JSON.stringify({
      image: srcBuf.toString('base64'),
      // 64 位 hex：产品侧只做格式校验；V1/V2 已各自占过别的 key
      key: 'c'.repeat(64),
      width: 512,
      height: 512,
    }),
  }),
  deps,
);
const submitted = (await submitRes.json()) as {
  taskId?: string;
  size?: string;
  cost?: number;
  error?: string;
};
if (!submitted.taskId) {
  console.error(`✗ 提交失败 ${submitRes.status}：${JSON.stringify(submitted)}`);
  process.exit(1);
}
console.log(
  `POST ${submitRes.status} · taskId ${submitted.taskId.slice(0, 8)}… · size ${submitted.size} · ${submitted.cost} 元`,
);

let final: Record<string, unknown> = {};
for (;;) {
  await new Promise((r) => setTimeout(r, 1500));
  const res = await handleAiStyle(
    new Request(`http://localhost/api/ai-style?taskId=${submitted.taskId}`, { method: 'GET' }),
    deps,
  );
  final = (await res.json()) as Record<string, unknown>;
  if (final.status === 'done' || final.status === 'failed') break;
  if (Date.now() - t0 > 150_000) {
    console.error('✗ 轮询超时');
    process.exit(1);
  }
}
if (final.status !== 'done') {
  console.error(`✗ 任务失败：${String(final.error)}`);
  process.exit(1);
}

const base64 = String(final.image).replace(/^data:[^,]+,/, '');
const buf = Buffer.from(base64, 'base64');
writeFileSync(resolve(OUT, 'v3.jpg'), buf);

const ms = Number(final.elapsedMs ?? Date.now() - t0);
console.log(
  `✓ v3.jpg · ${(buf.length / 1024).toFixed(0)}KB · ${(ms / 1000).toFixed(1)}s（上游 ${String(final.upstreamMs)}ms）`,
);

/* ---- 追加进 meta.json（V1/V2 的记录保留） ---- */
const metaPath = resolve(OUT, 'meta.json');
const meta = existsSync(metaPath)
  ? (JSON.parse(readFileSync(metaPath, 'utf8')) as {
      size: string;
      source: string;
      results: { tag: string; prompt: string; file: string; bytes: number; ms: number }[];
    })
  : { size, source: 'src-portrait.jpg', results: [] };

meta.results = meta.results.filter((r) => r.tag !== 'v3');
meta.results.push({
  tag: 'v3',
  prompt: CLOUD_PROMPT,
  file: 'v3.jpg',
  bytes: buf.length,
  ms,
});
writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

console.log(`\n产物：.data/prompt-compare/v3.jpg + meta.json（${meta.results.length} 条记录）`);
console.log('下一步：python .data/to-raw-compare.py && node scripts/exp-prompt-metrics.ts');
