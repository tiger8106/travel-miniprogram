// Two-way booking edit regression using the real cloud-function handlers and a tiny in-memory DB.
const assert = require('assert');
const Module = require('module');

const collections = {
  trips: [{
    _id: 'trip-1', _openid: 'user-1', sourceType: 'manual',
    items: [
      { itemId: 'train-1', dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 G101 次列车', startLocation: '成都东站', endLocation: '重庆北站', startTime: '08:00', endTime: '10:00' },
      { itemId: 'hotel-1', dayIndex: 0, category: 'hotel', activity: '入住成都原点酒店', endLocation: '成都原点酒店' },
      { itemId: 'hotel-breakfast-1', dayIndex: 1, category: 'food', activity: '在成都原点酒店吃早餐并出发', startLocation: '成都原点酒店', endLocation: '成都原点酒店', startTime: '07:00', endTime: '07:40' },
      { itemId: 'ticket-1', dayIndex: 0, category: 'ticket', activity: '预约德天瀑布门票', endLocation: '德天瀑布游客中心' },
    ],
  }],
  ticket_alarms: [
    { _id: 'alarm-train', _openid: 'user-1', tripId: 'trip-1', type: 'train', dayIndex: 0, linkedItemId: 'train-1', title: '车票：G101', bookingInfo: '成都东站→重庆北站 G101 08:00-10:00', fireAt: Date.now() + 3600000 },
    { _id: 'alarm-hotel', _openid: 'user-1', tripId: 'trip-1', type: 'hotel', dayIndex: 0, linkedItemId: 'hotel-1', title: '尽早确认酒店预订：成都原点酒店', bookingInfo: '成都原点酒店', fireAt: Date.now() + 3600000 },
    { _id: 'alarm-ticket', _openid: 'user-1', tripId: 'trip-1', type: 'ticket', dayIndex: 0, linkedItemId: 'ticket-1', title: '门票/预约：德天瀑布', bookingInfo: '德天瀑布门票', fireAt: Date.now() + 3600000 },
  ],
};

const copy = (value) => JSON.parse(JSON.stringify(value));
const db = {
  command: {},
  collection(name) {
    const rows = collections[name] || (collections[name] = []);
    return {
      doc(id) {
        return {
          async get() { return { data: copy(rows.find((row) => row._id === id) || null) }; },
          async update({ data }) {
            const row = rows.find((entry) => entry._id === id);
            if (!row) throw new Error(`missing ${name}/${id}`);
            Object.assign(row, copy(data));
            return { stats: { updated: 1 } };
          },
          async remove() {
            const index = rows.findIndex((row) => row._id === id);
            if (index >= 0) rows.splice(index, 1);
            return { stats: { removed: index >= 0 ? 1 : 0 } };
          },
        };
      },
      where(query) {
        const matches = () => rows.filter((row) => Object.keys(query || {}).every((key) => row[key] === query[key]));
        return {
          limit() { return this; },
          async get() { return { data: copy(matches()) }; },
          async remove() {
            const selected = new Set(matches());
            const remaining = rows.filter((row) => !selected.has(row));
            rows.splice(0, rows.length, ...remaining);
            return { stats: { removed: selected.size } };
          },
        };
      },
    };
  },
};

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  getWXContext() { return { OPENID: 'user-1' }; },
  database() { return db; },
};
const originalLoad = Module._load;
// Deployment copies must implement the same dependency propagation.
assert.strictEqual(require('fs').readFileSync(require.resolve('../cloudfunctions/itinerary/booking-sync'), 'utf8'),
  require('fs').readFileSync(require.resolve('../cloudfunctions/ticketAlarm/booking-sync'), 'utf8'));
for (const modulePath of ['../cloudfunctions/itinerary/booking-sync', '../cloudfunctions/ticketAlarm/booking-sync']) {
  const { synchronizeTrip } = require(modulePath);
  const original = { outline: { days: [{ hotel: '甲城旧酒店', moves: [
    { from: '甲站', to: '乙站', code: 'G100', startTime: '09:00', endTime: '11:00', schedSource: '12306' },
  ] }] }, items: [
    { itemId: 'access', dayIndex: 0, category: 'transport', transportType: 'bus', endLocation: '甲站', startTime: '08:00', endTime: '08:30' },
    { itemId: 'rail', dayIndex: 0, category: 'transport', transportType: 'train', startLocation: '甲站', endLocation: '乙站', startTime: '09:00', endTime: '11:00', activity: '乘G100次列车', bookingInfo: 'G100 09:00-11:00', schedSource: '12306' },
    { itemId: 'transfer', dayIndex: 0, category: 'transport', transportType: 'bus', startLocation: '乙站', endLocation: '景区', startTime: '11:00', endTime: '12:00' },
    { itemId: 'visit', dayIndex: 0, category: 'sight', startTime: '12:00', endTime: '14:00' },
    { itemId: 'fixed', dayIndex: 0, category: 'transport', transportType: 'train', startTime: '14:00', endTime: '16:00', schedSource: '12306' },
    { itemId: 'hotel', dayIndex: 0, category: 'hotel', endLocation: '甲城旧酒店', endLon: 100, endLat: 30, hotelPoiVerified: true },
  ] };
  const edited = copy(original.items);
  Object.assign(edited[1], { startLocation: '甲东站', endLocation: '乙西站', activity: '乘G200次列车', endTime: '12:00' });
  edited[5].endLocation = '甲城新酒店';
  const result = synchronizeTrip(original, edited);
  assert.strictEqual(result.items[0].endLocation, '甲东站');
  assert.strictEqual(result.items[2].startLocation, '乙西站');
  assert.strictEqual(result.items[2].endTime, '13:00');
  assert.strictEqual(result.items[3].endTime, '15:00');
  assert.strictEqual(result.items[4].startTime, '14:00');
  assert.match(result.items[4].note, /冲突/);
  assert.doesNotMatch(result.items[1].bookingInfo, /G100/);
  assert.strictEqual(result.items[1].schedSource, undefined);
  assert.strictEqual(result.outline.days[0].moves[0].to, '乙西站');
  assert.strictEqual(result.outline.days[0].hotel, '甲城新酒店');
  assert.strictEqual(result.items[5].hotelPoiVerified, false);
  assert.strictEqual(result.items[5].endLon, '');
  assert.strictEqual(original.items[2].startTime, '11:00', '同步不得修改原始快照');
}
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return originalLoad.call(this, request, parent, isMain);
};

