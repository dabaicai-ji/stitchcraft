# stitchcraft

十字绣图纸生成器 V1 —— 上传图片 → 裁剪取景 →（可选）像素风格化 → 保边平滑 → 感知减色到**真实 DMC 线号** → 网格图纸 + 可绣性报告 + A4 分页 PDF + AI 解读。

图片不出本机；AI 只接收指标 JSON，不接收图片。没有 API Key 时除「AI 解读」外全部功能可用。

`npm test` 之外还有一条像素风格化测试：`npm run itest:pixel`（纯 Node，不需要浏览器、不联网）。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc 严格类型检查 + 生产构建
npm test           # 指标单测 + 真实照片端到端 + PDF 导出测试
```

> 沙箱环境下 npm 默认缓存目录不可写：`npm install --cache <workspace>/.npm-cache`

**AI 解读（可选）**：把 `.env.example` 复制成 `.env.local`，填入 `DEEPSEEK_API_KEY`，重启 dev server。
Key 只在 Node 进程里用，永不进入浏览器 bundle。卡片右上角有状态徽标（`Key 已就绪` / `未配置 Key`），
靠 `GET /api/insight` 健康检查，不消耗 token。

首次拿到代码若 `public/fonts/noto-sans-sc-subset.ttf` 不存在，跑一次 `npm run font:build`（见「PDF 字体」）。

## 目录结构（相对 `npm create vite -- --template react-ts` 的增量）

```
stitchcraft/
├── index.html / vite.config.ts    # vite.config 里含本地代理（桥接 api/_lib）
├── api/_lib/insight.ts            # ★ DeepSeek 代理核心（Web 标准，三处复用）
├── api/insight.ts                 # ★ Vercel Edge Function 入口
├── netlify/edge-functions/        # ★ Netlify Edge Function 入口
├── netlify.toml
├── .env.example                   # DEEPSEEK_API_KEY 模板（.env.local 被 gitignore）
├── QUICKSTART.md                  # 内测使用说明
├── DEPLOY.md                      # 部署指南（Vercel / Netlify / 局域网）
├── public/fonts/
│   ├── noto-sans-sc-subset.ttf    # 生成的 CJK 子集（76KB，211 字符）
│   └── NOTICE.txt                 # SIL OFL 1.1 署名
│
├── scripts/                       # 纯 Node 工具链，不参与打包
│   ├── build-dmc.ts               # 色卡 JSON → src/core/data/dmc-colors.ts
│   ├── build-font-subset.ts       # 字体子集化 + 逐字符字形校验
│   ├── selftest.ts                # 50 项指标单测（含 CIEDE2000 标准数据）
│   ├── itest-pipeline.ts          # 真实照片端到端 + 断言
│   ├── itest-pdf.ts               # PDF 页数 / 彩色页 / 字体覆盖校验
│   └── exp-*.ts                   # 阈值标定、平滑强度、字体嵌入排查
│
├── src/
│   ├── App.tsx                    # 主壳：upload / crop / result 三段状态机
│   │
│   ├── core/                      # ★ 纯函数，零 DOM、零 React，可被 Node 单测
│   │   ├── types.ts / config.ts / symbols.ts
│   │   ├── data/dmc-colors.ts     # 489 色（自动生成）
│   │   ├── color/{cie,oklab}.ts   # CIEDE2000 / OKLab + 线性光 LUT
│   │   ├── palette/dmc.ts         # 预计算 + 最近色匹配
│   │   │   └── classify.ts        # 色系 / 采购分组 / 主色-点缀角色
│   │   ├── pipeline/
│   │   │   ├── resize.ts          # 线性光面积平均
│   │   │   ├── stylize.ts         # ★ 引导滤波保边平滑
│   │   │   ├── quantize.ts        # OKLab k-means++ → DMC → 合并
│   │   │   ├── run.ts             # 管线编排（纯函数）
│   │   │   └── protocol.ts
│   │   ├── metrics/               # 5 个指标 + 规则引擎
│   │   └── llm/payload.ts         # 压缩 payload + 数字防幻觉
│   │
│   ├── workers/pipeline.worker.ts
│   ├── lib/workerClient.ts
│   ├── components/
│   │   ├── UploadZone.tsx
│   │   ├── CropStage.tsx          # 裁剪步骤（cropperjs 1.6）
│   │   ├── GridCanvas.tsx         # 缩放/平移/双指/LOD/符号
│   │   ├── ParamPanel.tsx
│   │   ├── MetricCards.tsx
│   │   └── AiReport.tsx           # ★ 流式 AI 解读 + 校验 UI
│   │
│   ├── llm/                       # ★ DeepSeek 客户端侧
│   │   ├── prompt.ts              # 系统提示词（硬性规则）
│   │   ├── client.ts              # SSE 流式客户端
│   │   └── patch.ts               # 白名单参数补丁 + clamp
│   │
│   └── render/pdf/                # PDF 导出（按需加载）
│       ├── layout.ts              # 页面清单 + A4 分页（10 格对齐）
│       ├── labels.ts              # 中文标签 + 子集字符集
│       ├── font.ts                # 浏览器端加载子集字体
│       └── exportPdf.ts           # 总览 / 彩色 / 符号 / 线量 四类页面
│
└── .data/                         # 测试图片与源字体（gitignore）
```

## 管线

```
原始文件 → 对象 URL → 裁剪取景（决定构图比例）
  → 裁后 RGBA
  → resize.ts     线性光面积平均降采样（避免亮部发暗）
  → stylize.ts    引导滤波保边平滑（消绣格级噪点）
  → quantize.ts   24bit 去重 → OKLab k-means++ → 簇代表色 → DMC 匹配
  → 网格 + 5 项指标 + 规则引擎
  → Canvas 预览 / PDF 导出 / AI 解读
