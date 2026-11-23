/**
 * 云端 AI 插画（火山方舟 Seedream 4.0）的浏览器端。
 *
 * 与前端的像素模式并列为第三个风格选项。整条链路：
 *   裁剪图 RGBA → 压到长边 1024 / JPEG 0.85 → 算 sha256 缓存键
 *     → POST /api/ai-style（登记任务，立即返回 taskId，扣 2 张额度）
 *     → 轮询 GET /api/ai-style?taskId=（服务端并行跑两路，各出一张）
 *     → 得到 2 个候选 dataURL，**并排展示，等用户点选**
 *     → POST /api/ai-style?action=pick（服务端记 pickedId 并写缓存）
 *     → ImageBitmap → RGBA → 交给下游 resizeToGrid / 量化 / 指标
 *
 * 四条必须遵守的约定：
 *
 * 1) **Key 永不出现在这里。** 浏览器只认 /api/ai-style，ARK_API_KEY 只在服务端。
 * 2) **一次性付费的结果要能被复用。** 改色数 / 改格数会重跑整条管线，
 *    但绝不能因此重新调一次云端——App 侧按「同一张裁剪图」缓存选中的 RGBA。
 * 3) **选中才进管线。** 两张候选生成后停在「选择」状态，用户点了哪张才算数。
 * 4) **失败不白屏。** 超时 / 配额用完 / 上游报错都抛 CloudError，
 *    由调用方降级到像素模式并提示一句。
 */

import type { AiStyleResult } from './types.ts';

/**
 * 提示词必须与 api/_lib/aiStyle.ts 的 CLOUD_PROMPT 完全一致——
 * 它同时是缓存键的一部分，两边漂移会导致「同一张图重复计费」。
 * scripts/itest-cloud.ts 里有断言守着这件事。
 */
export const CLOUD_PROMPT =
  '把照片转成极简像素风图纸：背景去掉或简化为纯色块，只保留主体轮廓；减少杂色、用大块纯色、硬边、边缘干净；颜色不超过 12 种；保持原图取景与主体位置；不要文字、不要边框。';

/** 上传前的长边上限（压到 1024 后 JPEG 约 150–400KB） */
export const MAX_UPLOAD_EDGE = 1024;
export const JPEG_QUALITY = 0.85;
/** 一次生成几张候选（与服务端 IMAGES_PER_RUN 对齐，仅用于文案与断言） */
export const IMAGES_PER_RUN = 2;
/** 一次生成的成本（元），仅用于文案 */
export const COST_PER_RUN = 0.4;

const ENDPOINT = '/api/ai-style';
const POLL_INTERVAL_MS = 1500;
/** 客户端比服务端更耐心一点：两路并行约等于单次 8–20s，70s 还没好就降级 */
const POLL_TIMEOUT_MS = 70_000;
const DEVICE_KEY = 'sc_device_id';

export type CloudPhase = 'encode' | 'submit' | 'polling' | 'decode';

export interface CloudProgress {
  phase: CloudPhase;
  /** 轮询阶段已经等了多久 */
  elapsedMs?: number;
  message?: string;
}

export type CloudErrorCode =
  | 'encode'
  | 'network'
  | 'timeout'
  | 'quota'
  | 'not-configured'
  | 'upstream';

export class CloudError extends Error {
  readonly code: CloudErrorCode;
  /** 是否应该自动降级到像素模式 */
  readonly fallback: boolean;

  constructor(code: CloudErrorCode, message: string, fallback = true) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.fallback = fallback;
  }
}

export interface CloudStyleOptions {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  onProgress?: (p: CloudProgress) => void;
  signal?: AbortSignal;
}

/** 调试面板要展示的元信息（不把几百 KB 的 dataURL 塞进 state） */
export interface CloudMeta {
  size: string;
  cached: boolean;
  quotaLeft: number | null;
  mock: boolean;
  serverMs: number;
}

/** 一个可展示的候选（缩略图用 dataURL，避免额外请求） */
export interface CloudCandidateView {
  id: string;
  dataUrl: string;
  bytes: number;
  upstreamMs: number;
}

