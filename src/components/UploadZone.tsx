/**
 * 上传区：拖拽 / 点击 / 移动端拍照。
 *
 * 移动端最低保证：input 带 accept="image/*" 与 capture 属性可选，
 * 不做复杂适配，但保证能选图、能上传。
 */

import { useRef, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
  fileName?: string | null;
  compact?: boolean;
}

export function UploadZone({ onFile, fileName, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`upload ${compact ? 'upload-compact' : ''} ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
      {compact ? (
        <span className="upload-compact-text">
          更换图片{fileName ? `（当前：${fileName}）` : ''}
        </span>
      ) : (
        <>
          <div className="upload-icon">⬆</div>
          <p className="upload-title">拖入图片，或点击选择</p>
          <p className="upload-sub">JPG / PNG / WebP · 建议 800px 以上 · 人物 / 宠物 / 风景 / logo 均可</p>
        </>
      )}
    </div>
  );
}
