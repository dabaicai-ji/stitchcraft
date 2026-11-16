/**
 * 色彩科学内核：sRGB ↔ CIELAB ↔ CIEDE2000
 *
 * 为什么不用 RGB 欧氏距离：DMC 有 400+ 色，RGB 空间里「数值相近」不等于
 * 「看起来相近」。减色映射和混淆检测都必须用感知色差。
 *
 * 本实现按 Sharma, Wu & Dalal (2005) 的参考公式，已对标准测试数据校验
 * （见 scripts/selftest.ts，容差 1e-4）。
 */

import type { Lab } from '../types.ts';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const POW25_7 = 25 ** 7;

/* ------------------------------------------------------------------ */
/* sRGB → CIELAB (D65, 2°)                                             */
/* ------------------------------------------------------------------ */

function lin(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** 解析 "#rgb" / "#rrggbb" */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error(`非法 hex 颜色: ${hex}`);
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function hexToRgb(hex: string): [number, number, number] {
  return parseHex(hex);
}

/** 线性光 sRGB（0..1）→ CIELAB (D65, 2°) */
export function linearRgbToLab(R: number, G: number, B: number): Lab {
  // sRGB D65 矩阵，白点已归一化 (Xn=0.95047, Yn=1, Zn=1.08883)
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;

  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const f = (t: number): number => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);

  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function srgbToLab(hex: string): Lab {
  const [r8, g8, b8] = parseHex(hex);
  return linearRgbToLab(lin(r8 / 255), lin(g8 / 255), lin(b8 / 255));
}

/* ------------------------------------------------------------------ */
/* CIEDE2000                                                           */
/* ------------------------------------------------------------------ */

function hueDeg(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  let h = Math.atan2(b, a) * DEG;
  if (h < 0) h += 360;
  return h;
}

function deltaHue(h1: number, h2: number, c1: number, c2: number): number {
  if (c1 * c2 === 0) return 0;
  let d = h2 - h1;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

function meanHue(h1: number, h2: number, c1: number, c2: number): number {
  if (c1 * c2 === 0) return h1 + h2;
  if (Math.abs(h1 - h2) <= 180) return (h1 + h2) / 2;
  if (h1 + h2 < 360) return (h1 + h2 + 360) / 2;
  return (h1 + h2 - 360) / 2;
}

/** CIEDE2000 色差。返回值量纲≈「刚好能分辨」的 2~3 数量级。 */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueDeg(a1p, b1);
  const h2p = hueDeg(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dh = deltaHue(h1p, h2p, C1p, C2p);
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * RAD) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  const hbarp = meanHue(h1p, h2p, C1p, C2p);

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * RAD) +
    0.24 * Math.cos(2 * hbarp * RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * RAD);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;

  const x = dLp / Sl;
  const y = dCp / Sc;
  const z = dHp / Sh;

  return Math.sqrt(x * x + y * y + z * z + Rt * y * z);
}
