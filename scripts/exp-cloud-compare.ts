/**
 * 云端图生图横评（只跑对比，不动产品代码）。
 *
 *   node scripts/exp-cloud-compare.ts --dry-run          # 校验密钥/参数，不发请求
 *   node scripts/exp-cloud-compare.ts --only=ark         # 只跑火山
 *   node scripts/exp-cloud-compare.ts --image=landscape --samples=3
 *
 * 密钥（写在 stitchcraft/.env.local，已 gitignore）：
 *   ARK_API_KEY=...           火山方舟（Seedream 4.0）
 *   DASHSCOPE_API_KEY=sk-...  阿里云百炼（wanx2.1-imageedit）—— 注意是 sk- 开头的 API Key，
 *                             不是阿里云 AccessKey ID/Secret（那对是 RAM 签名用的，不能当 Bearer）
 *
 * 产物：.data/cloud-compare/<provider>-<n>.<ext> + manifest.json
 * 之后用 scripts/compose-cloud-compare.py 合成对比图。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(root, '.data/cloud-compare')
mkdirSync(OUT, { recursive: true })

/* ---------------- 参数 ---------------- */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)
const DRY = args['dry-run'] === 'true'
const ONLY = args.only ?? 'ark,dashscope'
const SAMPLES = Number(args.samples ?? 3)
const IMAGE_TAG = args.image ?? 'pet'

/** 统一提示词：给十字绣用的扁平插画风 */
const PROMPT =
  '把这张照片改成扁平插画风，硬边大色块，保留主体轮廓与构图，去掉背景杂物和细碎纹理，颜色不超过 12 种，不要文字和边框'

/* ---------------- 读取密钥（手动解析 .env.local，不引依赖） ---------------- */

