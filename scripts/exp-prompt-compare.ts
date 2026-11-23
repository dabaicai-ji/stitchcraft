/**
 * 提示词改版对比实验：同一张人像，旧提示词 vs 新提示词各真调一次。
 *
 *   node scripts/exp-prompt-compare.ts
 *
 * 成本：2 × 0.2 元（新号免费额度内）。
 *
 * 为什么分两条路径调：
 *   新提示词走 handleAiStyle + runCloudTask（和线上同一份产品代码），
 *   证明端到端链路本身正确；旧提示词只作为历史基线，直接打 ARK 接口。
 *   两者同模型、同尺寸、同输入图，对比才成立。
 *
 * 产物：
 *   .data/prompt-compare/old.jpg / new.jpg
 *   .data/prompt-compare/meta.json   （尺寸、耗时、prompt 全文）
 *
 * 之后用 python .data/to-raw-compare.py 转成管线能吃的 RGBA。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARK_URL,
  CLOUD_MODEL,
  handleAiStyle,
  runCloudTask,
  seedreamSize,
} from '../api/_lib/aiStyle.ts';
import type { AiStyleDeps } from '../api/_lib/aiStyle.ts';
import { MemoryTaskStore } from '../api/_lib/taskStore.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, '.data/prompt-compare');
mkdirSync(OUT, { recursive: true });

/** 2026-11-23 之前的提示词，作为「改前」基线 */
const OLD_PROMPT =
  '把这张照片改成扁平插画风，硬边大色块，保留主体轮廓与构图，去掉背景杂物和细碎纹理，颜色不超过 12 种，不要文字和边框';

/**
 * 2026-11-23 的「保人物」版，本实验的「改后」基线。
 *
 * ⚠️ 历史快照：产品里的提示词已经演进到 A/B 双档（PROMPT_A / PROMPT_B），
 * 这里刻意内联旧文本而不是 import，是为了让这个实验永远可复现它当时测的那两版。
 */
const V2_PROMPT =
  '保留人物完整形态/面部/姿态/服装，不要省略或替换人物，只简化背景和织物纹理，颜色不超过 12 种。';

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

const env = loadEnvLocal();
const apiKey = env.ARK_API_KEY;
if (!apiKey) {
  console.error('✗ .env.local 里没有 ARK_API_KEY');
  process.exit(1);
}

const srcPath = resolve(root, '.data/src-portrait.jpg');
const srcBuf = readFileSync(srcPath);
const dataUrl = `data:image/jpeg;base64,${srcBuf.toString('base64')}`;
// 源图是 512×512 的方图；尺寸规则与线上一致（短边 1024）
const size = seedreamSize(512, 512);
console.log(`输入：src-portrait.jpg ${(srcBuf.length / 1024).toFixed(0)}KB → 请求尺寸 ${size}`);
console.log(`新提示词：${V2_PROMPT}`);
console.log(`旧提示词：${OLD_PROMPT}\n`);

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

interface Result {
  tag: 'old' | 'new';
  prompt: string;
  file: string;
  bytes: number;
  ms: number;
}

const results: Result[] = [];

/* ---------- 旧提示词：直连基线 ---------- */
{
  console.log('── 旧提示词 ──');
  const t0 = Date.now();
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: CLOUD_MODEL,
      prompt: OLD_PROMPT,
      image: [dataUrl],
      size,
      response_format: 'url',
      watermark: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`  ✗ ARK ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const json = JSON.parse(text) as { data?: { url?: string; b64_json?: string }[] };
  const item = json.data?.[0];
  if (!item) {
    console.error(`  ✗ 返回无 data：${text.slice(0, 300)}`);
    process.exit(1);
  }
  const buf = item.url
    ? await download(item.url)
    : Buffer.from(item.b64_json ?? '', 'base64');
  const file = 'old.jpg';
  writeFileSync(resolve(OUT, file), buf);
  const ms = Date.now() - t0;
  console.log(`  ✓ ${file} · ${(buf.length / 1024).toFixed(0)}KB · ${(ms / 1000).toFixed(1)}s`);
  results.push({ tag: 'old', prompt: OLD_PROMPT, file, bytes: buf.length, ms });
}

/* ---------- 新提示词：走产品代码 ---------- */
{
  console.log('\n── 新提示词（产品代码路径）──');
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
      headers: { 'Content-Type': 'application/json', 'x-device-id': 'prompt-compare' },
      body: JSON.stringify({
        image: srcBuf.toString('base64'),
        key: 'b'.repeat(64),
        width: 512,
        height: 512,
      }),
    }),
    deps,
  );
  const submitted = (await submitRes.json()) as { taskId?: string; size?: string; error?: string };
  if (!submitted.taskId) {
    console.error(`  ✗ 提交失败 ${submitRes.status}：${JSON.stringify(submitted)}`);
    process.exit(1);
  }
  console.log(`  POST ${submitRes.status} · taskId ${submitted.taskId.slice(0, 8)}… · size ${submitted.size}`);

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
      console.error('  ✗ 轮询超时');
      process.exit(1);
    }
  }
  if (final.status !== 'done') {
    console.error(`  ✗ 任务失败：${String(final.error)}`);
    process.exit(1);
  }

  const base64 = String(final.image).replace(/^data:[^,]+,/, '');
  const buf = Buffer.from(base64, 'base64');
  const file = 'new.jpg';
  writeFileSync(resolve(OUT, file), buf);
  const ms = Number(final.elapsedMs ?? Date.now() - t0);
  console.log(
    `  ✓ ${file} · ${(buf.length / 1024).toFixed(0)}KB · ${(ms / 1000).toFixed(1)}s（上游 ${String(final.upstreamMs)}ms）`,
  );
  results.push({ tag: 'new', prompt: V2_PROMPT, file, bytes: buf.length, ms });
}

writeFileSync(
  resolve(OUT, 'meta.json'),
  JSON.stringify({ size, source: 'src-portrait.jpg', results }, null, 2),
  'utf8',
);

console.log(`\n产物：.data/prompt-compare/（old.jpg / new.jpg / meta.json）`);
console.log('下一步：python .data/to-raw-compare.py 然后 node scripts/exp-prompt-metrics.ts');