/** 一次生成的结果：两张候选 + 元信息 */
export interface CloudRunResult {
  taskId: string;
  size: string;
  candidates: CloudCandidateView[];
  /** 服务端是否命中缓存（命中则本次不计费） */
  cached: boolean;
  /** 今日剩余次数（缓存命中时为 null） */
  quotaLeft: number | null;
  mock: boolean;
  serverMs: number;
  /** 缓存命中时服务端带回来的上次选中项 */
  pickedId: string | null;
}

export interface CloudPickResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  size: string;
  bytes: number;
  upstreamMs: number;
}

/* ---------------- 设备标识（限流用） ---------------- */

/**
 * 设备 ID 只用于「每天 3 次、每次 2 张」的配额，不做任何追踪。
 * 隐私模式下 localStorage 可能抛异常，退化成 anonymous（服务端会按 IP 兜底）。
 */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(16).slice(2);
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return 'anonymous';
  }
}

/* ---------------- 编码 ---------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000; // 分块，避免 String.fromCharCode(...) 一次喂太多爆栈
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

async function toJpegBase64(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<{ base64: string; width: number; height: number; bytes: number }> {
  const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new CloudError('encode', '画布不可用，无法压缩图片');

  // 用 ImageBitmap 一步完成缩放：省掉「原尺寸 canvas + 再缩放」的一次大内存拷贝
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), width, height));
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, tw, th);
  } finally {
    bitmap.close();
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new CloudError('encode', 'JPEG 编码失败'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { base64: bytesToBase64(bytes), width: tw, height: th, bytes: bytes.length };
}

/** sha256(压缩后图 + 风格 + 提示词) → 缓存键 */
async function cacheKey(base64: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new CloudError('encode', '当前环境不支持 Web Crypto，无法计算缓存键');
  }
  const payload = new TextEncoder().encode(`cloud|${CLOUD_PROMPT}|${base64}`);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ---------------- 网络 ---------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CandidateWire {
  id: string;
  ok: boolean;
  image?: string;
  bytes?: number;
  upstreamMs?: number;
  error?: string;
}

interface SubmitResponse {
  taskId?: string;
  status?: string;
  cached?: boolean;
  size?: string;
  cost?: number;
  quotaLeft?: number;
  pickedId?: string;
  candidates?: number;
  error?: string;
  code?: string;
}

interface StatusResponse {
  taskId?: string;
  status?: string;
  size?: string;
  okCount?: number;
  candidates?: CandidateWire[];
  pickedId?: string;
  error?: string;
  mock?: boolean;
  elapsedMs?: number;
  upstreamMs?: number;
}

function deviceHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-device-id': deviceId() };
}

async function submit(
  body: { image: string; key: string; width: number; height: number },
  signal?: AbortSignal,
): Promise<SubmitResponse> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: deviceHeaders(),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new CloudError('network', '无法连接服务端，请检查网络后重试');
  }

  const data = (await res.json().catch(() => ({}))) as SubmitResponse;
  if (res.status === 429) {
    throw new CloudError('quota', data.error ?? '今日 AI 插画次数已用完');
  }
  if (res.status === 503) {
    throw new CloudError('not-configured', data.error ?? '服务端未配置 ARK_API_KEY');
  }
  if (!res.ok) {
    throw new CloudError('upstream', data.error ?? `提交失败（HTTP ${res.status}）`);
  }
  if (!data.taskId) throw new CloudError('upstream', '服务端没有返回 taskId');
  return data;
}

/**
 * 轮询直到出结果。
 * done / partial 都算「出图完成」——partial 表示两路里有一路失败，仍有图可用。
 */
