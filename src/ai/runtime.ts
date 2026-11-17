/**
 * ONNX Runtime Web 的加载与后端选择。
 *
 * ⚠️ 这个文件的两个决定都是实测出来的，别改回去：
 *
 * 1) **必须先探测后端，再决定 import 哪个包。**
 *    onnxruntime-web@1.31.1 里不同入口加载的 wasm 不是同一个（实测解包 bundle 得到）：
 *      import 'onnxruntime-web'        → ort-wasm-simd-threaded.jsep.wasm      29.52 MB
 *      import 'onnxruntime-web/webgpu' → ort-wasm-simd-threaded.asyncify.wasm  28.75 MB
 *      import 'onnxruntime-web/wasm'   → ort-wasm-simd-threaded.wasm           14.85 MB
 *    如果无脑 import webgpu，**没有 WebGPU 的用户也要下 28.75MB**，
 *    比纯 WASM 路线贵 14MB。所以这里按后端动态选包。
 *
 * 2) 动态 import：这些包 + wasm 都不能进首屏包，只有用户真正开启 AI 才加载。
 *
 * 部署前提：wasm 文件由 scripts/copy-ort-wasm.ts 复制到 public/ort/
 *          （prebuild 自动执行，脚本会自检 bundle 引用的文件名是否都已复制）。
 */

import type { AiBackend } from './types.ts';

/** 只保留我们用到的 ORT 面，避免把整个类型体系拖进来 */
type OrtModule = typeof import('onnxruntime-web/webgpu');

/** 各后端实际要下载的 wasm（字节数，用于 UI 提示「首次需下载 X MB」） */
export const WASM_BYTES: Record<AiBackend, number> = {
  webgpu: 28747738, // ort-wasm-simd-threaded.asyncify.wasm
  wasm: 14848852, // ort-wasm-simd-threaded.wasm
  cpu: 0, // 像素模式纯 TS，不需要 wasm
};

/** 各后端对应的 wasm 文件名（供自检/日志用） */
export const WASM_FILE: Record<AiBackend, string> = {
  webgpu: 'ort-wasm-simd-threaded.asyncify.wasm',
  wasm: 'ort-wasm-simd-threaded.wasm',
  cpu: '(无)',
};

const ortCache = new Map<AiBackend, Promise<OrtModule>>();

export async function getOrt(backend: AiBackend): Promise<OrtModule> {
  let pending = ortCache.get(backend);
  if (!pending) {
    pending = (async () => {
      const mod =
        backend === 'webgpu'
          ? await import('onnxruntime-web/webgpu')
          : await import('onnxruntime-web/wasm');

      const ort = mod as unknown as OrtModule;
      // wasm 与 .mjs loader 由构建脚本复制到 public/ort/
      ort.env.wasm.wasmPaths = '/ort/';
      // 没有跨源隔离（COOP/COEP）时 SharedArrayBuffer 不可用，只能单线程
      const isolated =
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      ort.env.wasm.numThreads = isolated
        ? Math.min(4, navigator.hardwareConcurrency || 2)
        : 1;
      ort.env.logLevel = 'error';
      return ort;
    })();
    ortCache.set(backend, pending);
  }
  return pending;
}

/** WebGPU 探测：有 navigator.gpu 且真能拿到 adapter 才算支持 */
export async function detectBackend(): Promise<AiBackend> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return 'wasm';
    const adapter = await gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

export interface SessionHandle {
  session: import('onnxruntime-web/webgpu').InferenceSession;
  backend: AiBackend;
  ort: OrtModule;
}

/**
 * 建会话。
 *
 * executionProviders 只在**同一个包内**做算子级兜底：
 *   WebGPU 包内传 ['webgpu','wasm']，不支持的算子回落到该包自带的 wasm。
 * 整包降级（WebGPU 会话都建不起来）时，要换用 wasm 包，因为两个包的
 * wasm 二进制不同，不能混用。
 */
export async function createSession(
  modelBytes: Uint8Array,
  preferred: AiBackend,
): Promise<SessionHandle> {
  if (preferred === 'webgpu') {
    try {
      const ort = await getOrt('webgpu');
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
      return { session, backend: 'webgpu', ort };
    } catch (err) {
      console.warn('[ai] WebGPU 会话创建失败，整包降级到 WASM 包：', err);
    }
  }

  const ort = await getOrt('wasm');
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, backend: 'wasm', ort };
}

/** 首次开启 AI 的总体积估算（wasm + 模型），用于下载前提示 */
export function firstLoadBytes(backend: AiBackend, modelBytes: number): number {
  return WASM_BYTES[backend] + modelBytes;
}
