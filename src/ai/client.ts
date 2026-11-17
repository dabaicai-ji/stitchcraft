/**
 * AI 风格化的主线程 API。
 *
 * 对外两个动作：
 *   warmModel(style)     —— 开启卡通时下载模型 + 建会话（像素模式不需要）
 *   applyAiStyle(...)    —— 跑一次风格化，卡通结果按 cacheKey 缓存
 *
 * 两个坑（用户明确指出，已在这里规避）：
 *   1) **像素模式不走 warmModel**：它没有模型，modelForStyle 返回 null，
 *      走 warm 会抛「不需要模型」。像素是纯 TS，直接 run。
 *   2) **像素结果不缓存**：它依赖格数 + 块大小 + 边缘阈值，只按「风格+裁剪」
 *      做 key 会在改格数时命中旧结果。201ms 的代价不值得冒这个错。
 *
 * 下载重试：网络类失败重试 3 次（指数退避）；**完整性校验失败不重试**，
 * 因为那说明拿到的内容不对，重试只会重复错误。
 */

import type { AiBackend, AiProgress, AiStyle, AiStyleResult } from './types.ts';
import { AiUnavailableError } from './types.ts';
import type { WorkerRequest, WorkerResponse } from './ai.worker.ts';
import { resolveBackend } from '../lib/env.ts';

export interface WarmInfo {
  backend: AiBackend;
  modelBytes: number;
  fromCache: boolean;
  downloadMs: number;
  wasmBytes: number;
}

interface Pending {
  resolve: (r: AiStyleResult) => void;
  reject: (e: unknown) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const resultCache = new Map<string, AiStyleResult>();
let lastProgress: ((p: AiProgress) => void) | null = null;
let backend: AiBackend | null = null;

/** 完整性校验失败：不重试 */
function isIntegrityError(message: string): boolean {
  return message.includes('完整性校验') || message.includes('sha256');
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      lastProgress?.(msg.progress);
      return;
    }
    if (msg.type === 'ready') {
      backend = msg.backend;
      return;
    }
    if (msg.type === 'error') {
      if (msg.id !== undefined) {
        pending.get(msg.id)?.reject(new AiUnavailableError('backend-init-failed', msg.message));
        pending.delete(msg.id);
      }
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      backend = msg.backend;
      p.resolve({
        rgba: new Uint8ClampedArray(msg.rgba),
        width: msg.width,
        height: msg.height,
        backend: msg.backend,
        modelBytes: msg.modelBytes,
        wasmBytes: msg.wasmBytes,
        downloadMs: msg.downloadMs,
        inferenceMs: msg.inferenceMs,
        cached: false,
      });
    }
  };
  worker.onerror = (ev) => {
    const err = new AiUnavailableError('backend-init-failed', ev.message || 'AI Worker 启动失败');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

export function currentBackend(): AiBackend | null {
  return backend;
}

/**
 * 下载模型 + 建会话。像素模式直接返回（没有模型可下）。
 * 网络失败重试 3 次，间隔 800ms / 1600ms。
 */
export async function warmModel(
  style: AiStyle,
  onProgress?: (p: AiProgress) => void,
): Promise<WarmInfo> {
  if (style !== 'anime') {
    // 像素 / none：不需要下载，也没有会话
    return {
      backend: 'cpu',
      modelBytes: 0,
      fromCache: true,
      downloadMs: 0,
      wasmBytes: 0,
    };
  }

  const w = ensureWorker();
  lastProgress = onProgress ?? null;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await warmOnce(w);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isIntegrityError(message)) throw err; // 内容不对，重试没意义
      lastError = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? '模型加载失败'));
}

function warmOnce(w: Worker): Promise<WarmInfo> {
  return new Promise<WarmInfo>((resolve, reject) => {
    const handler = (ev: MessageEvent<WorkerResponse>): void => {
      const msg = ev.data;
      if (msg.type === 'ready') {
        w.removeEventListener('message', handler);
        resolve({
          backend: msg.backend,
          modelBytes: msg.modelBytes,
          fromCache: msg.fromCache,
          downloadMs: msg.downloadMs,
          wasmBytes: msg.wasmBytes,
        });
      } else if (msg.type === 'error') {
        w.removeEventListener('message', handler);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'warm', style: 'anime', backend: resolveBackend() };
    w.postMessage(req);
  });
}

export interface ApplyAiStyleOptions {
  style: AiStyle;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 图纸格数：pixel 模式据此推导像素块大小 */
  gridWidth?: number;
  gridHeight?: number;
  /** 卡通模式的缓存键（建议「裁剪矩形」）；像素模式会忽略它 */
  cacheKey?: string;
  onProgress?: (p: AiProgress) => void;
}

export async function applyAiStyle(opts: ApplyAiStyleOptions): Promise<AiStyleResult> {
  if (opts.style === 'none') {
    throw new Error('applyAiStyle 不应收到 none');
  }

  // 只有卡通走缓存；像素依赖格数与参数，缓存会返回错误结果
  const key = opts.style === 'anime' && opts.cacheKey ? `anime:${opts.cacheKey}` : null;
  if (key) {
    const hit = resultCache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  lastProgress = opts.onProgress ?? null;
  const w = ensureWorker();
  const id = ++seq;

  const result = await new Promise<AiStyleResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const buf = new Uint8ClampedArray(opts.rgba).buffer as ArrayBuffer;
    const req: WorkerRequest & { type: 'run' } = {
      type: 'run',
      id,
      style: opts.style,
      rgba: buf,
      width: opts.width,
      height: opts.height,
      gridWidth: opts.gridWidth,
      gridHeight: opts.gridHeight,
      backend: resolveBackend(),
    };
    w.postMessage(req, [buf]);
  });

  if (key) resultCache.set(key, result);
  return result;
}

export function clearResultCache(): void {
  resultCache.clear();
}

/** 停掉 Worker（用户「跳过」下载、关闭卡通、或页面卸载时） */
export function disposeAi(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
  resultCache.clear();
  backend = null;
  lastProgress = null;
}