async function pollUntilDone(
  taskId: string,
  onProgress?: (p: CloudProgress) => void,
  signal?: AbortSignal,
): Promise<StatusResponse> {
  const t0 = performance.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (performance.now() - t0 > POLL_TIMEOUT_MS) {
      throw new CloudError(
        'timeout',
        `云端处理超过 ${Math.round(POLL_TIMEOUT_MS / 1000)} 秒还没返回，已切回像素模式`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    let res: Response;
    try {
      res = await fetch(`${ENDPOINT}?taskId=${encodeURIComponent(taskId)}`, {
        headers: { 'x-device-id': deviceId() },
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // 单次轮询失败不立刻放弃：任务在服务端还在跑，下一轮再试
      continue;
    }
    if (!res.ok) continue;

    const data = (await res.json().catch(() => ({}))) as StatusResponse;
    if (data.status === 'done' || data.status === 'partial') return data;
    if (data.status === 'failed') {
      throw new CloudError('upstream', data.error ?? '云端处理失败');
    }
    onProgress?.({
      phase: 'polling',
      elapsedMs: Math.round(performance.now() - t0),
    });
  }
}

/* ---------------- 解码 ---------------- */

async function decodeToRgba(dataUrl: string): Promise<{
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CloudError('encode', '画布不可用，无法解码云端结果');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { rgba: img.data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/* ---------------- 对外主函数 ---------------- */

/**
 * 提交一次生成并等两张候选出来。
 *
 * 注意：这一步**不选图**，也没有进入本地管线——返回的是两个 dataURL，
 * 交给 UI 并排展示，用户点选后再调 pickCandidate()。
 */
export async function submitCloud(opts: CloudStyleOptions): Promise<CloudRunResult> {
  opts.onProgress?.({ phase: 'encode' });
  const encoded = await toJpegBase64(opts.rgba, opts.width, opts.height);
  const key = await cacheKey(encoded.base64);

  opts.onProgress?.({ phase: 'submit' });
  const submitted = await submit(
    { image: encoded.base64, key, width: encoded.width, height: encoded.height },
    opts.signal,
  );
  const taskId = submitted.taskId!;

  // 命中缓存时服务端直接返回 200，但它不带图——仍要走一次轮询取候选
  opts.onProgress?.({ phase: 'polling', elapsedMs: 0 });
  const status = await pollUntilDone(taskId, opts.onProgress, opts.signal);

  const candidates: CloudCandidateView[] = (status.candidates ?? [])
    .filter((c) => c.ok && c.image)
    .map((c) => ({
      id: c.id,
      dataUrl: c.image!,
      bytes: c.bytes ?? 0,
      upstreamMs: c.upstreamMs ?? 0,
    }));

  if (candidates.length === 0) {
    throw new CloudError('upstream', status.error ?? '两张候选都生成失败');
  }

  return {
    taskId,
    size: status.size ?? submitted.size ?? `${encoded.width}x${encoded.height}`,
    candidates,
    cached: Boolean(submitted.cached),
    quotaLeft: typeof submitted.quotaLeft === 'number' ? submitted.quotaLeft : null,
    mock: Boolean(status.mock),
    serverMs: status.elapsedMs ?? 0,
    pickedId: status.pickedId ?? submitted.pickedId ?? null,
  };
}

/** 用户点选某张候选：服务端记 pickedId + 写缓存，本地解码成 RGBA。 */
export async function pickCandidate(
  taskId: string,
  candidateId: string,
  signal?: AbortSignal,
): Promise<CloudPickResult> {
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?action=pick`, {
      method: 'POST',
      headers: deviceHeaders(),
      body: JSON.stringify({ taskId, candidateId }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new CloudError('network', '无法连接服务端，请检查网络后重试');
  }

  const data = (await res.json().catch(() => ({}))) as {
    image?: string;
    size?: string;
    bytes?: number;
    upstreamMs?: number;
    error?: string;
  };
  if (!res.ok) {
    throw new CloudError('upstream', data.error ?? `选定失败（HTTP ${res.status}）`);
  }
  if (!data.image) throw new CloudError('upstream', '服务端没有返回选中的图');

  const decoded = await decodeToRgba(data.image);
  return {
    ...decoded,
    size: data.size ?? `${decoded.width}x${decoded.height}`,
    bytes: data.bytes ?? 0,
    upstreamMs: data.upstreamMs ?? 0,
  };
}

/** 把选中结果适配成管线使用的 AiStyleResult */
export function toAiStyleResult(
  picked: CloudPickResult,
  endToEndMs: number,
): AiStyleResult {
  return {
    rgba: picked.rgba,
    width: picked.width,
    height: picked.height,
    inferenceMs: Math.round(endToEndMs),
  };
}
