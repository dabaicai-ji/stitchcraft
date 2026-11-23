/**
 * Netlify Background Function：ai-style-run-background（文件名 +-background 是约定）
 *
 * 平台收到调用就立刻给调用方 202，函数本体继续执行最多 15 分钟——
 * 这正是「单张 8–15s 的 Seedream 调用」需要的东西。
 *
 * 只做一件事：跑任务。可重入：runCloudTask 内部对 done/failed 直接跳过，
 * 因为 Netlify 不保证后台函数只被触发一次。
 */

import { runCloudTask } from '../../api/_lib/aiStyle.ts';
import { BlobsTaskStore } from './_lib/blobsStore.ts';

export default async function handler(req: Request): Promise<Response> {
  let taskId = '';
  try {
    const body = (await req.json()) as { taskId?: unknown };
    taskId = typeof body.taskId === 'string' ? body.taskId : '';
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!taskId) return new Response('missing taskId', { status: 400 });

  await runCloudTask(taskId, {
    apiKey: process.env.ARK_API_KEY,
    store: new BlobsTaskStore(),
    // 后台函数里没有「再触发一次后台」的需求
    launch: () => {},
  });

  return new Response(null, { status: 202 });
}
