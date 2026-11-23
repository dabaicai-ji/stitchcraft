/**
 * 运行环境信息：构建版本、URL 开关、设备能力。
 *
 * URL 开关（都不需要改代码，手机上一行参数就能测）：
 *   ?debug=1         显示调试面板（处理耗时 / 设备）
 *
 * 本地 ONNX 时代还有 `?backend=webgpu` 这个隐藏开关，随卡通分支一起下线了：
 * 像素模式是纯 TS，没有推理后端可选。
 */

export const BUILD_INFO =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { hash: 'dev', time: '—' };

const params = new URLSearchParams(
  typeof location !== 'undefined' ? location.search : '',
);

export const debugEnabled =
  params.get('debug') === '1' || params.get('debug') === 'true';

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
