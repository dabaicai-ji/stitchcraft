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
 *   cache:<sha256>         去重键 → 用户**选中的**那个 taskId
 *   quota:<bucket>:<day>   当日已用「张数」（每次生成扣 2 张）
 *
 * 为什么不把输入图塞进任务 JSON：轮询每 1.5 秒一次，每次读 600KB 的 JSON
 * 纯属浪费；拆开后轮询只读 KB 级。
 *
 * 为什么缓存键现在指向「选中的任务」而不是「完成任务」：
 * 一次生成两张候选，只有用户点选的那张才是有效产出。未选中的候选不进缓存，
 * 否则同一张输入图第二次提交会命中一张用户从没选过的图——那是错的。
 */

export type CloudTaskStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed';

/** 候选档位：a = 极简（≤8 色、好绣）、b = 标准（≤16 色、清晰） */
export type CandidateSlot = 'a' | 'b';

/** 一次生成里的单张候选（两路各有自己的提示词与成败） */
export interface CloudCandidate {
  /** 稳定 id：c1（A）/ c2（B），前端用它回传 pick */
  id: string;
  /** 档位。缓存键按档位分离，A 的缓存不会冒领 B 的结果 */
  slot: CandidateSlot;
  ok: boolean;
  /** 结果图 base64（不含 data: 前缀），仅 ok=true 时有 */
  image?: string;
  imageMime?: string;
  imageBytes?: number;
  /** 这一路的上游耗时（毫秒） */
  upstreamMs?: number;
  error?: string;
}

export interface CloudTask {
  id: string;
  /** done = 所有待跑候选成功；partial = 至少一张成功；failed = 全部失败 */
  status: CloudTaskStatus;
  /**
   * 输入图哈希（前端只按压缩后的图算，不含 prompt）。
   * 单个候选的缓存键由它 + 档位 + 该路提示词派生（见 candidateKey）。
   */
  key: string;
  /** 本次真正要跑的档位；为空表示两路都命中缓存，无需调上游 */
  pending?: CandidateSlot[];
  /** 从缓存直接复用的候选（不必跑，也不占额度） */
  prefilled?: CloudCandidate[];
  size: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 两路候选的最终结果，按档位顺序（A 在前） */
  candidates?: CloudCandidate[];
  /** 成功候选张数（0/1/2），前端不必自己数 */
  okCount?: number;
  /** 用户点选的那张候选 id；只有 pick 之后才有值 */
  pickedId?: string;
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
  /** 某设备 / IP 在指定日期已用的张数 */
  getQuota(bucket: string, day: string): Promise<number>;
  /** 用量 +n（默认 1）并返回新值 */
  incrQuota(bucket: string, day: string, n?: number): Promise<number>;
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

  async incrQuota(bucket: string, day: string, n = 1): Promise<number> {
    const k = `${bucket}:${day}`;
    const next = (this.quota.get(k) ?? 0) + n;
    this.quota.set(k, next);
    return next;
  }
}
