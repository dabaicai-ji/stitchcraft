/**
 * 模型注册表 —— 体积、哈希、输入规格、许可，全部是核实过的实测值。
 *
 * ⚠️ 运行时 URL 现在指向 GitHub raw。**生产环境必须换自建 CDN / OSS**：
 *    - raw.githubusercontent.com 在国内不稳定，直接拖慢首次体验；
 *    - 模型文件放在第三方仓库，许可与可用性都不受我们控制。
 *    换地址只改这个文件，`urls` 支持多源回退。
 */

import type { AiStyle } from './types.ts';

export interface ModelInputSpec {
  /** 输入张量名 */
  name: string;
  /** 固定边长（像素）；null 表示动态尺寸 */
  fixedSize: number | null;
  /** 数据布局：NCHW */
  layout: 'NCHW';
}

export interface ModelLicense {
  name: string;
  /** 说明文字会展示在 UI 上 */
  note: string;
}

export interface ModelSpec {
  id: string;
  style: Exclude<AiStyle, 'none'>;
  label: string;
  description: string;
  /** 按优先级排列的下载地址 */
  urls: string[];
  /** 字节数（用于进度条分母，避免依赖 Content-Length） */
  bytes: number;
  /** 完整性校验，缓存命中后也要比对，防止 CDN 返回错误页 */
  sha256: string;
  input: ModelInputSpec;
  license: ModelLicense;
}

/** AnimeGANv2 · face_paint_512_v2，实测 8,594,990 字节 */
export const MODEL_ANIME: ModelSpec = {
  id: 'animeganv2-face-paint-512',
  style: 'anime',
  label: '卡通化',
  description: 'AnimeGANv2 人脸/人像风格。512×512 固定输入，画面会变成动画笔触。',
  urls: [
    // 同源第一位：国内首开稳定，且可配 immutable 缓存头
    '/models/animeganv2-face-paint-512.onnx',
    // 回退：同源 404 时才走（只在网络/HTTP 失败时回退；sha256 不匹配会直接报错）
    'https://raw.githubusercontent.com/Kazuhito00/AnimeGANv2-ONNX-Sample/main/model/face_paint_512_v2_0.onnx',
  ],
  bytes: 8594990,
  sha256: '1381b17ed988e14a1f3cf8954d88073c0884ff4b70128ebe599f0d6021bca63e',
  input: { name: 'input_image', fixedSize: 512, layout: 'NCHW' },
  license: {
    name: 'MIT（转换仓库）+ 上游未声明',
    note:
      '【仅比赛/内测】Kazuhito00/AnimeGANv2-ONNX-Sample 为 MIT，但其上游 TachibanaYoshino/AnimeGANv2 仓库未声明 LICENSE，权重许可存在灰区。公网上线前必须替换为许可干净的模型或摘掉该功能。',
  },
};

/**
 * 像素模式**没有模型** —— 用 TS 实现（src/ai/pixelate.ts）。
 *
 * 原因：Photo2Pixel 的 ONNX 只有 23.8KB，但为了跑它要背 14.85MB（WASM）
 * ～28.75MB（WebGPU）的 onnxruntime，而且它内部也就是「平滑+下采样+边缘+量化」。
 * TS 重写后：0 额外运行时、块大小可直接对齐绣格、参数可运行时调。
 *
 * ⚠️ 实测补充：ONNX 版因为 pixel_size 固定 16（与绣格不对齐），碎片率反而变差；
 *    TS 版把块边长设成「一个绣格」后，多数图类碎片率下降 30–50%。
 */

export function modelForStyle(style: AiStyle): ModelSpec | null {
  if (style === 'anime') return MODEL_ANIME;
  return null;
}