```

管线跑在 Web Worker；主线程保留裁剪后的像素，改参数不需要重新裁剪或解码。

### 裁剪与格数的关系

裁剪框决定**构图比例**，图纸宽度只决定**分辨率**：改格数不需要重裁，换图才重置取景框。

### 保边平滑（风格化）

在**网格分辨率**上做引导滤波（不是原图）：要消的就是最终格子粒度的噪点，
在 120×120 上处理 <5ms；在 1024² 上平滑再降采样等于平滑完又丢信息。

以亮度为引导图，分别滤 R/G/B 线性光通道（交叉引导，比三通道各自自引导更不容易色偏）。

实测（120 格 / 16 色）：

| 强度 | photo 碎片 | screen 碎片 | building 碎片 | 用色变化 |
|---|---|---|---|---|
| 0（关） | 12.3% | 18.8% | 22.9% | 16 |
| 0.2 | 4.0% | 14.7% | 9.1% | 13–15 |
| **0.4（默认）** | **3.3%** | **11.6%** | **5.1%** | 12–15 |
| 0.6 | 2.3% | 11.6% | 5.5% | 14 |
| 1.0 | 2.0% | 11.4% | 4.2% | 13–15 |

0.4 是拐点：碎片率降 60–75%，再往上收益递减且开始吃掉用色数。

### 画布 LOD

| 缩放 | 绘制内容 |
|---|---|
| ≥ 1.2 | 每 10 格粗线 |
| ≥ 6 | 单格细线 |
| ≥ 6.25（字号 ≥ 5px） | 每格符号 |

判据是**字形像素高度**而非缩放倍数；工具栏「符号」可强制开启。

生成文档见 [QUICKSTART.md](./QUICKSTART.md)（内测使用说明）。

## 线量清单 CSV

左下角「导出 CSV」纯本地生成，为「拿着去淘宝批量买线」设计：

| 列 | 说明 |
|---|---|
| 色系 | OKLCH 色相自动分桶，白/灰/黑/棕/红/橙/黄/绿/青/蓝/紫/粉 |
| 采购分组 | 中性 / 大地 / 暖色 / 黄色 / 冷绿 / 冷蓝，同组一起下单省运费 |
| 角色 | 主色 ≥10% / 辅色 3–10% / 点缀 <3%，决定整包买还是一束 |

表尾还有「采购分组小结」（每组色数/格数/束数/成本）。
格式：UTF-8 BOM + CRLF（Windows Excel 中文不乱码），字段按 RFC 4180 转义。

## PDF 导出

四类页面，顺序由 `layout.ts` 的**页面清单**决定（渲染只负责逐页画，避免插入页面时页码错位）：

1. **总览页** —— 参数摘要、配色图例、页码索引矩阵、彩色页位置提示
2. **彩色页** —— 单页全景（小图纸）或 40×50 分页（超大图纸），带 10 格粗线与坐标
3. **符号页** —— 每页 40×50 格，每格一个符号
4. **线量页** —— 清单、合计、可绣性摘要、数据署名

彩色页策略：

| 条件 | 行为 |
|---|---|
| 整图缩到 A4 后格边长 ≥ 1.2mm | 单页全景（120×68 约 4.5mm） |
| 低于 1.2mm（如 220 格宽 → 0.86mm） | 按 40×50 分页铺彩色 |

- 小图纸的彩色格允许放大到 12mm（否则缩在角落一小块，且永远够不到「印色号」的门槛）
- **色号数字**：默认关闭，仅当格边长 ≥ 6mm 且色号 ≤4 字符时印（4.5mm 格里塞 4 位色号需要 <3.5pt，打印不可读）
- 逐字符定位绘制，规避渲染器忽略 `/W` 宽度表导致数字被拉成「2 1 . 8」

### PDF 字体（唯一的硬坑）

`pdf-lib` 自带的 `subset: true` 对 CFF 轮廓字体会**把字形抽没**（实测渲染空白），所以：

1. 构建期用 `subset-font` 把 Noto Sans SC 子集化到 211 字符（76KB）
2. 运行时 `embedFont(bytes, { subset: false })`
3. `build-font-subset.ts` 逐字符校验字形；`itest-pdf.ts` 还有一条断言：
   **子集必须覆盖 `PDF_CHARSET` 全部字符** —— 改了 labels 忘记重建字体会立刻失败

源字体（SIL OFL 1.1，可再分发）保存为 `.data/NotoSansSC-Regular.otf`：

```
https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf
```

## AI 解读（DeepSeek）

```
规则报告（本地、免费、瞬时、永不失败）
  └─ 点「让 AI 解释」→ POST /api/insight → Vite 中间件代理（持 Key）
       → DeepSeek 流式返回 → 前端逐字渲染
       → 数字校验：输出里每个数字都要能在 payload 里找到出处
       → 白名单参数补丁 → clone/clamp → 用户点「应用并重算」才生效
