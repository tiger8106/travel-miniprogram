// cloudfunctions/itinerary/index.js
// 行程 CRUD：save / get / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'trips';
const ITINERARY_VERSION = 'v1.4-booking-usage-sync';
const { synchronizeTrip, usageInfoForItem } = require('./booking-sync');

function bookingTypeForItem(item) {
  const it = item || {};
  if (it.category === 'hotel') return 'hotel';
  if (it.category === 'ticket' || /门票|预约|船票|游船|竹筏|漂流|索道|缆车/.test(String(it.activity || ''))) return 'ticket';
  if (it.category !== 'transport') return '';
  const text = `${it.transportType || ''} ${it.activity || ''}`;
  if (/plane|航班|飞机/.test(text)) return 'plane';
  if (/train|火车|列车|高铁|动车/.test(text)) return 'train';
  if (/bus|大巴|班车|直通车/.test(text)) return 'bus';
  return '';
}

function bookingInfoForItem(item) {
  const it = item || {};
  const type = bookingTypeForItem(it);
  const saved = String(it.bookingInfo || '').trim();
  if (type === 'hotel') return String(it.endLocation || saved || it.activity || '').trim();
  if (type === 'ticket') return String(it.activity || saved || it.endLocation || '').trim();
  if (['train', 'plane', 'bus'].includes(type)) {
    const route = [it.startLocation, it.endLocation].filter(Boolean).join('→');
    const code = String(it.activity || '').match(/\b[A-Z]{1,2}\d{1,5}\b/i);
    const times = [it.startTime, it.endTime].filter(Boolean).join('-');
    const live = [route, code && code[0], times].filter(Boolean).join(' ');
    return live || saved || String(it.activity || '').trim();
  }
  return saved;
}

function updateBookingTitle(title, previousInfo, nextInfo, type) {
  const old = String(title || '提醒');
  if (previousInfo && old.includes(previousInfo)) return old.replace(previousInfo, nextInfo).slice(0, 100);
  const m = old.match(/^(.{1,36}?[：:])/);
  const prefix = m ? m[1] : ({ hotel: '酒店预订：', ticket: '门票/预约：', train: '车票：', plane: '机票：', bus: '车票：' }[type] || '待办：');
  return `${prefix}${nextInfo}`.slice(0, 100);
}

/**
 * 酒店名称不是孤立的入住条目：下一天早餐/退房、跨天交通起点以及回酒店
 * 的活动文案都可能引用旧名称。行程页改酒店后，把同一份 items 里的关联文本
 * 一并替换，避免行程页、闹钟页和后续天数各显示一套酒店信息。
 */
function syncHotelReferencesInItems(oldItems, newItems) {
  const oldRows = Array.isArray(oldItems) ? oldItems : [];
  const nextRows = Array.isArray(newItems) ? newItems : [];
  const keyOf = (it, index) => String(it && (it.itemId || it.key || it._id || it.id) || `legacy-${index}`);
  const oldMap = new Map(oldRows.map((it, i) => [keyOf(it, i), it]));
  const changes = [];
  nextRows.forEach((next, index) => {
    if (!next || next.category !== 'hotel') return;
    const key = keyOf(next, index);
    const previous = oldMap.get(key) || (oldRows[index] && oldRows[index].category === 'hotel' ? oldRows[index] : null);
    if (!previous) return;
    const before = bookingInfoForItem(previous);
    const after = bookingInfoForItem(next);
    if (!before || !after || before === after) return;
    const aliases = [...new Set([before, previous.endLocation, previous.bookingInfo, previous.activity]
      .map((value) => String(value || '').trim())
      .filter((value) => value && value !== after))]
      .sort((a, b) => b.length - a.length);
    if (aliases.length) changes.push({ aliases, after });
  });
  if (!changes.length) return nextRows;
  const replace = (value) => {
    let out = String(value || '');
    changes.forEach(({ aliases, after }) => {
      aliases.forEach((alias) => { out = out.split(alias).join(after); });
    });
    return out;
  };
  return nextRows.map((item) => {
    if (!item) return item;
    const out = Object.assign({}, item);
    ['startLocation', 'endLocation', 'activity', 'note', 'bookingInfo'].forEach((field) => {
      if (out[field] === undefined || out[field] === null) return;
      const before = String(out[field]);
      const after = replace(before);
      if (after === before) return;
      out[field] = after;
      if (field === 'startLocation') { out.startLon = ''; out.startLat = ''; }
      if (field === 'endLocation') { out.endLon = ''; out.endLat = ''; }
    });
    return out;
  });
}

