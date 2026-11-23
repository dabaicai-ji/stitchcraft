/**
 * 云端 AI 插画（火山方舟 Seedream 4.0）—— 服务端核心。
 *
 * 用 Web 标准 Request / Response 编写，和 insight.ts 同一套思路，一份代码跑三处：
 *   本地 dev / preview : vite.config.ts 里的 Node 桥接层（内存 store + 进程内后台执行）
 *   Netlify            : netlify/functions/ai-style.ts（提交/查询/选择）+ ai-style-run-background.ts（后台执行）
 *   Node 测试          : scripts/itest-cloud.ts 直接喂 Request
 *
 * 四个关键设计，都被现实约束逼出来的：
 *
 * 1) **异步任务，不是一次请求等 15 秒。**
 *    火山 Seedream 是同步接口，单张 8–15s；Netlify 普通 Function 免费版 10s 超时。
 *    所以 POST 只登记任务并返回 taskId，真正的调用发生在 Background Function 里
 *    （Netlify 上文件名带 -background 的函数，返回 202 后还能继续跑，最长 15 分钟）。
 *    本地没有 background 机制，launch 直接在当前 Node 进程里跑，语义一致。
 *
 * 2) **一次生成两张候选，并行两路。**
 *    火山 Seedream 4.0 的 `n` 参数无效（实测 n=2 只返回 1 张），所以服务端
 *    用 Promise.all 并行发两次、每次 n 默认 1 张。两路互不拖累：一路失败不影响另一路。
 *    耗时约等于单次（并行），成本翻倍（0.4 元/次）。
 *
 * 3) **选中之后才写缓存。**
 *    一次出两张，未选中的那张用户根本没见过——它不是「有效产出」。
 *    所以 cache:<sha256> 只在 pick 时写入；同一张输入图第二次提交会命中
 *    用户上次选中的那张，不再重复计费，也不会命中一张没人选过的图。
 *
 * 4) **输入图与任务分键存。** 轮询每 1.5 秒一次，任务 JSON 里不该带 300KB 输入图。
 */

import type { CloudCandidate, CloudTask, TaskStore } from './taskStore.ts';

/* ---------------- 常量（照横评实测，不随意改） ---------------- */

export const CLOUD_MODEL = 'doubao-seedream-4-0-20260415';
/**
 * 提示词（2026-11-23 第三版：极简像素风）。
 *
 * 版本演进，每一次都是实测驱动的：
 *   V1「扁平插画风 + 硬边大色块」——人物被简化掉（脸和口罩糊成抽象色面）。
 *   V2「只保人物、去掉风格」——人物完整了，但风格约束消失后模型画得更写实，
 *      细节变多 → 混淆边比从 0.9% 涨到 8.7%。**风格和主体是并列约束，不是二选一。**
 *   V3「风格 + 主体 + 构图」三段式——人物完整、混淆压回 1.2%，但碎片率 8.4%、构图仍会漂。
 *   V4（当前）改成极简像素风：先要「像图纸」，背景压成纯色块、只留主体轮廓。
 *      这是产品定位的转向——不是让照片变好看，而是让它变成能直接绣的图纸。
 *
 * ⚠️ 这段文字同时是缓存键的一部分（sha256 里含 prompt），
 * 与 src/ai/cloud.ts 的 CLOUD_PROMPT 必须逐字一致，itest-cloud 有断言守着。
 */
export const CLOUD_PROMPT =
  '把照片转成极简像素风图纸：背景去掉或简化为纯色块，只保留主体轮廓；减少杂色、用大块纯色、硬边、边缘干净；颜色不超过 12 种；保持原图取景与主体位置；不要文字、不要边框。';
export const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

/** 一次生成几张候选（并行发几次请求） */
export const IMAGES_PER_RUN = 2;
/** 每设备 / IP 每天可用的**张数**上限（成本护栏） */
export const DAILY_IMAGE_LIMIT = 6;
/** 对外口径：每天可生成几次（每次 2 张） */
export const DAILY_RUN_LIMIT = DAILY_IMAGE_LIMIT / IMAGES_PER_RUN;
/** 单张成本（元），仅用于文案 */
export const COST_PER_IMAGE = 0.2;
/** 一次生成（2 张）的成本 */
export const COST_PER_RUN = COST_PER_IMAGE * IMAGES_PER_RUN;
/** Seedream 要求的最小总像素 */
export const MIN_PIXELS = 921600;
/** 请求体上限：1024 长边 JPEG 约 300–500KB，base64 后 ~700KB，留足余量 */
const MAX_BODY = 8 * 1024 * 1024;

