// 提醒事项的纯数据规则。
// fireAt = 用户真正要办理的时刻（放票/开放预约/入住前办理等）
// remindAt = 按 leadMinutes 提前提醒用户的时刻

const DEFAULT_LEAD_MINUTES = 5;
const VALID_TYPES = ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'];

function clampLead(value, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback == null ? DEFAULT_LEAD_MINUTES : fallback;
  return Math.max(1, Math.min(60, Math.round(n)));
}

function isCompleted(alarm) {
  return !!(alarm && (alarm.completed === true || alarm.status === 'completed'));
}

function calcRemindAt(fireAt, leadMinutes) {
  const ts = Number(fireAt);
  if (!isFinite(ts) || ts <= 0) return 0;
  return ts - clampLead(leadMinutes, DEFAULT_LEAD_MINUTES) * 60 * 1000;
}

function normalizeType(type) {
  return VALID_TYPES.includes(type) ? type : 'other';
}

function normalizeTitle(title) {
  return String(title || '提醒').trim().replace(/[\s\u3000]+/g, '').slice(0, 100);
}

// 用于重新生成时保留同一事项的 _id、完成状态和用户提醒偏好。
function makeAlarmKey(alarm) {
  const date = String(alarm && (alarm.fireAtStr || '')).slice(0, 10);
  return `${normalizeType(alarm && alarm.type)}|${date}|${normalizeTitle(alarm && alarm.title)}`;
}

function normalizeAlarm(alarm, fallbackLead) {
  const a = alarm || {};
  const fireAt = Number(a.fireAt) || 0;
  const leadMinutes = clampLead(a.leadMinutes, fallbackLead == null ? DEFAULT_LEAD_MINUTES : fallbackLead);
  const completed = isCompleted(a);
  return Object.assign({}, a, {
    fireAt,
    leadMinutes,
    // remindAt 是派生值，不信任旧版本或手工写入的缓存值，避免后台推送错过新提醒时间。
    remindAt: calcRemindAt(fireAt, leadMinutes),
    type: normalizeType(a.type),
    title: normalizeTitle(a.title),
    completed,
    completedAt: completed ? (Number(a.completedAt) || 0) : 0,
    status: completed ? 'completed' : 'pending',
    alarmKey: a.alarmKey || makeAlarmKey(a),
  });
}

module.exports = {
  DEFAULT_LEAD_MINUTES,
  VALID_TYPES,
  clampLead,
  isCompleted,
  calcRemindAt,
  normalizeType,
  makeAlarmKey,
  normalizeAlarm,
};
