// cloudfunctions/itinerary/index.js
// 行程 CRUD：save / get / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'trips';

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
        return await save(db, _, openid, event);
      case 'get':
        return await get(db, openid, event.tripId);
      case 'list':
        return await list(db, openid);
      case 'update':
        return await update(db, openid, event);
      case 'delete':
        return await del(db, openid, event);
      default:
        return { code: -1, msg: '未知 action: ' + action };
    }
  } catch (err) {
    console.error('[itinerary]', action, err);
    return { code: -1, msg: err.message || '操作失败' };
  }
};

async function save(db, _, openid, { payload }) {
  const now = Date.now();
  const data = {
    _openid: openid,
    title: payload.title || '我的行程',
    summary: payload.summary || '',
    startDate: payload.startDate || null,
    endDate: payload.endDate || null,
    sourceFileID: payload.sourceFileID || null,
    items: payload.items || [],
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection(COL).add({ data });
  return { code: 0, data: { tripId: res._id } };
}

async function get(db, openid, tripId) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const res = await db.collection(COL).doc(tripId).get();
  if (!res.data || res.data._openid !== openid) {
    return { code: -1, msg: '行程不存在' };
  }
  return { code: 0, data: res.data };
}

async function list(db, openid) {
  const res = await db.collection(COL)
    .where({ _openid: openid })
    .orderBy('updatedAt', 'desc')
    .limit(50)
    .get();
  return { code: 0, data: res.data };
}

async function update(db, openid, { tripId, patch }) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  // 鉴权
  const cur = await db.collection(COL).doc(tripId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  const safePatch = { ...patch, updatedAt: Date.now() };
  await db.collection(COL).doc(tripId).update({ data: safePatch });
  return { code: 0 };
}

async function del(db, openid, { tripId }) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const cur = await db.collection(COL).doc(tripId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  await db.collection(COL).doc(tripId).remove();
  // 级联删除关联闹钟和旅行建议
  await db.collection('ticket_alarms').where({ tripId }).remove().catch(() => {});
  await db.collection('suggestions').where({ tripId }).remove().catch(() => {});
  return { code: 0 };
}