/**
 * 尺寸归一测试（回归防线）。
 *
 * 事故背景：点选云端候选后，云端图（1368×1024）的 RGBA 被按裁剪源图尺寸
 * （2000×1500）交给管线，Worker 按 srcWidth 算 stride → 每行错位 → 画面糊。
 * 而且**指标看不出来**：错位后的图碎片率反而更低（大面积重复色块更"好绣"），
 * 只有图面能暴露。所以这里钉两件事：
 *   1. coverRect 的数学（归一化本身正确）；
 *   2. workerClient 入口断言（尺寸不自洽必须立刻抛，不能静默错位）。
 *
 * 跑法： node scripts/itest-size.ts
 */

import { coverRect } from '../src/ai/cloud.ts';
import { runPipelineInWorker } from '../src/lib/workerClient.ts';
import type { PipelineParams } from '../src/core/pipeline/run.ts';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

console.log('\n[1] coverRect：等比铺满 + 居中裁剪');

{
  // 同比例：1024² → 512²，正好铺满，无裁剪
  const r = coverRect(1024, 1024, 512, 512);
  ok('1:1 同比例铺满', near(r.x, 0) && near(r.y, 0) && near(r.w, 512) && near(r.h, 512));
}

{
  // 真实场景：1368×1024 的云端图 → 2000×1500 的源图（比例接近，裁掉极少）
  const r = coverRect(1368, 1024, 2000, 1500);
  const coversX = r.x <= 0 && r.x + r.w >= 2000;
  const coversY = r.y <= 0 && r.y + r.h >= 1500;
  ok('4:3 场景完全覆盖目标', coversX && coversY, JSON.stringify(r));
  ok('4:3 场景保持原始宽高比', near(r.w / r.h, 1368 / 1024, 1e-9));
  const cropRatio = Math.abs(r.x) / r.w + Math.abs(r.y) / r.h;
  ok('4:3 场景裁剪比例 < 2%', cropRatio < 0.02, `crop=${(cropRatio * 100).toFixed(2)}%`);
}

{
  // 竖版目标：正方形图放进 1000×2000，横向裁掉一半
  const r = coverRect(1000, 1000, 1000, 2000);
  ok('竖版 cover 取长边', near(r.w, 2000) && near(r.h, 2000));
  ok('竖版居中裁剪 x=-500', near(r.x, -500) && near(r.y, 0));
}

console.log('\n[2] workerClient 入口断言：尺寸不自洽必须立刻抛');

const params: PipelineParams = {
  targetWidth: 120,
  maxColors: 16,
  fabricCount: 14,
  strands: 2,
  minColorShare: 0.002,
  seed: 1,
  stylize: 0.2,
};

{
  // 事故复现：4MB 的云端图缓冲 + 512×512 的声明
  const wrong = new Uint8ClampedArray(1024 * 1024 * 4);
  let message = '';
  let rejected = false;
  try {
    // Node 里没有 Worker，若断言没拦住会抛 ReferenceError（另一个错误）
    await runPipelineInWorker({ rgba: wrong, srcWidth: 512, srcHeight: 512, params });
  } catch (err) {
    rejected = true;
    message = err instanceof Error ? err.message : String(err);
  }
  ok('尺寸不匹配 → reject', rejected);
  ok('错误信息指向调用方归一化', message.includes('像素缓冲与声明的源尺寸不一致'), message.slice(0, 80));
}

{
  // 正确尺寸：不应被断言拦下（Node 无 Worker，会以 Worker 相关错误结束，但错误信息不该是我们这条）
  const right = new Uint8ClampedArray(512 * 512 * 4);
  let message = '';
  try {
    await runPipelineInWorker({ rgba: right, srcWidth: 512, srcHeight: 512, params });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  ok('尺寸匹配 → 不触发断言', !message.includes('像素缓冲与声明的源尺寸不一致'), message.slice(0, 80));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} 尺寸归一测试：${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
