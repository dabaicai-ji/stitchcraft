/**
 * 指标面板：把 5 个确定性指标渲染成人能读的卡片。
 *
 * 设计原则：**数字永远在第一位，解释在第二位。**
 * 每张卡都给出「实际值 / 阈值 / 结论」，而不是只给一个形容词。
 */

import type { StitchabilityReport } from '../core/types.ts';

interface Props {
  report: StitchabilityReport;
}

function pct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function Meter({
  value,
  warn,
  block,
  label,
  display,
  hint,
}: {
  value: number;
  warn: number;
  block: number;
  label: string;
  display: string;
  hint?: string;
}) {
  const max = Math.max(block * 1.6, value * 1.05, 0.001);
  const ratio = Math.min(1, value / max);
  const level = value >= block ? 'block' : value >= warn ? 'warn' : 'ok';
  return (
    <div className={`meter meter-${level}`}>
      <div className="meter-head">
        <span className="meter-label" title={hint}>
          {label}
        </span>
        <span className="meter-value">{display}</span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${ratio * 100}%` }} />
        <div className="meter-warn" style={{ left: `${(warn / max) * 100}%` }} />
        <div className="meter-block" style={{ left: `${(block / max) * 100}%` }} />
      </div>
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span className="stars" aria-label={`难度 ${n} 星`}>
      {'★'.repeat(n)}
      <span className="stars-dim">{'★'.repeat(5 - n)}</span>
    </span>
  );
}

const LEVEL_TEXT: Record<string, string> = {
  block: '劝退',
  warn: '注意',
  info: '提示',
};

export function MetricCards({ report }: Props) {
  const { scale, continuity, confusion, supply, tone, difficulty, issues } = report;

  const topColors = supply.perColor.slice(0, 8);

  return (
    <div className="metrics">
      {/* ---------- 难度 ---------- */}
      <section className="card card-difficulty">
        <header className="card-head">
          <h3>可绣性难度</h3>
          <Stars n={difficulty.stars} />
        </header>
        <div className="difficulty-main">
          <span className="difficulty-label">{difficulty.label}</span>
          <span className="difficulty-score">{Math.round(difficulty.score * 100)} / 100</span>
        </div>
        <div className="breakdown">
          {(
            [
              ['噪点', difficulty.breakdown.noise, '孤岛针 + 碎片块，决定费不费手'],
              ['混淆', difficulty.breakdown.confusion, '相邻色太像，决定会不会绣错'],
              ['采购', difficulty.breakdown.supply, '色数 + 束数，决定贵不贵'],
            ] as const
          ).map(([label, value, hint]) => (
            <div className="breakdown-row" key={label} title={hint}>
              <span>{label}</span>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${value * 100}%` }} />
              </div>
              <span className="bar-num">{Math.round(value * 100)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 规模 ---------- */}
      <section className="card">
        <header className="card-head">
          <h3>规模</h3>
          <span className="tag">{scale.fabricCount}ct</span>
        </header>
        <dl className="kv">
          <div>
            <dt>图纸</dt>
            <dd>
              {scale.width} × {scale.height} 格
            </dd>
          </div>
          <div>
            <dt>成品</dt>
            <dd>
              {scale.widthCm.toFixed(1)} × {scale.heightCm.toFixed(1)} cm
            </dd>
          </div>
          <div>
            <dt>可绣格数</dt>
            <dd>{scale.stitchableCells.toLocaleString()}</dd>
          </div>
          <div>
            <dt>实际用色</dt>
            <dd>
              {scale.colorCount} 色{scale.backgroundCells > 0 ? ` · 留白 ${scale.backgroundCells}` : ''}
            </dd>
          </div>
        </dl>
      </section>

      {/* ---------- 噪点 ---------- */}
      <section className="card">
        <header className="card-head">
          <h3>噪点 / 连续性</h3>
          <span className="tag">{continuity.componentCount} 个连通块</span>
        </header>
        <Meter
          label="碎片率"
          hint="落在 1–4 格同色小块里的格占比；越高越要反复起针收针"
          value={continuity.confettiRatio}
          warn={0.08}
          block={0.15}
          display={pct(continuity.confettiRatio)}
        />
        <Meter
          label="孤立单针"
          hint="8 邻域没有任何同色格；必须单独起针收针"
          value={continuity.isolatedRatio}
          warn={0.01}
          block={0.03}
          display={pct(continuity.isolatedRatio)}
        />
        <Meter
          label="仅对角相连"
          hint="4 邻域无同色；画面上连着，但下针要沿对角线走，背面走线变多"
          value={continuity.isolated4Ratio}
          warn={0.05}
          block={0.2}
          display={pct(continuity.isolated4Ratio)}
        />
        <p className="card-note">
          最大同色块占 {pct(continuity.maxComponentShare)} · 平均块大小{' '}
          {continuity.meanComponentSize.toFixed(1)} 格
        </p>
      </section>

      {/* ---------- 混淆 ---------- */}
      <section className="card">
        <header className="card-head">
          <h3>相邻色混淆</h3>
          <span className="tag">{confusion.pairCount} 对</span>
        </header>
        {confusion.pairs.length === 0 ? (
          <p className="ok-note">
            没有 ΔE00 &lt; {confusion.maxDeltaE} 的相邻色对，绣起来不会认错线。
          </p>
        ) : (
          <ul className="pairs">
            {confusion.pairs.slice(0, 4).map((p) => (
              <li key={`${p.a}-${p.b}`}>
                <span
                  className="swatch"
                  style={{ background: report.supply.perColor.find((c) => c.dmcCode === p.dmcA)?.hex ?? '#888' }}
                />
                <span
                  className="swatch"
                  style={{ background: report.supply.perColor.find((c) => c.dmcCode === p.dmcB)?.hex ?? '#888' }}
                />
                <span className="pair-code">
                  {p.dmcA} / {p.dmcB}
                </span>
                <span className={`pair-de ${p.deltaE00 < confusion.maxDeltaE / 2 ? 'danger' : ''}`}>
                  ΔE00 {p.deltaE00.toFixed(1)}
                </span>
                <span className="pair-edges">{p.sharedEdges} 条边相邻</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- 线量 ---------- */}
      <section className="card">
        <header className="card-head">
          <h3>线量与采购</h3>
          <span className="tag">
            {supply.totalSkeins} 束 · ¥{supply.totalCost}
          </span>
        </header>
        <table className="thread-table">
          <thead>
            <tr>
              <th>线号</th>
              <th className="num">格数</th>
              <th className="num">束</th>
            </tr>
          </thead>
          <tbody>
            {topColors.map((c) => (
              <tr key={c.dmcCode}>
                <td>
                  <span className="swatch" style={{ background: c.hex }} />
                  <span className="sym">{c.symbol}</span>
                  {c.dmcCode}
                </td>
                <td className="num">{c.stitchCount.toLocaleString()}</td>
                <td className="num">{c.skeins}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {supply.perColor.length > topColors.length && (
          <p className="card-note">仅显示用量前 {topColors.length} 色</p>
        )}
        <p className="card-note">
          一束约可绣 {supply.perColor[0]?.stitchesPerSkein ?? 0} 格（{supply.fabricCount}ct /{' '}
          {supply.strands} 股 · 每格 {supply.perStitchMm.toFixed(1)}mm）
        </p>
      </section>

      {/* ---------- 明暗 ---------- */}
      {tone && (
        <section className="card">
          <header className="card-head">
            <h3>明暗溢出</h3>
            <span className="tag">
              亮度 {Math.round(tone.meanLuma * 100)}
            </span>
          </header>
          <Meter
            label="暗部溢出"
            hint="低于 5% 亮度的像素占比；减色后会糊成一块死黑"
            value={tone.shadowClipRatio}
            warn={0.15}
            block={0.3}
            display={pct(tone.shadowClipRatio)}
          />
          <Meter
            label="亮部溢出"
            hint="高于 95% 亮度的像素占比；减色后会糊成一块死白"
            value={tone.highlightClipRatio}
            warn={0.15}
            block={0.3}
            display={pct(tone.highlightClipRatio)}
          />
          <p className="card-note">
            动态范围 p5–p95：{Math.round(tone.p05 * 100)} – {Math.round(tone.p95 * 100)}
          </p>
        </section>
      )}

      {/* ---------- 问题 ---------- */}
      <section className="card">
        <header className="card-head">
          <h3>规则引擎结论</h3>
          <span className="tag">{issues.length} 条</span>
        </header>
        {issues.length === 0 ? (
          <p className="ok-note">没有触发任何规则，这张图纸各项指标都在舒适区。</p>
        ) : (
          <ul className="issues">
            {issues.map((issue, i) => (
              <li key={`${issue.code}-${i}`} className={`issue issue-${issue.level}`}>
                <span className="issue-level">{LEVEL_TEXT[issue.level] ?? issue.level}</span>
                <p>{issue.suggestion}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
