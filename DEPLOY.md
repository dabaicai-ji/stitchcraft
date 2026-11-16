# 部署指南

## 0. 先理解要部署什么

这个项目是 **「静态前端 + 一个小函数」**，不是传统后端：

```
dist/              纯静态文件（HTML / JS / CSS / 字体）→ 任何静态托管
api/insight.ts     ~150 行的 DeepSeek 代理函数 → 需要支持 serverless 的平台
```

**为什么不能纯静态**：DEEPSEEK_API_KEY 放进前端 JS 就等于公开泄露，而且 DeepSeek
接口不允许浏览器跨域直连。所以必须有一个只在服务端运行的小函数持有 Key。

好消息：这份代理代码是**用 Web 标准 Request/Response 写的**，同一份文件
（`api/_lib/insight.ts`）在本地 dev、Vercel Edge、Netlify Edge 上都能跑，
不存在「本地好使、上线就挂」的分叉。

**没有 Key 也能部署**：AI 卡片会显示「未配置 Key」，其它功能（生成图纸、指标、PDF、CSV）全部正常。

---

## 1. Vercel（推荐，最省事）

### 方式 A：Git 导入（推荐）

1. 把 `stitchcraft/` 推到 GitHub / GitLab
2. 登录 [vercel.com](https://vercel.com) → **Add New → Project** → 选仓库
3. 框架预设会自动识别为 **Vite**，不用改：
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Root Directory: 如果仓库根就是 stitchcraft 就不用改；如果在子目录，填 `stitchcraft`
4. **部署前先配环境变量**（见下）→ 点 Deploy

### 方式 B：命令行

```bash
npm i -g vercel
cd stitchcraft
vercel            # 首次会问项目名，一路回车
vercel --prod     # 发布到正式域名
```

### 配环境变量（关键步骤）

**Vercel 控制台路径**：Project → **Settings → Environment Variables**

| Name | Value | Environments |
|---|---|---|
| `DEEPSEEK_API_KEY` | `sk-你的key` | Production / Preview / Development 全勾 |

命完名点 Save，**然后必须 Redeploy 一次**（环境变量在部署时注入，改完不重新部署不生效）：
Deployments → 最新那条 → `...` → Redeploy。

### 验证部署成功

浏览器打开：

```
https://你的域名/api/insight
```

应返回 `{"configured":true}`。
如果返回 `{"configured":false}` → 环境变量没配对，或没重新部署。

---

## 2. Netlify

仓库里已经带好 `netlify.toml`，不用手写配置：

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[edge_functions]]
  function = "insight"
  path = "/api/insight"
```

步骤：

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → 选仓库
2. 构建设置会自动读 `netlify.toml`（Build `npm run build`，Publish `dist`）
3. **Site configuration → Environment variables** → Add a variable：
   - Key: `DEEPSEEK_API_KEY`
   - Value: `sk-...`
4. 部署完成后同样访问 `https://你的域名/api/insight` 验证 `{"configured":true}`

> Netlify 用的是 **Edge Functions**（Deno），免费计划已包含。如果平台提示需要开启，
> 在 Site configuration → Functions 里确认 Edge Functions 已启用。

---

## 3. 最傻瓜方式：局域网给室友用

不用任何账号、不用部署，5 分钟搞定。

### 3.1 用开发服务器（最快）

```bash
cd stitchcraft
npm run dev -- --host
```

终端会打印：

```
➜  Local:   http://localhost:5173/
➜  Network: http://192.168.1.23:5173/     ← 把这个发给室友
```

### 3.2 用生产构建 + 预览（更接近正式环境，也更快）

```bash
npm run build
npm run preview -- --host
```

`preview` 同样带代理（`vite.config.ts` 里 `configurePreviewServer`），所以 AI 功能也能用。

### 3.3 常见卡点

| 现象 | 解决 |
|---|---|
| 室友打不开 | 确认在同一 WiFi；Windows 防火墙放行 Node（首次运行会弹窗，选「允许专用网络」） |
| 不知道本机 IP | `ipconfig` 看「IPv4 地址」，通常 192.168.x.x |
| 手机打不开 | 同上，手机连同一个 WiFi，用电脑的 192.168 地址 |
| 改了 `.env.local` 不生效 | 重启 `npm run dev` |

### 3.4 ⚠️ 局域网模式的安全提醒

局域网模式下，**同一网络里的任何人都能通过你的电脑调用 DeepSeek**，消耗你账号的额度。

- 只在内测期间开，用完 `Ctrl+C` 关掉
- 别在公司/学校公共网络开
- 想更稳妥：给 Key 设置消费上限，或内测时用一个单独的 Key

---

## 4. 常见问题

**Q：部署后 AI 报 503「DEEPSEEK_API_KEY 未配置」**
A：环境变量名拼错（注意全大写）、配到了 Preview 但访问的是 Production、或者改完没重新部署。改完一定 Redeploy。

**Q：部署后 AI 报 404 或返回 HTML**
A：平台没识别出函数。Vercel 需要 `api/insight.ts` 在项目根（已就位）；Netlify 需要 `netlify.toml` + `netlify/edge-functions/insight.ts`（已就位）。

**Q：PDF 里中文变方框**
A：`public/fonts/noto-sans-sc-subset.ttf` 没提交进仓库（检查是否被 gitignore 误伤）。这个文件是构建产物但必须入库。

**Q：构建时报 `tsc` 错误**
A：`npm run build` 会先跑严格类型检查。本地 `npm run build` 能过，线上就能过。

**Q：不想暴露 AI 功能**
A：不配 `DEEPSEEK_API_KEY` 即可。AI 卡片显示「未配置 Key」，其它功能完全可用。

**Q：Vercel 免费额度够吗**
A：静态托管和 Edge Function 调用量都远超内测需求；真正的成本是 DeepSeek token（每次解读约 1.5k input / 300 output）。
代理已锁定 `max_tokens: 700` 并且只接受 ≤64KB 的请求体。

---

## 5. 部署前检查清单

```bash
npm run build          # 必须通过（含 tsc 严格检查）
npm test               # 指标 / 管线 / PDF / CSV 全绿
```

- [ ] `public/fonts/noto-sans-sc-subset.ttf` 已入库
- [ ] `.env.local` **没有**被提交（`.gitignore` 已含 `*.local`）
- [ ] 平台环境变量已配置并重新部署
- [ ] 访问 `/api/insight` 返回 `{"configured":true}`
- [ ] 手机打开页面，能上传图片、能双指缩放图纸
