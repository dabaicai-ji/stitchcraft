/**
 * 裁剪步骤 —— 在渲染网格之前把原图裁到目标构图。
 *
 * 为什么必须有这一步：原图宽高比和图纸格数比例不一致时，直接缩放会把画面压扁
 * （长条横图直接生成 120×35 的网格就是这个问题）。裁剪框决定**构图比例**，
 * 图纸宽度只决定**分辨率**，两者解耦之后：
 *   - 改「图纸宽度」不需要重新裁剪，只是同一取景下更清晰；
 *   - 改比例预设才需要重新取景。
 *
 * 用 cropperjs v1：取景框拖拽/八向缩放、触摸、比例锁定都是现成的，
 * 自己写要 300 行且很难做到同样稳。
 */

import { useEffect, useRef, useState } from 'react';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';

export interface CropData {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  crop: CropData;
  /** 裁剪框的宽高比；null 表示自由比例 */
  aspect: number | null;
}

interface Props {
  imageUrl: string;
  /** 图纸目标宽度（格），用于预览最终格子数 */
  targetWidth: number;
  fabricCount: number;
  initialCrop: CropData | null;
  onApply: (result: CropResult) => void;
  onCancel: () => void;
}

type PresetKey = 'original' | '1:1' | '4:3' | '3:4' | '16:9' | 'free';

const PRESET_LABELS: { key: PresetKey; label: string }[] = [
  { key: 'original', label: '原图比例' },
  { key: '1:1', label: '1:1' },
  { key: '4:3', label: '4:3' },
  { key: '3:4', label: '3:4' },
  { key: '16:9', label: '16:9' },
  { key: 'free', label: '自由' },
];

/** 裁剪后送进管线的最大边长 */
const MAX_CROP_EDGE = 1600;

export function CropStage({
  imageUrl,
  targetWidth,
  fabricCount,
  initialCrop,
  onApply,
  onCancel,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cropperRef = useRef<Cropper | null>(null);
  const initialCropRef = useRef(initialCrop);

  const [preset, setPreset] = useState<PresetKey>(initialCrop ? 'free' : 'original');
  const [imgLoaded, setImgLoaded] = useState(false);
  const [box, setBox] = useState<CropData | null>(initialCrop);
  const naturalRatioRef = useRef(1);

  const ratioFor = (key: PresetKey): number | null => {
    switch (key) {
      case '1:1':
        return 1;
      case '4:3':
        return 4 / 3;
      case '3:4':
        return 3 / 4;
      case '16:9':
        return 16 / 9;
      case 'original':
        return naturalRatioRef.current;
      default:
        return null;
    }
  };

  /* ---------- 初始化 Cropper ---------- */
  useEffect(() => {
    const img = imgRef.current;
    if (!imgLoaded || !img) return;

    const cropper = new Cropper(img, {
      viewMode: 1,
      dragMode: 'move',
      aspectRatio: ratioFor(preset) ?? NaN,
      autoCropArea: 0.92,
      restore: false,
      guides: true,
      center: true,
      highlight: false,
      background: true,
      modal: true,
      responsive: true,
      checkOrientation: true,
      toggleDragModeOnDblclick: false,
      cropBoxMovable: true,
      cropBoxResizable: true,
      ready() {
        const init = initialCropRef.current;
        if (init) {
          cropper.setData(init);
          setBox(init);
        } else {
          const d = cropper.getData();
          setBox({ x: d.x, y: d.y, width: d.width, height: d.height });
        }
      },
      crop(event) {
        const d = event.detail;
        setBox({ x: d.x, y: d.y, width: d.width, height: d.height });
      },
    });

    cropperRef.current = cropper;
    return () => {
      cropper.destroy();
      cropperRef.current = null;
    };
    // preset 变化通过下面的 effect 用 setAspectRatio 处理，不重建实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgLoaded, imageUrl]);

  /* ---------- 比例预设 ---------- */
  useEffect(() => {
    const cropper = cropperRef.current;
    if (!cropper) return;
    cropper.setAspectRatio(ratioFor(preset) ?? NaN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const apply = () => {
    const cropper = cropperRef.current;
    if (!cropper) return;

    const data = cropper.getData();
    const crop: CropData = {
      x: Math.round(data.x),
      y: Math.round(data.y),
      width: Math.round(data.width),
      height: Math.round(data.height),
    };

    const canvas = cropper.getCroppedCanvas({
      maxWidth: MAX_CROP_EDGE,
      maxHeight: MAX_CROP_EDGE,
      imageSmoothingQuality: 'high',
    });
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    onApply({
      rgba: imgData.data,
      width: canvas.width,
      height: canvas.height,
      crop,
      aspect: crop.height > 0 ? crop.width / crop.height : null,
    });
  };

  const gridHeight =
    box && box.width > 0
      ? Math.max(1, Math.round((targetWidth * box.height) / box.width))
      : null;

  const widthCm = (targetWidth / fabricCount) * 2.54;

  return (
    <div className="crop-stage">
      <div className="crop-canvas">
        <img
          ref={imgRef}
          src={imageUrl}
          alt="待裁剪的原图"
          onLoad={(e) => {
            const el = e.currentTarget;
            naturalRatioRef.current = el.naturalWidth / el.naturalHeight || 1;
            setImgLoaded(true);
          }}
        />
      </div>

      <div className="crop-bar">
        <div className="crop-presets">
          {PRESET_LABELS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`chip${preset === p.key ? ' is-on' : ''}`}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="crop-info">
          {gridHeight ? (
            <>
              将生成 <strong>{targetWidth} × {gridHeight}</strong> 格 · 宽约{' '}
              {widthCm.toFixed(1)}cm
            </>
          ) : (
            '拖动取景框选择保留区域'
          )}
        </div>

        <div className="crop-actions">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={apply}>
            应用裁剪
          </button>
        </div>
      </div>
    </div>
  );
}
