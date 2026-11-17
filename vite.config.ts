import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleInsight } from './api/_lib/insight.ts'

/**
 * 本地 dev / preview 的 DeepSeek 代理。
 * 逻辑在 api/_lib/insight.ts（Web 标准），这里只做 Node req/res 桥接。
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
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
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

/** 构建版本：git 短哈希 + 构建时间。手机上一眼确认打开的是不是最新部署。 */
function buildInfo(): { hash: string; time: string } {
  let hash = 'nogit'
  try {
    hash = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // 非 git 环境（比如只拿到 dist）就用时间戳兜底
  }
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    hash,
    time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/**
 * 跨源隔离开关：开启后 SharedArrayBuffer 可用 → onnxruntime 多线程（numThreads 可到 4）。
 * 本地也开，才能复现线上行为。风险：COEP 会拦掉没有 CORP 头的跨域资源。
 * 站内资源（模型/字体/wasm/api）都是同源，理论上安全。
 */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY
  const info = buildInfo()

  return {
    plugins: [react(), deepseekProxy(apiKey)],
    define: {
      __BUILD_INFO__: JSON.stringify(info),
    },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    build: {
      // pdf-lib + fontkit 是有意按需加载的大块，已单独分包
      chunkSizeWarningLimit: 1600,
    },
  }
})
