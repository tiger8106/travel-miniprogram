const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function loadQuota(replies) {
  let sdkCalls = 0; let loginCalls = 0; const calls = [];
  const wx = {
    showLoading() {}, hideLoading() {}, getDeviceInfo: () => ({ platform: 'android' }),
    login({ success }) { success({ code: 'code-' + (++loginCalls) }); },
    requestVirtualPayment(options) { sdkCalls++; replies.shift()(options); },
  };
  const module = { exports: {} };
  const request = {
    async callFn(_, data) {
      calls.push(data);
      return { outTradeNo: 'new-order', replacedOrderNo: 'old-order', signData: 'original-sign-data',
        paySig: 'pay-signature', signature: 'user-signature' };
    },
    async callFnKeepCode(_, data) {
      calls.push(data); return { code: 0, data: { ok: true, delivered: true } };
    },
  };
  vm.runInNewContext(fs.readFileSync('miniprogram/utils/quota.js', 'utf8'), {
    module, wx, console, require: (name) => name === './request' ? request : { clearPage() {} },
  });
  return { quota: module.exports, wx, calls, sdkCalls: () => sdkCalls, loginCalls: () => loginCalls };
}

async function run() {
  const recovery = loadQuota([
    (o) => o.fail({ errCode: '-15007', errMsg: 'expired session' }),
    (o) => { assert.strictEqual(o.signData, 'original-sign-data'); o.success({}); },
  ]);
  const result = await recovery.quota.payAgain('old-order');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(recovery.sdkCalls(), 2);
  assert.strictEqual(recovery.loginCalls(), 2, '过期后必须取新 code');
  assert.strictEqual(recovery.calls[1].outTradeNo, 'new-order', '刷新签名必须针对实际替代单');
  assert.strictEqual(recovery.calls[2].action, 'confirm');
  assert.strictEqual(recovery.calls[2].outTradeNo, 'new-order');
  assert.strictEqual(result.replacedOrderNo, 'old-order');

  const cancellation = loadQuota([(o) => o.fail({ errCode: '-2', errMsg: 'cancel' })]);
  await assert.rejects(cancellation.quota.payAgain('old-order'), (e) =>
    e.paymentCancelled && e.replacedOrderNo === 'old-order');
  assert.strictEqual(cancellation.sdkCalls(), 1, '用户取消不能自动再弹支付');
  assert(!cancellation.calls.some((o) => o.action === 'confirm'), '取消支付不能标记付款成功');

  const repeated = loadQuota([
    (o) => o.fail({ errCode: -15007 }), (o) => o.fail({ errCode: -15007 }),
  ]);
  await assert.rejects(repeated.quota.payAgain('old-order'), /登录态过期/);
  assert.strictEqual(repeated.sdkCalls(), 2, '登录异常最多重试一次');
  console.log('续付登录态恢复、替代单确认和用户取消不重试回归通过');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
