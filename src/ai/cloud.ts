/**
 * 云端 AI 插画（火山方舟 Seedream 4.0）的浏览器端。
 *
 * 与前端的像素模式并列为第三个风格选项。整条链路：
 *   裁剪图 RGBA → 压到长边 1024 / JPEG 0.85 → 算 sha256 缓存键
 *     → POST /api/ai-style（登记任务，立即返回 taskId）
 *     → 轮询 GET /api/ai-style?taskId=（服务端 Background Function 在跑）
 *     → dataURL → ImageBitmap → RGBA → 交给下游 resizeToGrid / 量化 / 指标
 *
 * 三条必须遵守的约定：
 *
 * 1) **Key 永不出现在这里。** 浏览器只认 /api/ai-style，ARK_API_KEY 只在服务端。
 * 2) **一次性付费的结果要能被复用。** 改色数 / 改格数会重跑整条管线，
 *    但绝不能因此重新调一次云端——App 侧按「同一张裁剪图」缓存结果 RGBA。
 * 3) **失败不白屏。** 超时 / 配额用完 / 上游报错都抛 CloudError，
 *    由调用方降级到像素模式并提示一句。
 */

import type { AiStyleResult } from './types.ts';

/**
 * 提示词必须与 api/_lib/aiStyle.ts 的 CLOUD_PROMPT 完全一致——
 * 它同时是缓存键的一部分，两边漂移会导致「同一张图重复计费」。
 * scripts/itest-cloud.ts 里有断言守着这件事。
 */
export const CLOUD_PROMPT =
  '把这张照片改成扁平插画风，硬边大色块，保留主体轮廓与构图，去掉背景杂物和细碎纹理，颜色不超过 12 种，不要文字和边框';

/** 上传前的长边上限（压到 1024 后 JPEG 约 150–400KB） */
export const MAX_UPLOAD_EDGE = 1024;
export const JPEG_QUALITY = 0.85;

const ENDPOINT = '/api/ai-style';
const POLL_INTERVAL_MS = 1500;
/** 客户端比服务端更耐心一点：8–15s 出图 + 排队，70s 还没好就降级 */
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

/** 调试面板要展示的元信息（不含 RGBA，避免把几百 KB 的像素塞进 React state） */
export interface CloudMeta {
  size: string;
  cached: boolean;
  quotaLeft: number | null;
  mock: boolean;
  serverMs: number;
}

export interface CloudStyleResult extends AiStyleResult {
  /** 火山实际生成的尺寸（服务端按裁剪比例算的） */
  size: string;
  /** 是否命中服务端缓存（命中则本次不计费） */
  cached: boolean;
  /** 剩余今日次数（服务端返回；缓存命中时为空） */
  quotaLeft: number | null;
  /** 服务端标记的 mock 任务（本地联调用） */
  mock: boolean;
  /** 服务端记录的端到端耗时 */
  serverMs: number;
}

/* ---------------- 设备标识（限流用） ---------------- */

/**
 * 设备 ID 只用于「每天 5 次」的配额，不做任何追踪。
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

interface SubmitResponse {
  taskId?: string;
  status?: string;
  cached?: boolean;
  size?: string;
  cost?: number;
  quotaLeft?: number;
  error?: string;
  code?: string;
}

interface StatusResponse {
  taskId?: string;
  status?: string;
  image?: string;
  size?: string;
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

async function poll(
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
    if (data.status === 'done' && data.image) return data;
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

async function decodeToRgba(dataUrl: string): Promise<AiStyleResult> {
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
    return {
      rgba: img.data,
      width: bitmap.width,
      height: bitmap.height,
      inferenceMs: 0,
    };
  } finally {
    bitmap.close();
  }
}

/* ---------------- 对外主函数 ---------------- */

export async function applyCloudStyle(opts: CloudStyleOptions): Promise<CloudStyleResult> {
  const t0 = performance.now();

  opts.onProgress?.({ phase: 'encode' });
  const encoded = await toJpegBase64(opts.rgba, opts.width, opts.height);
  const key = await cacheKey(encoded.base64);

  opts.onProgress?.({ phase: 'submit' });
  const submitted = await submit(
    {
      image: encoded.base64,
      key,
      width: encoded.width,
      height: encoded.height,
    },
    opts.signal,
  );

  const taskId = submitted.taskId!;
  const progress: CloudProgress = { phase: 'polling', elapsedMs: 0 };
  opts.onProgress?.(progress);

  const status = await poll(taskId, opts.onProgress, opts.signal);
  if (!status.image) throw new CloudError('upstream', '任务完成但没有返回图片');

  opts.onProgress?.({ phase: 'decode' });
  const decoded = await decodeToRgba(status.image);

  return {
    ...decoded,
    // 端到端耗时（编码 + 上传 + 等云端 + 解码），调试面板要看的就是它
    inferenceMs: Math.round(performance.now() - t0),
    size: status.size ?? submitted.size ?? `${decoded.width}x${decoded.height}`,
    // 服务端「提交即命中缓存」时会返回 cached + 复用同一个 taskId，
    // 此时 status.mock 可能为 undefined，用 submitted.cached 兜底
    cached: Boolean(submitted.cached ?? false),
    quotaLeft: typeof submitted.quotaLeft === 'number' ? submitted.quotaLeft : null,
    mock: Boolean(status.mock),
    serverMs: status.elapsedMs ?? (status.upstreamMs ?? 0),
  };
}

/** 从完整结果里取出 UI 需要的元信息（RGBA 留给调用方，不进 state） */
export function toCloudMeta(r: CloudStyleResult): CloudMeta {
  return {
    size: r.size,
    cached: r.cached,
    quotaLeft: r.quotaLeft,
    mock: r.mock,
    serverMs: r.serverMs,
  };
}
