/**
 * 主线程 ↔ Worker 的消息协议。
 * 单独成文件，避免主线程为了拿类型而 import 整个 worker 模块。
 */

import type { PipelineParams, PipelineOutput } from './run.ts';

export interface PipelineRequest {
  id: number;
  /** 源图 RGBA。postMessage 时会被 transfer 掉，调用方必须先拷贝。 */
  rgba: Uint8ClampedArray;
  srcWidth: number;
  srcHeight: number;
  params: PipelineParams;
  suggestColors?: boolean;
}

export type PipelineResponse =
  | { id: number; ok: true; output: PipelineOutput }
  | { id: number; ok: false; error: string };
