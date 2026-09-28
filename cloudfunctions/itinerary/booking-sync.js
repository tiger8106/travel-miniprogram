// Shared deployment copy: itinerary/booking-sync.js and ticketAlarm/booking-sync.js.
const key = (row, index) => String(row && (row.itemId || row.key || row._id || row.id) || 'legacy-' + index);
const minute = (value) => /^\d{1,2}:\d{2}$/.test(String(value || ''))
  ? Number(value.split(':')[0]) * 60 + Number(value.split(':')[1]) : null;
const clock = (value) => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
const codeOf = (row) => (String(row && row.activity || '').match(/\b[A-Z]{1,2}\d{1,5}\b/i) || [''])[0];
const rail = (row) => row && row.category === 'transport' && /train|plane|火车|动车|高铁|航班|列车/.test((row.transportType || '') + ' ' + (row.activity || ''));
const infoOf = (row) => [[row.startLocation, row.endLocation].filter(Boolean).join('→'),
  codeOf(row), [row.startTime, row.endTime].filter(Boolean).join('-')].filter(Boolean).join(' ');
const typeOf = (row) => {
  const text = `${row && row.transportType || ''} ${row && row.activity || ''}`;
  if (row && row.category === 'hotel') return 'hotel';
  if ((row && row.category === 'ticket') || /门票|预约|船票|游船|竹筏|漂流|索道|缆车/.test(text)) return 'ticket';
  if (/plane|航班|飞机/.test(text)) return 'plane';
  if (/train|火车|动车|高铁|列车/.test(text)) return 'train';
  if (/bus|大巴|班车|直通车/.test(text)) return 'bus';
  return '';
};
const dateShift = (date, offset) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  const d = new Date(`${date}T00:00:00+08:00`);
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + Number(offset || 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const sameName = (a, b) => {
  const x = String(a || '').replace(/[\s市县区镇街道酒店民宿客栈宾馆]/g, '');
  const y = String(b || '').replace(/[\s市县区镇街道酒店民宿客栈宾馆]/g, '');
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
function dateForItem(row, trip) {
  const di = Number(row && row.dayIndex || 0);
  const outlineDay = trip && trip.outline && trip.outline.days && trip.outline.days[di];
  return String((outlineDay && outlineDay.date) || dateShift(trip && trip.startDate, di) || '').trim();
}
function usageInfoForItem(row, trip) {
  const it = row || {};
  const type = typeOf(it);
  const date = dateForItem(it, trip);
  const time = it.startTime ? `${it.startTime}${it.endTime ? `-${it.endTime}` : ''}` : '时段待核实';
  if (type === 'hotel') {
    const hotel = String(it.endLocation || it.bookingInfo || it.activity || '酒店').trim();
    let lastDay = Number(it.dayIndex || 0);
    const allItems = Array.isArray(trip && trip.items) ? trip.items : [];
    for (let i = lastDay + 1; i < (trip && trip.outline && trip.outline.days || []).length; i++) {
      const outlineDay = trip.outline.days[i] || {};
      const candidate = outlineDay.hotel || outlineDay.overnight || outlineDay.city;
      if (candidate && sameName(candidate, hotel)) lastDay = i;
      else break;
    }
    // 没有 outline 的旧行程，按连续同名酒店条目推断住宿区间。
    if (lastDay === Number(it.dayIndex || 0)) {
      for (let i = Number(it.dayIndex || 0) + 1; i < 32; i++) {
        const next = allItems.find((item) => Number(item && item.dayIndex || 0) === i && item.category === 'hotel');
        if (!next || !sameName(next.endLocation || next.bookingInfo, hotel)) break;
        lastDay = i;
      }
    }
    const checkout = dateForItem({ dayIndex: lastDay + 1 }, trip) || String(trip && trip.endDate || '').slice(0, 10);
    return `住宿：${date || '入住日期待核实'} 至 ${checkout || '退房日期待核实'}；${hotel}`.slice(0, 180);
  }
  if (type === 'train' || type === 'plane' || type === 'bus') {
    const route = [it.startLocation, it.endLocation].filter(Boolean).join('→');
    const code = codeOf(it);
    return `乘车日期：${date || '日期待核实'}；时间：${time}；${code || '班次待核实'}${route ? `；路线：${route}` : ''}`.slice(0, 180);
  }
  if (type === 'ticket') {
    const name = String(it.activity || it.bookingInfo || it.endLocation || '门票/体验').trim();
    return `使用时间：${date || '日期待核实'} ${time}；${name}`.slice(0, 180);
  }
  return date ? `关联日期：${date}${it.startTime ? ` ${time}` : ''}` : '';
}
function replaceLocation(row, field, before, after) {
  if (!before || !after || before === after || row[field] !== before) return;
  row[field] = after;
  row.activity = String(row.activity || '').split(before).join(after);
  row.note = String(row.note || '').split(before).join(after);
  const prefix = field === 'startLocation' ? 'start' : 'end';
  row[prefix + 'Lon'] = row[prefix + 'Lat'] = '';
}
function synchronizeTrip(trip, editedItems) {
  const oldRows = Array.isArray(trip.items) ? trip.items : [];
  const items = editedItems.map((row) => Object.assign({}, row));
  const oldByKey = new Map(oldRows.map((row, i) => [key(row, i), row]));
  const nextByKey = new Map(items.map((row, i) => [key(row, i), row]));
  const outline = trip.outline ? JSON.parse(JSON.stringify(trip.outline)) : null;
  items.forEach((next, index) => {
    const old = oldByKey.get(key(next, index));
    if (!old) return;
    const routeChanged = old.startLocation !== next.startLocation || old.endLocation !== next.endLocation;
    const timeChanged = old.startTime !== next.startTime || old.endTime !== next.endTime;
    const codeChanged = codeOf(old) !== codeOf(next);
    const dayChanged = Number(old.dayIndex || 0) !== Number(next.dayIndex || 0);
    if (next.category === 'hotel' && old.endLocation !== next.endLocation) {
      next.startLon = next.startLat = next.endLon = next.endLat = '';
      next.hotelPoiVerified = false;
      next.hotelPoiVerifiedName = next.hotelPoiAddress = next.hotelPoiSource = '';
      ((outline && outline.days) || []).forEach((day) => {
        if (day.hotel !== old.endLocation) return;
        day.hotel = next.endLocation;
        day.hotelPoiVerified = false;
        day.hotelPoiVerifiedName = day.hotelPoiAddress = day.hotelPoiSource = '';
        day.hotelSearchHint = next.endLocation;
        day.hotelRecommendationReason = '用户修改的酒店，请核对地址和预订信息。';
      });
    }
    if (next.category !== 'transport' || !(routeChanged || timeChanged || codeChanged || dayChanged)) return;
    if (rail(next)) next.bookingInfo = infoOf(next);
    delete next.schedSource;
    delete next.sched;
    next.scheduleRequired = !!rail(next);
    if (routeChanged) {
      next.startLon = next.startLat = next.endLon = next.endLat = '';
    }
    const ordered = oldRows.map((row, i) => ({ row, key: key(row, i) }))
      .filter(({ row }) => Number(row.dayIndex || 0) === Number(old.dayIndex || 0))
      .sort((a, b) => (minute(a.row.startTime) ?? 1440) - (minute(b.row.startTime) ?? 1440));
    const position = ordered.findIndex((entry) => entry.key === key(next, index));
    if (!dayChanged && position >= 0) {
      const before = ordered[position - 1];
      const after = ordered[position + 1];
      const previous = before && nextByKey.get(before.key);
      const following = after && nextByKey.get(after.key);
      if (previous && !rail(previous)) replaceLocation(previous, 'endLocation', old.startLocation, next.startLocation);
      if (following && !rail(following)) replaceLocation(following, 'startLocation', old.endLocation, next.endLocation);
      // Delay propagates through flexible following activities until slack or a
      // booked service absorbs it. Never invent a new time for a fixed service.
      let cursor = minute(next.endTime);
      for (const entry of ordered.slice(position + 1)) {
        const row = nextByKey.get(entry.key);
        if (!row || cursor === null) break;
        const start = minute(row.startTime), end = minute(row.endTime);
        if (start === null || end === null || start >= cursor) break;
        if (rail(row) || row.scheduleRequired || row.schedSource === '12306' || cursor + end - start >= 1440) {
          row.note = [row.note, '前段时间已修改，与本段衔接冲突，请重新确认班次或游玩安排。'].filter(Boolean).join('；');
          break;
        }
        row.startTime = clock(cursor);
        row.endTime = clock(cursor + Math.max(1, end - start));
        cursor = minute(row.endTime);
      }
    }
    if (outline) {
      const day = (outline.days || [])[Number(old.dayIndex || 0)];
      const move = day && (day.moves || []).find((m) => m.from === old.startLocation && m.to === old.endLocation);
      if (move) {
        Object.assign(move, { from: next.startLocation, to: next.endLocation,
          startTime: next.startTime, endTime: next.endTime, code: codeOf(next), scheduleRequired: !!rail(next) });
        delete move.schedSource;
        move.sched = [];
        if (dayChanged && (outline.days || [])[Number(next.dayIndex || 0)]) {
          day.moves = day.moves.filter((m) => m !== move);
          const target = outline.days[Number(next.dayIndex || 0)];
          target.moves = (target.moves || []).concat(move);
        }
      }
    }
  });
  return Object.assign({ items }, outline ? { outline } : {});
}
module.exports = { synchronizeTrip, usageInfoForItem };
