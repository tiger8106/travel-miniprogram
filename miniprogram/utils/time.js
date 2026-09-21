// utils/time.js
// 时间格式化、比较等

/**
 * 格式化时间 HH:mm
 */
function fmtTime(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 格式化日期 MM-DD
 */
function fmtDateShort(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 格式化日期 YYYY-MM-DD
 */
function fmtDate(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 友好时间显示：今天 14:30 / 明天 09:00 / 10-05 16:20
 */
function fmtFriendly(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((d.setHours(0, 0, 0, 0) - new Date(now.setHours(0, 0, 0, 0))) / 86400000);
  const time = fmtTime(ts);
  if (diffDays === 0) return `今天 ${time}`;
  if (diffDays === 1) return `明天 ${time}`;
  if (diffDays === -1) return `昨天 ${time}`;
  if (diffDays > 1 && diffDays < 7) return `${diffDays}天后 ${time}`;
  return `${fmtDateShort(ts)} ${time}`;
}

/**
 * 时间字符串解析 "14:30" → Date 对象（今天）
 */
function parseTimeStr(str, baseDate) {
  if (!str) return null;
  const m = str.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = baseDate ? new Date(baseDate) : new Date();
  d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  return d;
}

/**
 * 距离某个时间点还差多少毫秒
 */
function diffMs(targetTs) {
  return targetTs - Date.now();
}

/**
 * 判断是否为今天
 */
function isToday(ts) {
  const t = new Date(ts);
  const n = new Date();
  return t.getFullYear() === n.getFullYear()
    && t.getMonth() === n.getMonth()
    && t.getDate() === n.getDate();
}

/**
 * 计算两个日期之间的所有日期
 */
function dateRange(startTs, endTs) {
  const result = [];
  const cur = new Date(startTs);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(endTs);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    result.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

module.exports = {
  fmtTime,
  fmtDate,
  fmtDateShort,
  fmtFriendly,
  parseTimeStr,
  diffMs,
  isToday,
  dateRange,
};