// cloudfunctions/ticketAlarm/index.js
// 抢票闹钟 CRUD：save / list / update / delete

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'ticket_alarms';
const COL_TRIP = 'trips';
const ALARM_VERSION = 'v1.5-single-reminder-usage';
const { synchronizeTrip, usageInfoForItem } = require('./booking-sync');
const {
  DEFAULT_LEAD_MINUTES,
  clampLead,
  calcRemindAt,
  normalizeAlarm,
  normalizeType,
  makeAlarmKey,
} = require('./alarm-model');

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

function updateBookingTitle(title, previousInfo, nextInfo, type) {
  const old = String(title || '提醒');
  if (previousInfo && old.includes(previousInfo)) return old.replace(previousInfo, nextInfo).slice(0, 100);
  const m = old.match(/^(.{1,36}?[：:])/);
  const prefix = m ? m[1] : ({ hotel: '酒店预订：', ticket: '门票/预约：', train: '车票：', plane: '机票：', bus: '车票：' }[type] || '待办：');
  return `${prefix}${nextInfo}`.slice(0, 100);
}

function applyBookingInfoToItem(item, info, type) {
  const value = String(info || '').trim().slice(0, 160);
  const next = Object.assign({}, item, { bookingInfo: value });
  if (type === 'hotel') {
    if (next.endLocation) next.endLocation = value.slice(0, 60);
    if (/入住|住宿|酒店/.test(String(next.activity || ''))) next.activity = `入住${value}`.slice(0, 200);
  } else if (type === 'ticket') {
    if (/门票|预约|购票|游船|竹筏|索道|缆车/.test(String(next.activity || ''))) next.activity = `预约/购票：${value}`.slice(0, 200);
  } else {
    const route = value.match(/^(.{2,30}?)[→>至-](.{2,30}?)(?:\s|$)/);
    if (route) {
      next.startLocation = route[1].trim();
      next.endLocation = route[2].trim().split(/\s+/)[0];
    }
    const timeRange = /(?:^|\s)(\d{1,2}:\d{2})\s*[-—–至~]\s*(\d{1,2}:\d{2})(?=$|[\s)）,，;；])/.exec(value);
    if (timeRange) {
      next.startTime = timeRange[1].padStart(5, '0');
      next.endTime = timeRange[2].padStart(5, '0');
    } else {
      const departure = /(?:发车|出发|起飞)?\s*(\d{1,2}:\d{2})/.exec(value);
      if (departure) next.startTime = departure[1].padStart(5, '0');
    }
    next.activity = `乘坐 ${value}`.slice(0, 200);
  }
  return next;
}

