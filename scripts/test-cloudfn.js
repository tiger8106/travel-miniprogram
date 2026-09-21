// scripts/test-cloudfn.js —— 直接加载云函数的新 llm.js / splitter.js 做端到端验证
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rawText = fs.readFileSync(path.join(__dirname, 'docx-raw.txt'), 'utf-8');

// 读 .env.local 注入环境变量（模拟云函数环境变量）
fs.readFileSync(path.join(root, '.env.local'), 'utf-8').split('\n').forEach((line) => {
  if (line.trim().startsWith('#')) return;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m && m[2]) process.env[m[1]] = m[2].trim();
});
// 云函数当前线上配置用的是 qwen-turbo
process.env.LLM_MODEL = 'qwen-turbo';

const { splitDocument, inferYear, ymd } = require('../cloudfunctions/parseTravelPlan/splitter');
const { callLLM } = require('../cloudfunctions/parseTravelPlan/llm');

(async () => {
  // 先单测 splitter
  const sp = splitDocument(rawText);
  console.log('=== splitter 单测 ===');
  console.log('days:', sp.days.length, '| booking lines:', sp.booking.length, '| header lines:', sp.header.length);
  console.log('year:', inferYear(sp.days));

  const t0 = Date.now();
  const result = await callLLM(rawText);
  const ms = Date.now() - t0;

  console.log('\n=== callLLM 端到端 ===');
  console.log('总耗时:', ms, 'ms (' + (ms / 1000).toFixed(1) + 's)');
  console.log('title:', result.title);
  console.log('summary:', (result.summary || '').slice(0, 60));
  console.log('startDate:', result.startDate, '| endDate:', result.endDate);

  const items = (result.items || []).filter((it) => it && (it.activity || '').trim());
  const byDay = {};
  items.forEach((it) => { byDay[it.dayIndex] = (byDay[it.dayIndex] || 0) + 1; });
  console.log('items:', items.length, '| 按天分布:', JSON.stringify(byDay));

  const alarms = (result.alarms || []).filter((a) => a && a.title && a.fireAt && !isNaN(new Date(a.fireAt).getTime()));
  console.log('alarms(有效):', alarms.length);
  console.log('suggestions keys:', Object.keys(result.suggestions || {}));

  // 模拟 index.js 的清洗逻辑做最终校验
  const maxDay = 64;
  const validCats = ['sight', 'food', 'hotel', 'transport', 'ticket', 'other'];
  const cleaned = items.map((it, idx) => {
    let di = parseInt(it.dayIndex, 10);
    if (!(di >= 0 && di < maxDay)) di = idx;
    return di;
  });
  const cleanedDist = {};
  cleaned.forEach((d) => { cleanedDist[d] = (cleanedDist[d] || 0) + 1; });
  console.log('清洗后按天分布:', JSON.stringify(cleanedDist));

  const pass =
    items.length >= 20 &&
    Object.keys(byDay).length >= sp.days.length - 1 &&
    result.startDate === '2026-09-30' &&
    result.endDate === '2026-10-07' &&
    alarms.length >= 5;

  console.log('\n===== 验证' + (pass ? '通过 ✅' : '不通过 ❌') + ' =====');
  fs.writeFileSync(path.join(__dirname, 'cloudfn-result.json'), JSON.stringify(result, null, 2), 'utf-8');
})().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
