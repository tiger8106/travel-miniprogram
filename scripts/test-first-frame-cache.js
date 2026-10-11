const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let openid = 'user-a';
const app = { globalData: { currentTripId: 'trip-a' } };
const pages = {};
const snapshots = {
  tickets: {
    openid, tripId: 'trip-a', pendingCount: 2, futureCount: 1, completedCount: 0,
    alarms: [
      { _id: 'hotel-1', type: 'hotel', title: '测试酒店', completed: false,
        actionAt: Date.now() + 86400000, remindAt: Date.now() + 80000000 },
      { _id: 'train-1', type: 'train', title: '车票', completed: false,
        actionAt: Date.now() + 86400000, remindAt: Date.now() + 80000000,
        remindFriendly: '明天' },
    ],
  },
  mytrips: { openid, trips: [{ _id: 'trip-a', title: '已存行程' }], activeCount: 1, endedCount: 0 },
};
const homeCache = {
  readPage: (key) => snapshots[key], writePage: (key, value) => { snapshots[key] = value; },
  clearPage: (key) => { delete snapshots[key]; }, selectedTripId: () => 'trip-a',
};
const auth = { getOpenid: () => openid, requireLogin: async () => !!openid,
  watch: () => () => {} };
let finishAlarms;
let finishTrips;
const api = {
  listAlarms: () => new Promise((resolve) => { finishAlarms = resolve; }),
  listItineraries: () => new Promise((resolve) => { finishTrips = resolve; }),
};
const alarm = { getAdvanceMin: () => 5, actionAtOf: (a) => a.actionAt,
  alarmTitleOf: require('../miniprogram/utils/alarm-title').alarmTitleOf,
  alarmKeyInfoOf: () => '', syncAlarms: () => {} };
const common = {
  console, Date, Promise, setTimeout, clearTimeout, getApp: () => app,
  wx: { showToast: () => {}, navigateTo: () => {} },
  require(name) {
    if (name.endsWith('/api')) return api;
    if (name.endsWith('/alarm')) return alarm;
    if (name.endsWith('/auth')) return auth;
    if (name.endsWith('/homecache')) return homeCache;
    if (name.endsWith('/env')) return { showDevTools: () => false };
    if (name.endsWith('/time')) return { fmtFriendly: () => '明天' };
    if (name.endsWith('/trip')) return { getPinnedIds: () => [], isEnded: () => false };
    if (name.endsWith('/genrunner')) return { sync: () => Promise.resolve(), subscribe: () => () => {} };
    return {};
  },
};
function makePage(path) {
  let page;
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), { ...common, Page: (p) => { page = p; } });
  page.data = { ...page.data };
  page.setData = (patch) => Object.assign(page.data, patch);
  return page;
}

(async () => {
  const tickets = makePage('miniprogram/pages/tickets/tickets.js');
  tickets.onShow();
  assert.strictEqual(tickets.data.loading, false, '提醒页首帧不能继续转圈');
  assert.strictEqual(tickets.data.hotelHint, true, '酒店提示应随列表同帧出现');
  assert.strictEqual(tickets.data.groups.length, 2, '分类卡应随列表同帧出现');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(tickets.data.groups.length, 2, '云请求未返回时分类不能消失');
  finishAlarms(snapshots.tickets.alarms);
  await Promise.resolve();
  await Promise.resolve();

  const group = makePage('miniprogram/pages/alarm-group/alarm-group.js');
  group.onLoad({ key: 'hotel' });
  group.onShow();
  assert.strictEqual(group.data.loading, false);
  assert.strictEqual(group.data.alarms.length, 1, '分类详情页首帧复用同一份提醒快照');

  const mytrips = makePage('miniprogram/pages/mytrips/mytrips.js');
  mytrips.onShow();
  assert.strictEqual(mytrips.data.loading, false, '行程列表首帧显示旧内容');
  assert.strictEqual(mytrips.data.trips[0].title, '已存行程');
  await Promise.resolve();
  assert.strictEqual(mytrips.data.loading, false, '后台刷新不能重新盖上加载占位');
  await new Promise((resolve) => setImmediate(resolve));
  finishTrips([{ _id: 'trip-a', title: '新标题', startDate: '2026-10-09', endDate: '2026-10-10' }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(mytrips.data.trips[0].title, '新标题');

  const appSource = fs.readFileSync('miniprogram/app.js', 'utf8');
  assert(appSource.includes('homeCache.selectedTripId(cachedOpenid)'), '冷启动应在云端请求前恢复选中行程');
  openid = 'user-b';
  assert.strictEqual(mytrips.showCached(), false, '其他账号不得展示旧行程列表');
  console.log('✅ 冷启动提醒/分类/行程首帧完整显示，后台刷新不遮挡，快照按账号隔离');
})().catch((error) => { console.error(error); process.exitCode = 1; });