export type MockMode = 'echo' | 'timeout' | null;

export interface AiStyleDeps {
  /** ARK_API_KEY，只从环境变量来，永不进前端 */
  apiKey: string | undefined;
  store: TaskStore;
  /** 后台执行器：Netlify 里触发 background function；本地直接在当前进程跑 */
  launch: (taskId: string) => void | Promise<void>;
  /** 测试用：echo 回显输入图（不联网）、timeout 永远不完成（验降级） */
  mock?: MockMode;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/* ---------------- 工具 ---------------- */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let out = '';
  const chunk = 0x8000; // 分块，避免 String.fromCharCode(...) 爆栈
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

/** 从 PNG / JPEG 魔数判断 MIME，不信任上游响应头 */
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return 'image/jpeg';
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `c_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `c_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
}

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 尺寸计算 ---------------- */

function round8(n: number): number {
  return Math.max(8, Math.round(n / 8) * 8);
}

/**
 * 按裁剪图比例算 Seedream 尺寸。
 *
 * 规则：短边固定 1024、长边按比例（都取 8 的倍数）——这样 1:1 是 1024²、
 * 4:3 是 1368×1024、16:9 是 1824×1024，总像素都 ≥ 921600 且远小于 2048 档。
 * 极端比例（裁剪成 6:1 长条）时短边 1024 会突破长边上限，此时改为
 * 「保证最小面积 921600」反算，避免生成一个又细又贵的图。
 */
export function seedreamSize(srcW: number, srcH: number): string {
  const w = Math.max(1, srcW);
  const h = Math.max(1, srcH);
  const aspect = w / h;

  let outW: number;
  let outH: number;
  if (aspect >= 1) {
    outH = 1024;
    outW = round8(Math.round(outH * aspect));
  } else {
    outW = 1024;
    outH = round8(Math.round(outW / aspect));
  }

  // 比例超过 4:1 时短边不再是 1024，改按最小面积算，避免长边爆到 4096
  if (Math.max(outW, outH) > 2048) {
    if (aspect >= 1) {
      outW = 2048;
      outH = round8(Math.round(outW / aspect));
    } else {
      outH = 2048;
      outW = round8(Math.round(outH * aspect));
    }
  }

  // 兜底：面积不足就等比放大（极少触发，但比被上游 400 拒绝好）
  if (outW * outH < MIN_PIXELS) {
    const k = Math.sqrt(MIN_PIXELS / (outW * outH));
    outW = round8(outW * k);
    outH = round8(outH * k);
  }
  return `${outW}x${outH}`;
}

/* ---------------- 上游调用 ---------------- */

interface SeedreamResult {
  image: string;
  mime: string;
  bytes: number;
  upstreamMs: number;
}

