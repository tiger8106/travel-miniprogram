// 验证 mock 模式的提醒 CRUD 与真实云端语义一致。
// 用法：node scripts/test-alarm-mock.js

const { TRIP_ID, STORE } = require('../miniprogram/services/mock-data');
const api = require('../miniprogram/services/api-mock');

(async () => {
  let pass = 0;
  let fail = 0;
  const ok = (condition, message) => {
    if (condition) {
      pass += 1;
      console.log('✅ ' + message);
    } else {
      fail += 1;
      console.log('❌ ' + message);
    }
  };

  const before = STORE.alarms.length;
  const fireAt = Date.now() + 2 * 86400000;
  await api.saveAlarms(TRIP_ID, [{
    _id: 'mock-alarm-state-test',
    title: '测试提醒',
    type: 'ticket',
    fireAt,
    fireAtStr: '2030-01-01 09:00',
    leadMinutes: 5,
  }]);
  ok(STORE.alarms.length === before + 1, '手动新增只追加，不覆盖已有事项');

  await api.updateAlarm('mock-alarm-state-test', { completed: true });
  let list = await api.listAlarms(TRIP_ID);
  let item = list.find((a) => a._id === 'mock-alarm-state-test');
  ok(item && item.completed === true && item.completedAt > 0, '完成状态保存并保留在分类数据中');

  await api.setAlarmAdvance(TRIP_ID, 15);
  list = await api.listAlarms(TRIP_ID);
  item = list.find((a) => a._id === 'mock-alarm-state-test');
  ok(item && item.leadMinutes === 15 && item.remindAt === item.fireAt - 15 * 60 * 1000,
    '统一修改提前量后提醒时间重新计算');

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
