/**
 * 像素风格化的主线程 API。
 *
 * 只有一个动作：把 RGBA 丢给常驻 Worker，拿回像素化后的 RGBA。
 *
 * 两条设计约束：
 *   1) **不缓存结果**：像素化依赖格数 + 块大小 + 边缘阈值，只按「风格 + 裁剪」
 *      做 key 会在改格数时命中旧结果。200ms 的代价不值得冒这个错。
 *   2) **Worker 常驻**：反复开关风格、拖参数时不必反复创建线程。
 */

import type { AiStyleResult } from './types.ts';
import type { WorkerRequest, WorkerResponse } from './ai.worker.ts';
import type { PixelateParams } from './pixelate.ts';

interface Pending {
  resolve: (r: AiStyleResult) => void;
  reject: (e: unknown) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'error') {
      if (msg.id !== undefined) {
        pending.get(msg.id)?.reject(new Error(msg.message));
        pending.delete(msg.id);
      }
      return;
    }
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    p.resolve({
      rgba: new Uint8ClampedArray(msg.rgba),
      width: msg.width,
      height: msg.height,
      inferenceMs: msg.inferenceMs,
    });
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || '像素化 Worker 启动失败');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

export interface ApplyPixelStyleOptions {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 图纸格数：块边长据此对齐到一个绣格 */
  gridWidth?: number;
  /** 参数覆盖（UI 暂未暴露，保留给后续「像素块大小」滑块） */
  pixelateParams?: Partial<PixelateParams>;
}

export async function applyPixelStyle(opts: ApplyPixelStyleOptions): Promise<AiStyleResult> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<AiStyleResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // 送一份拷贝，源 RGBA 主线程还要留着（关闭风格化后要能回到原图）
    const buf = new Uint8ClampedArray(opts.rgba).buffer as ArrayBuffer;
    const req: WorkerRequest = {
      type: 'run',
      id,
      rgba: buf,
      width: opts.width,
      height: opts.height,
      gridWidth: opts.gridWidth,
      pixelateParams: opts.pixelateParams,
    };
    w.postMessage(req, [buf]);
  });
}

/** 停掉 Worker（关闭风格化 / 页面卸载时） */
export function disposeAi(): void {
  worker?.terminate();
  worker = null;
  pending.clear();
}
