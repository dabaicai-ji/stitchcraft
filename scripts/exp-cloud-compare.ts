/**
 * 浜戠鍥剧敓鍥炬í璇勶紙鍙窇瀵规瘮锛屼笉鍔ㄤ骇鍝佷唬鐮侊級銆? *
 *   node scripts/exp-cloud-compare.ts --dry-run          # 鏍￠獙瀵嗛挜/鍙傛暟锛屼笉鍙戣姹? *   node scripts/exp-cloud-compare.ts                    # 榛樿 pet 鍥撅紝涓ゅ鍚?3 寮? *   node scripts/exp-cloud-compare.ts --only=ark         # 鍙窇鐏北
 *   node scripts/exp-cloud-compare.ts --image=landscape --samples=3
 *
 * 瀵嗛挜锛堝啓鍦?stitchcraft/.env.local锛屽凡 gitignore锛夛細
 *   ARK_API_KEY=...           鐏北鏂硅垷锛圫eedream 4.0锛? *   DASHSCOPE_API_KEY=...     闃块噷浜戠櫨鐐硷紙wanx2.1-imageedit锛? *   SILICONFLOW_API_KEY=...   鍙€夛紙Qwen-Image-Edit锛岄渶鍥剧墖鍏綉 URL锛屾湰鍦?base64 閫氬父涓嶆敮鎸侊級
 *
 * 浜х墿锛?data/cloud-compare/<provider>-<n>.<ext> + manifest.json
 * 涔嬪悗鐢?scripts/compose-cloud-compare.py 鍚堟垚瀵规瘮鍥俱€? */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(root, '.data/cloud-compare')
mkdirSync(OUT, { recursive: true })

/* ---------------- 鍙傛暟 ---------------- */

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

/** 缁熶竴鎻愮ず璇嶏細缁欏崄瀛楃唬鐢ㄧ殑鎵佸钩鎻掔敾椋?*/
const PROMPT =
  '鎶婅繖寮犵収鐗囨敼鎴愭墎骞虫彃鐢婚锛岀‖杈瑰ぇ鑹插潡锛屼繚鐣欎富浣撹疆寤撲笌鏋勫浘锛屽幓鎺夎儗鏅潅鐗╁拰缁嗙绾圭悊锛岄鑹蹭笉瓒呰繃 12 绉嶏紝涓嶈鏂囧瓧鍜岃竟妗?

/* ---------------- 璇诲彇瀵嗛挜锛堟墜鍔ㄨВ鏋?.env.local锛屼笉寮曚緷璧栵級 ---------------- */

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

/* ---------------- 鍥剧墖 ---------------- */

interface ImgMeta {
  tag: string
  width: number
  height: number
}
const images = JSON.parse(
  readFileSync(resolve(root, '.data/ai-images.json'), 'utf8'),
) as ImgMeta[]

/** 婧?JPEG锛坆ase64 鐩翠紶闇€瑕佺紪鐮佸悗鐨勫浘锛宺aw 涓嶈锛?*/
const SRC: Record<string, string> = {
  pet: resolve(root, '.data/src-pet.jpg'),
  portrait: resolve(root, '.data/src-portrait.jpg'),
  landscape: resolve(root, '../../dufe-ppt/assets/raw/dufe_official_1.jpg'),
}

