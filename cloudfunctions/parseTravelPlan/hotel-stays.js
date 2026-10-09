// 上传攻略的酒店条目只保存每天最终住宿的酒店/民宿，不把交通、餐饮、寄存行李混入住宿卡片。
function hotelName(item) {
  const values = [item.endLocation, item.activity, item.startLocation].map((v) => String(v || '').trim());
  let name = values.find((v) => /酒店|民宿|客栈|宾馆|别院/.test(v) && !/^(酒店|民宿|客栈|宾馆)$/.test(v)) || values[0] || '';
  name = name.replace(/^(?:入住|办理入住|返回|回到|回|前往|抵达|到达|住在|住进|打车前往|在)\s*/, '')
    .replace(/(?:办理入住|入住|睡觉|休息|放行李|寄存行李|取行李|吃饭|周边逛|附近.*).*$/, '')
    .replace(/[，。；,;].*$/, '').trim();
  if (/^(?:酒店|民宿|客栈|宾馆)(?:附近|周边)?$/.test(name)) return '';
  return name.slice(0, 60);
}

// 逐日原文比模型分类更能区分「路过/寄存」和「今晚实际住宿」。取当天最后一次
// 明确提到的具名酒店；“返回酒店”等泛称不用于覆盖前一天住宿。
function hotelFromDaySource(day) {
  const candidates = [];
  (day && day.lines || []).forEach((line) => {
    const re = /(?:前往|回到|返回|回|去|抵达|到达|入住|住在|住进)([^，。；\n]{2,70}?(?:酒店|别院|民宿|客栈|宾馆)(?:（[^）]{1,35}）)?)/g;
    let match;
    while ((match = re.exec(String(line))) !== null) {
      const name = hotelName({ endLocation: match[1] });
      if (name && /酒店|别院|民宿|客栈|宾馆/.test(name)) candidates.push(name);
    }
  });
  return candidates[candidates.length - 1] || '';
}

function cleanHotelStays(items, days) {
  const rows = Array.isArray(items) ? items : [];
  const best = new Map();
  rows.forEach((item, index) => {
    if (item.category !== 'hotel') return;
    const name = hotelName(item);
    if (!name) return;
    const activity = String(item.activity || '');
    const score = (/入住|住宿|睡觉|过夜|回.*休息/.test(activity) ? 10 : 0)
      + (/酒店|民宿|客栈|宾馆|别院/.test(name) ? 5 : 0) + index / 10000;
    const day = Number(item.dayIndex) || 0;
    if (!best.has(day) || best.get(day).score < score) best.set(day, { item, index, score, name });
  });
  const explicit = rows.reduce((out, item, index) => {
    if (item.category !== 'hotel') { out.push(item); return out; }
    const picked = best.get(Number(item.dayIndex) || 0);
    if (!picked || picked.index !== index) return out;
    out.push(Object.assign({}, item, {
      activity: `入住${picked.name}`,
      startLocation: '', endLocation: picked.name,
      note: '', bookingInfo: '', transportType: '',
      hotelBooked: picked.item.hotelBooked === true || /已(经)?(预订|预定|订好|确认)|已订|订妥|订单号/.test(
        [picked.item.activity, picked.item.note, picked.item.bookingInfo].join(' ')),
    }));
    return out;
  }, []);
  const maxDay = rows.reduce((value, item) => Math.max(value, Number(item.dayIndex) || 0), 0);
  const result = [];
  let previousHotel = '';
  let previousBooked = false;
  for (let day = 0; day <= maxDay; day++) {
    const dayRows = explicit.filter((item) => (Number(item.dayIndex) || 0) === day);
    result.push(...dayRows);
    const stay = dayRows.find((item) => item.category === 'hotel');
    if (stay) { previousHotel = stay.endLocation; previousBooked = !!stay.hotelBooked; continue; }
    if (!previousHotel || day >= maxDay || !dayRows.length) continue;
    if (dayRows.some((item) => /到家|回家|返家|返回家|抵达家/.test(String(item.activity || '')))) continue;
    const namedReturn = dayRows.find((item) => /(?:酒店|民宿|客栈|别院).*?(?:休息|睡觉|过夜)/.test(String(item.activity || '')));
    const name = namedReturn ? hotelName(namedReturn) || previousHotel : previousHotel;
    const booked = name === previousHotel && previousBooked;
    result.push({ dayIndex: day, startTime: '20:00', endTime: '',
      activity: `入住${name}`, category: 'hotel', startLocation: '', endLocation: name,
      note: '', bookingInfo: '', transportType: '', hotelBooked: booked });
    previousHotel = name;
    previousBooked = booked;
  }
  if (!Array.isArray(days) || !days.length) return result;
  const sourced = new Map(days.map((day) => [Number(day.index), hotelFromDaySource(day)]).filter(([, name]) => name));
  if (!sourced.size) return result;
  const byDay = new Map();
  result.forEach((item) => {
    const day = Number(item.dayIndex) || 0;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  });
  sourced.forEach((name, day) => {
    const old = byDay.get(day) || [];
    const matching = old.find((item) => item.category === 'hotel' && hotelName(item) === name);
    const withoutHotels = old.filter((item) => item.category !== 'hotel');
    withoutHotels.push(Object.assign({}, matching || {}, {
      dayIndex: day, startTime: matching && matching.startTime || '20:00', endTime: '',
      activity: `入住${name}`, category: 'hotel', startLocation: '', endLocation: name,
      note: '', bookingInfo: '', transportType: '', hotelBooked: !!(matching && matching.hotelBooked),
    }));
    byDay.set(day, withoutHotels);
  });
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, rows]) => rows);
}

module.exports = { hotelName, hotelFromDaySource, cleanHotelStays };