function syncHotelReferencesInTripItems(oldItems, newItems) {
  const oldRows = Array.isArray(oldItems) ? oldItems : [];
  const nextRows = Array.isArray(newItems) ? newItems : [];
  const keyOf = (it, index) => String(it && (it.itemId || it.key || it._id || it.id) || `legacy-${index}`);
  const oldMap = new Map(oldRows.map((it, i) => [keyOf(it, i), it]));
  const changes = [];
  nextRows.forEach((next, index) => {
    if (!next || next.category !== 'hotel') return;
    const previous = oldMap.get(keyOf(next, index))
      || (oldRows[index] && oldRows[index].category === 'hotel' ? oldRows[index] : null);
    if (!previous) return;
    const before = String(previous.endLocation || previous.bookingInfo || previous.activity || '').trim();
    const after = String(next.endLocation || next.bookingInfo || next.activity || '').trim();
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
    changes.forEach(({ aliases, after }) => aliases.forEach((alias) => {
      out = out.split(alias).join(after);
    }));
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

async function syncAlarmBookingToTrip(db, openid, alarm, info, type, dayIndex) {
  if (!alarm || !alarm.tripId || !info || !['train', 'plane', 'bus', 'ticket', 'hotel'].includes(type)) return null;
  const tripRes = await db.collection(COL_TRIP).doc(alarm.tripId).get();
  const trip = tripRes && tripRes.data;
  if (!trip || trip._openid !== openid || !Array.isArray(trip.items)) return null;
  let index = alarm.linkedItemId
    ? trip.items.findIndex((it) => String(it && it.itemId || '') === String(alarm.linkedItemId))
    : -1;
  if (index < 0 && Number.isInteger(Number(alarm.dayIndex))) {
    const candidates = trip.items.map((it, i) => ({ it, i }))
      .filter((row) => Number(row.it && row.it.dayIndex || 0) === Number(alarm.dayIndex)
        && bookingTypeForItem(row.it) === type);
    if (candidates.length === 1) index = candidates[0].i;
  }
  if (index < 0) return null;
  const items = trip.items.slice();
  items[index] = applyBookingInfoToItem(items[index], info, type);
  if (dayIndex !== undefined && Number.isInteger(Number(dayIndex))) {
    items[index].dayIndex = Number(dayIndex);
  }
  const syncedItems = type === 'hotel'
    ? syncHotelReferencesInTripItems(trip.items, items)
    : items;
  const synchronized = synchronizeTrip(trip, syncedItems);
  await db.collection(COL_TRIP).doc(alarm.tripId).update({ data: { ...synchronized, updatedAt: Date.now() } });
  return synchronized.items[index];
}

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
        dayIndex: Number.isInteger(Number(a.dayIndex)) ? Number(a.dayIndex) : undefined,
        bookingInfo: String(a.bookingInfo || '').slice(0, 160),
        usageInfo: String(a.usageInfo || '').slice(0, 180),
        linkedItemId: String(a.linkedItemId || '').slice(0, 100),
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
  const tripRes = tripId ? await db.collection(COL_TRIP).doc(tripId).get().catch(() => null) : null;
  const trip = tripRes && tripRes.data;
  return {
    code: 0,
    data: (res.data || []).map((a) => {
      const tripItems = trip && Array.isArray(trip.items) ? trip.items : [];
      let linked = a.linkedItemId
        ? tripItems.find((item) => String(item && item.itemId || '') === String(a.linkedItemId))
        : null;
      if (!linked) {
        const sameDay = tripItems.filter((item) => Number(item && item.dayIndex || 0) === Number(a.dayIndex || 0)
          && bookingTypeForItem(item) === a.type);
        const bookingText = String(a.bookingInfo || '').trim();
        const textMatches = bookingText
          ? sameDay.filter((item) => `${item.activity || ''} ${item.bookingInfo || ''} ${item.startLocation || ''} ${item.endLocation || ''}`.includes(bookingText))
          : [];
        linked = textMatches.length === 1 ? textMatches[0] : (sameDay.length === 1 ? sameDay[0] : null);
      }
      const usageInfo = String(a.usageInfo || '').trim()
        || (linked ? usageInfoForItem(linked, trip) : '');
      return normalizeAlarm(Object.assign({}, a, usageInfo ? { usageInfo } : {}), DEFAULT_LEAD_MINUTES);
    }),
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
  if (patch.bookingInfo !== undefined) safePatch.bookingInfo = String(patch.bookingInfo).trim().slice(0, 160);
  if (patch.usageInfo !== undefined) safePatch.usageInfo = String(patch.usageInfo).trim().slice(0, 180);
  if (patch.dayIndex !== undefined && Number.isInteger(Number(patch.dayIndex))) safePatch.dayIndex = Number(patch.dayIndex);
  if (patch.linkedItemId !== undefined) safePatch.linkedItemId = String(patch.linkedItemId).slice(0, 100);
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
  const shouldSyncTrip = (patch.bookingInfo !== undefined && safePatch.bookingInfo)
    || (patch.dayIndex !== undefined && current.bookingInfo);
  if (shouldSyncTrip) {
    const nextType = safePatch.type || current.type;
    try {
      const linkedItem = await syncAlarmBookingToTrip(
        db, openid, current, safePatch.bookingInfo || current.bookingInfo, nextType,
        safePatch.dayIndex !== undefined ? safePatch.dayIndex : undefined,
      );
      if (linkedItem) {
        safePatch.linkedItemId = String(linkedItem.itemId || current.linkedItemId || '').slice(0, 100);
        safePatch.dayIndex = Number(linkedItem.dayIndex || 0);
        const trip = await db.collection(COL_TRIP).doc(current.tripId).get().catch(() => null);
        if (trip && trip.data) safePatch.usageInfo = usageInfoForItem(linkedItem, Object.assign({}, trip.data, { items: trip.data.items || [] })).slice(0, 180);
      }
      if (patch.bookingInfo !== undefined && patch.title === undefined) {
        safePatch.title = updateBookingTitle(current.title, String(current.bookingInfo || ''), safePatch.bookingInfo, nextType);
        safePatch.alarmKey = makeAlarmKey(Object.assign({}, current, safePatch));
      }
    } catch (e) {
      console.error('[ticketAlarm] 闹钟已保留新信息，关联行程同步失败:', e.message);
    }
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
