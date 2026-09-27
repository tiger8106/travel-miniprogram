// 验证提醒事项的时间、分类、完成状态和生成查漏规则。
// 用法：node scripts/test-alarm-state.js

const model = require('../cloudfunctions/ticketAlarm/alarm-model');
const infer = require('../cloudfunctions/parseTravelPlan/alarm-infer');
const plan = require('../cloudfunctions/generatePlan/plan');
const { tsToDateStr, parseCnTime } = require('../cloudfunctions/parseTravelPlan/cn-time');

let pass = 0;
let fail = 0;
function ok(condition, message, extra) {
  if (condition) {
    pass += 1;
    console.log('✅ ' + message);
  } else {
    fail += 1;
    console.log('❌ ' + message + (extra ? ' → ' + extra : ''));
  }
}

const today = tsToDateStr(Date.now());
const startDate = plan.shiftDate(today, 30);
const endDate = plan.shiftDate(startDate, 2);
const items = [
  {
    dayIndex: 0,
    activity: '乘坐高铁前往成都',
    transportType: 'train',
    startLocation: '重庆西',
    endLocation: '成都东',
    note: '起售时间 08:30',
  },
  {
    dayIndex: 1,
    activity: '预约都江堰景区门票',
    category: 'ticket',
  },
  {
    dayIndex: 1,
    activity: '入住成都酒店',
    category: 'hotel',
  },
  {
    dayIndex: 0,
    activity: '整理身份证、药品和充电宝',
    category: 'other',
  },
];

console.log('============================================');
console.log('提醒数据模型');
console.log('============================================');
const fireAt = parseCnTime(`${startDate}T10:00:00`);
const reminder = model.normalizeAlarm({
  _id: 'a1',
  title: '抢车票',
  type: 'train',
  fireAt,
  leadMinutes: 10,
  remindAt: fireAt - 60 * 1000,
});
ok(reminder.remindAt === fireAt - 10 * 60 * 1000, '提醒时间始终由办理时间和提前量计算', String(reminder.remindAt));
ok(model.calcRemindAt(fireAt, 10) === reminder.remindAt, 'calcRemindAt 与标准化结果一致');
ok(model.clampLead(999, 5) === 60 && model.clampLead(0, 5) === 1, '提前量限制在 1~60 分钟');
const done = model.normalizeAlarm({ title: '已买门票', type: 'ticket', fireAt, completed: true });
ok(done.completed && done.status === 'completed', '已完成事项保留为 completed 状态');
ok(model.makeAlarmKey({ title: ' 抢 车票 ', type: 'train', fireAtStr: `${startDate} 10:00` })
  === `train|${startDate}|抢车票`, '同一事项 key 会清理标题空格');

console.log('============================================');
console.log('行程查漏与分类');
console.log('============================================');
const inferred = infer.backfillRuleAlarms({ startDate, endDate, items }, []);
const types = new Set(inferred.map((a) => a.type));
ok(types.has('train'), '详细行程能补齐车票事项');
ok(types.has('ticket'), '详细行程能补齐景区门票事项');
ok(types.has('hotel'), '详细行程能补齐酒店事项');
ok(types.has('other'), '详细行程能补齐证件/药品/装备事项');
ok(inferred.every((a) => a.fireAt > Date.now() && a.remindAt === a.fireAt - 5 * 60 * 1000),
  '规则提醒均为未来时间且提前 5 分钟');
const trainAlarm = inferred.find((a) => a.type === 'train');
ok(trainAlarm && /08:30$/.test(trainAlarm.fireAtStr), '攻略明确起售时间时沿用来源时刻', trainAlarm && trainAlarm.fireAtStr);

const detailed = plan.backfillDetailAlarms(
  { startDate, endDate },
  { days: [{ date: startDate }, { date: plan.shiftDate(startDate, 1) }] },
  [
    { dayIndex: 1, activity: '预约毕棚沟门票', category: 'ticket', note: '每日 08:15 开票' },
    { dayIndex: 0, activity: '准备护照和药品', category: 'other' },
  ],
  [],
);
ok(detailed.some((a) => a.type === 'ticket'), '制定新攻略会扫描最终详细行程中的门票');
ok(detailed.some((a) => a.type === 'other'), '制定新攻略会扫描最终详细行程中的行前准备');
const detailTicket = detailed.find((a) => a.type === 'ticket');
ok(detailTicket && /08:15$/.test(detailTicket.fireAtStr), '详细行程明确放票时间时沿用来源时刻', detailTicket && detailTicket.fireAtStr);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
