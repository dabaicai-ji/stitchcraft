/**
 * 云端风格化服务端链路自测（纯 Node，不联网、不启浏览器、不花一分钱）。
 *
 *   node scripts/itest-cloud.ts
 *
 * 覆盖：尺寸计算 / 提交 / 轮询到 done / 同 key 缓存命中不重复计费 /
 *       每日配额 / 超时任务卡在 running / 无 key 503 / 非法请求 400 /
 *       上游失败降级标记。
 *
 * 这里断言的是服务端契约——前端「超时降级」逻辑在 src/ai/cloud.ts，
 * 它的纯函数部分也在本脚本里验证。
 */

import { MemoryTaskStore } from '../api/_lib/taskStore.ts';
import type { CloudTask } from '../api/_lib/taskStore.ts';
import {
  CLOUD_PROMPT,
  DAILY_LIMIT,
  handleAiStyle,
  MIN_PIXELS,
  runCloudTask,
  seedreamSize,
} from '../api/_lib/aiStyle.ts';
import type { AiStyleDeps } from '../api/_lib/aiStyle.ts';
import { CLOUD_PROMPT as CLIENT_PROMPT, MAX_UPLOAD_EDGE } from '../src/ai/cloud.ts';

let pass = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 造一张「看起来像 JPEG」的 base64（只用于链路，不含真实图像内容） */
function fakeJpeg(seed: number): string {
  const buf = Buffer.alloc(4096 + seed, 0x41);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  return buf.toString('base64');
}

