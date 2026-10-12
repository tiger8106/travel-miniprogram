// 离线回归：实际动作、免费范围、入住闭环；性能只测并发/调用数，不冒称线上提速。
const assert = require('assert');
const fs = require('fs');
const T = require('../cloudfunctions/generatePlan/ticket-products');
const P = require('../cloudfunctions/generatePlan/plan');
const A = require('../cloudfunctions/parseTravelPlan/alarm-infer');
const R = require('../cloudfunctions/generatePlan/execution-review');
const E = require('../cloudfunctions/generatePlan/route-evidence');
const L = require('../cloudfunctions/generatePlan/llm');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('✓ ' + name); };
const row = (activity, category, startTime, endTime, startLocation = '', endLocation = '', transportType = '') =>
  ({ activity, category, startTime, endTime, startLocation, endLocation, transportType, dayIndex: 0, note: '' });
const pier = { ...row('前往遇龙河竹筏码头', 'transport', '07:30', '08:00', '酒店', '水厄底码头', 'ride'),
  itemId: 'pier', note: '每天20:00抢第二天的票。', ticketProduct: '遇龙河竹筏票', ticketRequired: true };
const raft = { ...row('遇龙河竹筏漂流（水厄底至综合码头段）', 'sight', '08:00', '09:30', '水厄底码头', '综合码头'), itemId: 'raft' };
const lakes = { ...row('游览两江四湖', 'sight', '16:30', '18:30', '', '两江四湖'), itemId: 'lakes', note: '沿榕湖、杉湖走一下。' };
const countryside = { ...row('骑电动车游明仕田园：游客中心至竹筏码头', 'sight', '16:30', '17:00', '明仕游客中心', '明仕河竹筏码头'), itemId: 'cycle' };
const admission = (item, place) => ({ type: 'ticket', source: 'ai', linkedItemId: item.itemId,
  title: `${place}门票/预约核验`, bookingInfo: place, dayIndex: 0,
  reservationRequired: true, note: '收费政策未独立核实，不代表已确认收费' });
const policies = [{ place: '两江四湖', activity: lakes.activity, dayIndex: 0, ticketRequired: false,
  reservationRequired: false, sourceUrl: 'https://www.glljsh.com/category/164.html' }];
