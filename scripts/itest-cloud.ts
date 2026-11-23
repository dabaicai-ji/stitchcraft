/**
 * 云端风格化服务端链路自测（纯 Node，不联网、不启浏览器、不花一分钱）。
 *
 *   node scripts/itest-cloud.ts
 *
 * 覆盖：尺寸计算 / 提交 / 轮询 / **并行两路候选** / 部分成功（partial）/
 *       全部失败（failed）/ 点选（pick）后写缓存 / 未点选不写缓存 /
 *       缓存命中不重复计费 / 每日配额（每次扣 2 张，6 张 = 3 次）/
 *       超时任务卡在 running / 无 key 503 / 非法请求 400 / 前后端契约一致。
 *
 * 这里断言的是服务端契约——前端「超时降级」逻辑在 src/ai/cloud.ts。
 */

import { MemoryTaskStore } from '../api/_lib/taskStore.ts';
import type { CloudTask } from '../api/_lib/taskStore.ts';
import {
  CLOUD_PROMPT,
  COST_PER_RUN,
  DAILY_IMAGE_LIMIT,
  DAILY_RUN_LIMIT,
  handleAiStyle,
  IMAGES_PER_RUN,
  MIN_PIXELS,
  runCloudTask,
  seedreamSize,
} from '../api/_lib/aiStyle.ts';
import type { AiStyleDeps } from '../api/_lib/aiStyle.ts';
import {
  CLOUD_PROMPT as CLIENT_PROMPT,
  COST_PER_RUN as CLIENT_COST_PER_RUN,
  IMAGES_PER_RUN as CLIENT_IMAGES_PER_RUN,
  MAX_UPLOAD_EDGE,
} from '../src/ai/cloud.ts';

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

/** 可编程上游桩：每次调用返回 handler(序号) 的结果，并记录调用次数 */
function stubFetch(handler: (call: number) => Response): {
  fn: typeof fetch;
  calls: () => number;
} {
  let n = 0;
  const fn = (async () => handler(++n)) as unknown as typeof fetch;
  return { fn, calls: () => n };
}

function okBody(seed: number): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: fakeJpeg(seed) }] }), {
    status: 200,
  });
}

