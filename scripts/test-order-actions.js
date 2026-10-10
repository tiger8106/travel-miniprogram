const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const stale = deferred();
const fresh = deferred();
let reads = 0;
let confirmContent = '';
let cached = null;
let page;
const orderNo = 'VPMUIE0HD6K2GS93';
const quota = {
  orderList: () => (++reads === 1 ? stale.promise : fresh.promise),
  cancelOrder: async () => true,
  syncOrders: async () => ({ delivered: 0 }),
};
const auth = { getOpenid: () => 'owner', isLoggedIn: () => true };
const homeCache = { readPage: () => cached, writePage: (_, value) => { cached = value; } };
const wx = {
  showModal({ content, success }) { confirmContent = content; if (success) success({ confirm: true }); },
  showLoading() {}, hideLoading() {}, showToast() {},
};
vm.runInNewContext(fs.readFileSync('miniprogram/pages/orders/orders.js', 'utf8'), {
  Page: (value) => { page = value; }, console, Date, Promise, Set, wx,
  require(name) {
    if (name.endsWith('/quota')) return quota;
    if (name.endsWith('/auth')) return auth;
    if (name.endsWith('/homecache')) return homeCache;
    throw new Error(name);
  },
});
page.data = Object.assign({}, page.data, { loggedIn: true, loading: false, page: 1,
  list: [{ outTradeNo: orderNo, status: 'created', statusText: '待支付' }] });
page.setData = (patch) => Object.assign(page.data, patch);

async function run() {
  const oldRequest = page.refresh();
  await page.onCancel({ currentTarget: { dataset: { no: orderNo } } });
  assert.strictEqual(confirmContent, '确定取消这笔订单吗？');
  assert.strictEqual(reads, 2, '取消后即使旧列表请求未结束，也要发起新请求');
  assert.strictEqual(page.data.list[0].status, 'cancelled', '成功后立即更新卡片状态');
  stale.resolve({ list: [{ outTradeNo: orderNo, status: 'created' }], hasMore: false });
  await oldRequest;
  assert.strictEqual(page.data.list[0].status, 'cancelled', '旧响应不得覆盖取消结果');
  fresh.resolve({ list: [{ outTradeNo: orderNo, status: 'created' }], hasMore: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(page.data.list[0].status, 'cancelled', '短暂读到旧副本也不能让取消按钮闪回');
  assert.strictEqual(cached.list[0].status, 'cancelled');
  console.log('订单取消确认与并发列表刷新回归通过');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
