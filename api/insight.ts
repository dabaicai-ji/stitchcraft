/**
 * Vercel Edge Function：/api/insight
 *
 * 和本地 dev 用的是同一份逻辑（api/_lib/insight.ts），不存在「本地能跑、
 * 上线就挂」的分叉。环境变量在 Vercel 项目 Settings → Environment Variables 里配置。
 */

import { handleInsight } from './_lib/insight.ts'

export const config = { runtime: 'edge' }

export default function handler(request: Request): Promise<Response> {
  return handleInsight(request, process.env.DEEPSEEK_API_KEY)
}
