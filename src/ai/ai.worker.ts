/**
 * AI 风格化 Worker（常驻）。
 *
 * 为什么必须是**常驻** Worker：
 *   - 模型 8.2MB + ONNX 会话有初始化开销（实测加载 279ms），每次重建不可接受；
 *   - IndexedDB 缓存只解决「下载」，不解决「会话复用」。
 *
 * 主线程只管发 RGBA、收 RGBA；模型下载、会话、推理全在这里。
 */

import type { AiBackend, AiProgress, AiStyle } from './types.ts';
import { loadModelBytes } from './cache.ts';
import { modelForStyle } from './models.ts';
import type { ModelSpec } from './models.ts';
import { createSession, detectBackend } from './runtime.ts';
import type { SessionHandle } from './runtime.ts';
import { assertNonEmpty, postprocessAnime, preprocessAnime } from './transforms.ts';
import { pixelate } from './pixelate.ts';
import type { PixelateParams } from './pixelate.ts';

export interface WarmRequest {
  type: 'warm';
  style: AiStyle;
}

export interface RunRequest {
  type: 'run';
  id: number;
  style: AiStyle;
  rgba: ArrayBuffer;
  width: number;
  height: number;
  /** 图纸格数，pixel 模式据此推导块大小 */
  gridWidth?: number;
  gridHeight?: number;
  /** 像素模式参数；省略则按图纸格数推导（块 = 1 绣格） */
  pixelateParams?: Partial<PixelateParams>;
}

export type WorkerRequest = WarmRequest | RunRequest | { type: 'dispose' };

export type WorkerResponse =
  | { type: 'progress'; progress: AiProgress }
  | { type: 'ready'; backend: AiBackend; modelBytes: number; cached: boolean }
  | {
      type: 'result';
      id: number;
      rgba: ArrayBuffer;
      width: number;
      height: number;
      backend: AiBackend;
      inferenceMs: number;
      modelBytes: number;
    }
  | { type: 'error'; id?: number; message: string };

interface Loaded {
  handle: SessionHandle;
  spec: ModelSpec;
  inputName: string;
  outputName: string;
}

/** 按风格缓存的会话（同一时刻一般只用一种） */
const loaded = new Map<AiStyle, Loaded>();

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(
    msg,
    transfer,
  );
}

function pushProgress(progress: AiProgress): void {
  post({ type: 'progress', progress });
}

async function ensureLoaded(style: AiStyle): Promise<Loaded> {
  const existing = loaded.get(style);
  if (existing) return existing;

  const spec = modelForStyle(style);
  if (!spec) throw new Error(`未知风格：${style}`);

  pushProgress({ stage: 'downloading', ratio: 0 });
  const bytes = await loadModelBytes(spec, {
    onProgress: (loadedBytes, totalBytes) =>
      pushProgress({
        stage: 'downloading',
        ratio: totalBytes > 0 ? loadedBytes / totalBytes : null,
        loadedBytes,
        totalBytes,
      }),
  });

  pushProgress({ stage: 'compiling', ratio: null, totalBytes: spec.bytes });
  const preferred = await detectBackend();
  const handle = await createSession(bytes, preferred);

  pushProgress({ stage: 'idle', ratio: 1, backend: handle.backend });
  post({ type: 'ready', backend: handle.backend, modelBytes: spec.bytes, cached: true });

  const entry: Loaded = {
    handle,
    spec,
    inputName: spec.input.name,
    outputName: style === 'anime' ? 'output_image' : 'output',
  };
  loaded.set(style, entry);
  return entry;
}

async function run(req: RunRequest): Promise<void> {
  const rgba = new Uint8ClampedArray(req.rgba);

  // ---- 像素模式：纯 TS，不碰 ORT、不下载任何模型 ----
  if (req.style === 'pixel') {
    pushProgress({ stage: 'running', ratio: null, backend: 'cpu' });
    const t0p = performance.now();
    const params: PixelateParams = {
      pixelSize: req.pixelateParams?.pixelSize ?? derivePixelSize(req.width, req.gridWidth),
      edgeThresh: req.pixelateParams?.edgeThresh ?? 100,
      smoothRadius: req.pixelateParams?.smoothRadius ?? 2,
      levels: req.pixelateParams?.levels ?? 24,
    };
    const out = pixelate(rgba, req.width, req.height, params);
    const ms = performance.now() - t0p;
    pushProgress({ stage: 'done', ratio: 1, backend: 'cpu', message: `${ms.toFixed(0)}ms` });
    post(
      {
        type: 'result',
        id: req.id,
        rgba: out.buffer as ArrayBuffer,
        width: req.width,
        height: req.height,
        backend: 'cpu',
        inferenceMs: ms,
        modelBytes: 0,
      },
      [out.buffer as ArrayBuffer],
    );
    return;
  }

  const entry = await ensureLoaded(req.style);
  const { session, ort, backend } = entry.handle;
  pushProgress({ stage: 'running', ratio: null, backend });

  const t0 = performance.now();
  let outData: ImageData;

  if (req.style === 'anime') {
    const input = preprocessAnime(rgba, req.width, req.height);
    const tensor = new ort.Tensor('float32', input.data, input.dims);
    const feeds: Record<string, import('onnxruntime-web/webgpu').Tensor> = {
      [entry.inputName]: tensor,
    };
    const outputs = await session.run(feeds);
    const out = outputs[entry.outputName];
    outData = postprocessAnime(out.data as Float32Array, req.width, req.height);
  } else {
    throw new Error(`未实现的风格：${req.style}`);
  }

  const inferenceMs = performance.now() - t0;
  assertNonEmpty(outData, req.style === 'anime' ? '卡通化' : '像素化');

  pushProgress({ stage: 'done', ratio: 1, backend, message: `${inferenceMs.toFixed(0)}ms` });

  post(
    {
      type: 'result',
      id: req.id,
      rgba: outData.data.buffer as ArrayBuffer,
      width: outData.width,
      height: outData.height,
      backend,
      inferenceMs,
      modelBytes: entry.spec.bytes,
    },
    [outData.data.buffer as ArrayBuffer],
  );
}

/**
 * 像素块大小推导（单位：源图像素）。
 *
 * 关键：块边长必须**正好等于一个绣格**，这样像素块边界与绣格对齐，
 * 不会人为制造碎边（实测：ONNX 版固定 pixel_size=16 与绣格不对齐，
 * 碎片率 11.8% 反而比原始 12.3% 还差；对齐后多数图类下降 30–50%）。
 */
function derivePixelSize(sourceWidth: number, gridWidth?: number): number {
  if (!gridWidth || gridWidth <= 0) return 8;
  return Math.max(1, Math.round(sourceWidth / gridWidth));
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  void (async () => {
    try {
      if (req.type === 'warm') {
        await ensureLoaded(req.style);
      } else if (req.type === 'run') {
        await run(req);
      }
    } catch (err) {
      post({
        type: 'error',
        id: req.type === 'run' ? req.id : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
