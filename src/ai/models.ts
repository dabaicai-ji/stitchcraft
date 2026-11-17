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
    'https://raw.githubusercontent.com/Kazuhito00/AnimeGANv2-ONNX-Sample/main/model/face_paint_512_v2_0.onnx',
  ],
  bytes: 8594990,
  sha256: '1381b17ed988e14a1f3cf8954d88073c0884ff4b70128ebe599f0d6021bca63e',
  input: { name: 'input_image', fixedSize: 512, layout: 'NCHW' },
  license: {
    name: 'MIT（转换仓库）+ 上游未声明',
    note:
      'Kazuhito00/AnimeGANv2-ONNX-Sample 为 MIT；但其上游 TachibanaYoshino/AnimeGANv2 仓库未声明 LICENSE，权重许可存在灰区。比赛/内测可用，商业发布前需替换或取得授权。',
  },
};

/**
 * Photo2Pixel 参数化模型，实测 24,382 字节。
 * 输入 rgb 为动态 [1,3,H,W]，另有三个标量参数控制像素块大小与边缘。
 */
export const MODEL_PIXEL: ModelSpec = {
  id: 'photo2pixel-param',
  style: 'pixel',
  label: '像素化',
  description: 'Photo2Pixel 参数化模型（23.8KB）。动态尺寸，按目标格数直接出图，边缘加深。',
  urls: ['https://raw.githubusercontent.com/Jzou44/photo2pixel/main/photo2pixel.onnx'],
  bytes: 24382,
  sha256: '8c48dcad0b9872937efbf4ae61bf40c23ce410e23dcffed1767a2ba8d6d74d21',
  input: { name: 'rgb', fixedSize: null, layout: 'NCHW' },
  license: {
    name: 'Apache-2.0',
    note: 'Jzou44/photo2pixel 为 Apache-2.0，可商用，需保留许可声明。',
  },
};

/** Photo2Pixel 的运行时标量参数默认值（对应它 CLI 的默认配置） */
export const PIXEL_DEFAULTS = {
  kernelSize: 10,
  pixelSize: 16,
  edgeThresh: 100,
} as const;

export function modelForStyle(style: AiStyle): ModelSpec | null {
  if (style === 'anime') return MODEL_ANIME;
  if (style === 'pixel') return MODEL_PIXEL;
  return null;
}
