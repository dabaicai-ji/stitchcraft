/**
 * 符号分配与对比色。
 *
 * 只使用 ASCII 字母 + 数字（A–Z、a–z、0–9，共 62 个）。
 * 原因：图纸要打印、要跨字体渲染，几何符号（◆▲●）在部分字体里会缺字或宽窄不一，
 * 而「看起来像一团黑」的符号会直接毁掉可读性。色数上限 40 < 62，够用。
 */

export const SYMBOL_SET: string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
];

/**
 * 按用量从多到少分配符号。
 * 最常用的颜色拿到最易辨认的 A/B/C，这是图纸可读性的关键。
 */
export function assignSymbols(count: number): string[] {
  if (count > SYMBOL_SET.length) {
    throw new Error(`色数 ${count} 超过可用符号数 ${SYMBOL_SET.length}`);
  }
  return SYMBOL_SET.slice(0, count);
}

/** 根据底色亮度选择黑/白文字，保证符号在任意线色上都看得清 */
export function contrastOn(linearR: number, linearG: number, linearB: number): string {
  const y = 0.2126 * linearR + 0.7152 * linearG + 0.0722 * linearB;
  return y > 0.32 ? '#111111' : '#ffffff';
}
