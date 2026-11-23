/**
 * 风格化面板：原始 / 像素 / AI 插画。
 *
 * 硬性约束（用户明确要求，改文案前先看这里）：
 *   - **禁止**出现「降碎片」类表述；只讲「更像素 / 更像图纸」。
 *   - 指标面板如实显示启用前后两个碎片率数字，不加评价。
 *   - AI 插画必须**点了才开始上传**：先出确认条，用户点「开始处理」才发请求。
 *
 * AI 插画一次生成两张候选（火山 n 参数无效，服务端并行发两次）：
 * 两张并排展示 → 用户点选 → 选中的那张才进本地管线。
 * 没选之前管线不跑，也不会写缓存。
 */

import type { AiStyle, AiStyleResult } from '../ai/types.ts';
import type { CloudMeta, CloudRunResult } from '../ai/cloud.ts';
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
  /** 本次生成的两张候选（null = 还没到「选择」阶段） */
  cloudRun: CloudRunResult | null;
  /** 用户已选中的候选 id */
  pickedId: string | null;
  /** 点选某张候选 */
  onPick: (candidateId: string) => void;
  picking: boolean;
  debug: boolean;
  /** 不启用风格化时的碎片率，用于如实展示「前后两个数字」 */
  baselineConfetti: number | null;
  currentConfetti: number | null;
}

export function AiStylePanel(props: Props) {
  const { style, onChoose, running, error, cloudPending, cloudRun, pickedId } = props;

  const options = [
    ['none', '原始', '不启用风格化，直接走原图'],
    ['pixel', '像素', '本地计算 · 0 下载 0 费用'],
    ['cloud', 'AI 插画', '上传到火山云 · 每次 2 张约 0.4 元'],
  ] as const;

  const choosing = cloudRun !== null && !pickedId;

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
            AI 插画会把裁剪后的图片上传到火山云处理，<strong>每次生成 2 张候选</strong>，约{' '}
            <strong>0.4 元</strong>（每天最多 3 次），出图约 15 秒。继续？
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
          {style === 'cloud'
            ? '云端处理中…（并行生成 2 张，通常 10–20 秒）'
            : '像素化处理中…'}
        </div>
      )}

      {/* 两张候选并排：点选之前管线不动 */}
      {style === 'cloud' && cloudRun && cloudRun.candidates.length > 0 && (
        <div className="ai-candidates-wrap">
          <div className="ai-candidates-hint">
            {choosing ? 'A 极简好绣 · B 细节清晰，选一张进入图纸处理：' : '已选：'}
            {cloudRun.cached && <span className="ai-cached"> · 缓存命中，未计费</span>}
          </div>
          <div className="ai-candidates">
            {cloudRun.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ai-candidate${pickedId === c.id ? ' is-on' : ''}`}
                disabled={props.picking}
                onClick={() => props.onPick(c.id)}
                title={`${c.label} · ${c.hint} · ${(c.bytes / 1024).toFixed(0)}KB · ${(c.upstreamMs / 1000).toFixed(1)}s`}
              >
                <img src={c.dataUrl} alt={`候选 ${c.label} ${c.hint}`} />
                <span className="ai-candidate-badge">{c.label}</span>
                <span className="ai-candidate-label">
                  {pickedId === c.id ? '已选' : c.hint}
                </span>
              </button>
            ))}
          </div>
          {props.picking && <div className="ai-progress-text">正在读取选中的图…</div>}
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
              <div>方式：云端（火山 Seedream 4.0 · 并行 2 张）</div>
              <div>生成尺寸：{props.cloudMeta?.size ?? '—'}</div>
              <div>
                候选：{cloudRun?.candidates.length ?? 0} 张
                {pickedId ? ` · 选中 ${pickedId}` : ' · 待选择'}
                {cloudRun?.cached ? ' · 缓存' : ''}
                {cloudRun?.mock ? ' · mock' : ''}
              </div>
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
