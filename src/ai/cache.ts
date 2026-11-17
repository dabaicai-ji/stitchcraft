/**
 * 模型缓存（IndexedDB）+ 完整性校验。
 *
 * 为什么用 IndexedDB 而不是 Cache Storage：
 *   - Cache Storage 是给 HTTP 响应用的，键是 URL，模型换 CDN 就失效；
 *   - IndexedDB 可以直接存 ArrayBuffer，键用 `id@sha256前12位`，
 *     模型更新时哈希变了自然就是新键，旧条目不会污染。
 *
 * 校验：缓存命中也要比一次 sha256。成本约几十毫秒，但能挡住
 * 「CDN 返回了一个 200 的 HTML 错误页」这类事故 —— 那种情况不解码就会在
 * onnxruntime 里报一个完全看不懂的错。
 */

import type { ModelSpec } from './models.ts';

const DB_NAME = 'stitchcraft-ai';
const DB_VERSION = 1;
const STORE = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

function idbGet(key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve, reject) => {
    void openDb().then((db) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    }, reject);
  });
}

function idbPut(key: string, value: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    void openDb().then((db) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    }, reject);
  });
}

/** 缓存键：模型 id + 内容哈希前缀，模型一更新就自动失效 */
function cacheKey(spec: ModelSpec): string {
  return `${spec.id}@${spec.sha256.slice(0, 12)}`;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface LoadModelOptions {
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * 取模型字节：先查 IndexedDB，未命中再按 urls 顺序下载。
 * 两条路径都做 sha256 校验。
 */
export async function loadModelBytes(
  spec: ModelSpec,
  opts: LoadModelOptions = {},
): Promise<Uint8Array> {
  const key = cacheKey(spec);

  const cached = await idbGet(key);
  if (cached) {
    if ((await sha256Hex(cached)) === spec.sha256) {
      opts.onProgress?.(cached.byteLength, cached.byteLength);
      return new Uint8Array(cached);
    }
    // 缓存损坏：当作未命中，走下载覆盖
  }

  let lastError: unknown = null;
  for (const url of spec.urls) {
    try {
      const buf = await downloadWithProgress(url, spec.bytes, opts);
      if ((await sha256Hex(buf)) !== spec.sha256) {
        throw new Error('模型校验失败（sha256 不匹配，可能是 CDN 返回了错误页）');
      }
      await idbPut(key, buf);
      return new Uint8Array(buf);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastError = err;
    }
  }

  throw new Error(
    `模型下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function downloadWithProgress(
  url: string,
  expectedBytes: number,
  opts: LoadModelOptions,
): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || expectedBytes;
  if (!res.body) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    opts.onProgress?.(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** 供设置页展示「已缓存多少」用 */
export async function clearModelCache(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}
