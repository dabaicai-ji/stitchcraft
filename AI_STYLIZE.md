# 端侧 AI 风格化 —— 选型核实与骨架

> 状态：**骨架已就绪，等确认后接入管线**。
> 本文所有体积/耗时/碎片率数字都是本机实测，不是估算。

## 1. 模型选型确认

| | AnimeGANv2 (face_paint_512_v2) | Photo2Pixel | 我们的现状 |
|---|---|---|---|
| ONNX 体积 | **8,594,990 B（8.20 MB）** | **24,382 B（23.8 KB）** | — |
| 输入 | `input_image` **固定 [1,3,512,512]** | `rgb` **[1,3,H,W] 动态** + `param_kernel_size`/`param_pixel_size`/`param_edge_thresh` 三个标量 | — |
| 输出 | `output_image` [1,3,512,512]，tanh 值域 [-1,1] | 动态，与输入同量纲 | — |
| 实测加载 | 279 ms | ~10 ms | — |
| 实测推理 | **2488 ms（WASM，512²）** | 58 ms（WASM，240×134） | 引导滤波 ~2 ms |
| 许可 | 转换仓库 MIT，**上游 TachibanaYoshino 仓库未声明 LICENSE（灰区）** | Apache-2.0 | 自有代码 |

预处理按官方样例核实（Kazuhito00 `sample_onnx.py`）：
`resize → RGB → x/255*2-1 → NCHW`，后处理 `(y*0.5+0.5)*255`。
实测输出范围 [-0.96, 0.87]、1.2 万种颜色，画面确为动画风 → **假设成立**。

Photo2Pixel 的归一化实测是 **0..255**（传 0..1 时边缘阈值 100 永不触发，画面被抹平）。

## 2. 关键实测：AI 到底降不降碎片率？

120 格 / 16 色，真实校园照片（1595×899）：

| 输入 | stylize | 碎片率 | 孤岛率 | 用色 | 难度 |
|---|---|---|---|---|---|
| 原始 | 0 | 12.3% | 4.0% | 16 | 3★ |
| 原始 | 0.4（当前默认） | **3.3%** | 1.0% | 13 | 2★ |
| AnimeGANv2 | 0 | 12.2% | 3.4% | 16 | 3★ |
| AnimeGANv2 | 0.4 | **2.3%** | 0.6% | 15 | 3★ |
| Photo2Pixel | 0 | 11.8% | 5.0% | 13 | 3★ |
| Photo2Pixel | 0.4 | 11.3% | 4.8% | 10 | 3★ |

结论（这不是预期，是数据）：

1. **AnimeGANv2 单独用几乎不降碎片**（12.3% → 12.2%）。它把画面变成动画风，但笔触边缘在
   120 格分辨率下依然是碎的。
2. 叠加现有保边平滑后，碎片率 3.3% → 2.3%，相对再降约 30% —— **有收益，但边际**。
3. **像素化反而更差**（11.8% ← 12.3%）：像素块边界与绣格不对齐时等于人为制造碎边。
4. 真正压碎片的是**已有的引导滤波 + 降色数**，不是神经网络。

> 所以：AI 风格化的价值在**观感**（照片 → 更"像图纸"的画面），不在碎片率。
> 产品文案不应该承诺"开 AI 碎片率会降"，否则就是拿一个 1 个百分点去解释 38MB 下载。

## 3. 运行时体积才是真正的大头

`onnxruntime-web@1.31.1` 实测产物：

| 文件 | 体积 |
|---|---|
| `ort-wasm-simd-threaded.jsep.wasm`（WebGPU/WebNN 用） | **28.15 MiB** |
| `ort-wasm-simd-threaded.wasm`（纯 WASM） | 14.16 MiB |
| webgpu bundle JS | 122 KB |
| 模型本身（AnimeGANv2） | 8.20 MB |

即：**运行时是模型的 3.4 倍**。所以必须
（a）动态 import，进 AI 才下载；（b）多线程需要 COOP/COEP 响应头，没有就单线程。

## 4. 骨架代码

```
src/ai/
├── types.ts      风格/后端/进度/结果类型
├── models.ts     模型注册表（体积、sha256、输入规格、许可说明）
├── cache.ts      IndexedDB 缓存 + sha256 完整性校验 + 下载进度
├── runtime.ts    ORT 动态加载、WebGPU 探测、会话创建与自动降级
├── transforms.ts AnimeGANv2 / Photo2Pixel 的预处理与后处理
├── ai.worker.ts  常驻 Worker：模型下载、会话复用、推理
└── client.ts     主线程 API：warmModel() / applyAiStyle()
scripts/copy-ort-wasm.ts   把 wasm 复制到 public/ort/（prebuild 自动执行）
```

设计要点：

- **常驻 Worker**：会话初始化 279ms + 模型 8MB，每次重建不可接受。
- **结果缓存**：`applyAiStyle` 按「裁剪矩形 + 风格」做 key 缓存。WASM 单次 2.4 秒，
  用户拖色数滑块时绝不能重算。
- **后端降级**：`executionProviders: ['webgpu','wasm']`，WebGPU 不支持的算子由 WASM 兜底，
  比整模型回退更稳；WebGPU 会话都建不起来时再整体回退。
- **缓存键带哈希**：`id@sha256前12位`，模型更新自动失效；命中后仍校验一次，
  挡住「CDN 返回 200 的 HTML 错误页」。

## 5. 接入点（待确认后做）

`src/core/pipeline/run.ts` 里，裁剪结果进来、`resizeToGrid` 之前插一层：

```
裁后 RGBA
  → [可选] AI 风格化（Worker，结果按裁剪 key 缓存）
  → resizeToGrid → stylize → quantize → metrics
```

因为 AI 结果直接替换 RGBA，下游完全不用改。

## 6. 尚未验证 / 待办

- **浏览器端 WebGPU 推理耗时未实测**（本机无浏览器自动化）。按经验应在 200–500ms，
  但需要你在 Chrome 里点一次确认。
- `OffscreenCanvas` 缩放路径只在浏览器可用，Node 实验里用的是自写面积平均，两者会有细微差异。
- 模型 URL 目前指向 GitHub raw，**国内不稳定**，上线前要镜像到自有 CDN/OSS。
- AnimeGANv2 上游许可灰区，商业发布前需替换模型或取得授权。
- 像素模式的 `pixel_size` 与绣格的对应关系还需在浏览器里调参确认。
