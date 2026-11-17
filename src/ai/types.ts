/**
 * AI 风格化的公共类型。
 *
 * 设计前提（都是实测出来的，不是假设）：
 *   - AnimeGANv2 ONNX 输入是**固定** [1,3,512,512]，不吃其他尺寸；
 *   - Photo2Pixel ONNX 输入是**动态**的 [1,3,H,W]，外加三个运行时标量参数；
 *   - WASM 后端一次 512×512 推理约 2.4 秒（Node 实测），所以结果必须缓存，
 *     不能每次改色数都重跑。
 */

/** 风格选项。none = 走现有 stylize 管线，不加载任何模型 */
export type AiStyle = 'none' | 'anime' | 'pixel';

/** 推理后端 */
export type AiBackend = 'webgpu' | 'wasm';

/** 模型下载 / 加载 / 推理的阶段，用于 UI 进度 */
export type AiStage = 'idle' | 'downloading' | 'compiling' | 'running' | 'done' | 'error';

export interface AiProgress {
  stage: AiStage;
  /** 0..1，未知时为 null */
  ratio: number | null;
  loadedBytes?: number;
  totalBytes?: number;
  backend?: AiBackend;
  message?: string;
}

export interface AiStyleResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  backend: AiBackend;
  /** 模型体积（字节），用于在 UI 上说明「下载了多少」 */
  modelBytes: number;
  /** 推理耗时（毫秒） */
  inferenceMs: number;
  /** 是否命中了缓存（同一张裁剪图重复请求时为 true） */
  cached: boolean;
}

export class AiUnavailableError extends Error {
  readonly reason: 'model-download-failed' | 'backend-init-failed' | 'unsupported' | 'aborted';
  constructor(reason: AiUnavailableError['reason'], message: string) {
    super(message);
    this.name = 'AiUnavailableError';
    this.reason = reason;
  }
}
