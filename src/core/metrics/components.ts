/**
 * 连续性 / 噪点指标（指标 1）
 *
 * 用并查集做同色连通域标记，一次扫描完成。两个关键取舍：
 *
 *  1) 主口径用 **8 邻接**：对角相连的两格可以连续走针，不算「孤立针」。
 *  2) 但 8 邻接会把**棋盘格**判成完全连通（实为最痛苦的绣法之一）。
 *     所以额外统计 `isolated4Ratio`（4 邻域内无同色）专门抓这个病理。
 *     只报 8 邻接会给出「快乐误判」，这是原型阶段最容易被投诉的失准点。
 *
 * 复杂度：O(N·α(N))，400×400 网格 ≈ 160k 格，实测 < 10ms。
 */

import { BACKGROUND } from '../types.ts';
import type {
  ComponentStats,
  GridData,
  PerColorComponents,
} from '../types.ts';

export function computeComponentStats(
  grid: GridData,
  confettiMax = 5,
): ComponentStats {
  const { width: W, height: H, cells } = grid;
  const n = grid.palette.length;
  const N = W * H;

  if (cells.length !== N) {
    throw new Error(`cells 长度 ${cells.length} 与 ${W}x${H} 不符`);
  }

  const parent = new Int32Array(N);
  const rank = new Uint8Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // 路径压缩
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };

  const union = (a: number, b: number): void => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };

  // ---- 一遍扫描，只和「已扫过的」W / NW / N / NE 合并 → 等价 8 邻接 ----
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const c = cells[i];
      if (c === BACKGROUND) continue;

      if (x > 0 && cells[i - 1] === c) union(i, i - 1);
      if (y > 0) {
        const up = i - W;
        if (cells[up] === c) union(i, up);
        if (x > 0 && cells[up - 1] === c) union(i, up - 1);
        if (x < W - 1 && cells[up + 1] === c) union(i, up + 1);
      }
    }
  }

  // ---- 统计每个连通块大小 ----
  const size = new Int32Array(N);
  let stitchable = 0;
  for (let i = 0; i < N; i++) {
    if (cells[i] === BACKGROUND) continue;
    stitchable++;
    size[find(i)]++;
  }

  // ---- 分类统计 ----
  const perColor: PerColorComponents[] = [];
  for (let k = 0; k < n; k++) {
    perColor.push({
      paletteIndex: k,
      stitchCount: 0,
      componentCount: 0,
      largestComponent: 0,
      confettiCells: 0,
    });
  }

  const seenRoot = new Uint8Array(N);
  let isolated = 0;
  let isolated4 = 0;
  let confetti = 0;
  let maxComponent = 0;
  let componentCount = 0;

  for (let i = 0; i < N; i++) {
    const c = cells[i];
    if (c === BACKGROUND) continue;
    if (c < 0 || c >= n) throw new Error(`非法 palette 下标 ${c}`);

    const r = find(i);
    const sz = size[r];
    const pc = perColor[c];
    pc.stitchCount++;

    if (!seenRoot[r]) {
      seenRoot[r] = 1;
      componentCount++;
      pc.componentCount++;
      if (sz > pc.largestComponent) pc.largestComponent = sz;
      if (sz > maxComponent) maxComponent = sz;
    }

    if (sz === 1) isolated++;
    if (sz < confettiMax) {
      confetti++;
      pc.confettiCells++;
    }

    // 4 邻域是否有同色：抓「仅对角相连」的棋盘格
    const x = i % W;
    const y = (i - x) / W;
    let has4 = false;
    if (x > 0 && cells[i - 1] === c) has4 = true;
    else if (x < W - 1 && cells[i + 1] === c) has4 = true;
    else if (y > 0 && cells[i - W] === c) has4 = true;
    else if (y < H - 1 && cells[i + W] === c) has4 = true;
    if (!has4) isolated4++;
  }

  const div = (a: number, b: number): number => (b === 0 ? 0 : a / b);

  return {
    stitchableCells: stitchable,
    isolatedCells: isolated,
    isolatedRatio: div(isolated, stitchable),
    isolated4Cells: isolated4,
    isolated4Ratio: div(isolated4, stitchable),
    confettiCells: confetti,
    confettiRatio: div(confetti, stitchable),
    componentCount,
    maxComponentSize: maxComponent,
    maxComponentShare: div(maxComponent, stitchable),
    meanComponentSize: div(stitchable, componentCount),
    perColor,
  };
}
