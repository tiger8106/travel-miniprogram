// scripts/test-parse-local.js
// 本地跑一遍真实攻略的解析（不部署云函数）：
//   node scripts/test-parse-local.js [docx原文文件路径]
//
// 默认读 scripts/docx-raw.txt（由 dump-docx.py 从 .docx 抽取，与线上 mammoth 抽取等价）
// 输出：每天条目数、时间线、零时长/缺结束时间的异常条目统计

const path = require('path');
const fs = require('fs');

// ---------- 加载 .env.local ----------
const envPath = path.resolve(__dirname, '..', '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('❌ 缺少 .env.local（需 LLM_PROVIDER / LLM_API_KEY）');
  process.exit(1);
}
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  const l = line.trim();
  if (!l || l.startsWith('#')) return;
  const m = l.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (!m) return;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
});

const rawFile = process.argv[2] || path.resolve(__dirname, 'docx-raw.txt');
const rawText = fs.readFileSync(rawFile, 'utf-8');

const { callLLM } = require('../cloudfunctions/parseTravelPlan/llm.js');
const { sanitizeItems } = require('../cloudfunctions/parseTravelPlan/normalize.js');
const { splitDocument } = require('../cloudfunctions/parseTravelPlan/splitter.js');

(async () => {
  console.log('============================================');
  console.log('原文:', path.basename(rawFile), '| 字符数:', rawText.length);
  const { days } = splitDocument(rawText);
  console.log('识别到天数:', days.length, '→', days.map((d) => `${d.month}/${d.day}`).join(', '));
  console.log('============================================\n');

  const t0 = Date.now();
  const parsed = await callLLM(rawText);
  const ms = Date.now() - t0;
  if (!parsed) {
    console.error('❌ 解析失败');
    process.exit(1);
  }

  const items = sanitizeItems(parsed.items);
  console.log(`解析耗时 ${(ms / 1000).toFixed(1)}s | 条目数 ${items.length} | 闹钟 ${(parsed.alarms || []).length}`);
  console.log('日期:', parsed.startDate, '~', parsed.endDate, '| 标题:', parsed.title);

  // 按天打印时间线
  const byDay = new Map();
  items.forEach((it) => {
    if (!byDay.has(it.dayIndex)) byDay.set(it.dayIndex, []);
    byDay.get(it.dayIndex).push(it);
  });
  let zero = 0;
  const srcLineCount = days.map((d) => d.lines.filter((l) => l && !/^注[:：]/.test(l.trim())).length);

  [...byDay.keys()].sort((a, b) => a - b).forEach((di) => {
    const list = byDay.get(di);
    const d = days[di];
    const src = srcLineCount[di] || 0;
    console.log(`\n【第${di + 1}天 ${d ? d.month + '月' + d.day + '日' : ''}】原文 ${src} 行 → ${list.length} 条`);
    list.forEach((it) => {
      const bad = it.startTime && it.endTime === it.startTime;
      if (bad) zero++;
      console.log(`  ${it.startTime}-${it.endTime} ${it.activity}${bad ? '  ⚠零时长' : ''}` +
        (it.startLocation || it.endLocation ? `  [${it.startLocation || '?'} → ${it.endLocation || '?'}]` : ''));
    });
  });

  console.log('\n============================================');
  console.log(zero === 0 ? '✅ 无零时长异常条目' : `❌ 仍有 ${zero} 条零时长条目`);
  const missingEnd = items.filter((it) => !it.endTime).length;
  console.log(missingEnd === 0 ? '✅ 所有条目都有结束时间' : `❌ ${missingEnd} 条缺结束时间`);
  console.log('============================================');
})().catch((e) => {
  console.error('❌ 运行失败:', e.message);
  process.exit(1);
});
