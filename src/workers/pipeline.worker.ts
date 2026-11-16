/**
 * 管线 Worker。
 *
 * 为什么必须放 Worker：400 格 + 40 色的 k-means 最坏要 1 秒左右，
 * 放主线程会让 slider 拖动卡成幻灯片。Worker 里跑，UI 全程可交互。
 *
 * 传输策略：
 *   - 源图用 transfer 送进来（零拷贝），主线程保留自己的副本用于参数重跑；
 *   - cells 用 transfer 送回去（160k 个 Int16 = 320KB）。
 */

import { runPipeline } from '../core/pipeline/run.ts';
import type { PipelineRequest, PipelineResponse } from '../core/pipeline/protocol.ts';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<PipelineRequest>) => void) | null;
  postMessage(message: PipelineResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (ev: MessageEvent<PipelineRequest>) => {
  const req = ev.data;
  try {
    const output = runPipeline({
      rgba: req.rgba,
      srcWidth: req.srcWidth,
      srcHeight: req.srcHeight,
      params: req.params,
      suggestColors: req.suggestColors,
    });
    const transfer: Transferable[] = [output.grid.cells.buffer as ArrayBuffer];
    scope.postMessage({ id: req.id, ok: true, output }, transfer);
  } catch (err) {
    scope.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
