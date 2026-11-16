/**
 * 浏览器端加载 PDF 中文字体子集。
 *
 * 字体文件由 `npm run font:build` 生成到 public/fonts/，
 * 只含 PDF 用到的 ~90 个字符，约 9KB（完整 Noto Sans SC 是 7.95MB）。
 * 加载失败时返回 null，导出会自动降级为英文标签，不会整页报错。
 */

let cache: Promise<Uint8Array | null> | null = null;

export function loadPdfFont(): Promise<Uint8Array | null> {
  if (!cache) {
    cache = fetch('/fonts/noto-sans-sc-subset.ttf')
      .then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
      .catch(() => null);
  }
  return cache;
}
