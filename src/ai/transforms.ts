/**
 * 各模型的预处理 / 后处理。
 *
 * AnimeGANv2 的数值约定来自官方推理样例（Kazuhito00 sample_onnx.py），不是猜的：
 *   预处理：resize → BGR2RGB → x/255*2-1 → NCHW
 *   后处理：(y*0.5+0.5).clip(0,1)*255 → HWC
 * 我们已经实测：输入固定 512×512，输出 [1,3,512,512]，输出值域约 [-1,1]。
 *
 * 尺寸策略：官方样例是先**中心裁成正方形**再缩放。对我们不合适 ——
 * 十字绣成品图不能丢内容。所以改成「压扁到 512²」再在输出端压回原比例：
 * 模型看到的画面形变，但内容一点不丢，而且前后两次形变互相抵消。
 * 如果实测发现人脸/建筑变形影响观感，再换成「等比缩放 + 边缘镜像补边」。
 */

/** 用 OffscreenCanvas 做高质量缩放（浏览器内部用硬件/优化路径，比手写滤镜快） */
function resizeImageData(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): ImageData {
  const srcCanvas = new OffscreenCanvas(sw, sh);
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('OffscreenCanvas 2D 不可用');
  srcCtx.putImageData(new ImageData(new Uint8ClampedArray(src), sw, sh), 0, 0);

  const dstCanvas = new OffscreenCanvas(dw, dh);
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) throw new Error('OffscreenCanvas 2D 不可用');
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = 'high';
  dstCtx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, dw, dh);
  return dstCtx.getImageData(0, 0, dw, dh);
}

/* ------------------------------------------------------------------ */
/* AnimeGANv2                                                          */
/* ------------------------------------------------------------------ */

export const ANIME_INPUT_SIZE = 512;

export interface AnimeInput {
  data: Float32Array;
  dims: [number, number, number, number];
}

/** RGBA（任意宽高）→ [1,3,512,512] 的 [-1,1] NCHW 张量 */
export function preprocessAnime(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): AnimeInput {
  const img = resizeImageData(rgba, width, height, ANIME_INPUT_SIZE, ANIME_INPUT_SIZE);
  const px = img.data;
  const n = ANIME_INPUT_SIZE * ANIME_INPUT_SIZE;
  const out = new Float32Array(3 * n);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // x/255 * 2 - 1
    out[i] = (px[o] / 255) * 2 - 1;
    out[n + i] = (px[o + 1] / 255) * 2 - 1;
    out[2 * n + i] = (px[o + 2] / 255) * 2 - 1;
  }

  return { data: out, dims: [1, 3, ANIME_INPUT_SIZE, ANIME_INPUT_SIZE] };
}

/** [1,3,512,512] 的 tanh 输出 → 原比例 RGBA */
export function postprocessAnime(
  output: Float32Array,
  targetWidth: number,
  targetHeight: number,
): ImageData {
  const size = ANIME_INPUT_SIZE;
  const n = size * size;
  const rgb = new Uint8ClampedArray(n * 4);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // (y*0.5+0.5) 后乘 255
    rgb[o] = Math.round((output[i] * 0.5 + 0.5) * 255);
    rgb[o + 1] = Math.round((output[n + i] * 0.5 + 0.5) * 255);
    rgb[o + 2] = Math.round((output[2 * n + i] * 0.5 + 0.5) * 255);
    rgb[o + 3] = 255;
  }

  return resizeImageData(rgb, size, size, targetWidth, targetHeight);
}

/* ------------------------------------------------------------------ */
/* Photo2Pixel                                                         */
/* ------------------------------------------------------------------ */

export interface PixelParams {
  kernelSize: number;
  pixelSize: number;
  edgeThresh: number;
}

/**
 * Photo2Pixel 输入：动态 [1,3,H,W] + 三个标量。
 *
 * ⚠️ 实测结论（已用真实照片验证）：
 *    - 该模型对输入尺度是等变的，但 `param_edge_thresh` 的语义是 0~255，
 *      所以**必须传 0..255 归一化**，传 0..1 时边缘阈值永远不触发，输出会被抹平。
 *    - 实测 0..255 输入 → 输出范围 [0, 253.8]（含纯黑描边），符合预期。
 */
export function preprocessPixel(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): { data: Float32Array; dims: [number, number, number, number] } {
  const n = width * height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = rgba[o];
    out[n + i] = rgba[o + 1];
    out[2 * n + i] = rgba[o + 2];
  }
  return { data: out, dims: [1, 3, height, width] };
}

export function postprocessPixel(
  output: Float32Array,
  dims: readonly number[],
): ImageData {
  const height = dims[2];
  const width = dims[3];
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  // 与输入同量纲：0..255
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    rgba[o] = Math.round(output[i]);
    rgba[o + 1] = Math.round(output[n + i]);
    rgba[o + 2] = Math.round(output[2 * n + i]);
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

/** 零尺寸校验：模型的动态输出偶尔会给出 0，直接抛比让后续算管道崩更好 */
export function assertNonEmpty(img: ImageData, what: string): void {
  if (img.width <= 0 || img.height <= 0) {
    throw new Error(`${what} 输出为空（${img.width}×${img.height}）`);
  }
}