const profile = P.normalizeInput({ startDate: '2027-10-04', endDate: '2027-10-04' });
test('前往筏码头、骑行经过筏码头不是乘筏；明确复合乘观光车保留', () => {
  assert(T.ticketAccessOnly(pier)); assert(T.ticketAccessOnly(countryside));
  assert(!T.actualTicketExperience(pier)); assert(T.actualTicketExperience(raft));
  assert(T.actualTicketExperience(row('抵达甲山停车场，乘观光车到入口', 'transport')));
  assert(!T.actualTicketExperience(row('不乘坐竹筏，只散步', 'sight')));
});
test('已核查票务不能把含竹筏字样的接驳当作收费体验', () => {
  const facts = [{ place: '水厄底码头', product: '遇龙河竹筏票', ticketRequired: true,
    sourceUrl: 'https://www.ysylh.cn/' }];
  assert.equal(T.knownTicketProducts([pier], facts).length, 0);
  assert.equal(T.knownTicketProducts([pier, raft], facts)[0].item.itemId, 'raft');
});
test('精确20点筏票不被码头错误提名抢占，同产品只剩真实漂流提醒', () => {
  const precise = { type: 'ticket', title: '2027-10-04 遇龙河竹筏', source: 'parsed',
    linkedItemId: 'raft', dayIndex: 0, fireAt: Date.parse('2027-10-03T20:00:00+08:00'),
    fireAtStr: '2027-10-03 20:00', visitDate: '2027-10-04' };
  const wrong = { ...precise, linkedItemId: 'pier', ticketRequired: true, ticketProduct: '遇龙河竹筏票' };
  const result = A.completeReservationAlarms({ startDate: '2027-10-04', items: [pier, raft] }, [wrong, precise]);
  const tickets = result.filter((alarm) => alarm.type === 'ticket' && /竹筏|漂流/.test(alarm.title));
  assert.equal(tickets.length, 1); assert.equal(tickets[0].fireAtStr, precise.fireAtStr);
  assert.equal(tickets[0].linkedItemId, 'raft');
});
test('新攻略与上传均不为湖边散步、田园骑行补泛化门票', () => {
  const outline = { days: [{ date: '2027-10-04', highlights: [], ticketPolicies: policies }] };
  const items = [pier, raft, lakes, countryside];
  const generated = P.normalizeBookingAlarmKinds(P.linkBookingAlarms(P.backfillDetailAlarms(profile, outline, items, []), items), items, profile, policies);
  const uploaded = A.completeReservationAlarms({ startDate: '2027-10-04', items, ticketPolicies: policies }, []);
  for (const result of [generated, uploaded]) {
    assert(result.some((a) => a.type === 'ticket' && /竹筏|漂流/.test(a.title)));
    assert(!result.some((a) => a.type === 'ticket' && /两江四湖|明仕田园|前往遇龙河/.test(a.title)));
  }
});
test('免费散步政策不抹掉同区真实收费游船或免费需预约的景区', () => {
  const ship = { ...row('乘两江四湖夜游游船', 'sight', '19:00', '20:30', '文昌桥码头', '解放桥码头', 'ship'), itemId: 'ship' };
  const alarms = [admission(lakes, '两江四湖'), { ...admission(ship, '两江四湖'), title: '两江四湖夜游船票', ticketProduct: '两江四湖夜游船票', ticketRequired: true }];
  const result = T.filterTicketAlarms(alarms, [lakes, ship], policies);
  assert.equal(result.length, 1); assert.equal(result[0].linkedItemId, 'ship');
  const museum = { ...row('参观甲博物馆', 'sight', '10:00', '12:00', '', '甲博物馆'), itemId: 'museum' };
  assert.equal(T.filterTicketAlarms([admission(museum, '甲博物馆')], [museum], [{ ...policies[0], place: '甲博物馆', activity: museum.activity, reservationRequired: true }]).length, 1);
});
test('历史自动核验兼容过滤；手动事项、真实付费园林漫步不丢失', () => {
  assert.equal(T.filterTicketAlarms([admission(countryside, '明仕田园')], [countryside]).length, 0);
  assert.equal(T.filterTicketAlarms([{ ...admission(countryside, '明仕田园'), source: 'manual' }], [countryside]).length, 1);
  const paid = { ...lakes, activity: '甲园林漫步', note: '需购买门票', endLocation: '甲园林' };
  assert.equal(T.filterTicketAlarms([admission(paid, '甲园林')], [paid]).length, 1);
  assert.equal(T.normalizeTicketPolicies([{ ...policies[0], sourceUrl: 'https://example.com' }]).length, 0);
  assert(!T.freeAdmissionFor({ ...lakes, dayIndex: 1 }, policies));
});
test('无关联ID的泛化景区票按实际游览过滤，不受游客中心接驳干扰', () => {
  const move = row('乘车前往明仕田园风景区游客中心', 'transport', '16:00', '16:30', '酒店', '明仕田园风景区游客中心', 'bus');
  const alarm = { ...admission(countryside, '明仕田园风景区'), linkedItemId: '', source: 'rule' };
  assert.equal(T.filterTicketAlarms([alarm], [move, countryside]).length, 0);
});
const hotel = { ...row('入住甲酒店', 'hotel', '10:00', '10:30', '', '甲酒店'), itemId: 'hotel' };
const train = row('乘D1001到乙城', 'transport', '12:00', '13:00', '甲站', '乙站', 'train');
test('普通入住、办理入住后单向列车均须重排，重试耗尽也不发布矛盾候选', () => {
  for (const activity of ['入住甲酒店', '办理入住甲酒店', '入住后休息整理']) {
    const items = [{ ...hotel, activity }, train];
    assert(R.executionIssues(items, { hotel: '甲酒店' }).some((issue) => /入住后仍单向跨城/.test(issue)));
    const day = {};
    assert.equal(R.finalizeWithWarnings(items, 0, day, [], { hotel: '甲酒店' }).length, 0);
    assert(day.executionCandidate.length); assert(!day.executionReviewStatus);
  }
});
test('发布酒店名称规范不把具体寄存处降格为大纲码头，存取闭环仍通过', () => {
  const outline = { days: [{ hotel: '旧酒店' }, { hotel: '新酒店', moves: [{ from: '旧酒店', to: '甲码头' }] }] };
  const stored = { ...row('退房并前往甲码头寄存行李', 'transport', '08:00', '08:30', '旧酒店', '甲码头游客中心', 'ride'), dayIndex: 1 };
  const pickup = { ...row('取回寄存行李', 'other', '11:00', '11:15', '', '甲码头游客中心'), dayIndex: 1 };
  const cleaned = P.syncHotelReferences([stored, pickup], outline);
  assert.equal(cleaned[0].endLocation, '甲码头游客中心');
  assert(!R.executionIssues(cleaned, {}).some((issue) => /寄存行李未|取回地点/.test(issue)));
  const wrong = P.syncHotelReferences([{ ...stored, endLocation: '旧酒店' }], outline);
  assert.equal(wrong[0].endLocation, '甲码头', '错误酒店终点仍可根据明确退房去向纠正');
});
test('已确认的无寄存漂流与异地取件不可在重试耗尽后靠警示发布', () => {
  const items = [row('甲河竹筏漂流', 'sight', '09:00', '10:30', '甲码头', '乙码头'),
    row('取回寄存行李', 'other', '11:00', '11:30', '', '丙车站')];
  const day = {};
  assert.equal(R.finalizeWithWarnings(items, 0, day, [], { enforceRailSchedules: true }).length, 0);
  assert(day.executionCandidate.length); assert(day.executionReviewIssues.some((s) => /取回行李前没有/.test(s)));
});
test('先列车后入住、明确退房转城、基地真实往返均不误报', () => {
  const hasError = (items) => R.executionIssues(items, { hotel: '甲酒店' }).some((issue) => /入住后仍单向跨城/.test(issue));
  assert(!hasError([train, { ...hotel, startTime: '14:00', endTime: '14:30' }]));
  assert(!hasError([hotel, row('退房带走行李', 'hotel', '11:00', '11:30', '', '甲酒店'), train]));
  assert(!hasError([hotel, train, row('乘D1002返回甲城', 'transport', '17:00', '18:00', '乙站', '甲站', 'train'),
    row('返回甲酒店休息', 'hotel', '19:00', '20:00', '', '甲酒店')]));
});
test('只差固定铁路缓冲时整体提前准备链，不缩游览/交通，不动列车，开放/首日/太阳锁仍阻止', () => {
  const visit = row('参观甲馆', 'sight', '10:00', '11:00', '', '甲馆');
  const access = row('打车前往甲站', 'transport', '11:00', '11:25', '甲馆', '甲站', 'ride');
  const rail = row('乘D1001前往乙站', 'transport', '12:00', '13:00', '甲站', '乙站', 'train');
  const context = { hotel: '乙酒店', lightLuggage: true, enforceRailSchedules: true,
    official: [{ code: 'D1001', startLocation: '甲站', endLocation: '乙站', startTime: '12:00', endTime: '13:00' }] };
  const rest = row('回房休息', 'hotel', '20:00', '21:00', '', '乙酒店');
  const rows = [visit, access, rail, rest];
  const shifted = R.advanceFlexibleRailAccess(rows, context);
  assert.equal(shifted[0].startTime, '09:55'); assert.equal(shifted[0].endTime, '10:55');
  assert.equal(shifted[1].endTime, '11:20'); assert.equal(shifted[2].startTime, '12:00');
  assert.equal(R.executionIssues(shifted, context).length, 0); assert.equal(rows[0].startTime, '10:00');
  assert.strictEqual(R.advanceFlexibleRailAccess(rows, { ...context, isFirst: true }), rows);
  assert.strictEqual(R.advanceFlexibleRailAccess([{ ...visit, timingLocked: true }, access, rail, rest], context)[0].startTime, '10:00');
  const blocked = { ...context, visitWindows: [{ place: '甲馆', openTime: '10:00', sourceUrl: 'https://www.glljsh.com/' }] };
  assert.strictEqual(R.advanceFlexibleRailAccess(rows, blocked), rows);
});
test('批量日历组件、回调与死工具已移除，逐项日历回调保留', () => {
  const wxml = fs.readFileSync('miniprogram/pages/tickets/tickets.wxml', 'utf8');
  const js = fs.readFileSync('miniprogram/pages/tickets/tickets.js', 'utf8');
  assert(!/onSyncAllToCalendar|futureCount/.test(wxml + js));
  assert(/alarm\.addToCalendar/.test(js));
  assert(!/addAllToCalendar/.test(fs.readFileSync('miniprogram/utils/alarm.js', 'utf8')));
});

