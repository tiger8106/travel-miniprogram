const assert = require('assert');
const { cleanHotelStays } = require('../cloudfunctions/parseTravelPlan/hotel-stays');
const { groupHotelReminders } = require('../cloudfunctions/parseTravelPlan/hotel-reminders');
const { canonicalHotelReminders } = require('../cloudfunctions/generatePlan/plan');

const rows = [
  { dayIndex: 0, category: 'hotel', activity: '19:50打车前往梵泊美地酒店（桂林两江四湖象鼻山景区店）放行李', endLocation: '梵泊美地酒店（桂林两江四湖象鼻山景区店）', note: '打车约27分钟' },
  { dayIndex: 0, category: 'hotel', activity: '回梵泊美地酒店（桂林两江四湖象鼻山景区店）睡觉', endLocation: '梵泊美地酒店（桂林两江四湖象鼻山景区店）', note: '沿正阳步行街返回' },
  { dayIndex: 0, category: 'food', activity: '吃桂林米粉' },
  { dayIndex: 1, category: 'hotel', activity: '在民宿露台吃饭', endLocation: '民宿' },
  { dayIndex: 1, category: 'hotel', activity: '入住龙脊别院（西山韶乐店）', endLocation: '龙脊别院（西山韶乐店）', note: '已预订；观光车后步行' },
  { dayIndex: 2, category: 'other', activity: '回龙脊别院（西山韶乐店）休息' },
  { dayIndex: 3, category: 'transport', activity: '返回家中' },
];
const result = cleanHotelStays(rows);
const hotels = result.filter((row) => row.category === 'hotel');
assert.strictEqual(hotels.length, 3);
assert.deepStrictEqual(hotels.map((row) => row.endLocation), [
  '梵泊美地酒店（桂林两江四湖象鼻山景区店）', '龙脊别院（西山韶乐店）', '龙脊别院（西山韶乐店）',
]);
assert(hotels.every((row) => row.note === '' && row.bookingInfo === '' && row.startLocation === ''));
assert(hotels[1].hotelBooked && hotels[2].hotelBooked, '已订状态应随连续入住保留，但干扰备注不进酒店卡片');
assert.strictEqual(result.filter((row) => row.category === 'food').length, 1);
assert(cleanHotelStays([{ dayIndex: 0, category: 'hotel', activity: '入住甲城栖云酒店',
  endLocation: '甲城栖云酒店', hotelBooked: true }])[0].hotelBooked,
  '模型已判定预订且原备注被清理时仍要保留已订状态');
console.log('✅ Word 酒店示例：每天仅保留实际住宿名称，清除交通/餐饮/寄存备注');

const dates = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
const source = [
  ['前往甲城栖云酒店办理入住。', '回甲城栖云酒店睡觉。'],
  ['打车前往乙城接驳酒店乘车。', '回乙城青山别院休息。'],
  ['回乙城青山别院取行李。', '返回甲城栖云酒店睡觉。'],
  ['返回家中。'],
].map((lines, index) => ({ index, date: dates[index], lines }));
const confused = [0, 1, 2].map((dayIndex) => ({ dayIndex, category: 'hotel',
  activity: '入住错误酒店', endLocation: '错误酒店' }));
const sourced = cleanHotelStays(confused, source).filter((item) => item.category === 'hotel');
assert.deepStrictEqual(sourced.map((item) => item.endLocation), ['甲城栖云酒店', '乙城青山别院', '甲城栖云酒店']);
const reminders = groupHotelReminders([], sourced, dates[0], Date.parse('2026-09-01T00:00:00Z'));
assert.strictEqual(reminders.length, 2, '非连续入住同一酒店只建一条提醒');
assert.strictEqual(reminders[0].title, '甲城栖云酒店');
assert(/2026-09-30入住、2026-10-01退房/.test(reminders[0].note));
assert(/2026-10-02入住、2026-10-03退房/.test(reminders[0].note));
assert(!reminders[0].note.includes('甲城栖云酒店'), '备注不重复酒店名称');
const generated = canonicalHotelReminders([], { days: [
  { date: dates[0], hotel: '甲城栖云酒店' }, { date: dates[1], hotel: '乙城青山别院' },
  { date: dates[2], hotel: '甲城栖云酒店' }, { date: dates[3], hotel: '' },
] });
assert.strictEqual(generated.filter((a) => a.type === 'hotel').length, 2);
assert.strictEqual(generated[0].title, '甲城栖云酒店');
assert(!generated[0].note.includes('甲城栖云酒店'));
console.log('✅ 上传/新建酒店提醒统一：仅酒店名作标题，多晚归并，备注列完整入住退房日期');