```

三道安全线都不依赖模型自觉：

1. 只发送指标 JSON（约 1.5KB），不上传图片
2. `auditNarrative` 校验数字出处（允许 ×100 百分比表达），对不上标红
3. `sanitizePatch` 丢弃非白名单字段、clamp 到合法区间

代理还做了：请求体形状/长度校验（64KB 上限）、锁定 model 与 `max_tokens`、SSE 归一化成
`data: {"d":"..."}` + `data: [DONE]`（换模型不用改前端）。

生产部署时把同一逻辑搬到 Cloudflare Worker / 任何 Node 服务即可，**纯前端不可能安全持有 Key**。

## 色卡数据与许可

- 来源：**MakeBead craft-color-codes**（`data/json/dmc-floss.json`，489 色）
- 许可：**CC BY 4.0** —— 可商用，但必须保留署名（页脚 / PDF 末页）
- 上游标注 `cross-checked`，修正了被 Excel 损坏的 hex 与 DMC 309 的错值
- ⚠️ 社区整理的**近似 sRGB** 值，不是 DMC 官方数据

## 已知限制

- 可绣性阈值只用了 3 张图初步标定（见 `config.ts`），需要 20+ 张定稿；
  注意默认平滑 0.4 会整体拉低碎片率，阈值目前仍是「绝对质量门槛」而非分位数
- 线量为几何估算（14ct/2 股 ≈ 599 格/束），保守取值，待真实作品标定
- AI 解读只做了 V1 单轮；多轮对话式调参（模型主动追问）未实现
- 本地风格化只剩**像素模式**（纯 TS、0 下载）。本地 ONNX 卡通分支已下线
  （实测不降碎片、代价 51.5MB、许可灰区），卡通改走云端图生图，见 `AI_STYLIZE.md`
- PDF 未做「彩色铺色 + 符号叠加」的混合模式
