// 用真实报错单号走取消 action 的完整本地链路；微信查单响应由测试桩替代。
const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

const orderNos = [
  'VPMUIN9HTGLY7A2R', 'VPMUIE0HD6K2GS93',
  'VPMUIDZC2LCMFYMK', 'VPMUIDYLRHDCPB8B',
];
const row = {
  _id: 'local-order', _openid: 'owner', outTradeNo: orderNos[0],
  price: 300, env: 0, goodsId: 'plan_1', status: 'created', createdAt: Date.now(),
};
let queryResponse;
const db = {
  command: { gte: (value) => value },
  collection(name) {
    return {
      where() { return this; }, limit() { return this; },
      get: async () => ({ data: name === 'users'
        ? [{ _id: 'user', _openid: 'owner', sessionKey: 'local-session-key' }] : [row] }),
      add: async () => ({ _id: 'replacement-order' }),
      doc() { return { update: async ({ data }) => Object.assign(row, data) }; },
    };
  },
};
const httpsMock = {
  get(url, callback) {
    const response = new EventEmitter();
    process.nextTick(() => {
      callback(response);
      response.emit('data', JSON.stringify({ access_token: 'local-test-token', expires_in: 7200 }));
      response.emit('end');
    });
    return new EventEmitter();
  },
  request(options, callback) {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.write = () => {};
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      callback(response);
      response.emit('data', JSON.stringify(queryResponse));
      response.emit('end');
    });
    return request;
  },
};
const originalLoad = Module._load;
const originalEnv = {
  MP_APPID: process.env.MP_APPID,
  MP_APPSECRET: process.env.MP_APPSECRET,
  XPAY_APP_KEY: process.env.XPAY_APP_KEY,
  XPAY_OFFER_ID: process.env.XPAY_OFFER_ID,
  XPAY_ENV: process.env.XPAY_ENV,
  INTERNAL_TOKEN: process.env.INTERNAL_TOKEN,
};
process.env.MP_APPID = 'local-test-appid';
process.env.MP_APPSECRET = 'local-test-secret';
process.env.XPAY_APP_KEY = 'local-test-key';
process.env.XPAY_OFFER_ID = 'local-offer';
process.env.XPAY_ENV = '0';
process.env.INTERNAL_TOKEN = 'local-internal-token';
Module._load = function load(id, parent, isMain) {
  if (id === 'https') return httpsMock;
  if (id === 'wx-server-sdk') return {
    DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db,
    getWXContext: () => ({ OPENID: 'owner' }),
  };
  return originalLoad.call(this, id, parent, isMain);
};
const virtualPay = require('../cloudfunctions/virtualPay/index');
Module._load = originalLoad;

async function run() {
  const orderNo = orderNos[0];
  queryResponse = { errcode: '0', order: {
    order_id: orderNo, order_fee: 300, status: 1, env_type: 1,
    // 微信尚未扣款时可省略 paid_fee。
  } };
  let result = await virtualPay.main({ action: 'cancelOrder', outTradeNo: orderNo }, {});
  assert.strictEqual(result.code, 0);
  assert.strictEqual(row.status, 'cancelled');
  assert.strictEqual(row.lastQueryReason, 'platform_status:1');

  row.status = 'created';
  queryResponse = { errcode: -1, errmsg: 'query temporarily unavailable' };
  result = await virtualPay.main({ action: 'cancelOrder', outTradeNo: orderNo }, {});
  assert.strictEqual(result.code, -2);
  assert.strictEqual(row.status, 'created');
  assert(!result.msg.includes('同步订单'));

  queryResponse = { errcode: 0, order: {
    order_id: orderNo, order_fee: 300, status: 1, paid_fee: 300, env_type: 1,
  } };
  result = await virtualPay.main({ action: 'cancelOrder', outTradeNo: orderNo }, {});
  assert.strictEqual(result.code, -2);
  assert.strictEqual(row.status, 'created');
  queryResponse = { errcode: 0, order: {
    order_id: orderNo, order_fee: 300, status: 0, env_type: 1,
  } };
  result = await virtualPay.main({ action: 'repay', outTradeNo: orderNo, platform: 'android' }, {});
  assert.strictEqual(result.code, 0, '微信初始化失败的原单应自动换新单继续支付');
  assert.notStrictEqual(result.data.outTradeNo, orderNo);
  assert.strictEqual(row.status, 'cancelled');
  row.status = 'created';
  for (const [index, no] of orderNos.slice(1).entries()) {
    row.outTradeNo = no;
    row.status = 'created';
    delete row.paymentReturnedAt;
    queryResponse = index === 1
      ? { errcode: 0, order: { order_id: no, order_fee: 300, status: 0, env_type: 1 } }
      : { errcode: 268490002, errmsg: index === 0 ? 'order_id not exist' : '订单不存在' };
    result = await virtualPay.main({ action: 'cancelOrder', outTradeNo: no }, {});
    assert.strictEqual(result.code, 0, `${no} 微信明确未建成订单时应允许取消本地订单`);
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.lastQueryReason, index === 1 ? 'platform_status:0' : 'query_error:268490002');

    row.status = 'created';
    result = await virtualPay.main({ action: 'repay', outTradeNo: no, platform: 'android' }, {});
    assert.strictEqual(result.code, 0, `${no} 微信未建成订单时应能继续支付`);
    if (index === 1) assert.notStrictEqual(result.data.outTradeNo, no);
    else assert.strictEqual(result.data.outTradeNo, no);
  }
  row.status = 'created';
  delete row.paymentReturnedAt;
  queryResponse = { errcode: 268490002, errmsg: 'missing env field' };
  result = await virtualPay.main({ action: 'cancelOrder', outTradeNo: row.outTradeNo }, {});
  assert.strictEqual(result.code, -2, '普通参数错误不可当作微信无单');
  assert.strictEqual(row.lastQueryDetail, 'missing env field');
  queryResponse = { errcode: 0, errmsg: 'ok' };
  row.paymentReturnedAt = Date.now();
  row.status = 'created';
  result = await virtualPay.main({ action: 'cancelOrder', outTradeNo: row.outTradeNo }, {});
  assert.strictEqual(result.code, -2, '已返回支付结果但微信查不到订单时不得直接取消');
  assert.strictEqual(row.status, 'created');
  console.log('取消/继续支付链路：微信无单可处理；查单异常、金额异常或已有支付证据不可误取消');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
