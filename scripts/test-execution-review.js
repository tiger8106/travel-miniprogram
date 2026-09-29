// 执行复核的通用回归；只使用虚拟地名，不把测试线路答案写进生产规则。
const assert = require('assert');
const llm = require('../cloudfunctions/generatePlan/llm');
const R = require('../cloudfunctions/generatePlan/execution-review');
const P = require('../cloudfunctions/generatePlan/plan');
const E = require('../cloudfunctions/generatePlan/route-evidence');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
const row = (startTime, endTime, category, activity, startLocation = '', endLocation = '', transportType = '') =>
  ({ dayIndex: 0, startTime, endTime, category, activity, startLocation, endLocation, transportType, note: '' });
const room = row('20:00', '21:00', 'other', '回房休息', '', '甲城晨光酒店');
test('长途包车离开父景区后不把新目的地游览冒充旧景区覆盖', () => {
  const normalized = R.normalizeReviewRows([
    row('06:00', '07:00', 'sight', '观赏晨景', '', '甲山观景台'),
    row('09:00', '11:30', 'transport', '乘包车前往乙镇', '甲山停车场', '乙镇码头', 'car'),
    row('13:00', '14:00', 'sight', '游览乙镇', '', '乙镇古街'),
  ], 1, { scopeCandidates: ['甲山'] });
  assert.equal(normalized[0].visitScope, '甲山');
  assert(!normalized[2].visitScope);
});
test('同日三段列车逐段补票，普通公交不生成预购车票提醒', () => {
  const profile = P.normalizeInput({ startDate: '2026-12-20', endDate: '2026-12-21' });
  const outline = { days: [{ date: profile.startDate, highlights: [], moves: [
    { from: '甲城站', to: '乙城站', mode: 'train' },
    { from: '乙城站', to: '丙城站', mode: 'train' },
    { from: '丙城站', to: '甲城站', mode: 'train' },
    { from: '甲城站', to: '甲城酒店', mode: 'bus', bookingRequired: false },
  ] }, { date: profile.endDate, highlights: [], moves: [], overnight: '返程' }] };
  const alarms = P.fallbackAlarms(profile, outline);
  assert.equal(alarms.filter((a) => a.type === 'train').length, 3);
  assert(!alarms.some((a) => a.type === 'bus'));
});
test('站字别名、车次和往返方向能正确绑定使用时间', () => {
  const items = [
    Object.assign(row('09:00', '10:00', 'transport', '乘 D123 动车', '甲城站', '乙城站', 'train'), { itemId: 'go' }),
    Object.assign(row('18:00', '19:00', 'transport', '乘 D456 动车', '乙城站', '甲城站', 'train'), { itemId: 'back' }),
  ];
  const alarms = P.linkBookingAlarms([
    { type: 'train', dayIndex: 0, bookingInfo: '甲城→乙城 D123' },
    { type: 'train', dayIndex: 0, bookingInfo: '乙城→甲城' },
  ], items);
  assert.equal(alarms[0].linkedItemId, 'go'); assert.equal(alarms[1].linkedItemId, 'back');
});
test('多个观景点共用一张景区提醒，已取消的可选点不留下门票', () => {
  const items = ['甲观景台', '乙观景台'].map((name, i) => Object.assign(
    row(`${10 + i}:00`, `${11 + i}:00`, 'sight', `游览${name}`, '', name),
    { itemId: `point-${i}`, visitScope: '晨光梯田' }));
  const alarms = P.dedupeBookingAlarmRecords(P.linkBookingAlarms([
    { type: 'ticket', dayIndex: 0, bookingInfo: '甲观景台', title: '甲观景台门票/预约放票' },
    { type: 'ticket', dayIndex: 0, bookingInfo: '乙观景台', title: '乙观景台门票/预约放票' },
    { type: 'ticket', dayIndex: 0, bookingInfo: '可选温泉', title: '可选温泉门票/预约放票' },
  ], items));
  assert.equal(alarms.length, 1); assert.equal(alarms[0].bookingInfo, '晨光梯田');
});
test('乘坐竹筏和游船是真正的票务体验，不按普通打车接驳过滤', () => {
  const items = ['乘坐人工竹筏漂流', '乘坐四星级游船'].map((activity, i) => Object.assign(
    row(`${10 + i}:00`, `${11 + i}:00`, 'sight', activity), { itemId: `experience-${i}` }));
  const alarms = items.map((it) => ({ type: 'ticket', dayIndex: 0, title: `预约${it.activity}`, linkedItemId: it.itemId }));
  assert.equal(P.normalizeBookingAlarmKinds(alarms, items).length, 2);
});
test('父景区门票根据最终游览补齐，连日观景不重复补入园票', () => {
  const profile = P.normalizeInput({ startDate: '2026-12-20', endDate: '2026-12-21' });
  const items = [
    Object.assign(row('10:00', '12:00', 'sight', '沿步道游览甲观景台', '', '甲观景台', 'walk'), { itemId: 'entry', visitScope: '晨光梯田' }),
    Object.assign(row('06:00', '07:00', 'sight', '观赏晨景'), { dayIndex: 1, itemId: 'sunrise', visitScope: '晨光梯田' }),
  ];
  const alarms = P.backfillDetailAlarms(profile, { days: [{ date: profile.startDate }, { date: profile.endDate }] }, items, []);
  const tickets = P.normalizeBookingAlarmKinds(alarms, items, profile).filter((a) => a.type === 'ticket');
  assert.equal(tickets.length, 1); assert.equal(tickets[0].linkedItemId, 'entry');
});
test('末日实际参观博物馆仍补预约，日常搬运行李不变成行前闹钟', () => {
  const profile = P.normalizeInput({ startDate: '2026-12-20', endDate: '2026-12-21' });
  const items = [
    Object.assign(row('09:00', '10:30', 'sight', '游览甲城历史博物馆', '', '甲城历史博物馆出口', 'walk'), { dayIndex: 1, itemId: 'museum', visitScope: '甲城' }),
    Object.assign(row('12:00', '13:00', 'transport', '携带全部行李前往车站', '甲城酒店', '甲城站', 'ride'), { dayIndex: 1, note: '准备好大件行李，注意安全' }),
  ];
  const alarms = P.backfillDetailAlarms(profile, { days: [{ date: profile.startDate }, { date: profile.endDate }] }, items, []);
  assert(alarms.some((a) => a.type === 'ticket' && a.linkedItemId === 'museum'));
  assert(!alarms.some((a) => a.type === 'other'));
});
test('同日入住与回房都存在时酒店预订仍精确关联首次入住', () => {
  const items = [
    Object.assign(row('14:00', '14:30', 'hotel', '办理入住', '', '甲城晨光酒店'), { itemId: 'checkin' }),
    Object.assign(row('20:00', '21:00', 'hotel', '回房休息', '', '甲城晨光酒店'), { itemId: 'return' }),
  ];
  assert.equal(P.linkBookingAlarms([{ type: 'hotel', dayIndex: 0, bookingInfo: '甲城晨光酒店' }], items)[0].linkedItemId, 'checkin');
});
test('同地点活动保留住宿终点但不生成 A→A 导航', () => {
  const normalized = R.normalizeReviewRows([row('20:00', '21:00', 'hotel', '回房休息', '甲城晨光酒店', '甲城晨光酒店')], 1)[0];
  assert.equal(normalized.startLocation, ''); assert.equal(normalized.endLocation, '甲城晨光酒店');
});
test('验收按真实回房动作和地址识别住宿闭环，不仅认分类', () => {
  assert.deepEqual(R.executionIssues([room], { hotel: '甲城晨光酒店' }), []);
  assert(R.executionIssues([room], { hotel: '乙城晨光酒店' }).length > 0);
});
test('仅填写 hotel 分类不能冒充回到正确住宿地', () => {
  assert(R.executionIssues([Object.assign({}, room, { category: 'hotel' })], { hotel: '乙城晨光酒店' }).includes('当晚收尾住宿地错误'));
});
test('验收不悄悄压缩模型重叠时段', () => {
  const normalized = R.normalizeReviewRows([row('09:00', '11:00', 'sight', '游览甲景区'), row('10:00', '12:00', 'food', '午餐'), room], 0);
  assert.equal(normalized[0].endTime, '11:00');
  assert(R.executionIssues(normalized, {}).includes('时段重叠'));
});
test('官方站名允许尾部站字差异，不允许更换站点或时刻', () => {
  const official = [{ startLocation: '甲城北', endLocation: '乙城东', startTime: '10:00', endTime: '12:00', code: 'G123' }];
  const train = row('10:00', '12:00', 'transport', '乘 G123 高铁', '甲城北站', '乙城东站', 'train');
  assert.deepEqual(R.executionIssues([train, room], { official }), []);
  assert(R.executionIssues([Object.assign({}, train, { endTime: '12:05' }), room], { official }).includes('修改或遗漏了官方班次'));
});
test('铁路不能到汽车站，也不能使用多个备选站或住宿地', () => {
  assert(R.executionIssues([row('10:00', '11:00', 'transport', '乘高铁', '甲城站', '乙城汽车站', 'train'), room], {}).includes('铁路使用了非铁路上车/下车点'));
  assert(R.executionIssues([row('10:00', '11:00', 'transport', '乘高铁', '甲城站/甲城北站', '乙城站', 'train'), room], {}).includes('铁路站点仍是模糊占位或多个备选'));
  assert(R.executionIssues([row('10:00', '11:00', 'transport', '乘高铁', '甲城酒店', '乙城站', 'train'), room], {}).includes('铁路上车/下车点没有明确车站'));
});
test('进站交通必须结束在发车前至少40分钟', () => {
  const access = row('09:00', '09:30', 'transport', '打车去车站', '甲城酒店', '甲城站', 'ride');
  const train = row('10:00', '11:00', 'transport', '乘高铁', '甲城站', '乙城站', 'train');
  assert(R.executionIssues([access, train, room], {}).includes('铁路进站接驳没有40分钟安检缓冲'));
});
test('否定行李指令不被误当成寄存或再次入住', () => {
  const last = Object.assign({}, room, { endLocation: '用户家', note: '无需重新办理入住；不用寄存行李', endTime: '21:00' });
  assert.deepEqual(R.executionIssues([last], { isLast: true, origin: '用户家', backTime: '21:00', sameHotel: true }), []);
});
test('连住不能重新放下大件行李，末日不能新寄存', () => {
  assert(R.executionIssues([Object.assign({}, room, { note: '放下大件行李' })], { sameHotel: true }).includes('连住期间重复入住或放下大件行李'));
  assert(R.executionIssues([Object.assign({}, room, { note: '把行李寄存在酒店' })], { isLast: true }).includes('末日错误寄存行李'));
});
test('太阳窗口由事实锁定，不能被模型习惯时刻替代', () => {
  const solar = [{ activity: '观赏日落', startTime: '17:40', endTime: '18:30', note: '日落约18:10' }];
  const normalized = R.normalizeReviewRows([row('16:00', '17:00', 'sight', '观赏日落（日落约17:00）'), room], 0, { solar });
  assert.equal(normalized[0].startTime, '17:40'); assert.equal(normalized[0].endTime, '18:30');
  assert(!normalized[0].activity.includes('17:00')); assert(normalized[0].note.includes('18:10'));
});
test('放行李后单向游览再回住宿合理，中途折返午休须用户明确要求', () => {
  const route = [row('09:00', '09:30', 'hotel', '入住放行李', '', '甲城晨光酒店'),
    row('10:00', '11:00', 'sight', '游览甲观景台', '', '甲观景台'),
    row('11:00', '11:30', 'other', '返回民宿午休', '甲观景台', '甲城晨光酒店'),
    row('12:00', '14:00', 'sight', '游览乙观景台', '', '乙观景台'), room];
  const context = { hotel: '甲城晨光酒店', scenicRoute: true };
  assert(R.executionIssues(route, context).includes('景区核心游线中途折返住宿地'));
  assert(!R.executionIssues(route, Object.assign({}, context, { middayRest: true })).includes('景区核心游线中途折返住宿地'));
  assert(!R.executionIssues(route.filter((_, i) => i !== 2), context).includes('景区核心游线中途折返住宿地'));
});
test('地图距离识别不可能的步行，不把直线距离当实际导航结果', () => {
  const points = { 甲酒店: { lat: 25, lon: 110 }, 乙码头: { lat: 25.1, lon: 110 } };
  assert(E.geometryIssues([row('09:00', '09:30', 'transport', '步行去码头', '甲酒店', '乙码头', 'walk')], points).length);
  assert.equal(E.geometryIssues([row('09:00', '09:30', 'transport', '打车去码头', '甲酒店', '乙码头', 'ride')], points).length, 0);
});
test('铁路换乘知识与耗时下限不能用待核实备注掩盖', () => {
  const train = row('10:00', '11:00', 'transport', '乘动车（待核实）', '甲城站', '乙城站', 'train');
  const issues = R.executionIssues([train, room], { routeFacts: [{ from: '甲城站', to: '乙城站', mode: 'train',
    direct: false, via: ['丙城枢纽站'], minMinutes: 130 }] });
  assert(issues.some((issue) => /无直达.*换乘/.test(issue))); assert(issues.some((issue) => issue.includes('交通下限')));
});
test('连住首段只补留房状态，换酒店补全量携带状态', () => {
  const rows = [row('08:00', '09:00', 'food', '早餐'), room];
  assert(R.normalizeReviewRows(rows, 1, { sameHotel: true })[0].note.includes('大件行李留在房间'));
  assert(R.normalizeReviewRows(rows, 1, { previousHotel: '甲城晨光酒店' })[0].note.includes('退房时带走全部行李'));
  assert.equal(R.normalizeReviewRows(rows, 1, { lightLuggage: true })[0].note, '');
});
test('末日不能把大件行李理解为小背包后安排索道登山', () => {
  const mountain = row('09:00', '10:00', 'transport', '乘坐索道上山', '甲山门口', '甲山山顶', 'bus');
  assert(R.executionIssues([mountain, room], {}).includes('携带大件行李安排了不便随身携带的活动'));
  assert(!R.executionIssues([mountain, room], { lightLuggage: true }).includes('携带大件行李安排了不便随身携带的活动'));
});
test('落库重复审计不再删改实际景点和原有窗口', () => {
  const outline = { days: [{ city: '甲城', hotel: '甲城晨光酒店', overnight: '甲城', highlights: [], moves: [] }, { overnight: '返程' }] };
  const raw = [row('10:00', '11:00', 'sight', '游览甲城观景台', '', '甲城观景台'), room];
  const once = P.auditMergedDetailItems(raw, outline, { startDate: '2026-10-01', endDate: '2026-10-02' });
  const twice = P.auditMergedDetailItems(once, outline, { startDate: '2026-10-01', endDate: '2026-10-02' });
  assert.equal(once.find((item) => item.category === 'sight').startTime, '10:00');
  assert.deepEqual(twice, once);
});
test('交通和真实游览标签按动作归一，不把进景区算成游玩', () => {
  const normalized = R.normalizeReviewRows([
    row('09:00', '10:00', 'sight', '徒步前往山顶', '甲观景台', '乙山顶', 'walk'),
    row('10:00', '12:00', 'other', '游览山顶步道并拍照', '', '乙山顶'),
  ], 0);
  assert.equal(normalized[0].category, 'transport'); assert.equal(normalized[1].category, 'sight');
});
test('用户自设提前分钟数进入生成资料，缺省为五分钟', () => {
  assert.equal(P.normalizeInput({ leadMinutes: 12 }).leadMinutes, 12);
  assert.equal(P.normalizeInput({}).leadMinutes, 5);
});
test('明日出发不是日出，严禁寄存不是实际寄存', () => {
  const end = Object.assign({}, room, { activity: '返回酒店，整理明日出发用品', note: '严禁寄存行李', endLocation: '用户家' });
  assert.deepEqual(R.executionIssues([end], { isLast: true, origin: '用户家' }), []);
});
test('连住早餐不再办理退房寄存，回房不会重复搬运行李', () => {
  const normalized = R.normalizeReviewRows([
    row('08:00', '09:00', 'food', '早餐，办理退房或确认续住，将大件行李寄存酒店前台', '', '甲城晨光酒店'),
    Object.assign({}, room, { activity: '回房放置行李', note: '直接回房放置行李并休息' }),
  ], 1, { sameHotel: true, hotel: '甲城晨光酒店' });
  assert(!/退房|寄存|放置行李/.test(JSON.stringify(normalized)));
  assert.deepEqual(R.executionIssues(normalized, { sameHotel: true, hotel: '甲城晨光酒店' }), []);
});
test('前往山上住宿搬运行李和购竹筏票不等于拖箱游玩', () => {
  const toHotel = row('10:00', '11:00', 'transport', '徒步上山至酒店放置行李', '甲山入口', '甲城晨光酒店', 'walk');
  const ticket = row('09:00', '09:30', 'ticket', '购买竹筏票', '', '甲山入口');
  const normalized = R.normalizeReviewRows([ticket, toHotel, room], 1, { hotel: '甲城晨光酒店' });
  assert(normalized[1].note.includes('协助搬运行李'));
  assert(!R.executionIssues(normalized, { hotel: '甲城晨光酒店' }).includes('携带大件行李安排了不便随身携带的活动'));
});
test('模式与地铁执行说明一致，不把车站到酒店算成列车', () => {
  const item = Object.assign({}, row('19:00', '19:30', 'transport', '从甲站前往酒店', '甲城站', '甲城晨光酒店', 'train'), { note: '乘坐地铁至中心站后步行' });
  assert.equal(R.normalizeReviewRows([item], 1)[0].transportType, 'bus');
});
test('估算列车顺延进站缓冲与运行下限，后续保持活动时长', () => {
  const access = row('09:00', '09:30', 'transport', '打车去车站', '甲酒店', '甲城站', 'ride');
  const train = row('09:30', '10:30', 'transport', '乘动车', '甲城站', '乙城站', 'train');
  const context = { routeFacts: [{ from: '甲城站', to: '乙城站', mode: 'train', minMinutes: 90 }] };
  const normalized = R.normalizeReviewRows([access, train, row('10:30', '11:30', 'sight', '游览乙城'), room], 1, context);
  assert.equal(normalized[1].startTime, '10:10'); assert.equal(normalized[1].endTime, '11:40');
  assert.equal(normalized[2].endTime, '12:40');
  assert(!R.executionIssues(normalized, context).includes('铁路进站接驳没有40分钟安检缓冲'));
});
test('官方班次不因当前网络耗时或安检不足而被修改', () => {
  const access = row('09:00', '09:30', 'transport', '打车去站', '甲酒店', '甲城站', 'ride');
  const train = row('10:00', '11:00', 'transport', '乘G1001', '甲城站', '乙城站', 'train');
  const context = { official: [{ startLocation: '甲城站', endLocation: '乙城站', startTime: '10:00', endTime: '11:00', code: 'G1001' }],
    routeFacts: [{ from: '甲城站', to: '乙城站', mode: 'train', minMinutes: 100 }] };
  const normalized = R.normalizeReviewRows([access, train, room], 0, context);
  assert.equal(normalized[1].startTime, '10:00'); assert.equal(normalized[1].endTime, '11:00');
  assert(R.executionIssues(normalized, context).includes('铁路进站接驳没有40分钟安检缓冲'));
});
test('冬季山地游览不能延续至当地日落后，夜景与日落专门活动不误拦', () => {
  const context = { date: '2027-01-01', points: { 甲山: { lat: 31, lon: 103 } } };
  const hike = row('16:00', '19:00', 'sight', '游览前山徒步步道', '', '甲山');
  assert(R.executionIssues([hike, room], context).some((issue) => issue.includes('当地日落')));
  assert(!R.executionIssues([Object.assign({}, hike, { activity: '观赏日落夕阳' }), room], context).some((issue) => issue.includes('当地日落')));
});
test('铁路优先返程不能通过机场片段与到家后自由安排填满时间', () => {
  const home = row('10:00', '11:00', 'transport', '打车到家', '甲机场', '用户家', 'ride');
  const fill = row('11:00', '17:00', 'other', '行程结束，自由安排或休息', '', '用户家');
  const context = { isLast: true, origin: '用户家', backTime: '17:00', preferRail: true };
  const normalized = R.normalizeReviewRows([home, fill], 1, context);
  assert.equal(normalized.length, 1);
  assert(R.executionIssues(normalized, context).some((issue) => issue.includes('缺少实际列车')));
});
test('单段自驾授权不扩散，本人驾驶到目的地必须停车', () => {
  const drive = row('08:00', '09:00', 'transport', '自驾去景区', '甲城', '甲景区', 'car');
  assert(R.executionIssues([drive, room], { noDrive: true }).includes('未授权自驾'));
  const context = { noDrive: true, selfDriveAllowed: (item) => item.endLocation === '甲景区' };
  assert(!R.executionIssues([drive, room], context).includes('未授权自驾'));
  assert(R.executionIssues([drive, room], context).includes('自驾到达后缺少停车安排'));
  assert(!R.executionIssues([Object.assign({}, drive, { note: '先停车再游玩' }), room], context).includes('自驾到达后缺少停车安排'));
});
test('交通已回到酒店后收尾不能再次从车站出发', () => {
  const route = [row('19:00', '19:30', 'transport', '打车回酒店', '甲城站', '甲城晨光酒店', 'ride'),
    row('19:30', '20:00', 'hotel', '返回酒店休息', '甲城站', '甲城晨光酒店')];
  const context = { hotel: '甲城晨光酒店', points: {
    '甲城站': { lat: 30, lon: 103 }, '甲城晨光酒店': { lat: 30.1, lon: 103 },
  } };
  const normalized = R.normalizeReviewRows(route, 1, context);
  assert.equal(normalized[1].startLocation, '');
  assert(!R.executionIssues(normalized, context).some((issue) => issue.includes('凭空跳转')));
});
test('已执行复核的日期入库审计不修改时段或重排大纲', () => {
  const outline = { days: [{ city: '甲城', overnight: '甲城', hotel: '甲城晨光酒店', highlights: [], moves: [] }, { overnight: '返程', moves: [] }] };
  const reviewed = Object.assign({}, room, { executionReview: R.REVIEW_VERSION });
  const before = JSON.stringify(outline);
  const audited = P.auditMergedDetailItems([reviewed], outline, { origin: '用户家', startDate: '2026-10-01', endDate: '2026-10-02' });
  assert.equal(audited[0].startTime, reviewed.startTime); assert.equal(JSON.stringify(outline), before);
});
(async () => {
  const originalChat = llm.chatWithRetry;
  let calls = 0;
  try {
    llm.chatWithRetry = async (messages, opts) => {
      calls++;
      assert(!opts.maxTokens, '执行复核不得硬截断输出');
      assert(opts.enableSearch, '地理与运营知识必须联网核对');
      if (messages[0].content.includes('运营知识')) return JSON.stringify({ routeFacts: [], scenicRoute: '市区酒店附近短线，具体班次待查询', warnings: [], sources: [] });
      return JSON.stringify({ items: [row('12:00', '13:00', 'transport', '从家出发', '用户家', '甲城车站', 'ride'), room], moves: [] });
    };
    const outline = { days: [{ city: '甲城', overnight: '甲城', hotel: '甲城晨光酒店', highlights: [], moves: [] }, { overnight: '返程' }] };
    const first = await R.reviewExecutionItems({ origin: '用户家' }, outline, [room], Date.now() + 20000);
    assert(!first[0].executionReview, '运营检索轮不能提前标记时间线通过');
    const accepted = await R.reviewExecutionItems({ origin: '用户家' }, outline, first, Date.now() + 20000);
    assert.equal(accepted[0].executionReview, R.REVIEW_VERSION);
    await R.reviewExecutionItems({ origin: '用户家' }, outline, accepted, Date.now() + 20000);
    assert.equal(calls, 2, '知识和时间线分轮，已完成日期不能重复调用 LLM');
    passed++; console.log('✓ 真调用链无输出截断，已复核日期不重复执行');
  } finally { llm.chatWithRetry = originalChat; }
  console.log(`执行复核回归：${passed} 项通过`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
