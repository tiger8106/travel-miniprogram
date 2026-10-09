const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const trip = { _id: 'trip-a', title: '历史行程', startDate: '2026-10-01', endDate: '2026-10-02',
  items: [{ _id: 'item-1', dayIndex: 0, activity: '出发' }] };
const openid = 'user-a';
const snap = { openid, trip };
const tips = { tips: ['提前出发'], notices: [] };
const app = { globalData: { currentTripId: null, currentTrip: null } };
let requests = 0;
let page;
vm.runInNewContext(fs.readFileSync('miniprogram/pages/itinerary/itinerary.js', 'utf8'), {
  Date, Promise, JSON, console, setInterval, clearInterval,
  getApp: () => app, Page: (p) => { page = p; },
  wx: { showToast: () => {} },
  require(name) {
    if (name.endsWith('/auth')) return { getOpenid: () => openid, requireLogin: async () => true };
    if (name.endsWith('/homecache')) return { readPage: (key) => key === 'itinerary' ? snap
      : (key === 'daytips_trip-a_0' ? { openid, tips } : null),
      selectedTripId: () => 'trip-a', writePage: () => {} };
    if (name.endsWith('/api')) return { getItinerary: async () => { requests++; return trip; },
      getDayTips: () => new Promise(() => {}) };
    return {};
  },
});
page.data = { ...page.data, viewTripId: 'trip-a' };
page.setData = (patch) => Object.assign(page.data, patch);
page.renderTrip = function (value) { this.setData({ trip: value }); };
page.startTicker = () => {};
page.bgRefresh = async () => { requests++; };
page.onShow();
assert.strictEqual(page.data.trip.title, '历史行程', '详情页首帧应同步展示本地完整行程');
page.setData({ tripId: 'trip-a' });
page.loadDayTips();
assert.strictEqual(page.data.dayTips.tips[0], '提前出发', '当天建议也应先用本地快照展示');
new Promise((resolve) => setImmediate(resolve)).then(() => {
  assert.strictEqual(requests, 1, '已有快照时仅后台校准，不重复阻塞首屏');
  console.log('✅ 我的行程详情首帧恢复本地完整行程，后台校准不阻塞');
}).catch((e) => { console.error(e); process.exitCode = 1; });
