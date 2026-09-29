const assert = require('assert');
const rules = require('./parse-alarm-test-harness')();
const raw = [
  { title: '提前准备：抢 G1001 车票', type: 'train', fireAt: '2026-10-01 10:55' },
  { title: '抢票：甲站→乙站 G1001 高铁票', type: 'train', fireAt: '2026-10-01 11:00' },
  { title: '抢票：甲站→乙站 G1001 高铁票', type: 'train', fireAt: '2026-10-02 11:00' },
];
const cleaned = rules.cleanAlarms(raw, 'test-user', Date.now());
assert.equal(cleaned.length, 2, '同一车次准备/到点合并，但不同日期不能误合并');
assert(cleaned.every((row) => row.fireAtStr.endsWith('11:00')));
const custom = rules.prepareAlarmRecords(cleaned, 'test-user', 'trip-1', Date.now(), 12);
assert(custom.every((row) => row.leadMinutes === 12 && row.remindAt === row.fireAt - 12 * 60000));
const defaults = rules.prepareAlarmRecords(cleaned, 'test-user', 'trip-1', Date.now());
assert(defaults.every((row) => row.leadMinutes === 5 && row.remindAt === row.fireAt - 5 * 60000));
console.log('✓ 生产解析去重、日期隔离、默认/自设提前量均通过');
const uncertain = [{ title: '预订甲酒店', type: 'hotel', fireAt: '2026-09-15 09:00' }];
assert.equal(rules.cleanAlarms(uncertain, 'test-user', Date.now(), '9月15日起\n尽早预订甲酒店可取消房型。').length, 0);
assert.equal(rules.cleanAlarms(uncertain, 'test-user', Date.now(), '9月15日 09:00\n预订甲酒店。').length, 1);
assert.equal(rules.cleanAlarms(uncertain, 'test-user', Date.now(), '9月15日前后\n订甲酒店\n9月15日 11:00\n抢G1001高铁票').length, 0);
console.log('✓ 原文模糊日期不被模型编成固定提醒，其他类型精确日期不替模糊酒店背书');
assert.equal(rules.cleanAlarms([{ title: '预订甲城直通车', type: 'bus', fireAt: '2026-09-22 09:00' }],
  'test-user', Date.now(), '9月22～26日\n预订甲城直通车。\n9月22日 17:30\n抢G1001高铁票。').length, 0);
console.log('✓ 大巴模糊日期范围不被同日铁路精确时刻背书');
