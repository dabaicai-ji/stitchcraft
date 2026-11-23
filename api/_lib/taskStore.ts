/**
 * 云端风格化任务的存储抽象。
 *
 * 为什么抽一层：同一份核心逻辑要跑在三种地方——
 *   - 本地 vite dev：没有 Netlify runtime，用内存 Map（进程活着就有效）；
 *   - Netlify Functions：用 Blobs（跨实例共享，函数重启不丢）；
 *   - Node 测试脚本：也用内存 Map。
 *
 * 键空间（刻意把输入图拆成独立键）：
 *   task:<id>              任务 JSON —— 轮询只读这个，体积小（不含输入图）
 *   input:<id>             输入图 base64 —— 只有执行时才读，完成后删除
 *   cache:<sha256>         去重键 → 已完成的 taskId
 *   quota:<bucket>:<day>   当日调用次数
 *
 * 为什么不把输入图塞进任务 JSON：轮询每 2 秒一次，每次读 600KB 的 JSON
 * 纯属浪费；拆开后轮询只读 ~1KB。
 */

export type CloudTaskStatus = 'queued' | 'running' | 'done' | 'failed';

export interface CloudTask {
  id: string;
  status: CloudTaskStatus;
  /** sha256(压缩后的图 + prompt)，用于跨设备去重，命中则完全不调上游 */
  key: string;
  prompt: string;
  size: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 结果图 base64（不含 data: 前缀） */
  image?: string;
  imageMime?: string;
  imageBytes?: number;
  /** 上游调用耗时（毫秒），不含下载回流 */
  upstreamMs?: number;
  error?: string;
  /** 是否为 mock 任务（E2E 测试用，不产生真实费用） */
  mock?: boolean;
}

export interface TaskStore {
  getTask(id: string): Promise<CloudTask | null>;
  putTask(task: CloudTask): Promise<void>;
  getInput(id: string): Promise<string | null>;
  putInput(id: string, base64: string): Promise<void>;
  dropInput(id: string): Promise<void>;
  getCachedTaskId(key: string): Promise<string | null>;
  putCachedTaskId(key: string, taskId: string): Promise<void>;
  /** 某设备 / IP 在指定日期已用次数 */
  getQuota(bucket: string, day: string): Promise<number>;
  /** 用量 +1 并返回新值 */
  incrQuota(bucket: string, day: string): Promise<number>;
}

/** 内存实现：本地 dev、Node 测试用。重启即失效，这正是「本地」想要的。 */
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, CloudTask>();
  private inputs = new Map<string, string>();
  private cache = new Map<string, string>();
  private quota = new Map<string, number>();

  async getTask(id: string): Promise<CloudTask | null> {
    return this.tasks.get(id) ?? null;
  }

  async putTask(task: CloudTask): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }

  async getInput(id: string): Promise<string | null> {
    return this.inputs.get(id) ?? null;
  }

  async putInput(id: string, base64: string): Promise<void> {
    this.inputs.set(id, base64);
  }

  async dropInput(id: string): Promise<void> {
    this.inputs.delete(id);
  }

  async getCachedTaskId(key: string): Promise<string | null> {
    return this.cache.get(key) ?? null;
  }

  async putCachedTaskId(key: string, taskId: string): Promise<void> {
    this.cache.set(key, taskId);
  }

  async getQuota(bucket: string, day: string): Promise<number> {
    return this.quota.get(`${bucket}:${day}`) ?? 0;
  }

  async incrQuota(bucket: string, day: string): Promise<number> {
    const k = `${bucket}:${day}`;
    const next = (this.quota.get(k) ?? 0) + 1;
    this.quota.set(k, next);
    return next;
  }
}
