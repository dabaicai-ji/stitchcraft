/**
 * 风格化面板（像素模式）。
 *
 * 硬性约束（用户明确要求，改文案前先看这里）：
 *   - **禁止**出现「降碎片」类表述；只讲「更像素 / 更像图纸」。
 *   - 指标面板如实显示启用前后两个碎片率数字，不加评价。
 *
 * 本地 ONNX 卡通分支已下线（决策与实测见 AI_STYLIZE.md）：既然没有模型下载，
 * 就不再需要确认弹窗、下载进度条、重试/跳过、8 秒自动关闭这些配套 UI。
 */

import type { AiStyle, AiStyleResult } from '../ai/types.ts';
import { deviceLine } from '../lib/env.ts';

interface Props {
  style: AiStyle;
  onChoose: (style: AiStyle) => void;
  running: boolean;
  error: string | null;
  lastResult: AiStyleResult | null;
  debug: boolean;
  /** 不启用风格化时的碎片率，用于如实展示「前后两个数字」 */
  baselineConfetti: number | null;
  currentConfetti: number | null;
}

export function AiStylePanel(props: Props) {
  const { style, onChoose, running, error } = props;

  return (
    <div className="ai-style">
      <div className="ai-style-head">
        <span className="ai-style-title">风格化</span>
        <span className="tag">本地计算</span>
      </div>

      <div className="ai-style-options">
        {(
          [
            ['none', '原始', '不启用风格化'],
            ['pixel', '像素', '0 下载 · 纯本地计算'],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            key={value}
            type="button"
            className={`chip${style === value ? ' is-on' : ''}`}
            title={hint}
            disabled={running}
            onClick={() => onChoose(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {running && <div className="ai-progress-text">像素化处理中…</div>}

      {error && (
        <div className="ai-error">
          <p>{error}</p>
        </div>
      )}

      {style !== 'none' && props.baselineConfetti !== null && props.currentConfetti !== null && (
        <div className="ai-compare">
          碎片率：{Math.round(props.baselineConfetti * 1000) / 10}% →{' '}
          {Math.round(props.currentConfetti * 1000) / 10}%
          <span className="ai-compare-hint">（真实数字，不代表更好绣）</span>
        </div>
      )}

      {props.debug && (
        <div className="ai-debug">
          <div>方式：本地 TS（无模型、无下载）</div>
          <div>耗时：{(props.lastResult?.inferenceMs ?? 0).toFixed(0)} ms</div>
          <div>设备：{deviceLine()}</div>
        </div>
      )}
    </div>
  );
}