(async () => {
  const saved = { chat: L.chatWithRetry, points: E.collectRoutePoints, topology: E.collectRailTopology,
    roads: E.collectRoadTravelFacts, transits: E.collectUrbanTransitFacts };
  let ticketQueries = 0, audits = 0, concurrent = 0, peak = 0;
  try {
    E.collectRoutePoints = async () => ({}); E.collectRailTopology = async () => [];
    const nav = async () => { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 15)); concurrent--; return []; };
    E.collectRoadTravelFacts = nav; E.collectUrbanTransitFacts = nav;
    const visit = { ...row('甲河边散步', 'sight', '14:00', '15:00', '', '甲河'), itemId: 'visit' };
    const resting = row('回房休息', 'hotel', '20:00', '21:00', '', '甲酒店');
    const origin = row('从家出发', 'transport', '12:00', '13:00', '用户家', '甲酒店', 'ride');
    const day = { date: '2027-10-04', city: '甲城', overnight: '甲城', hotel: '甲酒店', highlights: [], moves: [] };
    L.chatWithRetry = async (messages, options) => {
      assert.equal(options.enableSearch, messages[0].content.includes('旅行票务') || messages[0].content.includes('运营知识'));
      assert(!options.maxTokens);
      if (messages[0].content.includes('旅行票务')) { ticketQueries++; return JSON.stringify({ ticketProducts: [], ticketPolicies: [{ ...policies[0], activity: visit.activity, place: '甲河' }] }); }
      if (messages[0].content.includes('运营知识')) return JSON.stringify({ routeFacts: [], scenicRoute: '市区短线', warnings: [] });
      audits++; return JSON.stringify({ items: [origin, visit, resting] });
    };
    const outline = { days: [day, { overnight: '返程' }] };
    const accepted = await R.reviewExecutionItems({ origin: '用户家', extra: '无大件行李' }, outline,
      [origin, visit, resting], Date.now() + 45000);
    assert(accepted.every((item) => item.executionReview === R.REVIEW_VERSION));
    assert.equal(audits, 1, '首次候选仍经过完整模型审计，不能为了提速跳过');
    assert.equal(peak, 2, '公路导航和市内公交核查独立并行');
    assert.equal(ticketQueries, 1); assert.equal(day.ticketPolicies.length, 1);
    const renamedOrigin = { ...origin, activity: '从家搭车出发', endLocation: '甲酒店大厅' };
    await R.reviewExecutionItems({ origin: '用户家', extra: '无大件行李' }, outline,
      [renamedOrigin, visit, resting], Date.now() + 45000);
    assert.equal(ticketQueries, 1, '接驳变化不重复查仍相同日期/范围/实际活动的票务');
    await R.reviewExecutionItems({ origin: '用户家', extra: '无大件行李' }, outline,
      [origin, { ...visit, activity: '参观甲河收费园区' }, resting], Date.now() + 45000);
    assert.equal(ticketQueries, 2, '同地点从散步改实际入园，即使体验关键词没变也必须重新查询');
    await R.reviewExecutionItems({ origin: '用户家', extra: '无大件行李' }, outline,
      [origin, { ...visit, activity: '乘甲河游船' }, resting], Date.now() + 45000);
    assert.equal(ticketQueries, 3, '实际活动变化必须使票务缓存失效');
    const baseChat = L.chatWithRetry;
    L.chatWithRetry = async (messages, options) => {
      if (messages[0].content.includes('旅行票务') || messages[0].content.includes('运营知识')) return baseChat(messages, options);
      audits++; assert.equal(options.enableSearch, false); return '{"acceptOriginal":true}';
    };
    const confirmed = await R.reviewExecutionItems({ origin: '用户家', extra: '无大件行李' }, outline,
      [origin, visit, resting], Date.now() + 45000);
    assert(confirmed.every((r) => r.executionReview === R.REVIEW_VERSION));
    assert.equal(confirmed.find((r) => r.category === 'sight').activity, visit.activity);
    const bad = await R.reviewExecutionItems({ origin: '用户家', extra: '无大件行李' }, outline,
      [origin, { ...visit, startTime: '12:15' }, resting], Date.now() + 45000);
    assert(!bad.every((r) => r.executionReview === R.REVIEW_VERSION), '模型确认也不能绕过时段重叠硬验收');
    passed++; console.log('✓ 同轮继续完整审计，导航并行且票务缓存按实际活动失效');
  } finally {
    L.chatWithRetry = saved.chat; E.collectRoutePoints = saved.points; E.collectRailTopology = saved.topology;
    E.collectRoadTravelFacts = saved.roads; E.collectUrbanTransitFacts = saved.transits;
  }
  console.log(`票务意图/入住时序/生成提速：${passed} 项通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