async function callSeedream(opts: {
  apiKey: string;
  inputBase64: string;
  prompt: string;
  size: string;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<SeedreamResult> {
  const { apiKey, inputBase64, prompt, size, fetchImpl } = opts;
  const t0 = opts.now();

  const res = await fetchImpl(ARK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CLOUD_MODEL,
      prompt,
      image: [`data:image/jpeg;base64,${inputBase64}`],
      size,
      response_format: 'url',
      watermark: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const text = await res.text();
  if (!res.ok) {
    // 上游错误原样带出前 300 字，方便在 UI 上看清是额度、模型还是参数问题
    throw new Error(`火山返回 ${res.status}：${text.slice(0, 300)}`);
  }

  let parsed: { data?: { url?: string; b64_json?: string }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`火山返回不是 JSON：${text.slice(0, 200)}`);
  }
  const item = parsed.data?.[0];
  if (!item) throw new Error(`火山返回无 data：${text.slice(0, 200)}`);

  // 优先直接拿 b64（少一次网络往返）；只有 URL 时才下载回流
  if (item.b64_json) {
    const bytes = Buffer.from(item.b64_json, 'base64');
    return {
      image: item.b64_json,
      mime: sniffMime(bytes),
      bytes: bytes.length,
      upstreamMs: opts.now() - t0,
    };
  }
  if (!item.url) throw new Error('火山既没返回 url 也没返回 b64_json');

  const img = await fetchImpl(item.url);
  if (!img.ok) throw new Error(`下载结果图失败 HTTP ${img.status}`);
  const buf = new Uint8Array(await img.arrayBuffer());
  return {
    image: bytesToBase64(buf),
    mime: sniffMime(buf),
    bytes: buf.length,
    upstreamMs: opts.now() - t0,
  };
}

/* ---------------- 任务执行 ---------------- */

function now(deps: AiStyleDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** 直接指向文档里写的 60s 轮询期限，测试里方便断言 */
export const POLL_TIMEOUT_MS = 60_000;

/**
 * 跑单路候选。**绝不让它抛**——一路失败不能拖垮另一路，
 * 这是「一张成功就展示一张」的前提。
 */
async function runCandidate(
  deps: AiStyleDeps,
  opts: { id: string; input: string; prompt: string; size: string },
): Promise<CloudCandidate> {
  const t0 = now(deps);
  try {
    if (deps.mock === 'echo') {
      // 回显：链路验证用，不产生费用，也不假装是风格化效果
      await sleep(400);
      const bytes = Buffer.from(opts.input, 'base64');
      return {
        id: opts.id,
        ok: true,
        image: opts.input,
        imageMime: sniffMime(bytes),
        imageBytes: bytes.length,
        upstreamMs: 400,
      };
    }
    if (!deps.apiKey) throw new Error('ARK_API_KEY 未配置');
    const r = await callSeedream({
      apiKey: deps.apiKey,
      inputBase64: opts.input,
      prompt: opts.prompt,
      size: opts.size,
      fetchImpl: deps.fetchImpl ?? fetch,
      now: () => now(deps),
    });
    return {
      id: opts.id,
      ok: true,
      image: r.image,
      imageMime: r.mime,
      imageBytes: r.bytes,
      upstreamMs: r.upstreamMs,
    };
  } catch (err) {
    return {
      id: opts.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      upstreamMs: now(deps) - t0,
    };
  }
}

/**
 * 执行一个任务。可重入：已 done / partial / failed 的任务直接跳过，
 * 因为 background function 可能被重复触发（Netlify 不保证只触发一次）。
 */
export async function runCloudTask(taskId: string, deps: AiStyleDeps): Promise<void> {
  const task = await deps.store.getTask(taskId);
  if (!task) return;
  if (task.status === 'done' || task.status === 'partial' || task.status === 'failed') return;

  const t0 = now(deps);
  await deps.store.putTask({
    ...task,
    status: 'running',
    startedAt: t0,
    updatedAt: t0,
  });

  // 超时降级测试：故意停在 running，让前端自己撞轮询超时
  if (deps.mock === 'timeout') return;

  try {
    const input = await deps.store.getInput(taskId);
    if (!input) throw new Error('任务输入已丢失（可能已过期）');

    // 并行两路：火山 n 参数无效，只能发两次；Promise.all 保证总耗时 ≈ 单次
    const ids = Array.from({ length: IMAGES_PER_RUN }, (_, i) => `c${i + 1}`);
    const candidates = await Promise.all(
      ids.map((id) =>
        runCandidate(deps, { id, input, prompt: task.prompt, size: task.size }),
      ),
    );

    const okCount = candidates.filter((c) => c.ok).length;
    const t1 = now(deps);
    await deps.store.putTask({
      ...task,
      status: okCount === 0 ? 'failed' : okCount === candidates.length ? 'done' : 'partial',
      candidates,
      okCount,
      error:
        okCount === 0
          ? candidates.map((c) => c.error).filter(Boolean).join(' | ') || '所有候选都失败'
          : undefined,
      finishedAt: t1,
      updatedAt: t1,
    });
    await deps.store.dropInput(taskId);
    // ⚠️ 这里**不写缓存**：缓存只在用户 pick 之后写入（见 handlePick）。
  } catch (err) {
    const t1 = now(deps);
    await deps.store.putTask({
      ...task,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: t1,
      updatedAt: t1,
    });
    await deps.store.dropInput(taskId);
  }
}

/* ---------------- HTTP 处理 ---------------- */

interface SubmitBody {
  image?: unknown;
  width?: unknown;
  height?: unknown;
  key?: unknown;
}

interface PickBody {
  taskId?: unknown;
  candidateId?: unknown;
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
}

/** 剩余「次数」（对外口径），按张数折算 */
function runsLeft(used: number): number {
  return Math.max(0, Math.floor((DAILY_IMAGE_LIMIT - used) / IMAGES_PER_RUN));
}

async function handleSubmit(request: Request, deps: AiStyleDeps): Promise<Response> {
  let body: SubmitBody;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return json(413, { error: '图片过大，请重新裁剪后再试' });
    }
    body = JSON.parse(text) as SubmitBody;
  } catch {
    return json(400, { error: '请求体解析失败' });
  }

  const image = typeof body.image === 'string' ? body.image.replace(/^data:[^,]+,/, '') : '';
  if (!image || image.length < 100) return json(400, { error: '缺少图片数据' });
  if (image.length > MAX_BODY) return json(413, { error: '图片过大' });
  if (!isHex64(body.key)) return json(400, { error: 'key 必须是 64 位十六进制 sha256' });

  const width = Number(body.width);
  const height = Number(body.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return json(400, { error: 'width / height 非法' });
  }

  // 缓存命中：不消耗配额、不再调云端（同一张图重复点不重复计费）
  const cachedId = await deps.store.getCachedTaskId(body.key);
  if (cachedId) {
    const cached = await deps.store.getTask(cachedId);
    if (
      cached &&
      (cached.status === 'done' || cached.status === 'partial') &&
      cached.pickedId &&
      cached.candidates?.some((c) => c.id === cached.pickedId && c.ok)
    ) {
      return json(200, {
        taskId: cached.id,
        status: cached.status,
        cached: true,
        cost: 0,
        pickedId: cached.pickedId,
      });
    }
  }

  const nowMs = now(deps);
  const day = todayUtc(nowMs);

  // 配额：优先按设备，无设备号时退回 IP（NAT 共享的锅，但有比没有好）
  const deviceId = (request.headers.get('x-device-id') ?? '').trim();
  const ip =
    (request.headers.get('x-nf-client-connection-ip') ?? '').trim() ||
    (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ||
    'unknown';
  const bucket = deviceId ? `dev:${deviceId}` : `ip:${ip}`;

  const used = await deps.store.getQuota(bucket, day);
  if (used + IMAGES_PER_RUN > DAILY_IMAGE_LIMIT) {
    return json(429, {
      error: `今日 AI 插画次数已用完（每天 ${DAILY_RUN_LIMIT} 次，每次 ${IMAGES_PER_RUN} 张）`,
      code: 'QUOTA_EXCEEDED',
      fallback: 'pixel',
      limit: DAILY_RUN_LIMIT,
      used: Math.floor(used / IMAGES_PER_RUN),
    });
  }

  if (!deps.apiKey && deps.mock === null) {
    return json(503, {
      error: 'ARK_API_KEY 未配置。本地请在 stitchcraft/.env.local 写入；部署请在 Netlify 环境变量里设置。',
      code: 'NOT_CONFIGURED',
      fallback: 'pixel',
    });
  }

  // 每次生成扣 2 张额度
  await deps.store.incrQuota(bucket, day, IMAGES_PER_RUN);

  const id = randomId();
  const task: CloudTask = {
    id,
    status: 'queued',
    key: body.key,
    prompt: CLOUD_PROMPT,
    size: seedreamSize(width, height),
    createdAt: nowMs,
    updatedAt: nowMs,
    mock: deps.mock === 'echo' || deps.mock === 'timeout',
  };
  await deps.store.putInput(id, image);
  await deps.store.putTask(task);

  // 后台执行：**要 await launch 返回**，否则 Netlify 上「触发 background function」
  // 的那个 fetch 会在函数被冻结前来不及发出（本地 launch 是 setTimeout，立即返回，
  // 语义不变；测试里的 launch 直接执行任务，await 也就是等它跑完）。
  await deps.launch(id);

  return json(201, {
    taskId: id,
    status: 'queued',
    cached: false,
    size: task.size,
    candidates: IMAGES_PER_RUN,
    cost: COST_PER_RUN,
    quotaLeft: runsLeft(used + IMAGES_PER_RUN),
  });
}

/** 候选对前端暴露的形态：成功的带 data URL，失败的只带错误 */
function candidatesForClient(task: CloudTask): unknown[] {
  return (task.candidates ?? []).map((c) =>
    c.ok && c.image
      ? {
          id: c.id,
          ok: true,
          image: `data:${c.imageMime ?? 'image/jpeg'};base64,${c.image}`,
          bytes: c.imageBytes ?? 0,
          upstreamMs: c.upstreamMs ?? 0,
        }
      : { id: c.id, ok: false, error: c.error ?? '未知错误' },
  );
}

async function handleStatus(request: Request, deps: AiStyleDeps): Promise<Response> {
  const taskId = new URL(request.url).searchParams.get('taskId');
  if (!taskId) return json(400, { error: '缺少 taskId' });

  const task = await deps.store.getTask(taskId);
  if (!task) return json(404, { error: '任务不存在或已过期（1 小时）' });

  const nowMs = now(deps);
  const base = {
    taskId: task.id,
    status: task.status,
    size: task.size,
    elapsedMs: (task.finishedAt ?? nowMs) - task.createdAt,
    okCount: task.okCount,
    candidates: task.status === 'running' || task.status === 'queued'
      ? undefined
      : candidatesForClient(task),
    pickedId: task.pickedId,
    error: task.error,
    mock: task.mock ?? false,
  };

  if (task.status === 'failed') {
    return json(200, { ...base, fallback: 'pixel' });
  }
  return json(200, base);
}

/**
 * 用户点选某张候选。
 *
 * 两个副作用，缺一不可：
 *   1) 记录 pickedId —— 之后轮询/缓存命中都能拿到「用户选的是哪张」；
 *   2) 写入 cache 键 —— 只有走到这一步的图才是有效产出，下次同图提交直接复用。
 */
async function handlePick(request: Request, deps: AiStyleDeps): Promise<Response> {
  let body: PickBody;
  try {
    body = (await request.json()) as PickBody;
  } catch {
    return json(400, { error: '请求体解析失败' });
  }
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
  if (!taskId || !candidateId) return json(400, { error: '缺少 taskId / candidateId' });

  const task = await deps.store.getTask(taskId);
  if (!task) return json(404, { error: '任务不存在或已过期（1 小时）' });
  if (task.status !== 'done' && task.status !== 'partial') {
    return json(409, { error: `任务还没出结果（当前 ${task.status}）` });
  }
  const candidate = task.candidates?.find((c) => c.id === candidateId && c.ok);
  if (!candidate?.image) return json(400, { error: '候选不存在或生成失败' });

  const t1 = now(deps);
  await deps.store.putTask({ ...task, pickedId: candidateId, updatedAt: t1 });
  // 选中即形成有效产出：写缓存（未选中的候选永远不进缓存）
  await deps.store.putCachedTaskId(task.key, task.id);

  return json(200, {
    taskId: task.id,
    candidateId,
    status: 'picked',
    image: `data:${candidate.imageMime ?? 'image/jpeg'};base64,${candidate.image}`,
    bytes: candidate.imageBytes ?? 0,
    size: task.size,
    upstreamMs: candidate.upstreamMs ?? 0,
    mock: task.mock ?? false,
  });
}

/**
 * 统一入口。
 *
 *   GET  /api/ai-style?taskId=            查任务（含候选项）
 *   POST /api/ai-style                    提交任务（扣 2 张额度）
 *   POST /api/ai-style?action=pick        选定一张候选（写缓存）
 *
 * 用 query 的 action 而不是子路径，是为了让 Netlify redirects 与本地桥接
 * 都只需要一条 /api/ai-style 规则，少一处配置就少一处线上不一致。
 */
export async function handleAiStyle(request: Request, deps: AiStyleDeps): Promise<Response> {
  const action = new URL(request.url).searchParams.get('action');
  if (request.method === 'GET') return handleStatus(request, deps);
  if (request.method === 'POST') {
    return action === 'pick' ? handlePick(request, deps) : handleSubmit(request, deps);
  }
  return json(405, { error: '只支持 GET（查询）/ POST（提交或选定）' });
}
