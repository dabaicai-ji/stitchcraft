/**
 * 像素化 Worker。
 *
 * 只做一件事：接 RGBA → 跑 pixelate() → 送回 RGBA。
 *
 * 为什么还留在 Worker 里：像素化要对全分辨率图做盒式模糊 + 逐像素 Sobel，
 * 1500×900 实测约 200ms，放主线程会明显卡住缩放和滚动。
 */

import { pixelate } from './pixelate.ts';
import type { PixelateParams } from './pixelate.ts';

export interface RunRequest {
  type: 'run';
  id: number;
  rgba: ArrayBuffer;
  width: number;
  height: number;
  /** 图纸格数：块边长据此对齐到一个绣格 */
  gridWidth?: number;
  /** 参数覆盖；省略则按图纸格数推导 */
  pixelateParams?: Partial<PixelateParams>;
}

export type WorkerRequest = RunRequest;

export type WorkerResponse =
  | {
      type: 'result';
      id: number;
      rgba: ArrayBuffer;
      width: number;
      height: number;
      inferenceMs: number;
    }
  | { type: 'error'; id?: number; message: string };

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(
    msg,
    transfer,
  );
}

/**
 * 像素块大小推导（单位：源图像素）。
 *
 * 关键：块边长必须**正好等于一个绣格**，这样像素块边界与绣格对齐，
 * 不会人为制造碎边（实测：固定 pixel_size 与绣格不对齐时碎片率反而更差）。
 */
function derivePixelSize(sourceWidth: number, gridWidth?: number): number {
  if (!gridWidth || gridWidth <= 0) return 8;
  return Math.max(1, Math.round(sourceWidth / gridWidth));
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type !== 'run') return;

    const t0 = performance.now();
    const rgba = new Uint8ClampedArray(req.rgba);
    const params: PixelateParams = {
      pixelSize: req.pixelateParams?.pixelSize ?? derivePixelSize(req.width, req.gridWidth),
      edgeThresh: req.pixelateParams?.edgeThresh ?? 100,
      smoothRadius: req.pixelateParams?.smoothRadius ?? 2,
      levels: req.pixelateParams?.levels ?? 24,
    };
    const out = pixelate(rgba, req.width, req.height, params);

    const expected = req.width * req.height * 4;
    if (out.length !== expected) {
      throw new Error(`像素化输出长度异常：${out.length} ≠ ${expected}`);
    }

    post(
      {
        type: 'result',
        id: req.id,
        rgba: out.buffer as ArrayBuffer,
        width: req.width,
        height: req.height,
        inferenceMs: performance.now() - t0,
      },
      [out.buffer as ArrayBuffer],
    );
  } catch (err) {
    post({
      type: 'error',
      id: req.type === 'run' ? req.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
