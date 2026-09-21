// utils/homecache.js
// 首页首屏快照缓存：把上一次渲染好的数据存在本地，
// 进页面时先用快照立刻渲染（不转圈），再在后台拉最新数据覆盖。
// 数据有变动（删除行程 / 上传新攻略 / 编辑保存）时调 clear() 失效。

const SNAP_KEY = 'home_snapshot_v1';
const ALARM_KEY = 'alarm_synced_at_v1';

function read() {
  try {
    const raw = wx.getStorageSync(SNAP_KEY);
    if (!raw || typeof raw !== 'object' || !raw.trip) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

function write(snapshot) {
  try {
    wx.setStorageSync(SNAP_KEY, snapshot);
  } catch (e) {
    // 存储写满或被限制时忽略，不影响主流程
  }
}

function clear() {
  try {
    wx.removeStorageSync(SNAP_KEY);
  } catch (e) {}
}

// 闹钟时区校准不需要每次进首页都做，记个时间戳节流
function alarmSyncedAt(tripId) {
  try {
    const m = wx.getStorageSync(ALARM_KEY);
    return (m && Number(m[tripId])) || 0;
  } catch (e) {
    return 0;
  }
}

function markAlarmSynced(tripId) {
  try {
    const m = wx.getStorageSync(ALARM_KEY) || {};
    m[tripId] = Date.now();
    wx.setStorageSync(ALARM_KEY, m);
  } catch (e) {}
}

// 闹钟页 / 建议页等也用同一套：按 key 存渲染快照，进页面先秒开再后台刷新
const PAGE_PREFIX = 'page_snap_';

function readPage(key) {
  try {
    const raw = wx.getStorageSync(PAGE_PREFIX + key);
    return raw && typeof raw === 'object' ? raw : null;
  } catch (e) {
    return null;
  }
}

function writePage(key, data) {
  try {
    wx.setStorageSync(PAGE_PREFIX + key, data);
  } catch (e) {}
}

function clearPage(key) {
  try {
    wx.removeStorageSync(PAGE_PREFIX + key);
  } catch (e) {}
}

// 建议页的「自动生成」很慢（10-20s LLM），失败/为空时不能每次进页面都重跑
const AUTO_TRY_KEY = 'suggestions_autotried_v1';
const AUTO_TRY_TTL = 12 * 60 * 60 * 1000;

function autoTriedAt(tripId) {
  try {
    const m = wx.getStorageSync(AUTO_TRY_KEY);
    return (m && Number(m[tripId])) || 0;
  } catch (e) {
    return 0;
  }
}

function markAutoTried(tripId) {
  try {
    const m = wx.getStorageSync(AUTO_TRY_KEY) || {};
    m[tripId] = Date.now();
    wx.setStorageSync(AUTO_TRY_KEY, m);
  } catch (e) {}
}

function clearAutoTried(tripId) {
  try {
    const m = wx.getStorageSync(AUTO_TRY_KEY) || {};
    delete m[tripId];
    wx.setStorageSync(AUTO_TRY_KEY, m);
  } catch (e) {}
}

// 距上次自动尝试是否已超过 TTL（没试过 → true）
function shouldAutoTry(tripId) {
  return Date.now() - autoTriedAt(tripId) >= AUTO_TRY_TTL;
}

module.exports = {
  read, write, clear, alarmSyncedAt, markAlarmSynced,
  readPage, writePage, clearPage,
  autoTriedAt, markAutoTried, clearAutoTried, shouldAutoTry,
};
