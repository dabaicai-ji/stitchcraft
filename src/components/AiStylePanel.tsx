/**
 * 风格化面板：原始 / 像素 / AI 插画。
 *
 * 硬性约束（用户明确要求，改文案前先看这里）：
 *   - **禁止**出现「降碎片」类表述；只讲「更像素 / 更像图纸」。
 *   - 指标面板如实显示启用前后两个碎片率数字，不加评价。
 *   - AI 插画必须**点了才开始上传**：先出确认条，用户点「开始处理」才发请求。
 *
 * 三个选项的定位差别要在 UI 上说清楚，否则用户不知道为什么要为它付钱：
 *   像素 = 本地计算，0 下载 0 费用；
 *   AI 插画 = 图片上传到火山云，约 0.2 元/张，出图约 10 秒。
 */

import type { AiStyle, AiStyleResult } from '../ai/types.ts';
import type { CloudMeta } from '../ai/cloud.ts';
import { deviceLine } from '../lib/env.ts';

interface Props {
  style: AiStyle;
  onChoose: (style: AiStyle) => void;
  /** 已点「AI 插画」但还没确认上传 */
  cloudPending: boolean;
  onConfirmCloud: () => void;
  onCancelCloud: () => void;
  running: boolean;
  error: string | null;
  lastResult: AiStyleResult | null;
  cloudMeta: CloudMeta | null;
  debug: boolean;
  /** 不启用风格化时的碎片率，用于如实展示「前后两个数字」 */
  baselineConfetti: number | null;
  currentConfetti: number | null;
}

export function AiStylePanel(props: Props) {
  const { style, onChoose, running, error, cloudPending } = props;

  const options = [
    ['none', '原始', '不启用风格化，直接走原图'],
    ['pixel', '像素', '本地计算 · 0 下载 0 费用'],
    ['cloud', 'AI 插画', '上传到火山云处理 · 约 0.2 元/张'],
  ] as const;

  return (
    <div className="ai-style">
      <div className="ai-style-head">
        <span className="ai-style-title">风格化</span>
        <span className="tag">{style === 'cloud' ? '云端处理' : '本地计算'}</span>
      </div>

      <div className="ai-style-options">
        {options.map(([value, label, hint]) => (
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

      {/* 确认条：不点「开始处理」就不会有任何字节离开浏览器 */}
      {cloudPending && !running && (
        <div className="ai-confirm">
          <p>
            AI 插画会把裁剪后的图片上传到火山云处理，单张约 <strong>0.2 元</strong>（每天最多 5 次），
            出图约 10 秒。继续？
          </p>
          <div className="ai-confirm-actions">
            <button type="button" className="btn-ghost" onClick={props.onCancelCloud}>
              取消
            </button>
            <button type="button" className="btn-primary" onClick={props.onConfirmCloud}>
              开始处理
            </button>
          </div>
        </div>
      )}

      {running && (
        <div className="ai-progress-text">
          {style === 'cloud' ? '云端处理中…（通常 8–15 秒）' : '像素化处理中…'}
        </div>
      )}

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
          {style === 'cloud' ? (
            <>
              <div>方式：云端（火山 Seedream 4.0）</div>
              <div>生成尺寸：{props.cloudMeta?.size ?? '—'}</div>
              <div>
                缓存：{props.cloudMeta?.cached ? '命中（未计费）' : '未命中'}
                {props.cloudMeta?.mock ? ' · mock' : ''}
              </div>
              <div>端到端：{(props.lastResult?.inferenceMs ?? 0).toFixed(0)} ms</div>
              <div>
                今日剩余：
                {props.cloudMeta?.quotaLeft === null || props.cloudMeta?.quotaLeft === undefined
                  ? '—'
                  : `${props.cloudMeta.quotaLeft} 次`}
              </div>
            </>
          ) : (
            <>
              <div>方式：本地 TS（无模型、无下载）</div>
              <div>耗时：{(props.lastResult?.inferenceMs ?? 0).toFixed(0)} ms</div>
            </>
          )}
          <div>设备：{deviceLine()}</div>
        </div>
      )}
    </div>
  );
}