function makeDeps(
  mock: AiStyleDeps['mock'],
  fetchImpl?: typeof fetch,
): { deps: AiStyleDeps; upstreamCalls: () => number } {
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
    fetchImpl:
      fetchImpl ??
      ((async () => {
        calls++;
        throw new Error('测试里不应真的联网');
      }) as unknown as typeof fetch),
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

async function pick(
  deps: AiStyleDeps,
  taskId: string,
  candidateId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleAiStyle(
    new Request('http://localhost/api/ai-style?action=pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, candidateId }),
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
    if (status === 'done' || status === 'partial' || status === 'failed') return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error(`轮询超时（状态 ${String(status)}）`);
    await sleep(50);
  }
}

interface CandidateWire {
  id: string;
  ok: boolean;
  image?: string;
  error?: string;
}

function candidatesOf(json: Record<string, unknown>): CandidateWire[] {
  return (json.candidates as CandidateWire[] | undefined) ?? [];
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

/* ---------------- 2. 提交 → 并行两路 → 两张候选 ---------------- */

console.log('\n[2] 提交 → 并行两路 → done + 2 候选（echo mock，不联网）');
{
  const { deps, upstreamCalls } = makeDeps('echo');
  const sub = await submit(deps, { image: fakeJpeg(1), width: 1024, height: 768, key: sha(1) });
  check('POST 返回 201', sub.status === 201, `实际 ${sub.status}`);
  check('返回 taskId', typeof sub.json.taskId === 'string');
  check(`返回预估成本 ${COST_PER_RUN}`, sub.json.cost === COST_PER_RUN, `实际 ${String(sub.json.cost)}`);
  check('声明本次生成 2 张', sub.json.candidates === IMAGES_PER_RUN, `实际 ${String(sub.json.candidates)}`);
  check(`返回剩余次数 ${DAILY_RUN_LIMIT - 1}`, sub.json.quotaLeft === DAILY_RUN_LIMIT - 1, `实际 ${String(sub.json.quotaLeft)}`);
  check('size 按比例算', sub.json.size === '1368x1024', `实际 ${String(sub.json.size)}`);

  const done = await waitDone(deps, String(sub.json.taskId));
  check('轮询到 done', done.status === 'done', `实际 ${String(done.status)}`);
  const cs = candidatesOf(done);
  check('返回 2 个候选', cs.length === IMAGES_PER_RUN, `实际 ${cs.length}`);
  check('候选 id 是 c1/c2', cs.map((c) => c.id).join(',') === 'c1,c2');
  check('两个候选都带图', cs.every((c) => typeof c.image === 'string' && c.image.startsWith('data:image/jpeg;base64,')));
  check('okCount = 2', done.okCount === 2, `实际 ${String(done.okCount)}`);
  check('pick 之前没有 pickedId', done.pickedId === undefined);
  check('mock 模式未联网', upstreamCalls() === 0);
  check('完成后清掉输入图', (await deps.store.getInput(String(sub.json.taskId))) === null);
}

/* ---------------- 3. 并行两路真的发了两次请求 ---------------- */

console.log('\n[3] 并行两路 = 两次上游请求（火山 n 参数无效，只能自己并发）');
{
  const stub = stubFetch(() => okBody(11));
  const { deps } = makeDeps(null, stub.fn);
  const sub = await submit(deps, { image: fakeJpeg(2), width: 1024, height: 768, key: sha(2) });
  await waitDone(deps, String(sub.json.taskId));
  check('上游被调用 2 次', stub.calls() === 2, `实际 ${stub.calls()}`);
}

/* ---------------- 4. 部分成功：一张失败仍出一张 ---------------- */

console.log('\n[4] 部分成功（partial）：一路失败，仍有候选可用');
{
  // 并行下无法保证谁先谁后，用「第 1 次成功、第 2 次失败」构造一半一半
  const stub = stubFetch((n) =>
    n === 1
      ? okBody(21)
      : new Response(JSON.stringify({ error: 'quota exhausted' }), { status: 429 }),
  );
  const { deps } = makeDeps(null, stub.fn);
  const sub = await submit(deps, { image: fakeJpeg(3), width: 1024, height: 768, key: sha(3) });
  const done = await waitDone(deps, String(sub.json.taskId));

  check('状态是 partial', done.status === 'partial', `实际 ${String(done.status)}`);
  check('okCount = 1', done.okCount === 1, `实际 ${String(done.okCount)}`);
  const cs = candidatesOf(done);
  check('候选数仍是 2（失败的那个也在，带错误）', cs.length === 2, `实际 ${cs.length}`);
  check('恰好 1 个候选可用', cs.filter((c) => c.ok).length === 1);
  check('失败候选带错误信息', cs.some((c) => !c.ok && String(c.error).includes('429')));
  check('partial 不带 fallback（还有图可用，不该降级）', done.fallback === undefined);
}

/* ---------------- 5. 全部失败 → failed + fallback ---------------- */

console.log('\n[5] 全部失败 → failed + fallback=pixel');
{
  const stub = stubFetch(
    () => new Response(JSON.stringify({ error: 'upstream boom' }), { status: 500 }),
  );
  const { deps } = makeDeps(null, stub.fn);
  const sub = await submit(deps, { image: fakeJpeg(4), width: 1024, height: 768, key: sha(4) });
  const done = await waitDone(deps, String(sub.json.taskId));

  check('任务标记 failed', done.status === 'failed', `实际 ${String(done.status)}`);
  check('带 fallback=pixel', done.fallback === 'pixel');
  check('okCount = 0', done.okCount === 0, `实际 ${String(done.okCount)}`);
  check('错误信息保留上游状态码', typeof done.error === 'string' && String(done.error).includes('500'));

  const task: CloudTask | null = await deps.store.getTask(String(sub.json.taskId));
  check('失败后清掉输入图', task !== null && (await deps.store.getInput(String(sub.json.taskId))) === null);
}

/* ---------------- 6. 点选（pick）：写缓存 + 返回图 ---------------- */

console.log('\n[6] 点选候选：记录 pickedId、写缓存、返回选中的图');
{
  const stub = stubFetch(() => okBody(31));
  const { deps } = makeDeps(null, stub.fn);
  const sub = await submit(deps, { image: fakeJpeg(5), width: 1024, height: 768, key: sha(5) });
  const taskId = String(sub.json.taskId);
  const done = await waitDone(deps, taskId);

  const before = await deps.store.getCachedTaskId(sha(5));
  check('pick 之前不写缓存', before === null, `实际 ${String(before)}`);

  const picked = await pick(deps, taskId, 'c2');
  check('pick 返回 200', picked.status === 200, `实际 ${picked.status}`);
  check('pick 返回选中的图', typeof picked.json.image === 'string' && String(picked.json.image).startsWith('data:'));
  check('pick 返回 candidateId', picked.json.candidateId === 'c2');

  const task = await deps.store.getTask(taskId);
  check('任务记录 pickedId=c2', task?.pickedId === 'c2', `实际 ${String(task?.pickedId)}`);
  const after = await deps.store.getCachedTaskId(sha(5));
  check('pick 之后写入缓存', after === taskId, `实际 ${String(after)}`);

  // 选一张不存在/失败的候选要被拒
  const badPick = await pick(deps, taskId, 'c9');
  check('点选不存在的候选返回 400', badPick.status === 400, `实际 ${badPick.status}`);
  const badTask = await pick(deps, 'c_not_exist', 'c1');
  check('点选不存在的任务返回 404', badTask.status === 404, `实际 ${badTask.status}`);

  // done 但还没 pick 时也能查（前端靠这个展示两张）
  const statusAgain = await poll(deps, taskId);
  check('轮询仍返回 2 个候选', candidatesOf(statusAgain.json).length === 2);
}

/* ---------------- 7. 缓存命中（只在 pick 之后） ---------------- */

console.log('\n[7] 同 key 再提交 → 命中「用户选中的那张」，不计费');
{
  const stub = stubFetch(() => okBody(41));
  const { deps } = makeDeps(null, stub.fn);

  const first = await submit(deps, { image: fakeJpeg(6), width: 1024, height: 768, key: sha(6) });
  const taskId = String(first.json.taskId);
  await waitDone(deps, taskId);

  // 还没 pick → 不该命中缓存
  const noPick = await submit(deps, { image: fakeJpeg(6), width: 1024, height: 768, key: sha(6) });
  check('未点选时再次提交仍会新建任务', noPick.status === 201, `实际 ${noPick.status}`);

  // pick 之后才命中
  await pick(deps, taskId, 'c1');
  const hit = await submit(deps, { image: fakeJpeg(6), width: 1024, height: 768, key: sha(6) });
  check('pick 之后返回 200', hit.status === 200, `实际 ${hit.status}`);
  check('cached = true', hit.json.cached === true);
  check('cost = 0', hit.json.cost === 0);
  check('复用同一个 taskId', hit.json.taskId === taskId, `实际 ${String(hit.json.taskId)}`);
  check('带上上次选中的 pickedId', hit.json.pickedId === 'c1', `实际 ${String(hit.json.pickedId)}`);

  const third = await submit(deps, { image: fakeJpeg(7), width: 1024, height: 768, key: sha(7) });
  check('换 key 仍会新建任务', third.status === 201 && third.json.cached === false);
}

/* ---------------- 8. 每日配额（每次 2 张，6 张 = 3 次） ---------------- */

console.log(`\n[8] 每日配额（每天 ${DAILY_RUN_LIMIT} 次 × ${IMAGES_PER_RUN} 张 = ${DAILY_IMAGE_LIMIT} 张）`);
{
  const { deps } = makeDeps('echo');
  const headers = { 'x-device-id': 'device-A' };
  const statuses: number[] = [];
  for (let i = 0; i < DAILY_RUN_LIMIT + 1; i++) {
    const r = await submit(
      deps,
      { image: fakeJpeg(i + 10), width: 1024, height: 768, key: sha(100 + i) },
      headers,
    );
    statuses.push(r.status);
    if (i === DAILY_RUN_LIMIT - 1) {
      check(`第 ${DAILY_RUN_LIMIT} 次仍成功`, r.status === 201, `实际 ${r.status}`);
      check('最后一次的 quotaLeft = 0', r.json.quotaLeft === 0, `实际 ${String(r.json.quotaLeft)}`);
    }
    if (i === DAILY_RUN_LIMIT) {
      check(`第 ${DAILY_RUN_LIMIT + 1} 次被拦（429）`, r.status === 429, `实际 ${r.status}`);
      check('响应带 fallback=pixel', r.json.fallback === 'pixel');
      check('响应带 QUOTA_EXCEEDED', r.json.code === 'QUOTA_EXCEEDED');
    }
  }
  check(
    `配额计数正确（前 ${DAILY_RUN_LIMIT} 次 201）`,
    statuses.slice(0, DAILY_RUN_LIMIT).every((s) => s === 201),
    statuses.join(','),
  );
  const used = await deps.store.getQuota('dev:device-A', new Date().toISOString().slice(0, 10));
  check(`累计扣满 ${DAILY_IMAGE_LIMIT} 张`, used === DAILY_IMAGE_LIMIT, `实际 ${used}`);

  // 换设备号应重新计数
  const other = await submit(
    deps,
    { image: fakeJpeg(20), width: 1024, height: 768, key: sha(200) },
    { 'x-device-id': 'device-B' },
  );
  check('换设备号不受影响', other.status === 201, `实际 ${other.status}`);
}

/* ---------------- 9. 超时任务停在 running ---------------- */

console.log('\n[9] timeout mock：任务停在 running（前端据此降级）');
{
  const { deps } = makeDeps('timeout');
  const sub = await submit(deps, { image: fakeJpeg(9), width: 1024, height: 768, key: sha(9) });
  await sleep(120);
  const r = await poll(deps, String(sub.json.taskId));
  check('状态是 running', r.json.status === 'running', `实际 ${String(r.json.status)}`);
  check('running 不带候选', r.json.candidates === undefined);
  check('running 不能 pick', (await pick(deps, String(sub.json.taskId), 'c1')).status === 409);
}

/* ---------------- 10. 异常路径 ---------------- */

console.log('\n[10] 异常路径');
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

/* ---------------- 11. 前后端契约一致 ---------------- */

console.log('\n[11] 前后端契约一致（防止两边漂移导致重复计费）');
{
  check('提示词与前端完全一致', CLIENT_PROMPT === CLOUD_PROMPT);
  check('前端上传长边 1024（与服务端尺寸规则相容）', MAX_UPLOAD_EDGE === 1024);
  check('两张/次 前后端一致', CLIENT_IMAGES_PER_RUN === IMAGES_PER_RUN);
  check('成本 0.4 前后端一致', CLIENT_COST_PER_RUN === COST_PER_RUN);

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