function loadEnvLocal(): Record<string, string> {
  const p = resolve(root, '.env.local')
  if (!existsSync(p)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}
const env = loadEnvLocal()

/* ---------------- 图片 ---------------- */

interface ImgMeta {
  tag: string
  width: number
  height: number
}
const images = JSON.parse(
  readFileSync(resolve(root, '.data/ai-images.json'), 'utf8'),
) as ImgMeta[]

/** 源 JPEG（base64 直传需要编码后的图，raw 不行） */
const SRC: Record<string, string> = {
  pet: resolve(root, '.data/src-pet.jpg'),
  portrait: resolve(root, '.data/src-portrait.jpg'),
  landscape: resolve(root, '../../dufe-ppt/assets/raw/dufe_official_1.jpg'),
}

const srcPath = SRC[IMAGE_TAG]
if (!srcPath || !existsSync(srcPath)) {
  console.error(`找不到 ${IMAGE_TAG} 的源图：${srcPath}`)
  process.exit(1)
}
const srcBuf = readFileSync(srcPath)
const mime = extname(srcPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
const dataUrl = `data:${mime};base64,${srcBuf.toString('base64')}`
const meta = images.find((i) => i.tag === IMAGE_TAG)
const aspect = meta ? meta.width / meta.height : 4 / 3

/** Seedream 尺寸：总像素 ≥ 921600，宽高比 1/16..16 */
function seedreamSize(): string {
  const w = 2048
  const h = Math.max(512, Math.round(w / aspect))
  return `${w}x${h}`
}

/* ---------------- 工具 ---------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let seq = 0
async function saveImage(buf: ArrayBuffer | Uint8Array, provider: string): Promise<string> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const file = `${provider}-${++seq}${isPng ? '.png' : '.jpg'}`
  writeFileSync(resolve(OUT, file), bytes)
  return file
}

async function download(url: string, provider: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`下载结果图失败 HTTP ${res.status}`)
  return saveImage(await res.arrayBuffer(), provider)
}

/* ---------------- 火山方舟 Seedream 4.0 ---------------- */

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
/**
 * 默认用 4.0 的现行版本号。注意 `doubao-seedream-4-0-250828` 已标记 Retiring（下线），
 * 调它会 404 InvalidEndpointOrModel.NotFound；可用 `--ark-model=` 覆盖。
 */
const ARK_MODEL = args['ark-model'] ?? 'doubao-seedream-4-0-20260415'

async function runArk(key: string, prompt: string): Promise<string> {
  const body = {
    model: ARK_MODEL,
    prompt,
    image: [dataUrl],
    size: seedreamSize(),
    response_format: 'url',
    watermark: false,
  }
  const t0 = performance.now()
  const res = await fetch(ARK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  const ms = performance.now() - t0
  const text = await res.text()
  if (!res.ok) throw new Error(`ARK ${res.status}: ${text.slice(0, 400)}`)

  const json = JSON.parse(text) as { data?: { url?: string; b64_json?: string }[] }
  const item = json.data?.[0]
  if (!item) throw new Error(`ARK 返回无 data：${text.slice(0, 300)}`)
  const file = item.url
    ? await download(item.url, 'ark')
    : await saveImage(Buffer.from(item.b64_json ?? '', 'base64'), 'ark')
  console.log(`  ark     ${ms.toFixed(0)}ms -> ${file}`)
  return file
}

/* ---------------- 阿里云百炼 wanx2.1-imageedit（异步） ---------------- */

const DS_BASE = 'https://dashscope.aliyuncs.com/api/v1'
const DS_MODEL = 'wanx2.1-imageedit'

async function runDashscope(key: string, prompt: string): Promise<string> {
  const t0 = performance.now()
  const res = await fetch(`${DS_BASE}/services/aigc/image2image/image-synthesis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: DS_MODEL,
      input: {
        function: 'stylization_all',
        prompt,
        base_image_url: dataUrl,
      },
      parameters: { strength: 0.6, n: 1 },
    }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`DashScope 创建任务 ${res.status}: ${text.slice(0, 400)}`)
  const created = JSON.parse(text) as { output?: { task_id?: string } }
  const taskId = created.output?.task_id
  if (!taskId) throw new Error(`DashScope 未返回 task_id：${text.slice(0, 300)}`)

  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const q = await fetch(`${DS_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    })
    const qt = await q.text()
    if (!q.ok) throw new Error(`DashScope 查询 ${q.status}: ${qt.slice(0, 300)}`)
    const j = JSON.parse(qt) as {
      output?: { task_status?: string; results?: { url?: string }[]; message?: string }
    }
    const st = j.output?.task_status
    if (st === 'SUCCEEDED') {
      const url = j.output?.results?.[0]?.url
      if (!url) throw new Error('任务成功但没有结果 URL')
      const file = await download(url, 'dashscope')
      console.log(`  dashscope ${(performance.now() - t0).toFixed(0)}ms -> ${file}`)
      return file
    }
    if (st === 'FAILED' || st === 'UNKNOWN') {
      throw new Error(`任务失败：${st} ${j.output?.message ?? ''}`)
    }
  }
  throw new Error('DashScope 轮询超时（3 分钟）')
}

/* ---------------- 主流程 ---------------- */

const providers = ONLY.split(',').map((s) => s.trim()).filter(Boolean)
const KEY_ENV: Record<string, string> = {
  ark: 'ARK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
}

console.log(`图片：${IMAGE_TAG}（${srcPath}）`)
console.log(`提示词：${PROMPT}`)
console.log(`样本数：每家 ${SAMPLES} 张 · 提供方：${providers.join(', ')}`)

if (DRY) {
  console.log('\n[dry-run] 不联网，仅校验：')
  for (const p of providers) {
    const envName = KEY_ENV[p] ?? 'UNKNOWN'
    const v = env[envName]
    console.log(`  ${p}: ${v ? `密钥已配置（${v.slice(0, 4)}…，长度 ${v.length}）` : `缺少 ${envName}`}`)
  }
  console.log(`  火山 model=${ARK_MODEL} size=${seedreamSize()} image=${mime} ${(srcBuf.length / 1024).toFixed(0)}KB`)
  console.log(`  百炼 model=${DS_MODEL} function=stylization_all strength=0.6（异步轮询）`)
  process.exit(0)
}

const manifest: {
  image: string
  prompt: string
  provider: string
  file: string
  ok: boolean
  error?: string
}[] = []

for (const provider of providers) {
  const envName = KEY_ENV[provider]
  const key = env?.[envName]
  if (!key) {
    console.warn(`\n⚠ 跳过 ${provider}：.env.local 里没有 ${envName}`)
    continue
  }
  console.log(`\n=== ${provider} ===`)
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const file = provider === 'ark' ? await runArk(key, PROMPT) : await runDashscope(key, PROMPT)
      manifest.push({ image: IMAGE_TAG, prompt: PROMPT, provider, file, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  x ${provider} 第 ${i + 1} 张失败：${message}`)
      manifest.push({ image: IMAGE_TAG, prompt: PROMPT, provider, file: '', ok: false, error: message })
    }
  }
}

// 合并已有 manifest（分供应商跑时保留对方结果）
const manifestPath = resolve(OUT, 'manifest.json')
const previous = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest)
  : []
const merged = [
  ...previous.filter((p) => !providers.includes(p.provider)),
  ...manifest,
]
writeFileSync(manifestPath, JSON.stringify(merged, null, 2), 'utf8')

const okCount = manifest.filter((m) => m.ok).length
console.log(`\n本次完成：成功 ${okCount} / ${manifest.length} 张，产物在 .data/cloud-compare/`)
console.log('下一步：python scripts/compose-cloud-compare.py --image=' + IMAGE_TAG)
