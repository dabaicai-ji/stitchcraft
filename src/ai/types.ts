/**
 * 风格化的公共类型。
 *
 * 本模块只剩**像素模式**：纯 TS 实现（pixelate.ts），0 下载、0 外部运行时。
 *
 * 本地 ONNX 卡通分支（AnimeGANv2 + onnxruntime-web）已按 2026-11-17 的决定下线：
 * 实测它在多数档位并不降低碎片率，却要背 8.2MB 模型 + 14.9~28.8MB wasm，
 * 且上游权重许可存在灰区。决策与实测数据见 AI_STYLIZE.md。
 */

/** 风格选项。none = 不启用风格化，走原有管线 */
export type AiStyle = 'none' | 'pixel';

/** 处理阶段（像素模式没有下载与编译，只有运行） */
export type AiStage = 'idle' | 'running' | 'done' | 'error';

export interface AiProgress {
  stage: AiStage;
  message?: string;
}

export interface AiStyleResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 处理耗时（毫秒） */
  inferenceMs: number;
}
