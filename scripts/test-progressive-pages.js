const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let openid = 'u1';
const snapshots = {
  pay: { openid, info: { total: 3, goods: [{ id: 'one' }] }, goods: [{ id: 'one' }], invite: { inviteCode: 'ABC' } },
  orders: { openid, list: [{ outTradeNo: 'old', goodsName: '旧订单', status: 'delivered' }], page: 1, hasMore: true },
  admin_panel: { openid, identity: { isAdmin: true, isSuper: true, me: { nickname: '管理员' } },
    panels: { users: [{ userId: 'a', nickname: '首批用户' }], userPage: 1, userTotalPages: 2,
      userTotal: 2, loadedTabs: { users: true, payments: false, config: false, staff: false, audit: false } } },
};
const homeCache = { readPage: (key) => snapshots[key], writePage: (key, value) => { snapshots[key] = value; },
  clearPage: (key) => { delete snapshots[key]; } };
const auth = { getOpenid: () => openid, isLoggedIn: () => !!openid };
const later = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const info = later();
const invite = later();
const firstOrders = later();
let syncCalls = 0;
const quota = { info: () => info.promise, inviteInfo: () => invite.promise,
  orderList: (page) => page === 1 ? firstOrders.promise : Promise.resolve({ list: [{ outTradeNo: 'new',
    goodsName: '更早订单', status: 'delivered', createdAt: Date.now() }], hasMore: false }),
  syncOrders: () => { syncCalls++; return Promise.resolve({ delivered: 0 }); } };
const identity = later();
let userCalls = 0;
const api = { adminIdentity: () => identity.promise, adminOverview: async () => ({ stats: { users: 2 }, totalGen: 1 }),
  adminSearchUsers: async (_, page) => {
    userCalls++;
    return { list: [{ userId: page === 1 ? 'a' : 'b', nickname: page === 1 ? '首批用户' : '后续用户' }],
      page, totalPages: 2, total: 2 };
  } };
const wx = { showToast: () => {} };

function makePage(path) {
  let page;
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), {
    console, Date, Promise, Set, wx, setTimeout,
    Page: (p) => { page = p; },
    require(name) {
      if (name.endsWith('/auth')) return auth;
      if (name.endsWith('/homecache')) return homeCache;
      if (name.endsWith('/quota')) return quota;
      if (name.endsWith('/admin-role')) return { cached: () => true, remember: () => {} };
      if (name.endsWith('/api')) return api;
      return {};
    },
  });
  page.data = { ...page.data };
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

(async () => {
  const pay = makePage('miniprogram/pages/pay/pay.js');
  pay.onShow();
  assert.strictEqual(pay.data.loading, false);
  assert.strictEqual(pay.data.info.total, 3, '额度首帧显示上次数据');
  info.resolve({ total: 4, goods: [{ id: 'one' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(pay.data.info.total, 4, '额度结果不应等待邀请接口');
  invite.resolve({ inviteCode: 'XYZ' });

  const orders = makePage('miniprogram/pages/orders/orders.js');
  orders.onShow();
  assert.strictEqual(orders.data.list[0].outTradeNo, 'old', '订单首帧使用缓存');
  assert.strictEqual(orders.data.loading, false);
  assert.strictEqual(syncCalls, 0, '订单同步不得挡在列表请求前');
  firstOrders.resolve({ list: [{ outTradeNo: 'first', status: 'delivered', createdAt: Date.now() }], hasMore: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(orders.data.list[0].outTradeNo, 'first');
  assert.strictEqual(syncCalls, 1, '列表展示后再后台同步订单');
  await orders.loadMore();
  assert.strictEqual(orders.data.list.length, 2);
  assert.strictEqual(orders.data.hasMore, false);

  const admin = makePage('miniprogram/pages/admin/admin.js');
  admin.onLoad();
  assert.strictEqual(admin.data.loading, false, '管理后台已有快照时首帧显示内容');
  assert.strictEqual(admin.data.users[0].nickname, '首批用户');
  identity.resolve({ isAdmin: true, isSuper: true, me: { nickname: '管理员' } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await admin.loadMoreUsers();
  assert.strictEqual(admin.data.users.length, 2, '用户列表在同一页面追加：' + JSON.stringify({ userCalls, page: admin.data.userPage, totalPages: admin.data.userTotalPages, loading: admin.data.loadingUsers, users: admin.data.users }));
  const wxml = fs.readFileSync('miniprogram/pages/admin/admin.wxml', 'utf8');
  assert(!/onUserPrev|onUserNext/.test(wxml), '管理后台不得再显示翻页按钮');

  openid = 'u2';
  assert.strictEqual(pay.showCached(), false, '额度快照不能串账号');
  assert.strictEqual(orders.showCached(), false, '订单快照不能串账号');
  assert.strictEqual(admin.showCached(), false, '管理后台快照不能串账号');
  pay.onShow();
  orders.onShow();
  assert.strictEqual(pay.data.info, null, '账号切换后旧额度不可停留在页面');
  assert.strictEqual(orders.data.list.length, 0, '账号切换后旧订单不可停留在页面');
  console.log('✅ 额度/订单/管理后台首帧缓存、后台校准、滚动追加和账号隔离');
})().catch((e) => { console.error(e); process.exitCode = 1; });
