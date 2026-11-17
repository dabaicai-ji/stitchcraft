/**
 * AI 风格化的主线程 API。
 *
 * 对外只暴露两个动作：
 *   warmModel(style)    —— 开启开关时后台静默下载 + 建会话（不阻塞用户操作）
 *   applyAiStyle(...)   —— 真正跑一次推理，结果按 cacheKey 缓存
 *
 * 为什么要 cacheKey：WASM 后端单次 512² 推理实测约 2.4 秒。用户拖动「色数」滑块
 * 会触发管线重算，但**裁剪没变时风格化结果不该重算**。所以调用方用
 * 「裁剪矩形 + 风格」拼一个 key，这里直接回缓存。
 */

import type { AiBackend, AiProgress, AiStyle, AiStyleResult } from './types.ts';
import { AiUnavailableError } from './types.ts';
import type { WorkerRequest, WorkerResponse } from './ai.worker.ts';

interface Pending {
  resolve: (r: AiStyleResult) => void;
  reject: (e: unknown) => void;
  onProgress?: (p: AiProgress) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const resultCache = new Map<string, AiStyleResult>();
let lastProgress: ((p: AiProgress) => void) | null = null;
let warmWaiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
let backend: AiBackend | null = null;

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
      for (const w of warmWaiters) w.resolve();
      warmWaiters = [];
      return;
    }
    if (msg.type === 'error') {
      if (msg.id !== undefined) {
        pending.get(msg.id)?.reject(new AiUnavailableError('backend-init-failed', msg.message));
        pending.delete(msg.id);
      } else {
        for (const w of warmWaiters) w.reject(new Error(msg.message));
        warmWaiters = [];
      }
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      p.resolve({
        rgba: new Uint8ClampedArray(msg.rgba),
        width: msg.width,
        height: msg.height,
        backend: msg.backend,
        modelBytes: msg.modelBytes,
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

/** 后台预热：下载模型 + 建会话。失败不抛给调用方，只报告进度 */
export function warmModel(style: AiStyle, onProgress?: (p: AiProgress) => void): Promise<void> {
  if (style === 'none') return Promise.resolve();
  lastProgress = onProgress ?? null;
  const w = ensureWorker();
  return new Promise<void>((resolve, reject) => {
    warmWaiters.push({ resolve, reject });
    const req: WorkerRequest = { type: 'warm', style };
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
  /** 缓存键：建议用「裁剪矩形 + 风格」，同键直接回缓存不再推理 */
  cacheKey?: string;
  onProgress?: (p: AiProgress) => void;
}

export async function applyAiStyle(opts: ApplyAiStyleOptions): Promise<AiStyleResult> {
  if (opts.style === 'none') {
    return {
      rgba: opts.rgba,
      width: opts.width,
      height: opts.height,
      backend: 'wasm',
      modelBytes: 0,
      inferenceMs: 0,
      cached: true,
    };
  }

  const key = opts.cacheKey ? `${opts.style}:${opts.cacheKey}` : null;
  if (key) {
    const hit = resultCache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  lastProgress = opts.onProgress ?? null;
  const w = ensureWorker();
  const id = ++seq;

  const result = await new Promise<AiStyleResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    // 拷贝后 transfer，主线程保留原图
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
    };
    w.postMessage(req, [buf]);
  });

  if (key) resultCache.set(key, result);
  return result;
}

export function clearResultCache(): void {
  resultCache.clear();
}

/** 停掉 Worker（页面卸载或用户关闭 AI 时） */
export function disposeAi(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
  resultCache.clear();
  backend = null;
}
