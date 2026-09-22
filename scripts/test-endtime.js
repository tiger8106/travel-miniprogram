// scripts/test-endtime.js
// 结束时间修复（normalize Pass 5）单测
// 覆盖：时长线索 / 分类常识 / 零时长 / 跨零点保护 / 下一条收敛 / 缺失 startTime 回填
//
// 运行：node scripts/test-endtime.js

const { sanitizeItems, parseDurationMin } = require('../cloudfunctions/parseTravelPlan/normalize.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---------- 1. 时长线索识别 ----------
ok(parseDurationMin('正常用时2.5小时到达金坑大寨停车场') === 150, '「2.5小时」→ 150 分钟', String(parseDurationMin('正常用时2.5小时')));
ok(parseDurationMin('步行2.7公里，约1.5小时') === 90, '「1.5小时」→ 90 分钟');
ok(parseDurationMin('步行1.6 km，约 40 min') === 40, '「40 min」→ 40 分钟');
ok(parseDurationMin('打车前往酒店，约27分钟') === 27, '「约27分钟」→ 27 分钟');
ok(parseDurationMin('1小时30分') === 90, '「1小时30分」→ 90 分钟');
ok(parseDurationMin('差不多半小时') === 30, '「半小时」→ 30 分钟');
ok(parseDurationMin('20元人民币背景观景区域') === 0, '「20元」不被误判成 20 分钟', String(parseDurationMin('20元人民币背景观景区域')));
ok(parseDurationMin('') === 0, '空文本 → 0');

// ---------- 2. 真实场景：攻略原文常见条目 ----------
const raw = [
  // 直通车：原文写了"正常用时2.5小时"
  { dayIndex: 0, startTime: '08:00', endTime: '08:00', activity: '乘坐桂林站→金坑大寨的直通车，正常用时2.5小时', category: 'transport' },
  // 步行：原文写了"约 40 min"
  { dayIndex: 0, startTime: '14:30', endTime: '14:30', activity: '前往龙脊索道（出站口），步行1.6 km，约 40 min', category: 'transport' },
  // 没时长线索的吃饭 → 分类默认 60 分钟
  { dayIndex: 0, startTime: '11:30', endTime: '11:30', activity: '在民宿吃午饭', category: 'food' },
  // 没时长线索的游览 → 分类默认 90 分钟，但被下一条 13:00 收敛
  { dayIndex: 0, startTime: '12:00', endTime: '', activity: '周边随便逛逛', category: 'sight' },
  { dayIndex: 0, startTime: '13:00', endTime: '14:30', activity: '走千层天梯一带', category: 'sight' },
  // 跨零点（合法）：endTime < startTime，必须原样保留
  { dayIndex: 1, startTime: '23:30', endTime: '00:30', activity: '夜班火车硬卧', category: 'transport' },
  // 区间正常：不动
  { dayIndex: 1, startTime: '06:30', endTime: '07:30', activity: '看日出', category: 'sight' },
  // 结束时间超过下一条开始 → 收敛
  { dayIndex: 1, startTime: '08:00', endTime: '12:00', activity: '吃早餐', category: 'food' },
  { dayIndex: 1, startTime: '09:00', endTime: '09:40', activity: '民宿周边逛', category: 'sight' },
];

const out = sanitizeItems(raw);
const at = (i) => out[i];

ok(at(0).endTime === '10:30', '直通车 08:00 + 2.5小时 → 10:30', at(0).endTime);
ok(at(1).endTime === '15:10', '步行 14:30 + 40min → 15:10', at(1).endTime);
ok(at(2).endTime === '12:00', '吃饭默认 60 分钟，但被下一条 12:00 收敛（行程不重叠）', at(2).endTime);
ok(at(3).endTime === '13:00', '游览默认 90 分钟，但被下一条 13:00 收敛', at(3).endTime);
ok(at(4).endTime === '14:30', '区间正常的条目不被改动', at(4).endTime);
ok(at(5).startTime === '23:30' && at(5).endTime === '00:30', '跨零点条目原样保留（不被当零时长改掉）', at(5).startTime + '→' + at(5).endTime);
ok(at(6).endTime === '07:30', '普通区间不受影响', at(6).endTime);
ok(at(7).endTime === '09:00', '结束时间超过下一条开始 → 收敛到 09:00', at(7).endTime);

// ---------- 3. 零时长必须绝迹 ----------
const zeroRaw = [
  { dayIndex: 0, startTime: '18:00', endTime: '18:00', activity: '逛东西巷', category: 'sight' },
  { dayIndex: 0, startTime: '18:40', endTime: '18:40', activity: '吃特色小吃', category: 'food' },
  { dayIndex: 0, startTime: '19:30', endTime: '19:30', activity: '逛正阳步行街', category: 'sight' },
];
const zeroOut = sanitizeItems(zeroRaw);
ok(zeroOut.every((it) => it.endTime && it.endTime !== it.startTime),
  '零时长条目全部被修复（endTime 不再等于 startTime）',
  JSON.stringify(zeroOut.map((x) => x.startTime + '→' + x.endTime)));

// ---------- 4. 天首条没时间 → 回填后也要有 endTime ----------
const noTime = [
  { dayIndex: 0, startTime: '', endTime: '', activity: '先去酒店放行李', category: 'hotel' },
  { dayIndex: 0, startTime: '14:30', endTime: '15:00', activity: '稍作休息', category: 'hotel' },
];
const ntOut = sanitizeItems(noTime);
ok(ntOut[0].startTime === '14:00', '无时间条目按后一条往前推 30 分钟 → 14:00', ntOut[0].startTime);
ok(ntOut[0].endTime && ntOut[0].endTime !== ntOut[0].startTime, '回填的条目也有合法 endTime', ntOut[0].endTime);

// ---------- 5. 汇总 ----------
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
