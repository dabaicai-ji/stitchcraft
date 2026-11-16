/**
 * 图纸预览画布 —— 缩放 / 平移 / 双指缩放 / LOD。
 *
 * 渲染架构（这是性能关键）：
 *   不在每一帧里画 N 个矩形，而是先把整个网格画成一张 **网格分辨率** 的离屏图，
 *   之后任何缩放都只是这一次 drawImage。因此 400×400 = 16 万格的图纸，
 *   缩放到 40 倍仍然只有 1 个 drawImage 调用。
 *
 *   LOD 分三档，解决「缩小时符号糊成一片、放大时格子看不清」：
 *     scale ≥ 1.2   → 每 10 格粗线（区块参考线，十字绣图纸的行业惯例）
 *     scale ≥ 6     → 单格细线
 *     scale ≥ 9     → 每格画符号（此时单格屏幕尺寸 ≥ 9px，符号可辨认）
 *
 * 坐标：所有 view 值都是 CSS 像素，canvas 内部按 devicePixelRatio 放大，
 * 所以高分屏不会糊，且鼠标坐标计算不需要额外换算。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GridData } from '../core/types.ts';
import { parseHex } from '../core/color/cie.ts';

const MIN_SCALE = 0.4;
const MAX_SCALE = 48;
/**
 * 符号 LOD 的判据是「字形像素高度」，不是缩放倍数。
 *
 * 之前写死 9 倍，结果用户缩放到 864% 时 scale=8.64，差 0.36 就看不到符号 ——
 * 典型的阈值卡在临界值上。现在改成：字号 = scale × 0.8，下限 5px
 * （5px 是加粗等宽大写字母在 1x 屏上还能辨认的下限），
 * 所以 scale ≥ 6.25 自动出符号；用户也可以手动强制开启。
 */
const SYMBOL_FONT_RATIO = 0.8;
const SYMBOL_MIN_FONT_PX = 5;
const SYMBOL_MIN_SCALE = SYMBOL_MIN_FONT_PX / SYMBOL_FONT_RATIO;
const CELL_LINE_MIN_SCALE = 6;
const BLOCK_LINE_MIN_SCALE = 1.2;
/** 可见格数超过该值就不画符号（否则 1 万次 fillText 会掉帧） */
const SYMBOL_MAX_VISIBLE = 9000;
const RULER = 18;

interface View {
  scale: number;
  x: number;
  y: number;
}

interface Props {
  grid: GridData;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export function GridCanvas({ grid }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<() => void>(() => {});
  const didFitRef = useRef(false);

  const [zoomLabel, setZoomLabel] = useState(0);
  const [hover, setHover] = useState<{ col: number; row: number } | null>(null);
  const [forceSymbols, setForceSymbols] = useState(false);

  /* ---------- 基底层：网格分辨率离屏图，深色格子上一律白底 ---------- */
  const base = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const img = ctx.createImageData(grid.width, grid.height);
    const d = img.data;
    const rgb = grid.palette.map((p) => parseHex(p.hex));

    for (let i = 0; i < grid.cells.length; i++) {
      const idx = grid.cells[i];
      const o = i * 4;
      if (idx < 0) {
        // 留白格：画布白底（未来接背景色）
        d[o] = 255;
        d[o + 1] = 255;
        d[o + 2] = 255;
      } else {
        const c = rgb[idx];
        d[o] = c[0];
        d[o + 1] = c[1];
        d[o + 2] = c[2];
      }
      d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }, [grid]);

