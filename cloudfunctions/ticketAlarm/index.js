// cloudfunctions/ticketAlarm/index.js
// 抢票闹钟 CRUD：save / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'ticket_alarms';

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { code: -1, msg: '未登录' };

  const { action } = event || {};
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
  const now = Date.now();
  const records = (alarms || []).map((a) => ({
    _openid: openid,
    tripId,
    title: a.title,
    note: a.note || '',
    fireAt: a.fireAt,
    fireAtStr: a.fireAtStr || '',
    type: a.type || 'other',
    source: a.source || 'manual',
    createdAt: now,
    updatedAt: now,
  }));
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
  const safePatch = { ...patch, updatedAt: Date.now() };
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