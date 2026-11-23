/**
 * 应用主壳：上传 → 裁剪 → Worker 管线 → Canvas 预览 + 指标面板。
 *
 * 新增裁剪步骤后，数据流变成：
 *   原始文件 → 对象 URL → 裁剪取景 → 裁后 RGBA（主线程持有）
 *     → 每次参数变化往 Worker 送一份拷贝 → grid + report
 *
 * 裁剪框决定**构图比例**，图纸宽度只决定**分辨率**，所以改格数不需要重新裁剪。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AiReport } from './components/AiReport.tsx';
import { AiStylePanel } from './components/AiStylePanel.tsx';
import { CropStage } from './components/CropStage.tsx';
import type { CropData, CropResult } from './components/CropStage.tsx';
import { GridCanvas } from './components/GridCanvas.tsx';
import { MetricCards } from './components/MetricCards.tsx';
import { ParamPanel } from './components/ParamPanel.tsx';
import { UploadZone } from './components/UploadZone.tsx';
import { DEFAULT_PARAMS } from './core/pipeline/run.ts';
import type { PipelineOutput, PipelineParams } from './core/pipeline/run.ts';
import { DMC_META } from './core/palette/dmc.ts';
import { runPipelineInWorker } from './lib/workerClient.ts';
import { applyPixelStyle, disposeAi } from './ai/client.ts';
import type { AiStyle, AiStyleResult } from './ai/types.ts';
import { pickCandidate, submitCloud, toAiStyleResult } from './ai/cloud.ts';
import type { CloudMeta, CloudRunResult } from './ai/cloud.ts';
import { stylizeForMode } from './ai/stylizeMode.ts';
import { BUILD_INFO, debugEnabled, deviceLine } from './lib/env.ts';
import { buildThreadCsv, downloadCsv } from './render/exportCsv.ts';
import { loadPdfFont } from './render/pdf/font.ts';
import { planPages } from './render/pdf/layout.ts';

type Stage = 'upload' | 'crop' | 'result';

interface SourceImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  name: string;
}

export default function App() {
  const [stage, setStage] = useState<Stage>('upload');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropData | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);

  const [params, setParams] = useState<PipelineParams>(DEFAULT_PARAMS);
  const [result, setResult] = useState<PipelineOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  // ---- 风格化（像素：纯本地 0 下载 / AI 插画：云端上传，每次 2 张约 0.4 元）----
  const [aiStyle, setAiStyle] = useState<AiStyle>('none');
  const [aiLast, setAiLast] = useState<AiStyleResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiBaseline, setAiBaseline] = useState<number | null>(null);
  /** 已点「AI 插画」但用户还没确认上传：确认前一个字节都不发 */
  const [cloudPending, setCloudPending] = useState(false);
  const [cloudMeta, setCloudMeta] = useState<CloudMeta | null>(null);
  /** 本次生成的两张候选（非 null 即进入「等用户点选」状态） */
  const [cloudRun, setCloudRun] = useState<CloudRunResult | null>(null);
  /** 用户已选中的候选 id —— 选中后管线才会跑 */
  const [cloudPickedId, setCloudPickedId] = useState<string | null>(null);
  /** 正在解码选中的那张图 */
  const [cloudPicking, setCloudPicking] = useState(false);
  /**
   * 云端结果按「同一张裁剪图」缓存。
   * 必须缓存：改色数 / 改格数会重跑整条管线，但绝不能因此再付一次 0.4 元。
   */
  const cloudRef = useRef<{
    source: SourceImage | null;
    pickedId: string | null;
    result: AiStyleResult | null;
  }>({ source: null, pickedId: null, result: null });
  /** 提交云端请求的进行中标记：防止 effect 重入导致重复计费 */
  const cloudInFlightRef = useRef(false);

  const firstRunRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  /** 用户是否手动调过平滑滑块：调过就不再被模式切换自动覆盖 */
  const stylizeTouchedRef = useRef(false);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const replaceUrl = useCallback((next: string | null) => {
    if (urlRef.current && urlRef.current !== next) {
      URL.revokeObjectURL(urlRef.current);
    }
    urlRef.current = next;
    setImageUrl(next);
  }, []);

  /* ---------------- 选图 ---------------- */
  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('只支持图片文件（JPG / PNG / WebP）');
        return;
      }
      setError(null);
      const url = URL.createObjectURL(file);
      replaceUrl(url);
      setFileName(file.name);
      setCrop(null);
      setSource(null);
      setResult(null);
      setSuggested(null);
      // 换图 = 之前的云端候选与缓存全部作废（旧坐标/旧结果对新图无意义）
      setCloudRun(null);
      setCloudPickedId(null);
      cloudRef.current = { source: null, pickedId: null, result: null };
      firstRunRef.current = true;
      setStage('crop');
    },
    [replaceUrl],
  );

  /* ---------------- 裁剪完成 ---------------- */
  const applyCrop = useCallback(
    (r: CropResult) => {
      setSource({
        rgba: r.rgba,
        width: r.width,
        height: r.height,
        name: fileName ?? 'image',
      });
      setCrop(r.crop);
      setStage('result');
      // 重新裁剪 = 新的构图：旧候选作废，避免拿错图去绣
      setCloudRun(null);
      setCloudPickedId(null);
      cloudRef.current = { source: null, pickedId: null, result: null };
      firstRunRef.current = true;
    },
    [fileName],
  );

  const cancelCrop = useCallback(() => {
    if (source) {
      setStage('result');
    } else {
      replaceUrl(null);
      setStage('upload');
    }
  }, [source, replaceUrl]);

  /* ---------------- 风格化 ---------------- */
  const chooseAiStyle = useCallback(
    (next: AiStyle) => {
      if (next === aiStyle) return; // 点当前已选中的选项不重复触发
      setAiError(null);
      // AI 插画要上传到云端而且计费：先出确认条，用户确认后才发请求
      setCloudPending(next === 'cloud');
      // 关闭时立刻释放 Worker；像素模式本身 0 下载、无模型可加载
      if (next === 'none') disposeAi();
      setAiStyle(next);
      // AI 插画已做结构简化，平滑降到 0.2；用户手动调过就不动，切走时恢复默认
      setParams((prev) => {
        const want = stylizeForMode(next, stylizeTouchedRef.current, prev.stylize);
        return want === prev.stylize ? prev : { ...prev, stylize: want };
      });
    },
    [aiStyle],
  );

  const confirmCloudStyle = useCallback(() => setCloudPending(false), []);

  const cancelCloudStyle = useCallback(() => {
    setCloudPending(false);
    setAiStyle('none');
  }, []);

  /** 选中一张候选：服务端记 pickedId + 写缓存，本地解码成 RGBA 进管线 */
  const pickAndApply = useCallback(
    async (taskId: string, candidateId: string): Promise<void> => {
      if (!source) {
        setAiError('缺少源图尺寸，无法把云端图归一到源尺寸');
        return;
      }
      setCloudPicking(true);
      setAiError(null);
      try {
        // 关键：云端图（如 1368×1024）必须 cover 缩放到裁剪源图尺寸（如 2000×1500），
        // 否则下游按 srcWidth 解释 stride 会逐行错位 —— 实测就是「画面糊成一片」。
        const picked = await pickCandidate(taskId, candidateId, {
          width: source.width,
          height: source.height,
        });
        const styled = toAiStyleResult(picked, 0);
        setCloudPickedId(candidateId);
        setAiLast(styled);
        cloudRef.current = { source, pickedId: candidateId, result: styled };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAiError(`选定失败：${msg}`);
      } finally {
        setCloudPicking(false);
      }
    },
    [source],
  );

  const handlePickCandidate = useCallback(
    (candidateId: string) => {
      if (!cloudRun) return;
      void pickAndApply(cloudRun.taskId, candidateId);
    },
    [cloudRun, pickAndApply],
  );

  /**
   * 提交云端生成（一次性付费）：确认后立刻跑，拿到两张候选就停在「等选择」。
   * 同一张裁剪图只提交一次——cloudInFlightRef + cloudRef 双保险，
   * 防止 effect 重入把一次生成变成两次计费。
   */
  useEffect(() => {
    if (aiStyle !== 'cloud' || cloudPending || stage !== 'result' || !source) return;
    if (cloudInFlightRef.current) return;
    if (cloudRef.current.source === source && cloudRef.current.pickedId) return;

    cloudInFlightRef.current = true;
    void (async () => {
      setAiRunning(true);
      setAiError(null);
      try {
        const run = await submitCloud({
          rgba: source.rgba,
          width: source.width,
          height: source.height,
        });
        setCloudRun(run);
        setCloudMeta({
          size: run.size,
          cached: run.cached,
          quotaLeft: run.quotaLeft,
          mock: run.mock,
          serverMs: run.serverMs,
        });
        // 缓存命中：服务端带回上次选中的那张，直接复用，不再让用户重选
        if (run.cached && run.pickedId) {
          await pickAndApply(run.taskId, run.pickedId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 失败 / 超时 / 配额用完：自动降级像素，不白屏也不让用户手动再点一次
        setAiError(`${msg} · 已自动切回像素模式`);
        setAiStyle('pixel');
      } finally {
        cloudInFlightRef.current = false;
        setAiRunning(false);
      }
    })();
  }, [aiStyle, cloudPending, stage, source, pickAndApply]);

  /* ---------------- 跑管线 ---------------- */
  useEffect(() => {
    if (!source || stage !== 'result') return;
    // AI 插画：用户还没点「开始处理」前，一个字节都不离开浏览器
    if (aiStyle === 'cloud' && cloudPending) return;

    const wantSuggestion = firstRunRef.current;
    const timer = window.setTimeout(
      () => {
        void (async () => {
          abortRef.current?.abort();
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          setBusy(true);

          // ---- 可选：先做风格化（结果直接替换 RGBA，下游不用改）----
          let inputRgba = source.rgba;
          if (aiStyle === 'pixel') {
            setAiRunning(true);
            try {
              const styled = await applyPixelStyle({
                rgba: source.rgba,
                width: source.width,
                height: source.height,
                gridWidth: params.targetWidth,
              });
              inputRgba = styled.rgba;
              setAiLast(styled);
            } catch (err) {
              setAiError(err instanceof Error ? err.message : String(err));
              setAiStyle('none');
              setAiRunning(false);
              setBusy(false);
              return;
            }
            setAiRunning(false);
          } else if (aiStyle === 'cloud') {
            const cached = cloudRef.current;
            if (cached.source === source && cached.result) {
              // 同一张裁剪图 + 同一张选中项：复用已经付过费的结果，绝不重复调云端
              inputRgba = cached.result.rgba;
              setAiLast(cached.result);
            } else {
              // 还没点选：管线原地等待，等 handlePickCandidate 解码完再跑
              setBusy(false);
              return;
            }
          }

          try {
            const out = await runPipelineInWorker({
              rgba: inputRgba,
              srcWidth: source.width,
              srcHeight: source.height,
              params,
              suggestColors: wantSuggestion,
              signal: ctrl.signal,
            });
            setResult(out);
            if (out.suggestedColors) setSuggested(out.suggestedColors);
            firstRunRef.current = false;
            setBusy(false);
            // 不启用风格化时的碎片率作为对照基线（约束①：如实显示前后两个数字）
            if (aiStyle === 'none') {
              setAiBaseline(out.report.continuity.confettiRatio);
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
          }
        })();
      },
      wantSuggestion ? 0 : 180,
    );

    return () => window.clearTimeout(timer);
  }, [source, params, stage, aiStyle, cloudPending, cloudPickedId]);

  const onChange = useCallback((patch: Partial<PipelineParams>) => {
    // 用户亲手动过平滑滑块（含一键应用建议里的值），从此不再被模式切换覆盖
    if (patch.stylize !== undefined) stylizeTouchedRef.current = true;
    setParams((prev) => ({ ...prev, ...patch }));
  }, []);

  const recrop = () => {
    setStage('crop');
  };

  /** 导出 PDF：字体加载失败会自动降级为英文标签，不阻断导出 */
  const handleExportPdf = useCallback(async () => {
    if (!result || pdfBusy) return;
    setPdfBusy(true);
    setError(null);
    try {
      // pdf-lib + fontkit 有 1MB+，按需加载：只有点导出时才下载这段代码
      const [{ exportGridPdf }, fontBytes] = await Promise.all([
        import('./render/pdf/exportPdf.ts'),
        loadPdfFont(),
      ]);
      const bytes = await exportGridPdf({
        grid: result.grid,
        report: result.report,
        fontBytes,
        title: fileName ? fileName.replace(/\.[^.]+$/, '') : undefined,
      });
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/pdf',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stitch-${result.grid.width}x${result.grid.height}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        `PDF 导出失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPdfBusy(false);
    }
  }, [result, pdfBusy, fileName]);

  const pageCount = result ? planPages(result.grid.width, result.grid.height).totalPages : 0;

  /** 线量清单 CSV：纯本地生成，不花网络 */
  const handleExportCsv = useCallback(() => {
    if (!result) return;
    const csv = buildThreadCsv(result.report);
    downloadCsv(
      csv,
      `threads-${result.grid.width}x${result.grid.height}.csv`,
    );
  }, [result]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✚</span>
          <div>
            <h1>十字绣图纸生成器</h1>
            <p>上传图片 → 裁剪取景 → 感知减色到真实 DMC 线号 → 可绣性报告</p>
          </div>
        </div>
        <span className="badge">V1 · 纯前端 · 图片不出浏览器</span>
      </header>

      <main className="layout">
        <section className="stage">
          <div className="stage-canvas">
            {stage === 'upload' && <UploadZone onFile={handleFile} />}

            {stage === 'crop' && imageUrl && (
              <CropStage
                imageUrl={imageUrl}
                targetWidth={params.targetWidth}
                fabricCount={params.fabricCount}
                initialCrop={crop}
                onApply={applyCrop}
                onCancel={cancelCrop}
              />
            )}

            {stage === 'result' && result && <GridCanvas grid={result.grid} />}
            {stage === 'result' && !result && (
              <div className="stage-placeholder">
                <span>正在生成图纸…</span>
              </div>
            )}

            {busy && <div className="busy-overlay">计算中…</div>}
          </div>

          <div className="stage-bar">
            <UploadZone
              compact
              onFile={handleFile}
              fileName={fileName}
            />
            <div className="stage-bar-right">
              {stage === 'result' && (
                <button type="button" className="btn-ghost" onClick={recrop}>
                  重新裁剪
                </button>
              )}
              {stage === 'result' && result && (
                <>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={handleExportCsv}
                    title="导出线量清单 CSV（Excel 可直接打开，含合计与采购备注）"
                  >
                    导出 CSV
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void handleExportPdf()}
                    disabled={pdfBusy}
                    title="导出 A4 分页图纸：总览 + 彩色全景 + 符号页 + 线量清单"
                  >
                    {pdfBusy ? '生成 PDF…' : `导出 PDF（${pageCount} 页）`}
                  </button>
                </>
              )}
              {result && (
                <span className="timing">
                  {result.grid.width}×{result.grid.height} 格 ·{' '}
                  {result.timings.totalMs.toFixed(0)}ms
                </span>
              )}
            </div>
          </div>

          {stage === 'result' && (
            <ParamPanel
              params={params}
              onChange={onChange}
              suggested={suggested}
              uniqueColors={result?.quantize.uniqueColors ?? null}
            />
          )}

          {stage === 'result' && (
            <AiStylePanel
              style={aiStyle}
              onChoose={chooseAiStyle}
              cloudPending={cloudPending}
              onConfirmCloud={confirmCloudStyle}
              onCancelCloud={cancelCloudStyle}
              running={aiRunning}
              error={aiError}
              lastResult={aiLast}
              cloudMeta={cloudMeta}
              cloudRun={cloudRun}
              pickedId={cloudPickedId}
              onPick={handlePickCandidate}
              picking={cloudPicking}
              debug={debugEnabled}
              baselineConfetti={aiBaseline}
              currentConfetti={result?.report.continuity.confettiRatio ?? null}
            />
          )}
        </section>

        <aside className="side">
          {error && <div className="error-box">⚠ {error}</div>}
          {result ? (
            <>
              <AiReport report={result.report} onApplyPatch={onChange} />
              <MetricCards report={result.report} />
            </>
          ) : (
            <div className="empty-state">
              <p>上传一张图片后，这里会显示 5 项可绣性指标</p>
              <ul>
                <li>孤岛 / 碎片率</li>
                <li>相邻色混淆对（CIEDE2000）</li>
                <li>线量与采购成本</li>
                <li>难度 1–5 星</li>
                <li>明暗溢出</li>
              </ul>
            </div>
          )}
        </aside>
      </main>

      <footer className="footer">
        <span>
          色卡数据：{DMC_META.attribution} · {DMC_META.license} · 社区近似 sRGB 值，非 DMC 官方数据
        </span>
        <span className="build-info">
          版本 {BUILD_INFO.hash} · {BUILD_INFO.time}
          {debugEnabled ? ` · ${deviceLine()}` : ''}
        </span>
      </footer>
    </div>
  );
}
