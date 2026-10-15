// 实际云函数入口 + 内存数据库，不调用微信发送，也不改线上行程。
const assert = require('assert');
const Module = require('module');
const fireAt = Date.now() + 5 * 60000;
const items = [
  { itemId: 'pier', dayIndex: 0, category: 'transport', activity: '前往甲河竹筏码头', endLocation: '甲码头' },
  { itemId: 'raft', dayIndex: 0, category: 'sight', activity: '体验甲河竹筏漂流', startLocation: '甲码头', endLocation: '乙码头' },
  { itemId: 'cycle', dayIndex: 0, category: 'sight', activity: '骑电动车游乙田园', endLocation: '乙田园' },
];
const alarm = (id, linkedItemId, title, extra = {}) => ({ _id: id, _openid: 'u', tripId: 'trip',
  type: 'ticket', source: 'ai', dayIndex: 0, linkedItemId, fireAt, leadMinutes: 5, title, ...extra });
const rows = [alarm('pier-alarm', 'pier', '甲河竹筏票', { ticketProduct: '甲河竹筏票', ticketRequired: true }),
  alarm('raft-alarm', 'raft', '甲河竹筏票', { ticketProduct: '甲河竹筏票', ticketRequired: true }),
  alarm('cycle-alarm', 'cycle', '乙田园门票核验', { note: '未独立核实，不代表已确认收费', reservationRequired: true }),
  alarm('manual-alarm', 'cycle', '自定义事项', { source: 'manual' }),
  alarm('completed-alarm', 'raft', '已完成竹筏', { completed: true }),
  alarm('other-user', 'pier', '其它账号手动事项', { _openid: 'other', source: 'manual' })];
const trip = { _id: 'trip', _openid: 'u', startDate: '2027-10-01', items };
let tripReads = 0;
const sent = [], updates = [];
const copy = (x) => JSON.parse(JSON.stringify(x));
const db = {
  command: { and: (...x) => x, gte: (x) => x, lte: (x) => x, neq: (x) => ({ neq: x }) },
  collection(name) { return {
    doc(id) { return {
      async get() { tripReads++; return { data: copy(trip) }; },
      async update({ data }) { updates.push([id, data]); return { stats: { updated: 1 } }; },
    }; },
    where(query) { return {
      orderBy() { return this; }, limit() { return this; },
      async get() { return { data: copy(rows.filter((a) => !query._openid || a._openid === query._openid)) }; },
    }; },
  }; },
};
const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db,
  getWXContext: () => ({ OPENID: 'u' }), openapi: { subscribeMessage: { send: async (x) => { sent.push(x); } } } };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) { return request === 'wx-server-sdk' ? cloud : originalLoad.call(this, request, parent, isMain); };
const tickets = require('../cloudfunctions/ticketAlarm/index');
const notifications = require('../cloudfunctions/sendAlarm/index');
Module._load = originalLoad;
(async () => {
  const snapshot = JSON.stringify(rows);
  const list = await tickets.main({ action: 'list', tripId: 'trip' });
  assert.equal(list.code, 0);
  assert.deepEqual(list.data.map((a) => a._id), ['raft-alarm', 'manual-alarm', 'completed-alarm']);
  assert.equal(JSON.stringify(rows), snapshot); assert.equal(updates.length, 0, '读取不能删除原记录或覆盖完成状态');
  trip._openid = 'other';
  const isolated = await tickets.main({ action: 'list', tripId: 'trip' });
  assert.equal(isolated.code, 0);
  assert.deepEqual(isolated.data.map((a) => a._id), rows.filter((a) => a._openid === 'u').map((a) => a._id),
    '归属不符的行程不能作为过滤或展示本账号提醒的依据');
  trip._openid = 'u';
  tripReads = 0;
  const pushed = await notifications.main({});
  assert.equal(pushed.code, 0); assert.equal(pushed.data.sent, 3);
  assert.equal(tripReads, 1, '同一行程只查询一次，按批次并行');
  assert.deepEqual(updates.map(([id]) => id), ['raft-alarm', 'manual-alarm', 'other-user']);
  assert(sent.some((x) => x.touser === 'other'), '不使用其它账号的行程内容过滤提醒');
  console.log('✓ 云端列表与实际通知入口过滤一致，保留手动/已完成/账号隔离，不删除原记录');
})().catch((error) => { console.error(error); process.exitCode = 1; });
