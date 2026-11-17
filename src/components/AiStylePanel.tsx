/**
 * AI 风格面板。
 *
 * 硬性约束（用户明确要求，改文案前先看这里）：
 *   - **禁止**出现「降碎片」类表述；只讲「更像素 / 更像图纸」。
 *   - 卡通默认关闭、标「实验性」，开启前必须确认并显示**精确体积**。
 *   - 下载中可随时「跳过」；失败可重试（网络类最多 3 次，客户端已实现）。
 *   - 8 秒规则：超时自动关闭，但**必须可恢复**，不能静默记住。
 */

import { useState } from 'react';
import type { AiBackend, AiProgress, AiStyle, AiStyleResult } from '../ai/types.ts';
import type { WarmInfo } from '../ai/client.ts';
import { MODEL_ANIME } from '../ai/models.ts';
import { WASM_BYTES } from '../ai/runtime.ts';
import { deviceLine } from '../lib/env.ts';

interface Props {
  style: AiStyle;
  onChoose: (style: AiStyle) => void;
  progress: AiProgress | null;
  running: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onSkip: () => void;
  slowWarn: boolean;
  onRecover: () => void;
  warmInfo: WarmInfo | null;
  lastResult: AiStyleResult | null;
  debug: boolean;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/** 卡通首开体积：模型 + 纯 WASM 运行时 */
const CARTOON_MB = mb(MODEL_ANIME.bytes + WASM_BYTES.wasm);

function backendLabel(b: AiBackend | undefined): string {
  if (b === 'webgpu') return 'WebGPU';
  if (b === 'wasm') return 'WASM';
  if (b === 'cpu') return 'TS（无后端）';
  return '—';
}

export function AiStylePanel(props: Props) {
  const { style, onChoose, progress, running, busy, error, slowWarn } = props;
  const [confirming, setConfirming] = useState(false);

  const choosingAnime = (): void => {
    if (confirming) return;
    setConfirming(true);
  };

  const stageText =
    progress?.stage === 'downloading'
      ? `下载模型 ${progress.ratio !== null ? `${Math.round(progress.ratio * 100)}%` : ''}`
      : progress?.stage === 'compiling'
        ? '初始化推理会话…'
        : running
          ? '风格化处理中…'
          : busy
            ? '准备中…'
            : '';

  return (
    <div className="ai-style">
      <div className="ai-style-head">
        <span className="ai-style-title">AI 风格化</span>
        <span className="tag">实验性</span>
      </div>

      <div className="ai-style-options">
        {(
          [
            ['none', '原始', '不加载任何模型'],
            ['pixel', '像素', '0 下载 · 纯本地方案'],
            ['anime', '卡通', '需下载模型 · 仅比赛内测'],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={value}
            type="button"
            className={`chip${style === value ? ' is-on' : ''}`}
            title={hint}
            disabled={busy || running}
            onClick={() => {
              if (value === 'anime') choosingAnime();
              else onChoose(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {confirming && (
        <div className="ai-confirm">
          <p>
            首次使用卡通风格需下载约 <strong>{CARTOON_MB} MB</strong>
            （模型 {mb(MODEL_ANIME.bytes)} MB + 推理运行时 {mb(WASM_BYTES.wasm)} MB），
            之后可离线使用。模型仅在比赛与内测中使用。
          </p>
          <div className="ai-confirm-actions">
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setConfirming(false);
                onChoose('anime');
              }}
            >
              下载并开启
            </button>
          </div>
        </div>
      )}

      {stageText && (
        <div className="ai-progress">
          <div className="ai-progress-text">{stageText}</div>
          {progress?.stage === 'downloading' && (
            <div className="meter-track">
              <div
                className="meter-fill"
                style={{ width: `${Math.round((progress.ratio ?? 0) * 100)}%` }}
              />
            </div>
          )}
          <button type="button" className="ai-skip" onClick={props.onSkip}>
            跳过
          </button>
        </div>
      )}

      {error && (
        <div className="ai-error">
          <p>{error}</p>
          <button type="button" className="btn-ghost" onClick={props.onRetry}>
            重试
          </button>
        </div>
      )}

      {slowWarn && (
        <div className="ai-warn">
          <p>已因设备性能自动关闭卡通（首次处理超过 8 秒），可在下方重新开启。</p>
          <button type="button" className="btn-ghost" onClick={props.onRecover}>
            重新开启
          </button>
        </div>
      )}

      {props.debug && (
        <div className="ai-debug">
          <div>后端：{backendLabel(props.lastResult?.backend ?? props.warmInfo?.backend)}</div>
          <div>
            下载：{mb(props.lastResult?.modelBytes ?? props.warmInfo?.modelBytes ?? 0)} MB ·
            wasm {mb(props.lastResult?.wasmBytes ?? props.warmInfo?.wasmBytes ?? 0)} MB ·
            {props.warmInfo?.fromCache ? ' 命中缓存' : ' 新下载'}
          </div>
          <div>
            耗时：下载 {(props.lastResult?.downloadMs ?? props.warmInfo?.downloadMs ?? 0).toFixed(0)} ms ·
            推理 {(props.lastResult?.inferenceMs ?? 0).toFixed(0)} ms
          </div>
          <div>结果命中缓存：{props.lastResult?.cached ? '是' : '否'}</div>
          <div>设备：{deviceLine()}</div>
        </div>
      )}
    </div>
  );
}
