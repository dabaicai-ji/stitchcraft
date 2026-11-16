/**
 * AI 解读面板。
 *
 * 三条安全线（都不依赖模型自觉）：
 *   1. 只发送指标 JSON，不发图片；
 *   2. 输出里的数字要和 payload 对得上，对不上就红字提示；
 *   3. 模型给的建议参数先过白名单 + clamp，且必须用户点一下才生效。
 *
 * 面板顶部有 Key 状态徽标：挂载时 GET /api/insight 做健康检查，
 * 这样「Key 到底读到了没有」不用靠猜，也不花 token。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PipelineParams } from '../core/pipeline/run.ts';
import type { StitchabilityReport } from '../core/types.ts';
import {
  auditNarrative,
  buildLLMPayload,
  collectAllowedNumbers,
} from '../core/llm/payload.ts';
import { InsightError, streamInsight } from '../llm/client.ts';
import { describePatch, extractPatch } from '../llm/patch.ts';
import { buildMessages } from '../llm/prompt.ts';

interface Props {
  report: StitchabilityReport;
  onApplyPatch: (patch: Partial<PipelineParams>) => void;
}

type Status = 'idle' | 'loading' | 'done' | 'error';

interface Audit {
  ok: boolean;
  unknown: number[];
  checked: number;
}

/** 去掉模型给的 JSON 代码块，正文里不重复展示 */
function stripCodeBlock(text: string): string {
  return text.replace(/```(?:json)?[\s\S]*?```/g, '').trim();
}

export function AiReport({ report, onApplyPatch }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [patch, setPatch] = useState<Partial<PipelineParams> | null>(null);
  const [note, setNote] = useState('');
  /** null = 检测中/无法判断，true = 代理已读到 Key */
  const [configured, setConfigured] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/insight')
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { configured?: boolean };
        return typeof body.configured === 'boolean' ? body.configured : null;
      })
      .catch(() => null)
      .then((v) => {
        if (alive) setConfigured(v);
      });
    return () => {
      alive = false;
    };
  }, []);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus('loading');
    setText('');
    setError(null);
    setErrorStatus(null);
    setAudit(null);
    setPatch(null);

    const payload = buildLLMPayload(report);
    const allowed = collectAllowedNumbers(payload);

    try {
      const full = await streamInsight(
        buildMessages(payload, note),
        ctrl.signal,
        (delta) => setText((prev) => prev + delta),
      );

      setAudit(auditNarrative(full, allowed));
      const nextPatch = extractPatch(full);
      if (nextPatch) setPatch(nextPatch);
      setStatus('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setStatus('error');
      setErrorStatus(err instanceof InsightError ? err.status : null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [report, note]);

  const body = stripCodeBlock(text);
  const ready = configured !== false;

  return (
    <section className="card ai-report">
      <header className="card-head">
        <h3>AI 解读</h3>
        <span
          className={`tag ${configured === false ? 'tag-warn' : configured ? 'tag-ok' : ''}`}
        >
          {configured === null ? '检测中…' : configured ? 'Key 已就绪' : '未配置 Key'}
        </span>
      </header>

      {status === 'idle' &&
        (ready ? (
          <p className="card-note">
            上面的数字都是程序算的。点一下让模型把它们翻译成人话，并给出可执行建议。
            只发送指标 JSON，不上传图片。
          </p>
        ) : (
          <div className="ai-error">
            <p>代理没有读到 DEEPSEEK_API_KEY，AI 解读暂不可用。</p>
            <p className="ai-error-hint">
              在 <code>stitchcraft/.env.local</code> 写入{' '}
              <code>DEEPSEEK_API_KEY=sk-...</code>，然后重启{' '}
              <code>npm run dev</code>。刷新页面后本卡右上角应显示「Key 已就绪」。
            </p>
          </div>
        ))}

      {status !== 'idle' && (
        <div className="ai-text">
          {body || (status === 'loading' ? '正在生成…' : '')}
        </div>
      )}

      {status === 'done' && audit && (
        <div className={`ai-audit ${audit.ok ? 'is-ok' : 'is-bad'}`}>
          {audit.ok
            ? `✓ 数字校验通过（${audit.checked} 个数字全部来自指标）`
            : `⚠ 检测到 ${audit.unknown.length} 个无出处的数字：${audit.unknown
                .slice(0, 5)
                .join(', ')} —— 这段文字不可全信`}
        </div>
      )}

      {patch && status === 'done' && (
        <div className="ai-patch">
          <span>建议参数：{describePatch(patch)}</span>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              onApplyPatch(patch);
              setPatch(null);
            }}
          >
            应用并重算
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="ai-error">
          <p>{error}</p>
          {errorStatus === 503 && (
            <p className="ai-error-hint">
              在 <code>stitchcraft/.env.local</code> 写入{' '}
              <code>DEEPSEEK_API_KEY=sk-...</code> 后重启{' '}
              <code>npm run dev</code>。
            </p>
          )}
        </div>
      )}

      <div className="ai-actions">
        <input
          className="ai-note"
          type="text"
          value={note}
          maxLength={120}
          placeholder="补充说明（可选）：比如「想做得简单点」「送人用」"
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary ai-run"
          onClick={() => void run()}
          disabled={status === 'loading' || !ready}
        >
          {status === 'loading' ? '生成中…' : status === 'done' ? '重新生成' : '让 AI 解释'}
        </button>
      </div>
    </section>
  );
}
