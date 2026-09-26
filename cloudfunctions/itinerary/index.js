// cloudfunctions/itinerary/index.js
// 行程 CRUD：save / get / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'trips';
const ITINERARY_VERSION = 'v1.1-generation-guard';

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) return { code: -1, msg: '未登录' };

  const { action } = event || {};
  console.log('[itinerary] version=%s action=%s', ITINERARY_VERSION, action || '');
  const db = cloud.database();
  const _ = db.command;

  try {
    switch (action) {
      case 'save':
        return await save(db, _, openid, event);
      case 'get':
        return await get(db, openid, event.tripId);
      case 'list':
        return await list(db, openid, event);
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
  if (!payload || typeof payload !== 'object') return { code: -1, msg: '缺少行程内容' };
  const now = Date.now();
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 500) : [];
  const data = {
    _openid: openid,
    title: String(payload.title || '我的行程').slice(0, 60),
    summary: String(payload.summary || '').slice(0, 500),
    startDate: payload.startDate ? String(payload.startDate).slice(0, 20) : null,
    endDate: payload.endDate ? String(payload.endDate).slice(0, 20) : null,
    sourceFileID: payload.sourceFileID ? String(payload.sourceFileID).slice(0, 500) : null,
    items,
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

async function list(db, openid, event) {
  const res = await db.collection(COL)
    .where({ _openid: openid })
    .orderBy('updatedAt', 'desc')
    .limit(50)
    .get();
  const data = res.data || [];
  if (!(event && event.compact)) return { code: 0, data };

  // 列表页只需要摘要；首页传 fullTripId 时只把当前选中的那份 items 带回。
  // 多份长攻略不会再一起穿过云函数响应和 setData。
  const fullId = String((event && event.fullTripId) || '');
  const compact = data.map((t) => {
    const out = Object.assign({}, t);
    out.itemCount = Array.isArray(t.items) ? t.items.length : 0;
    if (t._id !== fullId) delete out.items;
    return out;
  });
  return { code: 0, data: compact };
}

async function update(db, openid, { tripId, patch }) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  // 鉴权
  const cur = await db.collection(COL).doc(tripId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  if (cur.data.sourceType === 'ai' && cur.data.genStatus && cur.data.genStatus !== 'done') {
    return { code: -1, msg: '行程仍在生成，请完成后再编辑' };
  }
  if (!patch || typeof patch !== 'object') return { code: -1, msg: '缺少修改内容' };
  // 客户端只能改行程展示字段，禁止借 update 接口篡改 _openid、生成状态、
  // 创建时间等系统字段。items 也设上限，避免异常请求把整份文档写爆。
  const safePatch = {};
  const textFields = { title: 60, summary: 500, region: 300, startDate: 20, endDate: 20 };
  Object.keys(textFields).forEach((key) => {
    if (patch[key] !== undefined && patch[key] !== null) {
      safePatch[key] = String(patch[key]).slice(0, textFields[key]);
    }
  });
  if (patch.items !== undefined) {
    if (!Array.isArray(patch.items)) return { code: -1, msg: 'items 格式不合法' };
    safePatch.items = patch.items.slice(0, 500);
  }
  if (!Object.keys(safePatch).length) return { code: -1, msg: '没有可保存的修改' };
  safePatch.updatedAt = Date.now();
  await db.collection(COL).doc(tripId).update({ data: safePatch });
  return { code: 0 };
}

async function del(db, openid, { tripId }) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const cur = await db.collection(COL).doc(tripId).get();
  if (!cur.data || cur.data._openid !== openid) {
    return { code: -1, msg: '无权操作' };
  }
  if (cur.data.genStatus === 'generating') {
    return { code: -1, msg: '行程正在生成，请完成后再删除' };
  }
  await db.collection(COL).doc(tripId).remove();
  // 级联删除关联闹钟和旅行建议
  await db.collection('ticket_alarms').where({ _openid: openid, tripId }).remove().catch(() => {});
  await db.collection('suggestions').where({ _openid: openid, tripId }).remove().catch(() => {});
  return { code: 0 };
}