  /* ---------- 符号颜色：按底色亮度选黑/白 ---------- */
  const textColors = useMemo(
    () =>
      grid.palette.map((p) => {
        const [r, g, b] = parseHex(p.hex);
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        return y > 140 ? 'rgba(15,17,21,0.92)' : 'rgba(255,255,255,0.95)';
      }),
    [grid],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, wrap.clientWidth);
    const ch = Math.max(1, wrap.clientHeight);
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, cw, ch);

    const { scale, x, y } = viewRef.current;
    const gw = grid.width;
    const gh = grid.height;
    const dw = gw * scale;
    const dh = gh * scale;

    // 图纸纸面
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, dw, dh);

    // 缩小到 2 倍以下时允许平滑，避免摩尔纹；放大时保持像素锐利
    ctx.imageSmoothingEnabled = scale < 2;
    ctx.drawImage(base, x, y, dw, dh);

    // 可见格范围（视口裁剪）
    const c0 = Math.max(0, Math.floor(-x / scale));
    const c1 = Math.min(gw, Math.ceil((cw - x) / scale));
    const r0 = Math.max(0, Math.floor(-y / scale));
    const r1 = Math.min(gh, Math.ceil((ch - y) / scale));

    if (c1 > c0 && r1 > r0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, dw, dh);
      ctx.clip();

      // 10 格粗线
      if (scale >= BLOCK_LINE_MIN_SCALE) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1.5;
        for (let c = Math.floor(c0 / 10) * 10; c <= c1; c += 10) {
          const sx = Math.round(x + c * scale) + 0.5;
          ctx.moveTo(sx, y);
          ctx.lineTo(sx, y + dh);
        }
        for (let r = Math.floor(r0 / 10) * 10; r <= r1; r += 10) {
          const sy = Math.round(y + r * scale) + 0.5;
          ctx.moveTo(x, sy);
          ctx.lineTo(x + dw, sy);
        }
        ctx.stroke();
      }

      // 单格细线
      if (scale >= CELL_LINE_MIN_SCALE) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 1;
        for (let c = c0; c <= c1; c++) {
          const sx = Math.round(x + c * scale) + 0.5;
          ctx.moveTo(sx, y);
          ctx.lineTo(sx, y + dh);
        }
        for (let r = r0; r <= r1; r++) {
          const sy = Math.round(y + r * scale) + 0.5;
          ctx.moveTo(x, sy);
          ctx.lineTo(x + dw, sy);
        }
        ctx.stroke();
      }

      // 符号
      const visible = (c1 - c0) * (r1 - r0);
      const wantSymbols = forceSymbols || scale >= SYMBOL_MIN_SCALE;
      if (wantSymbols && visible <= SYMBOL_MAX_VISIBLE) {
        const fontPx = Math.min(
          Math.max(scale * SYMBOL_FONT_RATIO, SYMBOL_MIN_FONT_PX),
          26,
        );
        ctx.font = `600 ${fontPx}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let lastIdx = -1;
        for (let r = r0; r < r1; r++) {
          const rowOff = r * gw;
          const sy = y + (r + 0.5) * scale;
          for (let c = c0; c < c1; c++) {
            const idx = grid.cells[rowOff + c];
            if (idx < 0) continue;
            if (idx !== lastIdx) {
              ctx.fillStyle = textColors[idx];
              lastIdx = idx;
            }
            ctx.fillText(grid.palette[idx].symbol, x + (c + 0.5) * scale, sy);
          }
        }
      }

      ctx.restore();
    }

    // 外边框
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, dw + 1, dh + 1);

    /* ---------- 坐标尺（粘在视口边缘，1-based，和图纸惯例一致） ---------- */
    ctx.fillStyle = 'rgba(15,17,21,0.88)';
    ctx.fillRect(0, 0, cw, RULER);
    ctx.fillRect(0, 0, RULER, ch);

    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(190,200,215,0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (scale * 10 >= 26) {
      for (let c = Math.ceil(c0 / 10) * 10; c <= c1; c += 10) {
        const sx = x + c * scale;
        if (sx < RULER + 2 || sx > cw - 14) continue;
        ctx.fillText(String(c + 1), sx + 2, RULER / 2);
      }
      ctx.save();
      for (let r = Math.ceil(r0 / 10) * 10; r <= r1; r += 10) {
        const sy = y + r * scale;
        if (sy < RULER + 2 || sy > ch - 8) continue;
        ctx.save();
        ctx.translate(RULER / 2, sy + 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText(String(r + 1), 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }

    setZoomLabel(Math.round(scale * 100));
  }, [base, forceSymbols, grid, textColors]);

  /* ---------- 绘制调度（rAF 合并同一帧内的多次变更） ---------- */
  useEffect(() => {
    drawRef.current = draw;
    scheduleRef.current = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        drawRef.current();
      });
    };
    scheduleRef.current();
  }, [draw]);

  /* ---------- 自适应铺满 ---------- */
  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    if (cw < 2 || ch < 2) return;
    const s = clamp(
      Math.min((cw - 8) / grid.width, (ch - 8) / grid.height),
      MIN_SCALE,
      MAX_SCALE,
    );
    viewRef.current = {
      scale: s,
      x: (cw - grid.width * s) / 2,
      y: (ch - grid.height * s) / 2,
    };
    scheduleRef.current();
  }, [grid.width, grid.height]);

  useEffect(() => {
    didFitRef.current = false;
    fit();
  }, [fit]);

  /* ---------- 交互：滚轮 / 拖拽 / 双指 / 尺寸变化 ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const localPoint = (ev: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    const zoomAt = (px: number, py: number, factor: number) => {
      const v = viewRef.current;
      const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (ns === v.scale) return;
      const k = ns / v.scale;
      v.x = px - (px - v.x) * k;
      v.y = py - (py - v.y) * k;
      v.scale = ns;
      scheduleRef.current();
    };

    // wheel 必须用原生监听并 passive:false，React 的 onWheel 是 passive 的，拦不住页面滚动
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const p = localPoint(ev);
      zoomAt(p.x, p.y, Math.exp(-ev.deltaY * 0.0018));
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let panning = false;
    let last = { x: 0, y: 0 };
    let pinch: { dist: number; cx: number; cy: number } | null = null;

    const pinchInfo = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return null;
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      return {
        dist: Math.hypot(dx, dy) || 1,
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
    };

    const onPointerDown = (ev: PointerEvent) => {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, localPoint(ev));
      if (pointers.size === 1) {
        panning = true;
        last = { x: ev.clientX, y: ev.clientY };
      } else if (pointers.size === 2) {
        panning = false;
        pinch = pinchInfo();
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      const p = localPoint(ev);
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p);

      if (pointers.size === 2) {
        const info = pinchInfo();
        if (info && pinch) {
          zoomAt(info.cx, info.cy, info.dist / pinch.dist);
          const v = viewRef.current;
          v.x += info.cx - pinch.cx;
          v.y += info.cy - pinch.cy;
          pinch = info;
          scheduleRef.current();
        }
      } else if (panning) {
        const v = viewRef.current;
        v.x += ev.clientX - last.x;
        v.y += ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        scheduleRef.current();
      }

      // 悬停 cell 坐标
      const v = viewRef.current;
      const col = Math.floor((p.x - v.x) / v.scale);
      const row = Math.floor((p.y - v.y) / v.scale);
      if (col >= 0 && row >= 0 && col < grid.width && row < grid.height) {
        setHover((prev) =>
          prev && prev.col === col && prev.row === row ? prev : { col, row },
        );
      } else {
        setHover((prev) => (prev === null ? prev : null));
      }
    };

    const endPointer = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) panning = false;
    };

    const onDoubleClick = () => fit();

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('dblclick', onDoubleClick);

    const ro = new ResizeObserver(() => {
      if (!didFitRef.current && wrap.clientWidth > 0) {
        didFitRef.current = true;
        fit();
      }
      scheduleRef.current();
    });
    ro.observe(wrap);
    if (wrap.clientWidth > 0) didFitRef.current = true;

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', endPointer);
      canvas.removeEventListener('dblclick', onDoubleClick);
      ro.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [fit, grid.height, grid.width]);

  const zoomBy = (factor: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cx = wrap.clientWidth / 2;
    const cy = wrap.clientHeight / 2;
    const v = viewRef.current;
    const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
    if (ns === v.scale) return;
    const k = ns / v.scale;
    v.x = cx - (cx - v.x) * k;
    v.y = cy - (cy - v.y) * k;
    v.scale = ns;
    scheduleRef.current();
  };

  const hoverInfo = hover ? `列 ${hover.col + 1} · 行 ${hover.row + 1}` : null;

  return (
    <div className="canvas-shell" ref={wrapRef}>
      <canvas ref={canvasRef} className="grid-canvas" />

      <div className="canvas-toolbar">
        <button type="button" onClick={() => zoomBy(1 / 1.4)} title="缩小">
          −
        </button>
        <span className="zoom-readout">{zoomLabel}%</span>
        <button type="button" onClick={() => zoomBy(1.4)} title="放大">
          +
        </button>
        <button type="button" className="fit-btn" onClick={fit} title="铺满（双击画布同效）">
          铺满
        </button>
        <button
          type="button"
          className={`toggle${forceSymbols ? ' is-on' : ''}`}
          onClick={() => setForceSymbols((v) => !v)}
          title="强制显示符号（缩得很小时也能看到，用于核对配色）"
        >
          符号
        </button>
      </div>

      <div className="canvas-status">
        {grid.width} × {grid.height} 格
        {hoverInfo ? ` · 附近 ${hoverInfo}` : ''}
        <span className="hint"> 滚轮缩放 · 拖拽平移 · 双指缩放</span>
      </div>
    </div>
  );
}
