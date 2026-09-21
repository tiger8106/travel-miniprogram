// utils/trip.js
// 多攻略管理：分类（进行中/历史）+ 置顶（历史攻略添加到首页展示）

const PIN_KEY = '__pinned_trips__'; // 置顶到首页的历史攻略 id 列表

/**
 * "2026-09-30" → 当天本地 00:00 时间戳
 * 直接 new Date("YYYY-MM-DD") 会被解析成 UTC 零点（北京 08:00），导致日期错位
 */
function parseLocalDate(str) {
  if (!str) return NaN;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? NaN : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

/**
 * 攻略是否已结束（endDate 早于今天）
 * 没有.endDate 的攻略不算历史，保留在首页
 */
function isEnded(trip) {
  if (!trip || !trip.endDate) return false;
  const endTs = parseLocalDate(trip.endDate);
  if (isNaN(endTs)) return false;
  const now = new Date();
  const todayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return endTs < todayTs;
}

/**
 * 读取置顶的历史攻略 id 列表
 */
function getPinnedIds() {
  const v = wx.getStorageSync(PIN_KEY);
  return Array.isArray(v) ? v : [];
}

/**
 * 置顶/取消置顶，返回置顶后的状态（true=已置顶）
 */
function togglePinned(tripId) {
  if (!tripId) return false;
  let ids = getPinnedIds();
  const i = ids.indexOf(tripId);
  if (i >= 0) {
    ids.splice(i, 1);
    wx.setStorageSync(PIN_KEY, ids);
    return false;
  }
  ids.push(tripId);
  wx.setStorageSync(PIN_KEY, ids);
  return true;
}

/**
 * 攻略分组
 * @returns {{ active: Array, history: Array }}
 *   active  = 进行中/未来（首页展示）
 *   history = 已结束（历史行程页展示）
 */
function classifyTrips(trips) {
  const active = [];
  const history = [];
  (trips || []).forEach((t) => {
    (isEnded(t) ? history : active).push(t);
  });
  return { active, history };
}

/**
 * 首页可展示的攻略 = 进行中的 + 置顶的历史攻略
 */
function homeTrips(trips) {
  const { active, history } = classifyTrips(trips);
  const pinned = getPinnedIds();
  const pinnedHistory = history.filter((t) => pinned.indexOf(t._id) >= 0);
  return active.concat(pinnedHistory);
}

module.exports = {
  parseLocalDate,
  isEnded,
  getPinnedIds,
  togglePinned,
  classifyTrips,
  homeTrips,
};
