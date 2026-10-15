// 完整取消/续付/后台核对链路的离线回归；HTTP 和数据库使用有条件更新的测试桩。
const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const orderNos = ['VPMUIN9HTGLY7A2R', 'VPMUIE0HD6K2GS93', 'VPMUIDZC2LCMFYMK', 'VPMUIDYLRHDCPB8B'];
const records = { orders: [], users: [{ _id: 'user', _openid: 'owner', role: 'admin', sessionKey: 'cached-session' }] };
let actor = 'owner';
let queryResponse;
let beforeChange;
let queries = 0;
let tokenRequests = 0;
let id = 0;
let grants = 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const matches = (row, filter) => Object.entries(filter || {}).every(([key, value]) => {
  if (value && value.op === 'exists') return (row[key] !== undefined) === value.value;
  if (value && value.op === 'in') return value.value.includes(row[key]);
  if (value && value.op === 'gte') return row[key] >= value.value;
  return row[key] === value;
});
const db = {
  command: { exists: (value) => ({ op: 'exists', value }), in: (value) => ({ op: 'in', value }),
    gte: (value) => ({ op: 'gte', value }) },
  collection(name) {
    let filter = {}; let count = 100; let skip = 0; let sort;
    const api = {
      where(value) { filter = value; return api; },
      limit(value) { count = value; return api; },
      skip(value) { skip = value; return api; },
      orderBy(field, direction) { sort = { field, direction }; return api; },
      async get() {
        let rows = (records[name] || []).filter((row) => matches(row, filter));
        if (sort) rows.sort((a, b) => (Number(a[sort.field] || 0) - Number(b[sort.field] || 0)) * (sort.direction === 'asc' ? 1 : -1));
        return { data: rows.slice(skip, skip + count).map(clone) };
      },
      async update({ data }) {
        if (beforeChange) { const callback = beforeChange; beforeChange = null; callback(); }
        const rows = (records[name] || []).filter((row) => matches(row, filter));
        rows.forEach((row) => Object.assign(row, data));
        return { stats: { updated: rows.length } };
      },
      async add({ data }) {
        const row = Object.assign({ _id: 'insert-' + (++id) }, clone(data));
        records[name].push(row); return { _id: row._id };
      },
      doc(docId) { return { async update({ data }) {
        const row = (records[name] || []).find((o) => o._id === docId);
        assert(row); Object.assign(row, data); return { stats: { updated: 1 } };
      } }; },
    };
    return api;
  },
};
const httpsMock = {
  get(url, callback) {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    process.nextTick(() => {
      const response = new EventEmitter(); callback(response);
      const code = new URL(url).searchParams.get('js_code');
      let result;
      if (code) result = code === 'bad' ? { errcode: 40029, errmsg: 'invalid code' }
        : { session_key: 'fresh-session', openid: code === 'foreign' ? 'other' : 'owner' };
      else { tokenRequests++; result = { access_token: 'test-token-' + tokenRequests, expires_in: 7200 }; }
      response.emit('data', JSON.stringify(result)); response.emit('end');
    });
    return request;
  },
  request(options, callback) {
    const request = new EventEmitter(); let body = '';
    request.setTimeout = () => {};
    request.write = (chunk) => { body += chunk; };
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter(); callback(response);
      const query = JSON.parse(body);
      let result = { errcode: 0 };
      if (options.path.startsWith('/xpay/query_order')) {
        queries++;
        result = typeof queryResponse === 'function' ? queryResponse(query) : queryResponse;
      }
      response.emit('data', JSON.stringify(result)); response.emit('end');
    });
    return request;
  },
};
const saved = {};
for (const key of ['MP_APPID', 'MP_APPSECRET', 'XPAY_APP_KEY', 'XPAY_APP_KEY_SANDBOX', 'XPAY_OFFER_ID', 'XPAY_ENV', 'INTERNAL_TOKEN']) saved[key] = process.env[key];
Object.assign(process.env, { MP_APPID: 'test-app', MP_APPSECRET: 'test-secret',
  XPAY_APP_KEY: 'production-key', XPAY_APP_KEY_SANDBOX: 'sandbox-key',
  XPAY_OFFER_ID: 'test-offer', XPAY_ENV: '0', INTERNAL_TOKEN: 'test-internal' });
const load = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'https') return httpsMock;
  if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db,
    getWXContext: () => ({ OPENID: actor }), callFunction: async () => { grants++; return { result: { code: 0 } }; } };
  return load.call(this, name, parent, isMain);
};
const service = require('../cloudfunctions/virtualPay/index');
Module._load = load;
function reset(patch) {
  const row = Object.assign({ _id: 'base', _openid: 'owner', outTradeNo: orderNos[0], goodsId: 'plan_1',
    price: 300, env: 0, platform: 'android', status: 'created', createdAt: Date.now() }, patch);
  records.orders = [row]; actor = 'owner'; beforeChange = null; grants = 0;
  queryResponse = (q) => ({ errcode: 0, order: { order_id: q.order_id, order_fee: row.price, status: 1, env_type: q.env + 1 } });
  return row;
}
const call = (action, row, extra) => service.main(Object.assign({ action, outTradeNo: row.outTradeNo }, extra), {});

