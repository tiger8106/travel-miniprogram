// cloudfunctions/parseTravelPlan/cn-time.js
// 云函数服务器时区是 UTC，所有"北京时间"的解析/格式化必须走这里，
// 绝不直接 new Date(string)（会按服务器时区解析，导致 +8 小时错位）
const CN_OFFSET = 8 * 3600 * 1000;

/**
 * 解析 "YYYY-MM-DDTHH:mm[:ss]" 或 "YYYY-MM-DD HH:mm[:ss]"（北京时间）→ 绝对时间戳
 * 解析失败返回 NaN
 */
function parseCnTime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - CN_OFFSET;
}

/**
 * 时间戳 → 北京时间 "YYYY-MM-DD"
 */
function tsToDateStr(ts) {
  const d = new Date(ts + CN_OFFSET);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 时间戳 → 北京时间 "YYYY-MM-DD HH:mm"
 */
function tsToCnDateTimeStr(ts) {
  const d = new Date(ts + CN_OFFSET);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${tsToDateStr(ts)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

module.exports = { CN_OFFSET, parseCnTime, tsToDateStr, tsToCnDateTimeStr };
