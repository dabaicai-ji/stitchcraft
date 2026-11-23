/**
 * Netlify Blobs 版 TaskStore。
 *
 * 为什么用 Blobs 而不是内存：Functions 每个请求可能在**不同的实例**里执行
 * （提交、background 执行、轮询查询是三次独立调用），内存 Map 在线上等于不共享。
 * Blobs 免费额度 1GB，存「任务 JSON + 输入图 + 结果图」完全够。
 *
 * 为什么不在本地也用 Blobs：vite dev 里没有 Netlify runtime，getStore() 拿不到
 * siteID/token。所以本地用 MemoryTaskStore（见 api/_lib/taskStore.ts），
 * 两边实现同一个接口——核心逻辑不需要知道自己在哪。
 *
 * key 分隔符的坑：核心逻辑里写的是 `task:<id>` / `dev:<deviceId>` 这种冒号分隔，
 * 但 Blobs 的 key 只允许 字母数字 与 `/ . - _`，冒号会直接被拒。
 * 这里统一把冒号换成 `/`，键空间语义不变。
 */

import { getStore } from '@netlify/blobs';
import type { CloudTask, TaskStore } from '../../../api/_lib/taskStore.ts';

/** Blobs key 不允许冒号及其它特殊字符，统一降级成 `/` */
function blobKey(key: string): string {
  return key.replace(/[^A-Za-z0-9/._-]/g, '/');
}

const STORE_NAME = 'ai-style';

export class BlobsTaskStore implements TaskStore {
  // getStore 在 Netlify runtime 里会自动注入站点上下文，不需要显式传 siteID/token
  private readonly store = getStore({ name: STORE_NAME });

  async getTask(id: string): Promise<CloudTask | null> {
    // 显式 type: 'text'：@netlify/blobs 的重载里第一个是 { type?: 'arrayBuffer' }
    // 且参数可选，单参数调用会被它吃掉、返回 ArrayBuffer（类型定义的老问题）。
    const raw = await this.store.get(blobKey(`task:${id}`), { type: 'text' });
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CloudTask;
    } catch {
      // 被写坏的条目当作不存在，宁可重算也不要抛一个看不懂的错
      return null;
    }
  }

  async putTask(task: CloudTask): Promise<void> {
    await this.store.set(blobKey(`task:${task.id}`), JSON.stringify(task));
  }

  async getInput(id: string): Promise<string | null> {
    return this.store.get(blobKey(`input:${id}`), { type: 'text' });
  }

  async putInput(id: string, base64: string): Promise<void> {
    await this.store.set(blobKey(`input:${id}`), base64);
  }

  async dropInput(id: string): Promise<void> {
    await this.store.delete(blobKey(`input:${id}`));
  }

  async getCachedTaskId(key: string): Promise<string | null> {
    return this.store.get(blobKey(`cache:${key}`), { type: 'text' });
  }

  async putCachedTaskId(key: string, taskId: string): Promise<void> {
    await this.store.set(blobKey(`cache:${key}`), taskId);
  }

  async getQuota(bucket: string, day: string): Promise<number> {
    const raw = await this.store.get(blobKey(`quota:${bucket}:${day}`), { type: 'text' });
    const n = Number(raw ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * 读-改-写，非原子。
   *
   * Blobs 没有 compare-and-swap，并发下可能少计几次。这里的取舍：
   * 同一个人手点「AI 插画」的并发窗口是秒级，撞上的概率远低于「为此引入
   * 一个 Durable Object / KV 原子计数」的成本。护栏目的是拦住刷量，不是
   * 做精确计费——真要精确计费应该以云厂商账单为准。
   */
  async incrQuota(bucket: string, day: string, n = 1): Promise<number> {
    const k = blobKey(`quota:${bucket}:${day}`);
    const current = Number((await this.store.get(k)) ?? 0) || 0;
    const next = current + n;
    await this.store.set(k, String(next));
    return next;
  }
}
