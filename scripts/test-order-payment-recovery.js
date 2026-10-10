const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function loadQuota(replies, settings = {}) {
  let sdkCalls = 0; let loginCalls = 0; const calls = [];
  let preparedCalls = 0;
  const wx = {
    showLoading() {}, hideLoading() {}, getDeviceInfo: () => ({ platform: settings.platform || 'android' }),
    login({ success }) { success({ code: 'code-' + (++loginCalls) }); },
    requestVirtualPayment(options) { sdkCalls++; replies.shift()(options); },
  };
  const module = { exports: {} };
  const request = {
    async callFn(_, data) {
      calls.push(data);
      preparedCalls++;
      if (settings.rejectRecovery && preparedCalls > 1) throw new Error('微信侧已支付，请勿重复付款');
      return { outTradeNo: settings.reuseNumber ? 'new-order' : 'new-order-' + preparedCalls,
        replacedOrderNo: data.action === 'repay' ? data.outTradeNo : '', signData: 'sign-data-' + preparedCalls,
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
    (o) => { assert.strictEqual(o.signData, 'sign-data-2'); o.success({}); },
  ]);
  const result = await recovery.quota.payAgain('old-order');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(recovery.sdkCalls(), 2);
  assert.strictEqual(recovery.loginCalls(), 2, '过期后必须取新 code');
  assert.strictEqual(recovery.calls[1].outTradeNo, 'new-order-1', '刷新签名必须针对实际替代单');
  assert.strictEqual(recovery.calls[2].action, 'confirm');
  assert.strictEqual(recovery.calls[2].outTradeNo, 'new-order-2');
  assert.strictEqual(result.replacedOrderNo, 'old-order');
  assert.deepStrictEqual(Array.from(result.replacedOrderNos), ['old-order', 'new-order-1']);

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

  for (const failure of [
    { errCode: '-15002', errMsg: 'duplicate outTradeNo' },
    { errMsg: 'requestVirtualPayment:fail IOS支付时订单号重复' },
    { errCode: -15012, errMsg: '调用米大师失败导致关单' },
  ]) {
    const duplicate = loadQuota([(o) => o.fail(failure), (o) => {
      assert.strictEqual(o.signData, 'sign-data-2', '不能用原签名改订单号或再次拉起'); o.success({});
    }], { platform: 'ios' });
    const r = await duplicate.quota.payAgain('ios-old-order');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(duplicate.sdkCalls(), 2);
    assert.strictEqual(duplicate.loginCalls(), 2);
    assert.strictEqual(duplicate.calls[1].outTradeNo, 'new-order-1');
    assert.strictEqual(duplicate.calls[1].platform, 'ios');
    assert.strictEqual(r.outTradeNo, 'new-order-2');
    assert.strictEqual(duplicate.calls[2].outTradeNo, 'new-order-2', '只确认最后成功拉起的单号');
  }

  const duplicateAgain = loadQuota([
    (o) => o.fail({ errCode: -15002 }), (o) => o.fail({ errCode: -15002 }),
  ]);
  await assert.rejects(duplicateAgain.quota.payAgain('old-order'), /订单未能发起/);
  assert.strictEqual(duplicateAgain.sdkCalls(), 2, '换号失败不能无限拉起付款');
  const staleServer = loadQuota([(o) => o.fail({ errCode: -15002 })], { reuseNumber: true });
  await assert.rejects(staleServer.quota.payAgain('old-order'), /订单未能更新/);
  assert.strictEqual(staleServer.sdkCalls(), 1, '旧云函数返回原号时不能再次调用 SDK');
  const paid = loadQuota([(o) => o.fail({ errCode: -15002 })], { rejectRecovery: true });
  await assert.rejects(paid.quota.payAgain('old-order'), /已支付/);
  assert.strictEqual(paid.sdkCalls(), 1, '云端查明已支付时不能重新拉起');

  const cancelledAfterRecovery = loadQuota([
    (o) => o.fail({ errCode: -15002 }), (o) => o.fail({ errCode: -2 }),
  ]);
  await assert.rejects(cancelledAfterRecovery.quota.payAgain('old-order'), (e) => e.paymentCancelled
    && e.replacedOrderNo === 'old-order' && e.replacedOrderNos.length === 2);
  assert.strictEqual(cancelledAfterRecovery.sdkCalls(), 2);
  assert(!cancelledAfterRecovery.calls.some((o) => o.action === 'confirm'));

  const mixed = loadQuota([
    (o) => o.fail({ errCode: -15002 }), (o) => o.fail({ errCode: -15007 }),
    (o) => o.fail({ errCode: -15002 }),
  ]);
  await assert.rejects(mixed.quota.payAgain('old-order'), /订单未能发起/);
  assert.strictEqual(mixed.sdkCalls(), 3, '两类异常交替出现也必须保持重试上限');

  const newPurchase = loadQuota([(o) => o.fail({ errCode: -15002 }), (o) => o.success({})]);
  const purchased = await newPurchase.quota.pay('plan_1');
  assert.strictEqual(newPurchase.calls[0].action, 'createOrder');
  assert.strictEqual(newPurchase.calls[1].action, 'repay');
  assert.strictEqual(purchased.outTradeNo, 'new-order-2', '新购买遭遇重复号也须重新查单换号');
  const unknown = loadQuota([(o) => o.fail({ errCode: -1, errMsg: 'unknown failure' })]);
  await assert.rejects(unknown.quota.payAgain('old-order'), /unknown failure/);
  assert.strictEqual(unknown.sdkCalls(), 1, '未知失败不能盲目重付');
  assert.strictEqual(unknown.calls.length, 1);
  console.log('支付单号单次使用、iOS重复号恢复、登录恢复与取消/已支付不重试回归通过');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