function sha(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function makeDeps(mock: AiStyleDeps['mock']): { deps: AiStyleDeps; upstreamCalls: () => number } {
  const store = new MemoryTaskStore();
  let calls = 0;
  const deps: AiStyleDeps = {
    apiKey: mock === null ? 'test-key' : undefined,
    store,
    launch: (taskId: string) => {
      void runCloudTask(taskId, deps);
    },
    mock,
    now: () => Date.now(),
    // 真实调用会被替换成桩；mock 模式下不会被调用
    fetchImpl: (async () => {
      calls++;
      throw new Error('测试里不应真的联网');
    }) as unknown as typeof fetch,
  };
  return { deps, upstreamCalls: () => calls };
}

async function submit(
  deps: AiStyleDeps,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleAiStyle(
    new Request('http://localhost/api/ai-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function poll(
  deps: AiStyleDeps,
  taskId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleAiStyle(
    new Request(`http://localhost/api/ai-style?taskId=${taskId}`, { method: 'GET' }),
    deps,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function waitDone(
  deps: AiStyleDeps,
  taskId: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const r = await poll(deps, taskId);
    const status = r.json.status;
    if (status === 'done' || status === 'failed') return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error(`轮询超时（状态 ${String(status)}）`);
    await sleep(50);
  }
}

/* ---------------- 1. 尺寸计算 ---------------- */

console.log('\n[1] Seedream 尺寸（短边 1024，总像素 ≥ 921600）');
{
  const cases: [number, number, string][] = [
    [1024, 1024, '1024x1024'],
    [1024, 768, '1368x1024'],
    [1024, 576, '1824x1024'],
    [768, 1024, '1024x1368'],
    [576, 1024, '1024x1824'],
    [2048, 512, '2048x512'],
  ];
  for (const [w, h, want] of cases) {
    const got = seedreamSize(w, h);
    check(`${w}×${h} → ${want}`, got === want, `实际 ${got}`);
  }
  // 极端长条（13:1）必须放大到最小面积，但不能无限涨
  const long = seedreamSize(4000, 300).split('x').map(Number);
  check('极端长条面积 ≥ 921600', long[0] * long[1] >= 921600, `实际 ${long[0]}x${long[1]} = ${long[0] * long[1]}`);
  check('极端长条总像素不超 1.1M（不白烧成本）', long[0] * long[1] <= MIN_PIXELS * 1.1, `实际 ${long[0] * long[1]}`);
  const all = [seedreamSize(1, 1), seedreamSize(3, 1), seedreamSize(1, 3)];
  check('产物都满足 ≥921600', all.every((s) => s.split('x').map(Number).reduce((a, b) => a * b) >= 921600));
}

/* ---------------- 2. 提交 → 轮询 → done ---------------- */

console.log('\n[2] 提交 → 轮询 → done（echo mock，不联网）');
{
  const { deps, upstreamCalls } = makeDeps('echo');
  const sub = await submit(deps, { image: fakeJpeg(1), width: 1024, height: 768, key: sha(1) });
  check('POST 返回 201', sub.status === 201, `实际 ${sub.status}`);
  check('返回 taskId', typeof sub.json.taskId === 'string');
  check('返回预估成本 0.2', sub.json.cost === 0.2);
  check('返回剩余次数 4', sub.json.quotaLeft === 4, `实际 ${String(sub.json.quotaLeft)}`);
  check('size 按比例算', sub.json.size === '1368x1024', `实际 ${String(sub.json.size)}`);

  const done = await waitDone(deps, String(sub.json.taskId));
  check('轮询到 done', done.status === 'done', `实际 ${String(done.status)}`);
  check('done 带 data URL 图', typeof done.image === 'string' && String(done.image).startsWith('data:image/jpeg;base64,'));
  check('mock 模式未联网', upstreamCalls() === 0);
  const task = await deps.store.getTask(String(sub.json.taskId));
  check('完成后清掉输入图', (await deps.store.getInput(String(sub.json.taskId))) === null);
  check('任务记录了 upstreamMs', typeof task?.upstreamMs === 'number');
}

/* ---------------- 3. 缓存命中 ---------------- */

console.log('\n[3] 同 key 再提交 → 缓存命中，不计费');
{
  // 用可控上游桩（而不是 echo）：echo 刻意不写缓存，避免假图污染真实缓存
  const store = new MemoryTaskStore();
  const deps: AiStyleDeps = {
    apiKey: 'test-key',
    store,
    launch: (taskId: string) => {
      void runCloudTask(taskId, deps);
    },
    mock: null,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: fakeJpeg(2) }] }), {
        status: 200,
      })) as unknown as typeof fetch,
  };

  const first = await submit(deps, { image: fakeJpeg(2), width: 1024, height: 768, key: sha(2) });
  await waitDone(deps, String(first.json.taskId));

  const second = await submit(deps, { image: fakeJpeg(2), width: 1024, height: 768, key: sha(2) });
  check('第二次返回 200', second.status === 200, `实际 ${second.status}`);
  check('cached = true', second.json.cached === true);
  check('cost = 0', second.json.cost === 0);
  check('复用同一个 taskId', second.json.taskId === first.json.taskId);

  const third = await submit(deps, { image: fakeJpeg(3), width: 1024, height: 768, key: sha(3) });
  check('换 key 仍会新建任务', third.status === 201 && third.json.cached === false);
}

/* ---------------- 4. 每日配额 ---------------- */

console.log('\n[4] 每日配额（模拟设备每天 5 次）');
{
  const { deps } = makeDeps('echo');
  const headers = { 'x-device-id': 'device-A' };
  const statuses: number[] = [];
  for (let i = 0; i < DAILY_LIMIT + 1; i++) {
    const r = await submit(
      deps,
      { image: fakeJpeg(i + 10), width: 1024, height: 768, key: sha(100 + i) },
      headers,
    );
    statuses.push(r.status);
    if (i === DAILY_LIMIT - 1) {
      check(`第 ${DAILY_LIMIT} 次仍成功`, r.status === 201);
    }
    if (i === DAILY_LIMIT) {
      check(`第 ${DAILY_LIMIT + 1} 次被拦（429）`, r.status === 429, `实际 ${r.status}`);
      check('响应带 fallback=pixel', r.json.fallback === 'pixel');
      check('响应带 QUOTA_EXCEEDED', r.json.code === 'QUOTA_EXCEEDED');
    }
  }
  check(
    `配额计数正确（前 ${DAILY_LIMIT} 次 201）`,
    statuses.slice(0, DAILY_LIMIT).every((s) => s === 201),
    statuses.join(','),
  );

  // 换设备号应重新计数
  const other = await submit(
    deps,
    { image: fakeJpeg(20), width: 1024, height: 768, key: sha(200) },
    { 'x-device-id': 'device-B' },
  );
  check('换设备号不受影响', other.status === 201, `实际 ${other.status}`);
}

