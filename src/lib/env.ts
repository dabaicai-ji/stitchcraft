/**
 * 运行环境信息：构建版本、URL 开关、设备能力。
 *
 * URL 开关（都不需要改代码，手机上一行参数就能测）：
 *   ?backend=webgpu  强制 WebGPU（默认纯 WASM）
 *   ?debug=1         显示调试面板（后端/下载/推理耗时/缓存/设备内存）
 */

import type { AiBackend } from '../ai/types.ts';

export const BUILD_INFO =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { hash: 'dev', time: '—' };

const params = new URLSearchParams(
  typeof location !== 'undefined' ? location.search : '',
);

export const debugEnabled =
  params.get('debug') === '1' || params.get('debug') === 'true';

/**
 * 默认 **纯 WASM**（首开 23MB）。
 * WebGPU 是隐藏开关：有真机数据证明「至少快 2 倍」之前不翻默认值。
 */
export function resolveBackend(): AiBackend {
  return params.get('backend') === 'webgpu' ? 'webgpu' : 'wasm';
}

/** navigator.deviceMemory（单位 GB，仅 Chromium 系支持） */
export function deviceMemoryGb(): number | null {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof dm === 'number' ? dm : null;
}

/** 给调试面板用的一行摘要 */
export function deviceLine(): string {
  const mem = deviceMemoryGb();
  const cores = navigator.hardwareConcurrency ?? 0;
  return `${cores} 核 · ${mem ? `${mem} GB` : '内存未知'}`;
}
