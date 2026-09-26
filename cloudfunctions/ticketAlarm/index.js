// cloudfunctions/ticketAlarm/index.js
// 抢票闹钟 CRUD：save / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'ticket_alarms';
const COL_TRIP = 'trips';
const ALARM_VERSION = 'v1.1-ownership-safe';

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
    .map((a) => ({
    _openid: openid,
    tripId,
    title: String(a.title || '提醒').slice(0, 100),
    note: String(a.note || '').slice(0, 500),
    fireAt: Number(a.fireAt) || 0,
    fireAtStr: String(a.fireAtStr || '').slice(0, 32),
    type: String(a.type || 'other').slice(0, 20),
    source: 'manual',
    createdAt: now,
    updatedAt: now,
    }));
  if (records.some((r) => !r.fireAt)) return { code: -1, msg: '提醒时间不合法' };
  // 先删除该行程下 source=manual 的，再批量插入（保持同步）
  // 这里采用追加：返回结果让前端合并
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
  return { code: 0, data: res.data };
}

async function update(db, openid, { alarmId, patch }) {
  if (!alarmId) return { code: -1, msg: '缺少 alarmId' };
  const cur = await db.collection(COL).doc(alarmId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  if (!patch || typeof patch !== 'object') return { code: -1, msg: '缺少修改内容' };
  const safePatch = {};
  if (patch.title !== undefined) safePatch.title = String(patch.title).slice(0, 100);
  if (patch.note !== undefined) safePatch.note = String(patch.note).slice(0, 500);
  if (patch.type !== undefined) safePatch.type = String(patch.type).slice(0, 20);
  if (patch.fireAt !== undefined) {
    const fireAt = Number(patch.fireAt);
    if (!isFinite(fireAt) || fireAt <= 0) return { code: -1, msg: '提醒时间不合法' };
    safePatch.fireAt = fireAt;
  }
  if (patch.fireAtStr !== undefined) safePatch.fireAtStr = String(patch.fireAtStr).slice(0, 32);
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
