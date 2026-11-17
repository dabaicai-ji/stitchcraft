/**
 * ONNX Runtime Web 的加载与后端选择。
 *
 * 为什么用动态 import：onnxruntime-web 的 webgpu bundle 单独就有 120KB 的 JS，
 * 配套 wasm 是 14.85MB（WASM 版）/ 29.52MB（jsep 版，WebGPU 用）。这些必须在
 * 用户真正开启 AI 时才加载，不能进首屏包。
 *
 * ⚠️ 部署前提：wasm 文件要放在站点根下的 /ort/（scripts/copy-ort-wasm.ts 负责复制）。
 *    另外多线程 WASM 需要 COOP/COEP 响应头，没有的话 numThreads 会被降到 1。
 *    这两点都会影响「冷启动 2.4s」这个数字能不能压下来。
 */

import type { AiBackend } from './types.ts';

/** 只保留我们用到的 ORT 面，避免把整个类型体系拖进来 */
type OrtModule = typeof import('onnxruntime-web/webgpu');

let ortPromise: Promise<OrtModule> | null = null;

export async function getOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const ort = await import('onnxruntime-web/webgpu');
      // wasm 与 mjs 由构建脚本复制到 public/ort/
      ort.env.wasm.wasmPaths = '/ort/';
      // 没有跨源隔离（COOP/COEP）时 SharedArrayBuffer 不可用，只能单线程
      const isolated =
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      ort.env.logLevel = 'error';
      return ort;
    })();
  }
  return ortPromise;
}

/** WebGPU 探测：有 navigator.gpu 且真能拿到 adapter 才算支持 */
export async function detectBackend(): Promise<AiBackend> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
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
  /** 实际生效的执行后端（WebGPU 初始化失败会降级） */
  ort: OrtModule;
}

/**
 * 建会话。优先 WebGPU，失败自动降级 WASM。
 *
 * 注意 executionProviders 传的是**数组**：`['webgpu','wasm']` 表示
 * WebGPU 不支持的算子交给 WASM 兜底，这比整模型回退更稳。
 */
export async function createSession(
  modelBytes: Uint8Array,
  preferred: AiBackend,
): Promise<SessionHandle> {
  const ort = await getOrt();

  if (preferred === 'webgpu') {
    try {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
      return { session, backend: 'webgpu', ort };
    } catch (err) {
      console.warn('[ai] WebGPU 会话创建失败，回退 WASM：', err);
    }
  }

  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, backend: 'wasm', ort };
}
