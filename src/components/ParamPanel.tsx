/**
 * 参数面板。
 *
 * 「格数」和「布种」是联动的：用户只需要关心成品多大、要多少格，
 * 物理尺寸由 ct（每英寸格数）换算出来实时显示。
 */

import type { PipelineParams } from '../core/pipeline/run.ts';
import type { FabricCount } from '../core/types.ts';

interface Props {
  params: PipelineParams;
  onChange: (patch: Partial<PipelineParams>) => void;
  suggested: number | null;
  uniqueColors: number | null;
}

const FABRIC_OPTIONS: FabricCount[] = [14, 16, 18];

export function ParamPanel({ params, onChange, suggested, uniqueColors }: Props) {
  const widthCm = (params.targetWidth / params.fabricCount) * 2.54;
  const showSuggest = suggested !== null && suggested !== params.maxColors;

  return (
    <div className="params">
      <div className="param">
        <div className="param-head">
          <label htmlFor="p-width">图纸宽度</label>
          <span className="param-value">{params.targetWidth} 格</span>
        </div>
        <input
          id="p-width"
          type="range"
          min={40}
          max={400}
          step={10}
          value={params.targetWidth}
          onChange={(e) => onChange({ targetWidth: Number(e.target.value) })}
        />
        <div className="param-foot">
          成品约 {widthCm.toFixed(1)} cm 宽（{params.fabricCount}ct）
        </div>
      </div>

      <div className="param">
        <div className="param-head">
          <label htmlFor="p-colors">
            色数
            {showSuggest && (
              <button
                type="button"
                className="suggest-chip"
                onClick={() => onChange({ maxColors: suggested })}
                title="按色彩丰富度自动探测的肘部色数"
              >
                推荐 {suggested} 色
              </button>
            )}
          </label>
          <span className="param-value">{params.maxColors} 色</span>
        </div>
        <input
          id="p-colors"
          type="range"
          min={4}
          max={40}
          step={1}
          value={params.maxColors}
          onChange={(e) => onChange({ maxColors: Number(e.target.value) })}
        />
        <div className="param-foot">
          {uniqueColors !== null
            ? `这张图去重后有 ${uniqueColors.toLocaleString()} 种颜色`
            : '色数越少越好绣，越多越接近原图'}
        </div>
      </div>

      <div className="param">
        <div className="param-head">
          <label htmlFor="p-stylize">平滑降噪</label>
          <span className="param-value">{Math.round(params.stylize * 100)}%</span>
        </div>
        <input
          id="p-stylize"
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={params.stylize}
          onChange={(e) => onChange({ stylize: Number(e.target.value) })}
        />
        <div className="param-foot">
          压掉 1–2 格的小碎块，明显降低碎片率；调太高会糊掉细节、并用不满色数
        </div>
      </div>

      <div className="param-row">
        <div className="param">
          <div className="param-head">
            <label htmlFor="p-fabric">布种</label>
          </div>
          <select
            id="p-fabric"
            value={params.fabricCount}
            onChange={(e) => onChange({ fabricCount: Number(e.target.value) as FabricCount })}
          >
            {FABRIC_OPTIONS.map((ct) => (
              <option key={ct} value={ct}>
                {ct} ct
              </option>
            ))}
          </select>
        </div>

        <div className="param">
          <div className="param-head">
            <label htmlFor="p-strands">股数</label>
          </div>
          <select
            id="p-strands"
            value={params.strands}
            onChange={(e) => onChange({ strands: Number(e.target.value) })}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n} 股
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
