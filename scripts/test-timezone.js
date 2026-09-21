// scripts/test-timezone.js
// 验证云函数的北京时间解析/格式化（服务器 UTC 时区下 15:15 不得变成 23:15）
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('../cloudfunctions/parseTravelPlan/cn-time');

let failed = 0;
function check(name, pass, extra) {
  console.log(`${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!pass) failed++;
}

// 期望：北京时间 2026-09-21 15:15:00 的绝对时间戳
const expect = Date.UTC(2026, 8, 21, 15, 15, 0) - 8 * 3600 * 1000;

const ts1 = parseCnTime('2026-09-21T15:15:00');   // LLM 输出格式（T 分隔）
const ts2 = parseCnTime('2026-09-21 15:15');      // 空格分隔、无秒
check('parseCnTime("2026-09-21T15:15:00") = 北京时间 15:15', ts1 === expect,
  `实际 ${new Date(ts1).toISOString()}（应为 ${new Date(expect).toISOString()}）`);
check('parseCnTime("2026-09-21 15:15") 一致', ts2 === expect);
check('错误绝对值：不得等于 UTC 解析结果', ts1 !== Date.UTC(2026, 8, 21, 15, 15, 0));

check('tsToDateStr 回读 = 2026-09-21', tsToDateStr(ts1) === '2026-09-21', `实际 ${tsToDateStr(ts1)}`);
check('tsToCnDateTimeStr = "2026-09-21 15:15"', tsToCnDateTimeStr(ts1) === '2026-09-21 15:15');

// 北京凌晨 00:30 不得掉到前一天
const ts3 = parseCnTime('2026-09-22T00:30:00');
check('凌晨 00:30 日期不偏移', tsToDateStr(ts3) === '2026-09-22', `实际 ${tsToDateStr(ts3)}`);

// 脏值返回 NaN
check('脏值 "null" → NaN', Number.isNaN(parseCnTime('null')));
check('脏值 "" → NaN', Number.isNaN(parseCnTime('')));
check('脏值 "9月21日" → NaN', Number.isNaN(parseCnTime('9月21日 15:15')));

console.log(failed ? `\n${failed} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