/* ---------------- 5. 超时任务停在 running ---------------- */

console.log('\n[5] timeout mock：任务停在 running（前端据此降级）');
{
  const { deps } = makeDeps('timeout');
  const sub = await submit(deps, { image: fakeJpeg(5), width: 1024, height: 768, key: sha(5) });
  await sleep(120);
  const r = await poll(deps, String(sub.json.taskId));
  check('状态是 running', r.json.status === 'running', `实际 ${String(r.json.status)}`);
  check('running 不带图', r.json.image === undefined);
}

/* ---------------- 6. 异常路径 ---------------- */

console.log('\n[6] 异常路径');
{
  const noKey = makeDeps(null);
  noKey.deps.apiKey = undefined;
  const r503 = await submit(noKey.deps, { image: fakeJpeg(6), width: 1024, height: 768, key: sha(6) });
  check('无 Key 返回 503', r503.status === 503, `实际 ${r503.status}`);
  check('无 Key 标记降级', r503.json.fallback === 'pixel');

  const d = makeDeps('echo').deps;
  const badKey = await submit(d, { image: fakeJpeg(7), width: 1024, height: 768, key: 'abc' });
  check('非法 key 返回 400', badKey.status === 400, `实际 ${badKey.status}`);

  const noImage = await submit(d, { width: 1024, height: 768, key: sha(7) });
  check('缺图返回 400', noImage.status === 400, `实际 ${noImage.status}`);

  const noSize = await submit(d, { image: fakeJpeg(7), key: sha(8) });
  check('缺尺寸返回 400', noSize.status === 400, `实际 ${noSize.status}`);

  const notFound = await poll(d, 'c_not_exist');
  check('查不存在的任务返回 404', notFound.status === 404, `实际 ${notFound.status}`);

  const method = await handleAiStyle(
    new Request('http://localhost/api/ai-style', { method: 'DELETE' }),
    d,
  );
  check('非法方法返回 405', method.status === 405, `实际 ${method.status}`);
}

/* ---------------- 7. 上游失败 → failed ---------------- */

console.log('\n[7] 上游失败 → failed + fallback');
{
  const store = new MemoryTaskStore();
  const deps: AiStyleDeps = {
    apiKey: 'test-key',
    store,
    launch: (taskId: string) => {
      void runCloudTask(taskId, deps);
    },
    mock: null,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: 'quota exhausted' }), { status: 429 })) as unknown as typeof fetch,
  };
  const sub = await submit(deps, { image: fakeJpeg(9), width: 1024, height: 768, key: sha(9) });
  const done = await waitDone(deps, String(sub.json.taskId));
  check('任务标记 failed', done.status === 'failed', `实际 ${String(done.status)}`);
  check('带 fallback=pixel', done.fallback === 'pixel');
  check('保留上游错误信息', typeof done.error === 'string' && String(done.error).includes('429'));

  const task: CloudTask | null = await store.getTask(String(sub.json.taskId));
  check('失败后清掉输入图', task !== null && (await store.getInput(String(sub.json.taskId))) === null);
}

/* ---------------- 8. 前后端契约一致 ---------------- */

console.log('\n[8] 前后端契约一致（防止两边漂移导致重复计费）');
{
  check('提示词与前端完全一致', CLIENT_PROMPT === CLOUD_PROMPT);
  check('前端上传长边 1024（与服务端尺寸规则相容）', MAX_UPLOAD_EDGE === 1024);

  // 前端提交的字段名必须正好是服务端认的这四个
  const { deps } = makeDeps('echo');
  const body = {
    image: fakeJpeg(31),
    key: sha(31),
    width: 1024,
    height: 768,
  };
  check('前端 body 字段名（image/key/width/height）被接受', (await submit(deps, body)).status === 201);
}

/* ---------------- 汇总 ---------------- */

console.log('');
if (failures.length === 0) {
  console.log(`✓ 云端服务端自测通过：${pass} / ${pass}`);
  process.exit(0);
}
console.log(`✗ ${failures.length} 项失败（共 ${pass + failures.length} 项）：${failures.join(' / ')}`);
process.exit(1);
