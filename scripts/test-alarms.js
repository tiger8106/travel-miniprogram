#!/usr/bin/env node
/**
 * 端到端验证：国庆广西攻略的「预订安排」闹钟提取
 * 验证点：中文标题、时间严格取原文（9月21日15:15 等）、无 00:00 编造、模糊日期跳过、去重
 * 用法：node scripts/test-alarms.js
 */
const path = require('path');
const fs = require('fs');

// 读 .env.local
const envPath = path.resolve(__dirname, '..', '.env.local');
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
});

const { callLLM } = require('../cloudfunctions/parseTravelPlan/llm');
const { parseCnTime, tsToCnDateTimeStr } = require('../cloudfunctions/parseTravelPlan/cn-time');
const rules = require('./parse-alarm-test-harness')();

// 用真实文档文本（清理提取时混入的 XML 残片）
const docPath = path.resolve(__dirname, '..', '.docx-text.txt');
let rawText = fs.readFileSync(docPath, 'utf-8')
  .split('\n')
  .map((l) => l.replace(/<[^>]*>/g, '').trim())
  .filter(Boolean)
  .join('\n');
console.log(`文档文本 ${rawText.length} 字符`);

(async () => {
  console.log('调用 LLM（完整文档，含并行逐天 + 闹钟提取）...');
  const t0 = Date.now();
  const r = await callLLM(rawText);
  console.log(`LLM 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，items ${r.items.length} 条\n`);

  // 复刻 index.js 清洗：fireAt → 时间戳 + fireAtStr
  const alarms = rules.prepareAlarmRecords(rules.cleanAlarms(r.alarms, 'test-user', Date.now(), rawText),
    'test-user', 'test-trip', Date.now(), 12);

  console.log('=== 清洗后闹钟列表 ===');
  alarms.forEach((a) => console.log(`${a.fireAtStr}  [${a.type}]  ${a.title}${a.note ? '  (' + a.note.slice(0, 26) + ')' : ''}`));

  let failed = 0;
  const check = (name, cond, extra) => {
    console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond ? '' : '  ' + (extra || '')}`);
    if (!cond) failed++;
  };
  const byStr = (s) => alarms.filter((a) => a.fireAtStr === s);

  check('闹钟非空', alarms.length > 0, '一个都没提取到');
  check('标题全部含中文（无英文翻译标题）', alarms.every((a) => /[\u4e00-\u9fa5]/.test(a.title)),
    alarms.filter((a) => !/[\u4e00-\u9fa5]/.test(a.title)).map((a) => a.title).join(' | '));
  check('无 00:00 编造时间', alarms.every((a) => !a.fireAtStr.endsWith('00:00')),
    alarms.filter((a) => a.fireAtStr.endsWith('00:00')).map((a) => a.fireAtStr + a.title).join(' | '));

  // 关键精确时间（来自文档 3.1/3.5 表格）
  check('9月21日 15:15 南宁东→崇左南开抢', byStr('2026-09-21 15:15').some((a) => a.title.indexOf('南宁东') >= 0 && a.title.indexOf('崇左南') >= 0));
  check('9月21日 17:30 阳朔→南宁东开抢', byStr('2026-09-21 17:30').some((a) => a.title.indexOf('阳朔') >= 0));
  check('9月22日 17:30 崇左南→南宁开抢', byStr('2026-09-22 17:30').length > 0);
  check('9月23日 15:15 南宁东→重庆西开抢', byStr('2026-09-23 15:15').length > 0);
  check('9月16日 11:00 G2249 开抢', byStr('2026-09-16 11:00').length > 0);
  check('10月3日 20:00 遇龙河竹筏开抢', byStr('2026-10-03 20:00').length > 0);

  // 模糊日期不应生成（酒店 9月15日起）
  check('无 9月15日 的模糊酒店闹钟', alarms.every((a) => !a.fireAtStr.startsWith('2026-09-15')),
    alarms.filter((a) => a.fireAtStr.startsWith('2026-09-15')).map((a) => a.fireAtStr + a.title).join(' | '));
  check('直通车日期范围不被编成固定抢票时间', !alarms.some((a) => a.type === 'bus'
    && a.fireAtStr.startsWith('2026-09-22')));

  // 去重
  const keys = alarms.map((a) => a.fireAt + '|' + a.title.replace(/\s+/g, ''));
  check('无重复（同时刻同标题）', new Set(keys).size === keys.length);
  check('所有提醒严格使用用户设置的提前12分钟', alarms.every((a) =>
    a.leadMinutes === 12 && a.remindAt === a.fireAt - 12 * 60000));
  check('同一车次没有提前准备/到点两个独立提醒', alarms.filter((a) => /G2249/.test(a.title)).length === 1);

  console.log(failed ? `\n${failed} 项校验失败` : '\n闹钟提取校验全部通过 ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
