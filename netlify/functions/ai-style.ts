/**
 * Netlify Function：/api/ai-style（路径由 netlify.toml 映射）
 *
 * 两种方法同一个函数：
 *   POST          登记任务 + 触发 background function，立刻返回 taskId
 *   GET ?taskId=  读任务状态（轮询）
 *
 * 为什么 POST 不在这里直接调火山：Seedream 单张 8–15s，Netlify 普通 Function
 * 免费版 10s 就切断。真正干活的是 ai-style-run-background（同名 +-background，
 * 最长 15 分钟）。
 *
 * 环境变量：ARK_API_KEY（只在这里读，前端永远拿不到）
 */

import { handleAiStyle, parseUnlimitedDevices } from '../../api/_lib/aiStyle.ts';
import { BlobsTaskStore } from './_lib/blobsStore.ts';

/** Netlify 注入的站点地址（e.g. https://xxx.netlify.app），用于回调自己的后台函数 */
const SELF_BASE = process.env.URL ?? '';

/**
 * 免配额设备名单（开发机 / 演示机）。
 * 只在这里从环境变量读出来，**不向前端暴露名单内容**：
 * 前端只能通过提交/轮询响应里的 `unlimited: true|false` 知道「自己是否命中」。
 */
const UNLIMITED_DEVICES = parseUnlimitedDevices(process.env.AI_STYLE_UNLIMITED_DEVICE_IDS);

export default async function handler(req: Request): Promise<Response> {
  return handleAiStyle(req, {
    apiKey: process.env.ARK_API_KEY,
    store: new BlobsTaskStore(),
    unlimitedDeviceIds: UNLIMITED_DEVICES,
    launch: async (taskId: string): Promise<void> => {
      if (!SELF_BASE) {
        throw new Error('缺少 Netlify 的 URL 环境变量，无法触发后台函数');
      }
      const res = await fetch(`${SELF_BASE}/.netlify/functions/ai-style-run-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      // 202 = 平台已接收。此时任务还在后台跑，前端继续轮询 GET。
      if (!res.ok) throw new Error(`触发后台任务失败 HTTP ${res.status}`);
    },
  });
}