const itinerary = require('../cloudfunctions/itinerary/index');
const ticketAlarm = require('../cloudfunctions/ticketAlarm/index');
Module._load = originalLoad;

(async () => {
  const trip = collections.trips[0];
  const edited = copy(trip.items);
  edited[0] = Object.assign({}, edited[0], { activity: '乘 G103 次列车', startTime: '08:30', endTime: '10:25', dayIndex: 1 });
  edited[1] = Object.assign({}, edited[1], { activity: '入住成都安悦酒店', endLocation: '成都安悦酒店' });
  edited[3] = Object.assign({}, edited[3], { activity: '预约德天瀑布实名门票' });
  assert.strictEqual((await itinerary.main({ action: 'update', tripId: 'trip-1', patch: { items: edited } })).code, 0);
  assert.match(collections.ticket_alarms.find((a) => a._id === 'alarm-train').bookingInfo, /G103.*08:30-10:25/);
  assert.strictEqual(collections.ticket_alarms.find((a) => a._id === 'alarm-train').dayIndex, 1);
  assert.match(collections.ticket_alarms.find((a) => a._id === 'alarm-hotel').bookingInfo, /成都安悦酒店/);
  assert.match(collections.ticket_alarms.find((a) => a._id === 'alarm-ticket').bookingInfo, /实名门票/);
  assert.strictEqual(collections.trips[0].items.find((item) => item.itemId === 'hotel-breakfast-1').startLocation, '成都安悦酒店');
  assert.strictEqual(collections.trips[0].items.find((item) => item.itemId === 'hotel-breakfast-1').endLocation, '成都安悦酒店');

  const dayOnly = copy(collections.trips[0].items);
  dayOnly[3] = Object.assign({}, dayOnly[3], { dayIndex: 2 });
  assert.strictEqual((await itinerary.main({ action: 'update', tripId: 'trip-1', patch: { items: dayOnly } })).code, 0);
  assert.strictEqual(collections.ticket_alarms.find((a) => a._id === 'alarm-ticket').dayIndex, 2);

  await ticketAlarm.main({ action: 'update', alarmId: 'alarm-train', patch: { bookingInfo: '成都东站→重庆西站 G129 10:20-12:40' } });
  await ticketAlarm.main({ action: 'update', alarmId: 'alarm-hotel', patch: { dayIndex: 2 } });
  assert.strictEqual(collections.trips[0].items.find((item) => item.itemId === 'hotel-1').dayIndex, 2);
  assert.strictEqual(collections.ticket_alarms.find((a) => a._id === 'alarm-hotel').dayIndex, 2);
  await ticketAlarm.main({ action: 'update', alarmId: 'alarm-hotel', patch: { bookingInfo: '成都锦庭酒店' } });
  await ticketAlarm.main({ action: 'update', alarmId: 'alarm-ticket', patch: { bookingInfo: '德天瀑布实名预约门票' } });
  const current = collections.trips[0].items;
  assert.strictEqual(current[0].startLocation, '成都东站');
  assert.strictEqual(current[0].endLocation, '重庆西站');
  assert.strictEqual(current[0].startTime, '10:20');
  assert.strictEqual(current[0].endTime, '12:40');
  assert.strictEqual(current[1].endLocation, '成都锦庭酒店');
  assert.strictEqual(current.find((item) => item.itemId === 'hotel-breakfast-1').startLocation, '成都锦庭酒店');
  assert.strictEqual(current.find((item) => item.itemId === 'hotel-breakfast-1').endLocation, '成都锦庭酒店');
  assert.match(current[3].activity, /德天瀑布实名预约门票/);
  console.log('通过：行程→闹钟与闹钟→行程双向同步了车次、酒店和门票信息（含车次路线及时刻）');
})().catch((error) => {
  console.error('购票提醒同步测试失败：', error);
  process.exitCode = 1;
});