const srcPath = SRC[IMAGE_TAG]
if (!srcPath || !existsSync(srcPath)) {
  console.error(`鎵句笉鍒?${IMAGE_TAG} 鐨勬簮鍥撅細${srcPath}`)
  process.exit(1)
}
const srcBuf = readFileSync(srcPath)
const mime = extname(srcPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
const dataUrl = `data:${mime};base64,${srcBuf.toString('base64')}`
const meta = images.find((i) => i.tag === IMAGE_TAG)
const aspect = meta ? meta.width / meta.height : 4 / 3

/** Seedream 灏哄锛氭€诲儚绱?鈮?921600锛屽楂樻瘮 1/16..16 */
function seedreamSize(): string {
  const w = 2048
  const h = Math.max(512, Math.round(w / aspect))
  return `${w}x${h}`
}

/* ---------------- 宸ュ叿 ---------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let seq = 0
async function saveImage(buf: ArrayBuffer, provider: string): Promise<string> {
  const bytes = new Uint8Array(buf)
  // 绮楃暐鍒ゆ柇 PNG/JPEG 榄旀暟
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const file = `${provider}-${++seq}${isPng ? '.png' : '.jpg'}`
  writeFileSync(resolve(OUT, file), bytes)
  return file
}

async function download(url: string, provider: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`涓嬭浇缁撴灉鍥惧け璐?HTTP ${res.status}`)
  return saveImage(await res.arrayBuffer(), provider)
}

/* ---------------- 鐏北鏂硅垷 Seedream 4.0 ---------------- */

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
const ARK_MODEL = 'doubao-seedream-4-0-250828'

async function runArk(key: string, prompt: string): Promise<string> {
  const body = {
    model: ARK_MODEL,
    prompt,
    // 鍥剧敓鍥撅細鍙傝€冨浘鏁扮粍锛涘畼鏂规敮鎸?URL 鎴?base64
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
  if (!res.ok) throw new Error(`ARK ${res.status}: ${text.slice(0, 300)}`)

  const json = JSON.parse(text) as { data?: { url?: string; b64_json?: string }[] }
  const item = json.data?.[0]
  if (!item) throw new Error(`ARK 杩斿洖鏃?data锛?{text.slice(0, 200)}`)
  const file = item.url
    ? await download(item.url, 'ark')
    : await saveImage(Buffer.from(item.b64_json ?? '', 'base64'), 'ark')
  console.log(`  ark     ${ms.toFixed(0)}ms 鈫?${file}`)
  return file
}

/* ---------------- 闃块噷浜戠櫨鐐?wanx2.1-imageedit锛堝紓姝ワ級 ---------------- */

const DS_BASE = 'https://dashscope.aliyuncs.com/api/v1'
const DS_MODEL = 'wanx2.1-imageedit'

async function runDashscope(key: string, prompt: string): Promise<string> {
  const t0 = performance.now()
  const res = await fetch(`${DS_BASE}/services/aigc/image2image/image-synthesis`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      // 蹇呴』寮€寮傛锛屽惁鍒欓暱浠诲姟浼氳缃戝叧鎺愭柇
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: DS_MODEL,
      input: {
        // 鏁村浘椋庢牸鍖栵紱瀹樻柟鏀寔鐨勮嚜甯﹂鏍煎彧鏈夌粯鏈?閲戠當锛岃繖閲岄潬 prompt 寮曞
        function: 'stylization_all',
        prompt,
        base_image_url: dataUrl,
      },
      parameters: { strength: 0.6, n: 1 },
    }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`DashScope 鍒涘缓浠诲姟 ${res.status}: ${text.slice(0, 300)}`)
  const created = JSON.parse(text) as { output?: { task_id?: string } }
  const taskId = created.output?.task_id
  if (!taskId) throw new Error(`DashScope 鏈繑鍥?task_id锛?{text.slice(0, 200)}`)

  // 杞锛堜换鍔℃湁鏁堟湡 24h锛涜繖閲屾渶澶氱瓑 3 鍒嗛挓锛?  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const q = await fetch(`${DS_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    })
    const qt = await q.text()
    if (!q.ok) throw new Error(`DashScope 鏌ヨ ${q.status}: ${qt.slice(0, 300)}`)
    const j = JSON.parse(qt) as {
      output?: {
        task_status?: string
        results?: { url?: string }[]
        message?: string
      }
    }
    const st = j.output?.task_status
    if (st === 'SUCCEEDED') {
      const url = j.output?.results?.[0]?.url
      if (!url) throw new Error('浠诲姟鎴愬姛浣嗘病鏈夌粨鏋?URL')
      const file = await download(url, 'dashscope')
      console.log(`  dashscope ${(performance.now() - t0).toFixed(0)}ms 鈫?${file}`)
      return file
    }
    if (st === 'FAILED' || st === 'UNKNOWN') {
      throw new Error(`浠诲姟澶辫触锛?{st} ${j.output?.message ?? ''}`)
    }
  }
  throw new Error('DashScope 杞瓒呮椂锛? 鍒嗛挓锛?)
}

/* ---------------- 涓绘祦绋?---------------- */

const providers = ONLY.split(',').map((s) => s.trim()).filter(Boolean)
const KEY_ENV: Record<string, string> = {
  ark: 'ARK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
}

console.log(`鍥剧墖锛?{IMAGE_TAG}锛?{srcPath}锛塦)
console.log(`鎻愮ず璇嶏細${PROMPT}`)
console.log(`鏍锋湰鏁帮細姣忓 ${SAMPLES} 寮?路 鎻愪緵鏂癸細${providers.join(', ')}`)

if (DRY) {
  console.log('\n[dry-run] 涓嶈仈缃戯紝浠呮牎楠岋細')
  for (const p of providers) {
    const envName = KEY_ENV[p] ?? 'UNKNOWN'
    console.log(`  ${p}: ${env[envName] ? `瀵嗛挜宸查厤缃紙${env[envName].slice(0, 4)}鈥︼級` : `缂哄皯 ${envName}`}`)
  }
  console.log(`  鐏北 model=${ARK_MODEL} size=${seedreamSize()} image=${mime} ${(srcBuf.length / 1024).toFixed(0)}KB`)
  console.log(`  鐧剧偧 model=${DS_MODEL} function=stylization_all strength=0.6锛堝紓姝ヨ疆璇級`)
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
    console.warn(`\n鈿?璺宠繃 ${provider}锛?env.local 閲屾病鏈?${envName}`)
    continue
  }
  console.log(`\n=== ${provider} ===`)
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const file =
        provider === 'ark'
          ? await runArk(key, PROMPT)
          : await runDashscope(key, PROMPT)
      manifest.push({ image: IMAGE_TAG, prompt: PROMPT, provider, file, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  鉁?${provider} 绗?${i + 1} 寮犲け璐ワ細${message}`)
      manifest.push({ image: IMAGE_TAG, prompt: PROMPT, provider, file: '', ok: false, error: message })
    }
  }
}

writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

const okCount = manifest.filter((m) => m.ok).length
console.log(`\n瀹屾垚锛氭垚鍔?${okCount} / ${manifest.length} 寮狅紝浜х墿鍦?.data/cloud-compare/`)
console.log('涓嬩竴姝ワ細python scripts/compose-cloud-compare.py')