async function run() {
  for (const status of [0, 1, 6]) {
    const row = reset();
    queryResponse = { errcode: '0', order: { order_id: row.outTradeNo, order_fee: 300, status, env_type: 1 } };
    assert.strictEqual((await call('cancelOrder', row)).code, 0);
    assert.strictEqual(row.status, 'cancelled');
  }
  assert.strictEqual(tokenRequests, 1, '缓存凭证不能每单重复获取');
  for (const state of ['created', 'verifying', 'paid']) {
    let row = reset({ status: state });
    assert.strictEqual((await call('cancelOrder', row)).code, 0, state + ' 明确未支付应该能取消');
    row = reset({ status: state });
    const r = await call('repay', row, { code: 'good', platform: 'android' });
    assert.strictEqual(r.code, 0, state + ' 明确未支付应该能续付');
    assert.strictEqual(row.status, 'cancelled');
    assert.notStrictEqual(r.data.outTradeNo, row.outTradeNo, 'SDK 单号只能使用一次，续付必须换号');
    assert.strictEqual(r.data.replacedOrderNo, row.outTradeNo);
  }
  for (const [index, no] of orderNos.entries()) {
    const row = reset({ outTradeNo: no });
    queryResponse = index % 2 ? { errcode: 268490002, errmsg: '数据不存在 rid: test-request-id' } : { errcode: 0 };
    assert.strictEqual((await call('cancelOrder', row)).code, 0);
  }
  for (const bad of [
    { errcode: 268490002, errmsg: 'missing env field' },
    { errcode: 268490003, errmsg: 'invalid signature' },
    { errcode: -1, errmsg: 'temporarily unavailable' },
    { errcode: 0, order: { order_id: orderNos[0], order_fee: 300, status: 1, paid_fee: -1 } },
    { errcode: 0, order: { order_id: orderNos[0], order_fee: 300, status: 1, paid_fee: 300 } },
    { errcode: 0, order: { order_id: orderNos[0], order_fee: 300, status: null } },
    { errcode: 0, order: { order_id: 'other-order', order_fee: 300, status: 1 } },
  ]) {
    const row = reset(); queryResponse = bad;
    assert.strictEqual((await call('cancelOrder', row)).code, -2);
    assert.strictEqual(row.status, 'created');
    assert.strictEqual((await call('repay', row, { code: 'good' })).code, -2);
  }
  for (const evidence of [{ paymentReturnedAt: Date.now() }, { platformOrderId: 'wx-order' }, { paidAt: Date.now() },
    { verifiedPaymentAt: Date.now() }, { paidFee: 300 }, { platformStatus: 2 }]) {
    const row = reset(evidence); queryResponse = { errcode: 0 };
    assert.strictEqual((await call('cancelOrder', row)).code, -2, '无单不能绕过已有付款证据');
  }
  const evidenceRow = reset({ paidFee: 300 });
  assert.strictEqual((await call('cancelOrder', evidenceRow)).code, -2);
  assert.strictEqual(evidenceRow.paidFee, 300, '未支付快照不能覆盖历史付款证据');
  assert.strictEqual((await call('cancelOrder', evidenceRow)).code, -2, '重复点击不能绕过付款证据');

  let row = reset();
  queryResponse = (q) => ({ errcode: 0, order: { order_id: q.order_id, order_fee: 300, paid_fee: 300, status: 2 } });
  assert.strictEqual((await call('cancelOrder', row)).code, -2);
  assert.strictEqual(row.status, 'delivered'); assert.strictEqual(grants, 1);

  row = reset();
  queryResponse = (q) => ({ errcode: 0, order: { order_id: q.order_id, order_fee: 300, paid_fee: 300, status: 2 } });
  assert.strictEqual((await call('repay', row, { code: 'good', platform: 'ios' })).code, -2);
  assert.strictEqual(row.status, 'delivered');
  assert.strictEqual(records.orders.length, 1, '已付款时不允许新建替代单');
  assert.strictEqual(grants, 1);

  row = reset();
  queryResponse = (q) => ({ errcode: 0, order: { order_id: q.order_id, order_fee: 300, status: 0 } });
  const failed = await call('repay', row, { code: 'bad', platform: 'android' });
  assert.strictEqual(failed.code, -3);
  assert.strictEqual(row.status, 'created', '登录失败不能先取消原订单');
  assert.strictEqual(records.orders.length, 1);
  const foreign = await call('repay', row, { code: 'foreign', platform: 'android' });
  assert.strictEqual(foreign.code, -3, '新登录账号必须与订单归属相同');

  row = reset({ price: 200 });
  for (let n = 0; n < 10; n++) records.orders.push({ ...clone(row), _id: 'pending-' + n, outTradeNo: 'PENDING' + n });
  queryResponse = (q) => ({ errcode: 0, order: { order_id: q.order_id, order_fee: 200, status: q.order_id === row.outTradeNo ? 6 : 1 } });
  const replaced = await call('repay', row, { code: 'good', platform: 'android' });
  assert.strictEqual(replaced.code, 0, '继续原有购买不应被新建订单数量限制挡住');
  assert.strictEqual(row.status, 'cancelled');
  assert.strictEqual(row.replacementOrderNo, replaced.data.outTradeNo);
  assert.strictEqual(JSON.parse(replaced.data.signData).goodsPrice, 200, '替代订单保留原订单价格');
  const again = await call('repay', row, { code: 'good', platform: 'android' });
  assert.strictEqual(again.code, 0);
  assert.notStrictEqual(again.data.outTradeNo, replaced.data.outTradeNo, '旧入口重试跟随替代链后再次换新号');
  assert.strictEqual(again.data.replacedOrderNo, row.outTradeNo, '旧入口重试仍须让客户端立即更新旧卡片');

  row = reset({ env: 1 });
  const sameEnv = await call('repay', row, { code: 'good', platform: 'android' });
  assert.strictEqual(sameEnv.code, 0);
  assert.strictEqual(sameEnv.data.env, 1, '全局配置切换后仍使用原单环境和对应密钥');

  for (const remote of ['unpaid', 'not-found']) {
    row = reset({ platform: 'ios', price: 200 });
    queryResponse = remote === 'unpaid'
      ? (q) => ({ errcode: 0, order: { order_id: q.order_id, order_fee: 200, status: 1, paid_fee: 0 } })
      : { errcode: 268490002, errmsg: '数据不存在 rid: ios-test' };
    const ios = await call('repay', row, { code: 'good', platform: 'ios' });
    assert.strictEqual(ios.code, 0);
    assert.notStrictEqual(ios.data.outTradeNo, row.outTradeNo, remote + ' 的 iOS 单不能复用旧号');
    assert.strictEqual(JSON.parse(ios.data.signData).goodsPrice, 200);
    assert.strictEqual(ios.data.env, 0);
    assert.strictEqual(row.status, 'cancelled');
  }
  row = reset({ env: 1, platform: 'ios' });
  const iosProduction = await call('repay', row, { code: 'good', platform: 'ios' });
  assert.strictEqual(iosProduction.data.env, 0, 'iOS 续付只能用现网新单');

  row = reset();
  beforeChange = () => { row.status = 'delivered'; row.verifiedPaymentAt = Date.now(); };
  assert.strictEqual((await call('repay', row, { code: 'good', platform: 'ios' })).code, -2);
  assert.strictEqual(row.status, 'delivered');
  assert.strictEqual(records.orders[1].status, 'cancelled', '并发支付成功时新准备单作废，不能再拉起付款');

  row = reset();
  beforeChange = () => { row.status = 'delivered'; row.verifiedPaymentAt = Date.now(); };
  assert.strictEqual((await call('cancelOrder', row)).code, -2);
  assert.strictEqual(row.status, 'delivered', '并发付款结果不可被旧取消请求覆盖');

  row = reset({ status: 'verifying', createdAt: 1 });
  for (let n = 0; n < 65; n++) records.orders.push({ ...clone(row), _id: 'history-' + n,
    status: 'cancelled', outTradeNo: 'HISTORY' + n, createdAt: 100 + n });
  const before = queries;
  const sync = await call('sync', row, { outTradeNos: [row.outTradeNo, 'NONOWNER'] });
  assert.strictEqual(sync.code, 0);
  assert.strictEqual(row.status, 'created', '超过最近50笔的旧待核实订单也能按页面目标核对');
  assert.strictEqual(sync.data.changed, 1);
  assert.strictEqual(sync.data.orders[0].status, 'created');
  assert.strictEqual(queries - before, 1, '只核对本人指定订单');

  row = reset();
  let first = true;
  const tokensBefore = tokenRequests;
  queryResponse = (q) => { if (first) { first = false; return { errcode: 42001, errmsg: 'access token expired' }; }
    return { errcode: 0, order: { order_id: q.order_id, order_fee: 300, status: 1 } }; };
  assert.strictEqual((await call('cancelOrder', row)).code, 0, '凭证过期自动刷新再查单');
  assert.strictEqual(tokenRequests - tokensBefore, 1);

  row = reset();
  const inspect = await call('adminInspectOrder', row);
  assert.strictEqual(inspect.code, 0);
  assert.strictEqual(inspect.data.canCancel, true);
  assert.strictEqual(row.lastQueriedAt, undefined, '管理员单笔核查不写订单');
  actor = 'other';
  assert.strictEqual((await call('cancelOrder', row)).code, -1);
  assert.strictEqual((await call('adminInspectOrder', row)).code, -1);
  console.log('取消/续付/后台恢复回归通过：状态、历史单、替代单、原价原环境、登录、凭证刷新和并发保护');
}
run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
