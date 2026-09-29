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
test('水上终点先按运营起点核验，不能用错误终点绕过检查；竹筏无需固定发船时刻', () => {
  const context = { lightLuggage: true, sailingWindows: [
    { from: '甲码头', to: '乙综合码头', grade: '竹筏', departures: [], sourceUrl: 'https://operator.example/raft' },
  ] };
  const wrong = row('09:00', '10:30', 'sight', '体验竹筏漂流', '漂流起点（甲码头）', '漂流终点（丙码头）', 'ship');
  assert(R.executionIssues([wrong, room], context).some((issue) => /水上路线.*终点.*乙综合码头/.test(issue)));
  const right = Object.assign({}, wrong, { endLocation: '漂流终点（乙综合码头）', transportType: '' });
  assert(!R.executionIssues([right, room], context).some((issue) => /水上路线|发船|船型/.test(issue)));
  assert(!R.executionIssues([wrong, room], { lightLuggage: true }).some((issue) => /水上路线/.test(issue)));
});
test('同码头不同合法航线不互相误判，只核对实际船型而非备注中的备选船型', () => {
  const context = { sailingWindows: [
    { from: '甲码头', to: '乙码头', grade: '四星', departures: ['10:00'], sourceUrl: 'https://operator.example/a' },
    { from: '甲码头', to: '丙码头', grade: '四星', departures: ['11:00'], sourceUrl: 'https://operator.example/b' },
  ] };
  const cruise = row('11:00', '13:00', 'sight', '乘四星游船', '甲码头', '丙码头', 'ship');
  assert(!R.executionIssues([cruise, room], context).some((issue) => /水上路线|运营窗口|船型/.test(issue)));
  const wrong = Object.assign({}, cruise, { activity: '乘三星游船', note: '四星仅为备选' });
  assert(R.executionIssues([wrong, room], context).some((issue) => /船型必须明确/.test(issue)));
});
test('抵达段已入住放行李，游览回来只是回房；相邻到店和办理入住不误删', () => {
  const arrival = row('16:00', '17:00', 'transport', '乘车前往酒店办理入住并寄存行李', '甲城站', room.endLocation, 'ride');
  const night = row('20:00', '20:30', 'hotel', '入住甲城晨光酒店，整理随身物品', '', room.endLocation);
  const context = { hotel: room.endLocation };
  assert(R.executionIssues([arrival, night], context).some((issue) => /晚间应回房/.test(issue)));
  const normalized = R.normalizeReviewRows([arrival, night], 0, context);
  assert(!normalized[1].activity.includes('入住')); assert(normalized[1].activity.includes('回房'));
  const adjacent = R.normalizeReviewRows([arrival, Object.assign({}, night, { startTime: '17:00', endTime: '17:30' })], 0, context);
  assert(adjacent[1].activity.includes('入住'));
});
test('去漂流终点取回行李不是再次漂流，但取回后骑行仍须重新寄存', () => {
  const pickup = row('10:00', '10:30', 'other', '从漂流终点返回寄存处取回行李', '甲漂流终点', '甲寄存处');
  const store = row('09:00', '09:15', 'other', '寄存大件行李', '', '甲寄存处');
  assert(!R.executionIssues([store, pickup, room], {}).some((issue) => /携带大件/.test(issue)));
  const cycling = Object.assign({}, pickup, { activity: '取回行李后骑行电动车游览' });
  assert(R.executionIssues([store, cycling, room], {}).some((issue) => /携带大件/.test(issue)));
});
test('备注中的未核验参考车次不泄漏成实际使用班次', () => {
  const train = Object.assign(row('10:00', '11:00', 'transport', '计划乘动车从甲站至乙站', '甲站', '乙站', 'train'),
    { note: '参考车次D1001/D1003等，具体以购票为准。记得带证件。' });
  const normalized = R.normalizeReviewRows([train], 0)[0];
  assert(!/D1001|D1003/.test(normalized.note)); assert(normalized.note.includes('带证件'));
  assert(R.executionIssues([train], {}).some((issue) => /未核验参考车次/.test(issue)));
});
test('城市长时散步也要先放大件行李，单纯索道购票不能瞬移到山顶', () => {
  const walk = row('18:00', '19:00', 'other', '在甲城江边散步消食', '', '甲江');
  assert(R.executionIssues([walk, room], { hotel: room.endLocation }).some((issue) => /携带大件/.test(issue)));
  const deposit = row('17:00', '17:20', 'hotel', '办理入住放下行李', '', room.endLocation);
  assert(!R.executionIssues([deposit, walk, room], { hotel: room.endLocation }).some((issue) => /携带大件/.test(issue)));
  const cable = row('17:00', '17:30', 'ticket', '购买索道票并排队等候上行', '', '甲索道下站');
  const sunset = row('17:30', '18:30', 'sight', '在甲山顶观景台观赏日落', '', '甲山顶观景台');
  assert(R.executionIssues([cable, sunset, room], {}).some((issue) => /缺少实际索道上行/.test(issue)));
});
test('大纲已有父景区门票时，次晨日出不重复补购票提醒', () => {
  const profile = P.normalizeInput({ startDate: '2026-12-20', endDate: '2026-12-21' });
  const outline = { days: [{ date: '2026-12-20' }, { date: '2026-12-21' }] };
  const sunrise = Object.assign(row('06:00', '07:00', 'sight', '观赏甲山日出', '', '甲山'), { dayIndex: 1, itemId: 'sunrise', visitScope: '甲山' });
  const existing = [{ type: 'ticket', dayIndex: 0, title: '甲山景区门票/预约放票', bookingInfo: '甲山' }];
  assert.equal(P.backfillDetailAlarms(profile, outline, [sunrise], existing).filter((alarm) => alarm.type === 'ticket').length, 0);
});
test('最终大纲交通只同步实际接受条目，保留步行衔接，删除旧合成接驳', () => {
  const day = { moves: [{ from: '甲停车场', to: '乙索道站', mode: 'bus', autoConnector: true }] };
  const rows = [row('12:00', '12:30', 'transport', '步行至甲酒店', '甲停车场', '甲酒店', 'walk'),
    row('16:00', '16:30', 'transport', '步行至乙索道站', '甲观景台', '乙索道站', 'walk')]
    .map((item) => Object.assign(item, { executionReview: R.REVIEW_VERSION }));
  assert(R.syncAcceptedMoves(day, rows)); assert.equal(day.moves.length, 2);
  assert(day.moves.every((move) => move.mode === 'walk')); assert(!day.moves.some((move) => move.autoConnector));
  const official = { from: '甲站', to: '乙站', code: 'D1001', startTime: '10:00', endTime: '11:00', schedSource: '12306' };
  day.moves = [official]; assert(!R.syncAcceptedMoves(day, rows)); assert.strictEqual(day.moves[0], official);
});
test('候车候船和寄存不是新的购票，父景区与寺祠真实游览仍补预约', () => {
  const outline = { days: [{ date: '2026-12-20', highlights: [] }] };
  const items = [row('09:00', '09:30', 'ticket', '抵达甲码头，取票、安检、候船', '', '甲码头'),
    row('09:30', '10:00', 'other', '携带行李前往甲漂流起点寄存大件行李', '', '甲码头'),
    row('10:00', '12:00', 'sight', '体验甲河竹筏漂流', '甲码头', '乙码头'),
    Object.assign(row('13:00', '15:00', 'sight', '游览甲堰景区核心游线', '甲堰景区游客中心', '甲桥'), { visitScope: '甲堰' }),
    row('15:00', '17:00', 'sight', '游览乙祠与古街', '乙祠', '古街')]
    .map((item, i) => Object.assign(item, { itemId: `support-${i}` }));
  const profile = P.normalizeInput({ startDate: '2026-12-20', endDate: '2026-12-20' });
  const raw = P.backfillDetailAlarms(profile, outline, items, []);
  const alarms = P.normalizeBookingAlarmKinds(P.linkBookingAlarms(raw, items), items, profile);
  assert(!alarms.some((alarm) => /support-[01]/.test(alarm.linkedItemId)));
  assert(alarms.some((alarm) => /甲堰景区/.test(alarm.bookingInfo))); assert(alarms.some((alarm) => /乙祠/.test(alarm.bookingInfo)));
  assert(alarms.some((alarm) => alarm.linkedItemId === 'support-2'));
});
test('备注中的轨交备选不替换实际打车，公共交通不能沿用更短的打车时长', () => {
  const ride = Object.assign(row('15:00', '16:00', 'transport', '打车返回用户家', '甲城西站', '用户家', 'ride'),
    { note: '也可乘地铁，换乘耗时更长' });
  const normalized = R.normalizeReviewRows([ride], 0);
  assert.equal(normalized[0].transportType, 'ride'); assert(normalized[0].activity.includes('打车'));
  const bus = Object.assign({}, ride, { endTime: '15:40', transportType: 'bus', activity: '乘公共交通返回用户家' });
  assert(R.executionIssues([bus], { routeFacts: [{ from: '甲城西站', to: '用户家', mode: 'ride', minMinutes: 60 }] })
    .some((issue) => /不能直接沿用打车时长/.test(issue)));
});
test('短时接驳不能把公交和网约车混用同一时长，有真实公交证据才采用', () => {
  const mixed = row('15:15', '16:00', 'transport', '乘公交、地铁或网约车从甲西站回家', '甲西站', '用户家', 'ride');
  assert(R.executionIssues([mixed], {}).some((issue) => /混写公共交通/.test(issue)));
  const taxi = R.normalizeReviewRows([mixed], 0)[0];
  assert.equal(taxi.transportType, 'ride'); assert(taxi.activity.startsWith('乘网约车'));
  const bus = R.normalizeReviewRows([mixed], 0, { routeFacts: [{ from: '甲西站', to: '用户家', transitEstimate: true, minMinutes: 40, summary: '甲线换乙线' }] })[0];
  assert.equal(bus.transportType, 'bus'); assert(bus.note.includes('甲线换乙线'));
});
test('有住宿定位却无餐饮门店定位时不能断言某分店短程步行可达', () => {
  const walk = row('19:00', '19:15', 'transport', '步行前往甲米粉', room.endLocation, '甲米粉(中心店)', 'walk');
  const context = { points: { [room.endLocation]: { lon: 110, lat: 25 } } };
  assert(R.executionIssues([walk, room], context).some((issue) => /门店.*定位未核验/.test(issue)));
  assert(!R.executionIssues([walk, room], {}).some((issue) => /门店.*定位未核验/.test(issue)), '地图整体不可用不冒充已查证距离');
  context.points[walk.endLocation] = { lon: 110.001, lat: 25 };
  assert(!R.executionIssues([walk, room], context).some((issue) => /门店.*定位未核验/.test(issue)));
});
test('换船型后删除旧派生附注，资料对比不代表实际选了另一船型', () => {
  const cruise = Object.assign(row('12:00', '16:00', 'sight', '乘坐三星级游船游览', '甲码头', '乙码头'),
    { note: '注意防风；四星级漓江游船：旧码头出发，请按船票核对' });
  const normalized = R.normalizeReviewRows([cruise, room], 1);
  assert(normalized[0].note.includes('防风')); assert(!normalized[0].note.includes('四星'));
});
test('新寄存不能覆盖未取回的旧寄存，博物馆长游也需行李安排', () => {
  const route = [row('09:00', '09:15', 'other', '寄存大件行李', '', '甲寄存处'),
    row('10:00', '10:15', 'other', '寄存大件行李', '', '乙寄存处'), room];
  assert(R.executionIssues(route, {}).some((issue) => /甲寄存处.*未取回/.test(issue)));
  const museum = Object.assign(row('10:00', '12:00', 'sight', '游览乙博物馆'), { note: '行李暂存于包车后备箱或附近寄存点（若需）' });
  assert(R.executionIssues([museum, room], {}).some((issue) => /携带大件/.test(issue)));
});
test('准确停车场后的泛称别名可收敛，两个实际候选站仍要复核', () => {
  const result = R.normalizeReviewRows([row('08:00', '09:00', 'transport', '从甲山停车场/接驳车点乘车', '甲山停车场/接驳车点', '乙码头', 'ride'), room], 1);
  assert.equal(result[0].startLocation, '甲山停车场');
  const ambiguous = R.normalizeReviewRows([row('08:00', '09:00', 'transport', '乘车前往车站', '甲酒店', '甲东站/甲西站', 'ride'), room], 1);
  assert(R.executionIssues(ambiguous, {}).some((issue) => /多个备选/.test(issue)));
});
test('游船也是跨城移动，船型和开航时刻须符合带来源的运营窗口', () => {
  const cruise = row('11:00', '15:00', 'sight', '乘坐三星/四星游船游览', '甲码头', '乙码头');
  const context = { sailingWindows: [{ from: '甲码头', to: '乙码头', grade: '四星', departures: ['10:20'], sourceUrl: 'https://operator.example/sailing' }] };
  const normalized = R.normalizeReviewRows([cruise, room], 1, context);
  assert.equal(normalized[0].transportType, 'ship');
  assert(R.executionIssues(normalized, context).some((issue) => /发船/.test(issue)));
  assert(R.executionIssues(normalized, context).some((issue) => /明确船型/.test(issue)));
  const valid = Object.assign({}, normalized[0], { startTime: '10:20', activity: '乘坐四星游船游览' });
  assert(!R.executionIssues([valid, room], context).some((issue) => /发船|船型/.test(issue)));
});
test('先入园再到核心游览点不被误判为晚于停止入园', () => {
  const rows = [row('14:40', '14:55', 'ticket', '在甲沟景区购票入园', '', '甲沟景区游客中心'),
    row('15:05', '16:00', 'sight', '游览甲沟景区核心段'), room];
  assert(!R.executionIssues(rows, { visitWindows: [{ place: '甲沟景区', lastEntryTime: '15:00', closeTime: '17:30', sourceUrl: 'https://operator.example/entry' }] }).some((issue) => /停止入园/.test(issue)));
});
test('车站广场和候车厅是同一铁路枢纽，普通广场不能借此串站', () => {
  assert(R.sameEndpoint('甲城东站候车厅', '甲城东站'));
  assert(R.sameEndpoint('甲城东站南广场', '甲城东站'));
  assert(!R.sameEndpoint('甲城东站南广场', '甲城西站'));
  assert(!R.sameEndpoint('甲城人民广场', '甲城人民'));
});
test('入住条目仅填准确酒店起点时恢复住宿终点，不制造二次交通', () => {
  const result = R.normalizeReviewRows([row('20:00', '21:00', 'hotel', '抵达甲城晨光酒店办理入住并休息', '甲城晨光酒店')],
    1, { hotel: '甲城晨光酒店' });
  assert.equal(result[0].endLocation, '甲城晨光酒店'); assert.equal(result[0].startLocation, '');
  assert(!R.executionIssues(result, { hotel: '甲城晨光酒店' }).includes('当晚收尾住宿地错误'));
});
test('已寄存状态备注不会把寄存地点改为游览地点', () => {
  const route = [row('09:00', '09:20', 'other', '寄存大件行李', '', '甲景区游客中心寄存处'),
    Object.assign(row('09:20', '10:20', 'sight', '乘竹筏游览', '', '甲景区码头'), { note: '此时行李已寄存，无需携带' }),
    row('10:20', '10:40', 'other', '取回寄存的大件行李', '', '甲景区游客中心寄存处'), room];
  assert(!R.executionIssues(route, { hotel: room.endLocation }).some((issue) => /行李/.test(issue)));
});
test('安检和交通合并时按真实接驳下限拆分，不改变官方发车', () => {
  const access = row('07:30', '08:23', 'transport', '退房后前往甲城站并办理进站安检', '甲酒店', '甲城站', 'ride');
  const train = row('08:23', '09:14', 'transport', '乘D1001', '甲城站', '乙城站', 'train');
  const context = { official: [{ startLocation: '甲城站', endLocation: '乙城站', startTime: '08:23', endTime: '09:14', code: 'D1001' }],
    routeFacts: [{ from: '甲酒店', to: '甲城站', mode: 'ride', minMinutes: 30 }] };
  const result = R.normalizeReviewRows([access, train, room], 1, context);
  assert.equal(result[0].startTime, '07:13'); assert.equal(result[0].endTime, '07:43');
  assert.equal(result[1].activity, '进站安检、候车及检票'); assert.equal(result[2].startTime, '08:23');
  assert(!R.executionIssues(result, context).includes('铁路进站接驳没有40分钟安检缓冲'));
});
test('按车次恢复官方终点和下一段起点，不把到站改成另一车站', () => {
  const train = row('08:00', '09:30', 'transport', '乘D1001', '甲城站', '乙城东站', 'train');
  const access = row('09:30', '10:00', 'transport', '从乙城东站乘公交', '乙城东站', '乙酒店', 'bus');
  const result = R.normalizeReviewRows([train, access, room], 1, { official: [
    { startLocation: '甲城', endLocation: '乙城', startTime: '08:00', endTime: '09:00', code: 'D1001' },
  ] });
  assert.equal(result[0].endTime, '09:00'); assert.equal(result[0].endLocation, '乙城站');
  assert.equal(result[1].startLocation, '乙城站'); assert(!result[1].activity.includes('东站'));
});
test('并行批次合并后只撤回重复主菜的后一天，允许明确重复偏好', () => {
  const days = [{ meals: ['甲城焖鱼'] }, { meals: ['甲城焖鱼'] }];
  const rows = [0, 1].map((dayIndex) => Object.assign(row('12:00', '13:00', 'food', '午餐品尝甲城焖鱼'),
    { dayIndex, mealNames: ['甲城焖鱼'], executionReview: R.REVIEW_VERSION }));
  assert.deepEqual([...R.invalidateRepeatedMeals(days, rows)], [1]);
  assert.equal(rows[0].executionReview, R.REVIEW_VERSION); assert(!rows[1].executionReview);
  rows[1].executionReview = R.REVIEW_VERSION;
  assert.equal(R.invalidateRepeatedMeals(days, rows, '每天都想吃甲城焖鱼').size, 0);
});
test('景区冬季停止入园和出园接驳窗口有独立验收，未知时刻不编造', () => {
  const context = { visitWindows: [{ place: '甲沟', openTime: '08:30', lastEntryTime: '15:00', closeTime: '17:30', exitMinutes: 30, sourceUrl: 'https://operator.example/winter' }] };
  assert(R.executionIssues([row('15:40', '17:20', 'sight', '游览甲沟'), room], context).some((issue) => /停止入园/.test(issue)));
  assert(R.executionIssues([row('14:30', '17:20', 'sight', '游览甲沟'), room], context).some((issue) => /出园接驳/.test(issue)));
  assert(!R.executionIssues([row('14:00', '16:50', 'sight', '游览甲沟'), room], context).some((issue) => /甲沟/.test(issue)));
});
test('带来源的游线保守耗时按真实游览段累计，不把寄存或买票算游玩', () => {
  const context = { visitWindows: [{ place: '甲山', minVisitMinutes: 150, sourceUrl: 'https://operator.example/route', estimated: true }] };
  const short = row('14:00', '15:00', 'sight', '游览甲山核心游线', '', '甲山');
  const deposit = row('13:00', '14:00', 'other', '在甲山寄存大件行李', '', '甲山');
  assert(R.executionIssues([deposit, short, room], context).some((issue) => /仅60分钟.*150/.test(issue)));
  assert(!R.executionIssues([Object.assign({}, short, { endTime: '16:30' }), room], context).some((issue) => /保守用时/.test(issue)));
});
test('局部修订只替换目标段，拒绝越界和重叠补丁', () => {
  const before = [{ activity: '早餐' }, { activity: '游玩' }, room];
  const output = R.applyExecutionPatch(before, [{ startIndex: 1, endIndex: 1, items: [{ activity: '寄存' }, { activity: '游玩并取回' }] }]);
  assert.equal(output.length, 4); assert.strictEqual(output[0], before[0]); assert.strictEqual(output[3], room);
  assert.equal(before.length, 3);
  assert.equal(R.applyExecutionPatch(before, [{ startIndex: 3, endIndex: 3, items: [] }]), null);
  assert.equal(R.applyExecutionPatch(before, [{ startIndex: 3, endIndex: 3, items: [{ activity: '收尾' }] }]).length, 4);
  assert.equal(R.applyExecutionPatch(before, [{ startIndex: 0, endIndex: 1, items: [] }, { startIndex: 1, endIndex: 2, items: [] }]), null);
});
test('生成闹钟备注不固化提前设置，使用时间单独保留', () => {
  const [alarm] = P.annotateAlarmUsage([{ type: 'train', note: '提前15分钟开抢', usageInfo: '原摘要' }], [], { days: [] });
  assert(!/15|提前.*分钟/.test(alarm.note)); assert(/乘车日期/.test(alarm.note));
});
test('退房后去车站不被当晚酒店覆盖，退房预订关联昨晚酒店', () => {
  const outline = { days: [{ hotel: '甲城晨光酒店', city: '甲城' }, { hotel: '乙城星光酒店', city: '乙城' }] };
  const input = Object.assign(row('08:00', '09:00', 'hotel', '退房后前往甲城站', '甲城晨光酒店', '甲城站'), { dayIndex: 1 });
  const output = P.annotateHotelItems([input], outline)[0];
  assert.equal(output.endLocation, '甲城站');
  assert.equal(output.category, 'transport');
  assert.equal(output.bookingInfo, '甲城晨光酒店');
});
test('返程日游客中心寄存并原地取回允许，不能异地取回', () => {
  const rows = [row('09:00', '09:15', 'other', '寄存行李', '', '甲游客中心'),
    row('11:00', '11:15', 'other', '取回行李', '甲游客中心', '甲游客中心')];
  assert(!R.executionIssues(rows, { isLast: true }).some((x) => /寄存|取回/.test(x)));
  rows[1].startLocation = rows[1].endLocation = '乙游客中心';
  assert(R.executionIssues(rows, { isLast: true }).some((x) => /取回地点/.test(x)));
});
test('同日重复退房会被识别，备注说明不算再次退房', () => {
  const rows = [row('08:00', '08:15', 'hotel', '退房'), row('09:00', '09:15', 'hotel', '办理退房')];
  assert(R.executionIssues(rows, {}).includes('同一天重复退房'));
  rows[1].activity = '前往车站'; rows[1].note = '已退房，行李随身';
  assert(!R.executionIssues(rows, {}).includes('同一天重复退房'));
});
test('日出活动归类不能因起床整理前缀而丢失锁定窗口', () => {
  const sunrise = row('06:00', '07:00', 'other', '起床洗漱后拍摄甲观景台日出（约5:40-6:00）');
  const result = R.normalizeReviewRows([sunrise], 1, { solar: [sunrise] });
  assert.equal(result[0].category, 'sight'); assert.equal(result[0].startTime, '06:00');
  assert(!result[0].activity.includes('5:40'));
});
test('行李取回以后再骑行，不再把早上的寄存当成有效状态', () => {
  const rows = [row('08:00', '08:15', 'other', '寄存行李', '', '甲游客中心'),
    row('10:00', '10:15', 'other', '取回行李', '甲游客中心', '甲游客中心'),
    row('11:00', '12:00', 'sight', '骑行乡间道路', '', '甲村'), room];
  assert(R.executionIssues(rows, {}).includes('携带大件行李安排了不便随身携带的活动'));
});
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
test('游览山地不必写徒步才验收日照，多节点短游线仍须核对耗时', () => {
  const context = { date: '2027-01-02', points: { 甲山: { lat: 31, lon: 103 } } };
  const hike = row('18:05', '19:00', 'sight', '游览甲山（山门-甲道观-乙山顶方向）', '', '甲山前山游客中心');
  const issues = R.executionIssues([hike, room], context);
  assert(issues.some((issue) => issue.includes('当地日落')));
  assert(issues.some((issue) => issue.includes('多节点山地游线')));
});
test('新版仅撤回违反新约束的已接受日期，不调用模型重做合法日', () => {
  const outline = { days: [
    { date: '2027-01-01', hotel: room.endLocation },
    { date: '2027-01-02', hotel: room.endLocation, executionPoints: { 甲山: { lat: 31, lon: 103 } } },
    { date: '2027-01-03' },
  ] };
  const rows = [Object.assign(row('10:00', '11:00', 'transport', '从用户家乘公交前往甲酒店', '用户家', room.endLocation, 'bus'), { executionReview: R.REVIEW_VERSION }),
    Object.assign({}, room, { executionReview: R.REVIEW_VERSION }),
    Object.assign(row('18:05', '19:00', 'sight', '游览甲山（山门-甲道观-乙山顶）', '', '甲山'), { dayIndex: 1, executionReview: R.REVIEW_VERSION }),
    Object.assign({}, room, { dayIndex: 1, executionReview: R.REVIEW_VERSION })];
  assert.deepEqual([...R.invalidateUnsafeAcceptedDays({ origin: '用户家', goTime: '10:00' }, outline, rows)], [1]);
  assert.equal(rows[0].executionReview, R.REVIEW_VERSION);
  assert(!rows[2].executionReview);
  assert(outline.days[1].executionReviewIssues.some((issue) => issue.includes('当地日落')));
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
