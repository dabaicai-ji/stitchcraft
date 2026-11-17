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
import { applyAiStyle, disposeAi, warmModel } from './ai/client.ts';
import type { WarmInfo } from './ai/client.ts';
import type { AiProgress, AiStyle, AiStyleResult } from './ai/types.ts';
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

  // ---- AI 风格化 ----
  const [aiStyle, setAiStyle] = useState<AiStyle>('none');
  const [aiProgress, setAiProgress] = useState<AiProgress | null>(null);
  const [aiWarm, setAiWarm] = useState<WarmInfo | null>(null);
  const [aiLast, setAiLast] = useState<AiStyleResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiSlowWarn, setAiSlowWarn] = useState(false);
  const aiStartRef = useRef(0);

  const firstRunRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

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

  /* ---------------- AI 风格化 ---------------- */
  const chooseAiStyle = useCallback(async (next: AiStyle) => {
    setAiError(null);
    if (next === 'none') {
      setAiStyle('none');
      disposeAi();
      setAiWarm(null);
      setAiProgress(null);
      return;
    }
    // 像素模式：0 下载，不 warm（它没有模型）
    if (next === 'pixel') {
      setAiStyle('pixel');
      return;
    }

    // 卡通：先下载模型再切换，失败保持原样
    setAiBusy(true);
    aiStartRef.current = performance.now();
    try {
      const info = await warmModel('anime', setAiProgress);
      setAiWarm(info);
      setAiStyle('anime');
      setAiSlowWarn(false);
    } catch (err) {
      setAiError(`模型加载失败：${err instanceof Error ? err.message : String(err)}`);
      setAiStyle('none');
    } finally {
      setAiBusy(false);
      setAiProgress(null);
    }
  }, []);

  const skipAiDownload = useCallback(() => {
    disposeAi();
    setAiBusy(false);
    setAiProgress(null);
    setAiRunning(false);
    setAiStyle('none');
  }, []);

  /* ---------------- 跑管线 ---------------- */
  useEffect(() => {
    if (!source || stage !== 'result') return;

    const wantSuggestion = firstRunRef.current;
    const timer = window.setTimeout(
      () => {
        void (async () => {
          abortRef.current?.abort();
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          setBusy(true);

          // ---- 可选：先做 AI 风格化（结果直接替换 RGBA，下游不用改）----
          let inputRgba = source.rgba;
          if (aiStyle !== 'none') {
            setAiRunning(true);
            try {
              const styled = await applyAiStyle({
                style: aiStyle,
                rgba: source.rgba,
                width: source.width,
                height: source.height,
                gridWidth: params.targetWidth,
                cacheKey: crop
                  ? `${crop.x},${crop.y},${crop.width},${crop.height}`
                  : undefined,
                onProgress: setAiProgress,
              });
              inputRgba = styled.rgba;
              setAiLast(styled);
              setAiProgress(null);
            } catch (err) {
              if (!(err instanceof DOMException && err.name === 'AbortError')) {
                setAiError(err instanceof Error ? err.message : String(err));
                setAiStyle('none');
              }
              setAiRunning(false);
              setBusy(false);
              return;
            }
            setAiRunning(false);
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

            // 8 秒规则：从点开启卡通到出图超过 8 秒 → 自动关掉（可恢复，不静默记住）
            if (aiStyle === 'anime' && aiStartRef.current > 0) {
              const elapsed = performance.now() - aiStartRef.current;
              if (elapsed > 8000) {
                setAiStyle('none');
                setAiSlowWarn(true);
              }
              aiStartRef.current = 0;
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
  }, [source, params, stage, aiStyle, crop]);

  const onChange = useCallback((patch: Partial<PipelineParams>) => {
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
              onChoose={(next) => void chooseAiStyle(next)}
              progress={aiProgress}
              running={aiRunning}
              busy={aiBusy}
              error={aiError}
              onRetry={() => void chooseAiStyle('anime')}
              onSkip={skipAiDownload}
              slowWarn={aiSlowWarn}
              onRecover={() => void chooseAiStyle('anime')}
              warmInfo={aiWarm}
              lastResult={aiLast}
              debug={debugEnabled}
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
