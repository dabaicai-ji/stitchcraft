/**
 * Worker 客户端：一次调用一个 Worker，拿到结果就 terminate。
 *
 * 为什么不用常驻 Worker：管道是有状态的（像素缓冲），常驻需要自己管理生命周期和
 * 请求排队，容易泄漏；每次新建的启动成本约 2–5ms，在「拖 slider」这个场景下完全可接受。
 * 支持 AbortSignal：参数连续变化时上一次计算直接终止，避免旧结果覆盖新结果。
 */

import type { PipelineOutput, PipelineParams } from '../core/pipeline/run.ts';
import type { PipelineRequest, PipelineResponse } from '../core/pipeline/protocol.ts';

let seq = 0;

export interface RunOptions {
  rgba: Uint8ClampedArray;
  srcWidth: number;
  srcHeight: number;
  params: PipelineParams;
  suggestColors?: boolean;
  signal?: AbortSignal;
}

export function runPipelineInWorker(opts: RunOptions): Promise<PipelineOutput> {
  return new Promise<PipelineOutput>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }

    const worker = new Worker(
      new URL('../workers/pipeline.worker.ts', import.meta.url),
      { type: 'module' },
    );

    const id = ++seq;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = (): void => {
      finish(() => reject(new DOMException('已取消', 'AbortError')));
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (ev: MessageEvent<PipelineResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.ok) {
        finish(() => resolve(msg.output));
      } else {
        finish(() => reject(new Error(msg.error)));
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      finish(() => reject(new Error(ev.message || 'Worker 运行失败')));
    };

    // 拷贝一份再 transfer，主线程保留原图以便改参数重跑
    const rgba = new Uint8ClampedArray(opts.rgba);
    const req: PipelineRequest = {
      id,
      rgba,
      srcWidth: opts.srcWidth,
      srcHeight: opts.srcHeight,
      params: opts.params,
      suggestColors: opts.suggestColors,
    };

    worker.postMessage(req, [rgba.buffer as ArrayBuffer]);
  });
}
