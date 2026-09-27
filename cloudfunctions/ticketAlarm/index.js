// cloudfunctions/ticketAlarm/index.js
// 抢票闹钟 CRUD：save / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'ticket_alarms';
const COL_TRIP = 'trips';
const ALARM_VERSION = 'v1.2-stateful-reminders';
const {
  DEFAULT_LEAD_MINUTES,
  clampLead,
  calcRemindAt,
  normalizeAlarm,
  normalizeType,
  makeAlarmKey,
} = require('./alarm-model');

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { code: -1, msg: '未登录' };

  const { action } = event || {};
  console.log('[ticketAlarm] version=%s action=%s', ALARM_VERSION, action || '');
  const db = cloud.database();
  const _ = db.command;

  try {
    switch (action) {
      case 'save':
        return await save(db, openid, event);
      case 'list':
        return await list(db, openid, event.tripId);
      case 'setAdvance':
        return await setAdvance(db, openid, event);
      case 'update':
        return await update(db, openid, event);
      case 'delete':
        return await del(db, openid, event);
      default:
        return { code: -1, msg: '未知 action: ' + action };
    }
  } catch (err) {
    console.error('[ticketAlarm]', action, err);
    return { code: -1, msg: err.message || '操作失败' };
  }
};

/**
 * 批量保存（前端添加闹钟时）
 */
async function save(db, openid, { tripId, alarms }) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const trip = await db.collection(COL_TRIP).doc(tripId).get().catch(() => null);
  if (!trip || !trip.data || trip.data._openid !== openid) {
    return { code: -1, msg: '行程不存在或无权操作' };
  }
  const now = Date.now();
  const records = (Array.isArray(alarms) ? alarms : []).slice(0, 50)
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const fireAt = Number(a.fireAt) || 0;
      const leadMinutes = clampLead(a.leadMinutes, DEFAULT_LEAD_MINUTES);
      return {
        _openid: openid,
        tripId,
        title: String(a.title || '提醒').slice(0, 100),
        note: String(a.note || '').slice(0, 500),
        fireAt,
        fireAtStr: String(a.fireAtStr || '').slice(0, 32),
        leadMinutes,
        remindAt: calcRemindAt(fireAt, leadMinutes),
        completed: false,
        completedAt: 0,
        status: 'pending',
        alarmKey: makeAlarmKey({ ...a, fireAt, fireAtStr: a.fireAtStr }),
        type: normalizeType(a.type),
        source: 'manual',
        notified: false,
        createdAt: now,
        updatedAt: now,
      };
    });
  if (records.some((r) => !r.fireAt)) return { code: -1, msg: '提醒时间不合法' };
  // 手动保存采用追加语义；前端每次只传新事项，不能覆盖已有分类记录。
  const ids = [];
  for (const r of records) {
    const res = await db.collection(COL).add({ data: r });
    ids.push(res._id);
  }
  return { code: 0, data: { ids } };
}

async function list(db, openid, tripId) {
  const where = { _openid: openid };
  if (tripId) where.tripId = tripId;
  const res = await db.collection(COL)
    .where(where)
    .orderBy('fireAt', 'asc')
    .limit(200)
    .get();
  return {
    code: 0,
    data: (res.data || []).map((a) => normalizeAlarm(a, DEFAULT_LEAD_MINUTES)),
  };
}

/** 用户修改“提前几分钟提醒”时，统一更新本行程的事项。完成项也保存这个偏好，恢复待办时仍按新设置计算。 */
async function setAdvance(db, openid, { tripId, minutes }) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const trip = await db.collection(COL_TRIP).doc(tripId).get().catch(() => null);
  if (!trip || !trip.data || trip.data._openid !== openid) {
    return { code: -1, msg: '行程不存在或无权操作' };
  }
  const leadMinutes = clampLead(minutes, DEFAULT_LEAD_MINUTES);
  const rows = await db.collection(COL).where({ _openid: openid, tripId }).limit(500).get();
  const now = Date.now();
  let updated = 0;
  for (let i = 0; i < (rows.data || []).length; i += 20) {
    const batch = rows.data.slice(i, i + 20).map((a) => db.collection(COL).doc(a._id).update({
      data: {
        leadMinutes,
        remindAt: calcRemindAt(a.fireAt, leadMinutes),
        updatedAt: now,
      },
    }).then(() => { updated += 1; }));
    await Promise.all(batch);
  }
  return { code: 0, data: { tripId, leadMinutes, updated } };
}

async function update(db, openid, { alarmId, patch }) {
  if (!alarmId) return { code: -1, msg: '缺少 alarmId' };
  const cur = await db.collection(COL).doc(alarmId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  if (!patch || typeof patch !== 'object') return { code: -1, msg: '缺少修改内容' };
  const safePatch = {};
  const current = normalizeAlarm(cur.data, DEFAULT_LEAD_MINUTES);
  if (patch.title !== undefined) safePatch.title = String(patch.title).slice(0, 100);
  if (patch.note !== undefined) safePatch.note = String(patch.note).slice(0, 500);
  if (patch.type !== undefined) safePatch.type = normalizeType(patch.type);
  if (patch.fireAt !== undefined) {
    const fireAt = Number(patch.fireAt);
    if (!isFinite(fireAt) || fireAt <= 0) return { code: -1, msg: '提醒时间不合法' };
    safePatch.fireAt = fireAt;
  }
  if (patch.fireAtStr !== undefined) safePatch.fireAtStr = String(patch.fireAtStr).slice(0, 32);
  if (patch.leadMinutes !== undefined) {
    safePatch.leadMinutes = clampLead(patch.leadMinutes, current.leadMinutes);
  }
  if (patch.completed !== undefined) {
    const completed = patch.completed === true || patch.completed === 1 || patch.completed === 'true';
    safePatch.completed = completed;
    safePatch.completedAt = completed ? Date.now() : 0;
    safePatch.status = completed ? 'completed' : 'pending';
  }
  const nextFireAt = safePatch.fireAt !== undefined ? safePatch.fireAt : current.fireAt;
  const nextLead = safePatch.leadMinutes !== undefined ? safePatch.leadMinutes : current.leadMinutes;
  if (safePatch.fireAt !== undefined || safePatch.leadMinutes !== undefined) {
    safePatch.remindAt = calcRemindAt(nextFireAt, nextLead);
  }
  if (safePatch.title !== undefined || safePatch.type !== undefined
      || safePatch.fireAt !== undefined || safePatch.fireAtStr !== undefined) {
    safePatch.alarmKey = makeAlarmKey(Object.assign({}, current, safePatch));
  }
  if (!Object.keys(safePatch).length) return { code: -1, msg: '没有可保存的修改' };
  safePatch.updatedAt = Date.now();
  await db.collection(COL).doc(alarmId).update({ data: safePatch });
  return { code: 0 };
}

async function del(db, openid, { alarmId }) {
  if (!alarmId) return { code: -1, msg: '缺少 alarmId' };
  const cur = await db.collection(COL).doc(alarmId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  await db.collection(COL).doc(alarmId).remove();
  return { code: 0 };
}
