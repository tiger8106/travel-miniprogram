// 端到端：用真实的「9月20日工作通勤.docx」跑完整 callLLM 流程
// 前置：python 已把 docx 文本导出到 commute-raw.txt
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 读 Key
const envLocal = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf-8');
const keyMatch = envLocal.match(/LLM_API_KEY\s*=\s*(\S+)/);
if (!keyMatch) {
  console.error('未在 .env.local 找到 LLM_API_KEY');
  process.exit(1);
}
process.env.LLM_API_KEY = keyMatch[1];
process.env.LLM_PROVIDER = 'qwen';
process.env.LLM_MODEL = 'qwen-turbo';

const { callLLM } = require(path.join(ROOT, 'cloudfunctions', 'parseTravelPlan', 'llm.js'));

(async () => {
  const rawText = fs.readFileSync(path.join(__dirname, 'commute-raw.txt'), 'utf-8');
  console.log('=== 文档原文 ===');
  console.log(rawText);
  console.log('\n=== 开始解析 ===');
  const t0 = Date.now();
  const r = await callLLM(rawText);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`耗时: ${cost}s`);
  console.log('title:', r.title);
  console.log('startDate:', r.startDate, ' endDate:', r.endDate);
  console.log('items:', (r.items || []).length);

  // 模拟云函数 index.js 的清洗（时间归一化）
  const normTime = (t) => {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${p(Math.min(23, +m[1]))}:${p(Math.min(59, +m[2]))}`;
  };
  const items = (r.items || []).map((it) => ({
    ...it,
    startTime: normTime(it.startTime),
    endTime: normTime(it.endTime),
  })).sort((a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99'));

  console.log('\n=== 行程（按时间排序） ===');
  items.forEach((it) => {
    console.log(` ${it.startTime || '--:--'}${it.endTime ? '-' + it.endTime : ''}  ${it.activity}${it.startLocation ? `  [${it.startLocation}→${it.endLocation}]` : ''}`);
  });

  // 断言
  const assert = require('assert');
  assert.strictEqual(r.startDate, '2026-09-20', 'startDate 应为 2026-09-20');
  assert.strictEqual(r.endDate, '2026-09-20', 'endDate 应为 2026-09-20');
  assert.ok(items.length >= 4, '行程应至少 4 条');
  const first = items[0];
  assert.ok(/^0?\d{1,2}:\d{2}$/.test(first.startTime) && first.startTime.startsWith('07'), '最早行程应在 07 点');

  fs.writeFileSync(path.join(__dirname, 'commute-result.json'), JSON.stringify(r, null, 2));
  console.log('\n断言全部通过 ✓  结果已存 commute-result.json');
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
