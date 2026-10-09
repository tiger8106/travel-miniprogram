const assert = require('assert');
const Module = require('module');

const tables = {
  parse_tasks: [{ _id: 'task-1', _openid: 'user-1', status: 'running', phase: 'day', leaseUntil: 0,
    title: '后台解析测试', startDate: '2030-10-01', endDate: '2030-10-01',
    days: [{ index: 0, date: '2030-10-01', title: '第一天', lines: [] }],
    dayItems: [null], dayStatus: [false], dayCount: 1, booking: [], rawHead: '',
    suggestions: {}, alarmsRaw: [], region: '', createdAt: Date.now() }],
  trips: [], ticket_alarms: [], suggestions: [],
};
const copy = (v) => JSON.parse(JSON.stringify(v));
const db = {
  command: { lt: (value) => ({ lt: value }) },
  collection(name) {
    const rows = tables[name] || (tables[name] = []);
    return {
      doc(id) {
        return {
          async get() { return { data: copy(rows.find((row) => row._id === id) || null) }; },
          async update({ data }) { Object.assign(rows.find((row) => row._id === id), copy(data)); },
        };
      },
      where(filter) {
        return {
          async update({ data }) {
            const row = rows.find((candidate) => candidate._id === filter._id
              && candidate._openid === filter._openid && candidate.status === filter.status
              && candidate.leaseUntil < filter.leaseUntil.lt);
            if (row) Object.assign(row, copy(data));
            return { stats: { updated: row ? 1 : 0 } };
          },
        };
      },
      async add({ data }) {
        const _id = `${name}-${rows.length + 1}`;
        rows.push(Object.assign({ _id }, copy(data)));
        return { _id };
      },
    };
  },
};
let contextOpenid = 'user-1';
const cloud = { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
  getWXContext: () => ({ OPENID: contextOpenid }),
  callFunction: async () => ({ result: { code: 0, data: { ok: true } } }),
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloud;
  if (request === 'mammoth') return {};
  if (parent && /parseTravelPlan\/index\.js$/.test(parent.filename)) {
    if (request === './cloudCfg') return { apply: async () => {} };
    if (request === './llm') return {
      asArray: (v) => v || [], extractDay: async () => [{ dayIndex: 0, activity: '游览象鼻山', category: 'sight' }],
      extractAlarms: async () => [], extractSuggestions: async () => ({}),
    };
    if (request === './alarm-infer') return { inferAlarms: async () => [], backfillRuleAlarms: () => [], INFER_THRESHOLD: 0 };
    if (request === './geocode') return { geocodeBatch: async () => ({}), geocodeOne: async () => null, pickCity: () => '' };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const parser = require('../cloudfunctions/parseTravelPlan/index');
Module._load = originalLoad;

(async () => {
  const status = await parser.main({ action: 'status', taskId: 'task-1' });
  assert.strictEqual(status.data.status, 'running');
  for (let i = 0; i < 6; i++) {
    const response = await parser.main({ action: 'resume', taskId: 'task-1' });
    assert.strictEqual(response.code, 0, response.msg);
    if (response.data.status === 'done') break;
  }
  assert.strictEqual(tables.parse_tasks[0].status, 'done');
  assert.strictEqual(tables.trips.length, 1);
  const again = await parser.main({ action: 'resume', taskId: 'task-1' });
  assert.strictEqual(again.data.status, 'done');
  assert.strictEqual(tables.trips.length, 1, '重试不能重复入库');
  contextOpenid = '';
  const worker = await parser.main({ action: 'resume', taskId: 'task-1', openid: 'user-1' });
  assert.strictEqual(worker.data.status, 'done', '定时云函数没有微信上下文也能按任务归属续跑');
  const denied = await parser.main({ action: 'status', taskId: 'task-1', openid: 'user-1' });
  assert.strictEqual(denied.code, -1, '普通状态查询不能只靠传入 openid 冒充用户');
  console.log('✅ 云端解析任务可逐步续跑，离开页面后继续，并且完成后不重复入库');
})().catch((error) => { console.error(error); process.exitCode = 1; });
