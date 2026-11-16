import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleInsight } from './api/_lib/insight.ts'

/**
 * 本地 dev / preview 的 DeepSeek 代理。
 *
 * 真正的逻辑在 api/_lib/insight.ts（Web 标准 Request/Response），
 * 这里只做一层 Node req/res ↔ Web 的桥接。这样同一份代码
 * 既能在本地跑，也能直接部署到 Vercel / Netlify 的 Edge Runtime。
 */
function deepseekProxy(apiKey: string | undefined): Plugin {
  const install = (server: {
    middlewares: {
      use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void
    }
  }) => {
    server.middlewares.use('/api/insight', (req, res) => {
      void bridge(req, res, apiKey)
    })
  }

  return {
    name: 'deepseek-proxy',
    configureServer: install,
    configurePreviewServer: install,
  }
}

async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string | undefined,
): Promise<void> {
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method ?? 'GET',
      headers: {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
      },
    }

    if (req.method === 'POST') {
      // 请求体以流的方式转给 Web Request，不整段读进内存
      init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
      init.duplex = 'half'
    }

    const response = await handleInsight(
      new Request('http://localhost/api/insight', init),
      apiKey,
    )

    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))

    if (response.body) {
      Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      ).pipe(res)
    } else {
      res.end()
    }
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
    }
    res.end(
      JSON.stringify({
        error: `代理内部错误：${err instanceof Error ? err.message : String(err)}`,
      }),
    )
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY

  return {
    plugins: [react(), deepseekProxy(apiKey)],
    build: {
      // pdf-lib + fontkit 是有意按需加载的大块（点「导出 PDF」才下载），
      // 已经单独分包，不需要再对主包体积告警。
      chunkSizeWarningLimit: 1600,
    },
  }
})
