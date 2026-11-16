/**
 * Netlify Edge Function：/api/insight（路径由 netlify.toml 映射）
 *
 * Netlify 的 Edge Runtime 是 Deno，环境变量用 Netlify.env.get() 读，
 * 不能直接用 process.env。除这一行外逻辑与 Vercel 版完全一致。
 */

import { handleInsight } from '../../api/_lib/insight.ts'

// Deno 运行时提供的 Netlify 全局对象，这里给出最小声明以便 TypeScript 检查
declare const Netlify: { env: { get(name: string): string | undefined } }

export default function handler(request: Request): Promise<Response> {
  return handleInsight(request, Netlify.env.get('DEEPSEEK_API_KEY'))
}
