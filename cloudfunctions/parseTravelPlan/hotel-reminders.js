const { parseCnTime, tsToCnDateTimeStr, tsToDateStr } = require('./cn-time');
const DAY_MS = 86400000;

function bookingPrecaution(booking, name) {
  const lines = Array.isArray(booking) ? booking.map((line) => String(line || '').trim()) : [];
  const at = lines.findIndex((line) => line === name);
  if (at < 0) return '';
  const following = [];
  for (let i = at + 1; i < Math.min(lines.length, at + 12); i++) {
    if (/^\d{1,2}月\d{1,2}|^3\.\d|^酒店预订优先级/.test(lines[i])) break;
    if (lines[i]) following.push(lines[i]);
  }
  const note = following.reverse().find((line) => /确认|询问|提前|尽量|连住|避免|避开|方便|注意|预留|核对/.test(line)) || '';
  return note.split(name).join('').slice(0, 180);
}

function groupHotelReminders(alarms, items, startDate, now = Date.now(), booking) {
  const grouped = new Map();
  (items || []).filter((item) => item.category === 'hotel').forEach((item) => {
    const name = String(item.endLocation || '').trim();
    if (!name || /^(酒店|民宿|客栈|宾馆|住宿)$/.test(name)) return;
    const day = Number(item.dayIndex) || 0;
    const date = tsToDateStr(parseCnTime(`${startDate}T00:00:00`) + day * DAY_MS);
    if (!grouped.has(name)) grouped.set(name, { name, dates: new Set(), booked: true, dayIndex: day });
    const group = grouped.get(name);
    group.dates.add(date);
    group.booked = group.booked && item.hotelBooked === true;
    group.dayIndex = Math.min(group.dayIndex, day);
  });
  const hotelAlarms = [...grouped.values()].map((group) => {
    const dates = [...group.dates].sort();
    const stays = dates.map((date) => {
      const checkout = tsToDateStr(parseCnTime(`${date}T00:00:00`) + DAY_MS);
      return `${date}入住、${checkout}退房`;
    }).join('；');
    const checkIn = parseCnTime(`${dates[0]}T14:00:00`);
    const fireAt = group.booked || checkIn <= now ? checkIn : now + 5 * 60000;
    return {
      title: group.name,
      note: `住宿时间：${stays}；${group.booked ? '已预订，请核对订单、地址与入住要求。' : '待预订，请核对位置、房型与退改规则。'}${bookingPrecaution(booking, group.name) ? `其他注意事项：${bookingPrecaution(booking, group.name)}` : ''}`,
      fireAt, fireAtStr: tsToCnDateTimeStr(fireAt),
      type: 'hotel', source: 'rule', dayIndex: group.dayIndex,
      bookingInfo: group.name, completed: fireAt < now,
    };
  });
  return (alarms || []).filter((alarm) => alarm.type !== 'hotel').concat(hotelAlarms);
}

module.exports = { groupHotelReminders, bookingPrecaution };
