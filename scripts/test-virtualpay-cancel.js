// 用真实报错单号走取消 action 的完整本地链路；微信查单响应由测试桩替代。
const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');

const orderNo = 'VPMUIN9HTGLY7A2R';
const row = {
  _id: 'local-order', _openid: 'owner', outTradeNo: orderNo,
  price: 300, env: 0, goodsId: 'plan_1', status: 'created', createdAt: Date.now(),
};
let queryResponse;
const db = {
  collection() {
    return {
      where() { return this; }, limit() { return this; },
      get: async () => ({ data: [row] }),
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
};
process.env.MP_APPID = 'local-test-appid';
process.env.MP_APPSECRET = 'local-test-secret';
process.env.XPAY_APP_KEY = 'local-test-key';
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
  console.log('取消订单链路：明确未支付可取消；查单异常或实付金额异常不可误取消');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
