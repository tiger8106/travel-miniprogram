// scripts/test-pagecache.js
// 验证 utils/homecache.js 的页面快照缓存与「自动生成」节流逻辑
// 用法: node scripts/test-pagecache.js

const assert = require('assert');
const path = require('path');

// ---- 用内存 Map 模拟 wx 本地存储 ----
const store = new Map();
global.wx = {
  getStorageSync: (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : ''),
  setStorageSync: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))),
  removeStorageSync: (k) => store.delete(k),
};

const hc = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'homecache.js'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log('✅ ' + name);
  } else {
    fail++;
    console.log('❌ ' + name);
  }
}

// ---- 页面快照 ----
ok(hc.readPage('tickets') === null, '没写过时 readPage 返回 null');

hc.writePage('tickets', { tripId: 't1', alarms: [{ _id: 'a1' }], pendingCount: 1 });
const snap = hc.readPage('tickets');
ok(snap && snap.tripId === 't1' && snap.pendingCount === 1, 'writePage/readPage 往返正确');
ok(snap.alarms[0]._id === 'a1', '快照里的数组结构保留');

hc.writePage('suggestions', { tripId: 't1', suggestions: { weather: '晴' } });
ok(hc.readPage('tickets').tripId === 't1', '不同 key 互不干扰');
ok(hc.readPage('suggestions').suggestions.weather === '晴', 'suggestions key 独立读写');

hc.clearPage('tickets');
ok(hc.readPage('tickets') === null, 'clearPage 生效');
ok(hc.readPage('suggestions') !== null, 'clearPage 只清自己的 key');

// 返回的是深拷贝，改返回值不会污染存储
const s2 = hc.readPage('suggestions');
s2.suggestions.weather = '雨';
ok(hc.readPage('suggestions').suggestions.weather === '晴', 'readPage 返回副本，外部改动不污染缓存');

// ---- 首页 setData 去重的签名比较 ----
const a = { tripId: 't1', alarms: [{ _id: 'a1', friendly: '明天 15:15' }], pendingCount: 1 };
const b = { tripId: 't1', alarms: [{ _id: 'a1', friendly: '明天 15:15' }], pendingCount: 1 };
const c = { tripId: 't1', alarms: [{ _id: 'a1', friendly: '明天 15:20' }], pendingCount: 1 };
ok(JSON.stringify(a) === JSON.stringify(b), '内容相同时签名一致（跳过 setData）');
ok(JSON.stringify(a) !== JSON.stringify(c), '内容变化时签名不同（触发 setData）');

// ---- 建议页自动生成节流 ----
const TRIP = 'trip_001';
ok(hc.shouldAutoTry(TRIP) === true, '从未尝试过 → 允许自动生成');

hc.markAutoTried(TRIP);
ok(hc.shouldAutoTry(TRIP) === false, '刚尝试过 → 12 小时内不再自动跑');
ok(hc.autoTriedAt(TRIP) > 0, '记录到了尝试时间戳');

ok(hc.shouldAutoTry('trip_002') === true, '另一个行程互不影响');

hc.clearAutoTried(TRIP);
ok(hc.shouldAutoTry(TRIP) === true, '手动刷新清除标记后可再次生成');

// 超过 TTL 后自动放行
hc.markAutoTried(TRIP);
const realNow = Date.now;
Date.now = () => realNow() + 13 * 60 * 60 * 1000; // 推进 13 小时
ok(hc.shouldAutoTry(TRIP) === true, '超过 12 小时 TTL 后重新允许自动尝试');
Date.now = realNow;

// ---- 闹钟同步节流 ----
ok(hc.alarmSyncedAt('t1') === 0, '闹钟同步时间初始为 0');
hc.markAlarmSynced('t1');
ok(Math.abs(hc.alarmSyncedAt('t1') - Date.now()) < 3000, '标记后拿到当前时间戳');
ok(hc.alarmSyncedAt('t2') === 0, '不同行程的闹钟同步记录独立');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
