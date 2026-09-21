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

module.exports = { read, write, clear, alarmSyncedAt, markAlarmSynced };
