const assert = require('assert');
const X = require('../cloudfunctions/virtualPay/xpay');
const S = require('../cloudfunctions/virtualPay/sign');
const Module = require('module');

const local = { _openid: 'user-openid', outTradeNo: 'VPMUMUXLEQZ52FKZ', price: 300, env: 0 };
const request = X.signedRequest('/xpay/query_order', X.queryPayload(local), 'token', 'app-key');
assert.deepStrictEqual(JSON.parse(request.body), {
  openid: 'user-openid', env: 0, order_id: local.outTradeNo,
});
assert(request.url.endsWith(`pay_sig=${S.paySig('app-key', '/xpay/query_order', request.body)}`));
assert(!Object.hasOwn(JSON.parse(request.body), 'paySig'));

const paid = {
  errcode: 0,
  order: {
    order_id: local.outTradeNo, order_fee: 300, status: 2, env_type: 1,
    paid_fee: 300, wx_order_id: 'wx-123', channel_order_id: 'apple-123',
    sett_state: 4,
  },
};
const verified = X.readQueryResponse(paid, local);
assert.strictEqual(verified.ok, true);
assert.strictEqual(verified.platform.channelOrderId, 'apple-123');
assert.strictEqual(verified.platform.settlementState, 4);
const refunded = X.readQueryResponse({
  errcode: 0,
  order: { ...paid.order, status: 8, refund_fee: 300, left_fee: 0 },
}, local);
assert.strictEqual(refunded.ok, false);
assert.strictEqual(refunded.platform.refundFee, 300);
assert.strictEqual(refunded.platform.leftFee, 0);

for (const response of [
  { ...paid, errcode: -1 },
  { ...paid, order: { ...paid.order, order_id: 'OTHER-ORDER' } },
  { ...paid, order: { ...paid.order, order_fee: 100 } },
  { ...paid, order: { ...paid.order, paid_fee: undefined } },
  { ...paid, order: { ...paid.order, paid_fee: 301 } },
  { ...paid, order: { ...paid.order, env_type: 2 } },
  { ...paid, order: { ...paid.order, status: 1, paid_fee: 300 } },
  { ...paid, order: { ...paid.order, status: 5 } },
  { errcode: 0, paid_fee: 300 },
]) {
  assert.strictEqual(X.readQueryResponse(response, local).ok, false);
}

assert.deepStrictEqual(X.providePayload(local), { order_id: local.outTradeNo, env: 0 });
assert.strictEqual(X.appKeyForEnv(1, { production: 'live', sandbox: 'test' }), 'test');
const jsonNotify = X.readNotifyPayload(JSON.stringify({
  Event: 'xpay_goods_deliver_notify', OpenId: local._openid,
  OutTradeNo: local.outTradeNo, Env: 0,
}));
assert.strictEqual(jsonNotify.payload.OutTradeNo, local.outTradeNo);
const xmlNotify = X.readNotifyPayload(`<xml><Event><![CDATA[xpay_goods_deliver_notify]]></Event><OpenId>${local._openid}</OpenId><OutTradeNo><![CDATA[${local.outTradeNo}]]></OutTradeNo><Env>0</Env></xml>`);
assert.strictEqual(xmlNotify.format, 'xml');
assert.strictEqual(xmlNotify.payload.OutTradeNo, local.outTradeNo);
const iosNotify = X.readNotifyPayload('<xml><Event><![CDATA[xpay_subscribe_ios_refund_query_notify]]></Event><provide_status><![CDATA[1]]></provide_status><pay_order_id><![CDATA[VPMUMUXLEQZ52FKZ]]></pay_order_id></xml>');
assert.strictEqual(iosNotify.payload.Event, 'xpay_subscribe_ios_refund_query_notify');
assert.strictEqual(iosNotify.payload.provide_status, '1');
assert.strictEqual(iosNotify.payload.pay_order_id, local.outTradeNo);
assert(X.notifyResponse({ ErrCode: 0, ErrMsg: 'success' }, 'xml').includes('<ErrCode>0</ErrCode>'));
const iosResponse = X.notifyResponse({
  __iosRefundQuery: true, result_code: 0,
  result_info: '按平台规则处理', evidence: '未建立按订单消费台账',
}, 'json');
assert.deepStrictEqual(iosResponse, {
  result_code: 0, result_info: '按平台规则处理', evidence: '未建立按订单消费台账',
});
assert(X.notifyResponse({
  __iosRefundQuery: true, result_code: 0, result_info: 'ok', evidence: 'evidence',
}, 'xml').includes('<result_code>0</result_code>'));

// 真实小程序登录态也不能直接调用额度发货或退款。
const originalLoad = Module._load;
const originalToken = process.env.INTERNAL_TOKEN;
process.env.INTERNAL_TOKEN = 'server-only-test-token';
Module._load = function mockedLoad(id, parent, isMain) {
  if (id === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test', init() {}, database() { return {}; },
      getWXContext() { return { OPENID: 'user-openid' }; },
    };
  }
  return originalLoad.call(this, id, parent, isMain);
};
const quota = require('../cloudfunctions/quota/index');
Module._load = originalLoad;

Promise.all([
  quota.main({ action: 'deliver', goodsId: 'plan_1', orderNo: local.outTradeNo }, {}),
  quota.main({ action: 'refund', bizKey: 'plan:123' }, {}),
]).then((results) => {
  assert(results.every((r) => r.code === -1));
  console.log('虚拟支付查单校验及客户端直调发货/退款拦截通过');
}).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (originalToken === undefined) delete process.env.INTERNAL_TOKEN;
  else process.env.INTERNAL_TOKEN = originalToken;
});
