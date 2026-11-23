import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleInsight } from './api/_lib/insight.ts'
import { handleAiStyle, runCloudTask } from './api/_lib/aiStyle.ts'
import type { AiStyleDeps, MockMode } from './api/_lib/aiStyle.ts'
import { MemoryTaskStore } from './api/_lib/taskStore.ts'

/**
 * 本地 dev / preview 的 API 代理。
 *
 * 逻辑都在 api/_lib/（Web 标准 Request/Response），这里只做 Node req/res 桥接。
 * 上线时换成 netlify/functions 下的同名函数，前端请求路径不变。
 */
function apiProxy(
  name: string,
  path: string,
  handler: (req: Request) => Promise<Response>,
): Plugin {
  const install = (server: {
    middlewares: {
      use: (path: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void
    }
  }) => {
    server.middlewares.use(path, (req, res) => {
      void bridge(req, res, handler)
    })
  }
  return {
    name,
    configureServer: install,
    configurePreviewServer: install,
  }
}

async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (req: Request) => Promise<Response>,
): Promise<void> {
  try {
    // 必须保留 query：AI 插画靠 GET ?taskId= 轮询，丢掉就查不到任务
    const url = new URL(req.url ?? '/', 'http://localhost')
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method ?? 'GET',
      headers: {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
        // 配额按设备计数：把浏览器的设备号透传给服务端
        'x-device-id': String(req.headers['x-device-id'] ?? ''),
      },
    }
    if (req.method === 'POST') {
      init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
      init.duplex = 'half'
    }
    const response = await handler(new Request(url, init))
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

/** AI_STYLE_MOCK=echo|timeout 时启用 mock（本地验收用，线上不读） */
function parseMock(raw: string | undefined): MockMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'echo' || v === 'timeout') return v
  return null
}

/**
 * 本地没有 Netlify Background Function：用同一个 Node 进程里的 setTimeout 模拟
 * 「登记后立刻返回、后台继续跑」的语义。dev server 不退出，任务就能跑完。
 */
function createAiStyleDeps(apiKey: string | undefined, mock: MockMode): AiStyleDeps {
  const store = new MemoryTaskStore()
  const deps: AiStyleDeps = {
    apiKey,
    store,
    mock,
    launch: (taskId: string): void => {
      setTimeout(() => {
        void runCloudTask(taskId, deps)
      }, 0)
    },
  }
  return deps
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const deepseekKey = env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY
  const arkKey = env.ARK_API_KEY ?? process.env.ARK_API_KEY
  const mock = parseMock(env.AI_STYLE_MOCK ?? process.env.AI_STYLE_MOCK)
  const aiDeps = createAiStyleDeps(arkKey, mock)
  const info = buildInfo()

  return {
    plugins: [
      react(),
      apiProxy('deepseek-proxy', '/api/insight', (req) => handleInsight(req, deepseekKey)),
      apiProxy('ai-style-proxy', '/api/ai-style', (req) => handleAiStyle(req, aiDeps)),
    ],
    define: {
      __BUILD_INFO__: JSON.stringify(info),
    },
    build: {
      // pdf-lib + fontkit 是有意按需加载的大块，已单独分包
      chunkSizeWarningLimit: 1600,
    },
  }
})