async function syncTripItemBookings(db, openid, tripId, oldItems, newItems, trip) {
  const alarmsRes = await db.collection('ticket_alarms').where({ _openid: openid, tripId }).limit(500).get();
  const alarms = alarmsRes.data || [];
  const oldRows = Array.isArray(oldItems) ? oldItems : [];
  const nextRows = Array.isArray(newItems) ? newItems : [];
  const keyOf = (it, index) => String(it && (it.itemId || it.key || it._id || it.id) || `legacy-${index}`);
  const oldMap = new Map(oldRows.map((it, i) => [keyOf(it, i), it]));
  const now = Date.now();
  const updates = [];
  nextRows.forEach((next, index) => {
    const key = keyOf(next, index);
    const previous = oldMap.get(key) || (oldRows[index] && Number(oldRows[index].dayIndex || 0) === Number(next.dayIndex || 0) ? oldRows[index] : null);
    if (!previous) return;
    const type = bookingTypeForItem(next) || bookingTypeForItem(previous);
    if (!type) return;
    const before = bookingInfoForItem(previous);
    const after = bookingInfoForItem(next);
    const dayChanged = Number(previous.dayIndex || 0) !== Number(next.dayIndex || 0);
    if (!after || (before === after && !dayChanged)) return;
    const sameDay = alarms.filter((a) => a.type === type
      && Number(a.dayIndex) === Number(next.dayIndex || 0));
    // itemId 是跨页面同步的稳定关联键。先全局匹配，避免用户调整行程日期后，
    // 闹钟仍停留在旧 dayIndex 而无法被更新；只有旧数据没有关联键时才按当天回退匹配。
    let linked = alarms.filter((a) => a.type === type
      && (a.linkedItemId === key || a.linkedItemId === String(next.itemId || '')));
    if (!linked.length && sameDay.length > 1 && before) {
      linked = sameDay.filter((a) => String(a.bookingInfo || a.title || '').includes(before));
    }
    if (!linked.length && sameDay.length === 1) linked = sameDay;
    linked.forEach((alarm) => {
      const title = updateBookingTitle(alarm.title, String(alarm.bookingInfo || before), after, type);
      const alarmKey = `${type}|${String(alarm.fireAtStr || '').slice(0, 10)}|${title.replace(/[\s\u3000]+/g, '')}`;
      updates.push(() => db.collection('ticket_alarms').doc(alarm._id).update({ data: {
        title,
        bookingInfo: after.slice(0, 160),
        usageInfo: usageInfoForItem(next, Object.assign({}, trip || {}, { items: nextRows })).slice(0, 180),
        linkedItemId: String(next.itemId || key).slice(0, 100),
        dayIndex: Number(next.dayIndex || 0),
        alarmKey,
        updatedAt: now,
      } }));
    });
  });
  for (let i = 0; i < updates.length; i += 20) await Promise.all(updates.slice(i, i + 20).map((run) => run()));
}

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
    safePatch.items = syncHotelReferencesInItems(cur.data.items || [], patch.items.slice(0, 500));
    Object.assign(safePatch, synchronizeTrip(cur.data, safePatch.items));
  }
  if (!Object.keys(safePatch).length) return { code: -1, msg: '没有可保存的修改' };
  safePatch.updatedAt = Date.now();
  await db.collection(COL).doc(tripId).update({ data: safePatch });
  if (patch.items !== undefined) {
    try {
      await syncTripItemBookings(db, openid, tripId, cur.data.items || [], safePatch.items, Object.assign({}, cur.data, { items: safePatch.items }));
    } catch (e) {
      console.error('[itinerary] 行程已保存，但关联待办同步失败:', e.message);
    }
  }
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
