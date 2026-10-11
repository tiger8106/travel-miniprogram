const assert = require('assert');
const P = require('../cloudfunctions/generatePlan/plan');
const R = require('../cloudfunctions/generatePlan/execution-review');
const rail = require('../cloudfunctions/generatePlan/rail12306');
const { buildDocMeta } = require('../cloudfunctions/parseTravelPlan/docmeta');
const A = require('../cloudfunctions/parseTravelPlan/alarm-infer');
let count = 0;
function test(name, fn) { fn(); count++; console.log('✓ ' + name); }
const item = (activity, category = 'transport', from = '甲站', to = '乙站', mode = 'train') => ({
  dayIndex: 0, startTime: '14:00', endTime: '16:00', activity, category,
  startLocation: from, endLocation: to, transportType: mode, note: '',
});
test('标题年份优先，逐日日期正确跨年', () => {
  const meta = buildDocMeta('2027年旅游攻略\n12月31日｜出发\n出发\n1月1日｜游览\n游览');
  assert.equal(meta.startDate, '2027-12-31'); assert.equal(meta.endDate, '2028-01-01');
  const explicit = buildDocMeta('攻略\n2028年1月2日｜游览\n游玩');
  assert.equal(explicit.startDate, '2028-01-02');
});
test('未开售查询近期同星期，15天范围内只查实际乘车日', () => {
  const at = Date.parse('2026-10-10T00:00:00+08:00');
  assert.deepEqual(rail.queryDateFor('2026-10-24', at), { date: '2026-10-24', reference: false });
  const reference = rail.queryDateFor('2027-09-30', at);
  assert(reference.reference); assert(reference.date < '2026-10-25');
  assert.equal(new Date(reference.date).getUTCDay(), new Date('2027-09-30').getUTCDay());
});
test('参考班次按实际时刻规划且不选赶不上的早班，清洗不抹掉车次', () => {
  const day = { date: '2027-09-30', city: '乙城', overnight: '乙城', moves: [{ from: '甲站', to: '乙站', mode: 'train', startTime: '13:20' }] };
  const key = '甲站→乙站@2027-09-30';
  const found = new Map([[key, [
    { code: 'D1001', from: '甲站', to: '乙站', s: '12:30', e: '14:30' },
    { code: 'D1003', from: '甲站', to: '乙站', s: '14:00', e: '16:00' },
  ]]]);
  found.routeMeta = new Map([[key, { reference: true, referenceDate: '2026-10-17', sourceUrl: 'https://operator.example/timetable' }]]);
  const outline = { days: [day] };
  P.applyRealSchedules(outline, found, { goTime: '12:00' });
  const move = day.moves.find((m) => m.mode === 'train');
  assert.equal(move.code, 'D1003'); assert.equal(move.schedSource, 'reference');
  const clean = P.stripUnverifiedSchedules(P.enforceRealSchedule([item('乘坐D1003次动车')], outline), outline);
  assert(clean[0].activity.includes('D1003')); assert(clean[0].note.includes('开售后'));
  const context = { references: [{ startLocation: '甲站', endLocation: '乙站', startTime: '14:00', endTime: '16:00', code: 'D1003', referenceDate: '2026-10-17', sourceUrl: 'https://operator.example/timetable' }] };
  const reviewed = R.normalizeReviewRows(clean, 0, context)[0];
  assert.equal(reviewed.schedSource, 'reference'); assert(reviewed.note.includes('参考'));
  assert.equal(reviewed.startTime, '14:00');
});
test('实际导航酒店正确时仍纠正正文异地分店，备注也同步旧名', () => {
  const outline = { days: [{ city: '甲城', overnight: '甲城', hotel: '甲城花园酒店' }] };
  const rows = P.syncHotelReferences([item('前往花园酒店(乙城北站店)办理入住', 'hotel', '', '甲城花园酒店', '')], outline);
  assert(!rows[0].activity.includes('乙城北站店')); assert(rows[0].activity.includes('甲城花园酒店'));
});
test('已入住新酒店后的酒店晚餐不能被上一晚酒店别名覆盖', () => {
  const outline = { days: [{ overnight: '甲城', hotel: '甲城甲酒店' }, { overnight: '乙城', hotel: '乙城乙酒店' }] };
  const checkin = Object.assign(item('办理入住', 'hotel', '', '乙城乙酒店', ''), { dayIndex: 1, startTime: '18:00', endTime: '19:00' });
  const dinner = Object.assign(item('在酒店附近享用晚餐', 'food', '', '甲城甲酒店', ''), { dayIndex: 1, startTime: '20:00', endTime: '21:00' });
  assert.equal(P.syncHotelReferences([checkin, dinner], outline)[1].endLocation, '乙城乙酒店');
});
test('明确铁路站名只查询该站，不因邻站班次更多擅自切换', () => {
  const stations = [{ name: '甲城', code: 'AAA', city: '甲城' }, { name: '甲城东', code: 'AAB', city: '甲城' }];
  assert.deepEqual(rail.resolveStationCandidates('甲城东站', stations).map((station) => station.name), ['甲城东']);
});
test('游船为游览分类也不能重复同方向大巴', () => {
  const ship = item('乘坐游船赏景', 'sight', '甲码头', '乙码头', 'ship');
  const bus = Object.assign(item('乘大巴前往乙码头', 'transport', '甲码头', '乙码头', 'bus'), { startTime: '16:00', endTime: '17:00' });
  assert(R.executionIssues([ship, bus], { lightLuggage: true }).includes('同方向交通重复执行且没有返回起点'));
});
test('同址停车场/游客中心依据来源规范，不发明乘车转移', () => {
  const context = { aliases: [{ place: '甲景区停车场', names: ['甲游客中心', '甲景区停车场'], sourceUrl: 'https://operator.example/map' }] };
  const row = item('乘车前往停车场', 'transport', '甲游客中心', '甲景区停车场', 'bus');
  assert(R.executionIssues([row], context).some((issue) => issue.includes('同址')));
  const clean = R.normalizeReviewRows([row], 0, context)[0];
  assert.equal(clean.endLocation, '甲景区停车场'); assert(!clean.startLocation);
  assert(R.executionIssues([clean], context).some((issue) => issue.includes('同址')));
});
test('孤立取件、矛盾携行李、交通游览合并均拦截', () => {
  assert(R.executionIssues([item('取回寄存行李', 'other', '甲存包处', '甲存包处', '')], {}).some((issue) => issue.includes('没有同地点')));
  assert(R.executionIssues([item('携带全部大件行李，只携带随身小包前往码头')], {}).some((issue) => issue.includes('矛盾')));
  assert(R.executionIssues([item('乘车前往甲景区并游览')], {}).some((issue) => issue.includes('交通与景区游览合并')));
});
test('首日出行、为明日日出准备不是今天看日出；住宿不强制当晚进园', () => {
  assert(!R.executionIssues([item('国庆首日出行高峰，前往车站')], {}).includes('日出安排过晚'));
  assert(!R.executionIssues([item('早睡为第二天的日出做准备', 'hotel', '', '甲酒店', '')], {}).includes('日出安排过晚'));
  const days = [{ overnight: '甲瀑布附近', highlights: [] }, { highlights: ['甲瀑布'] }];
  assert.deepEqual(R.requiredPlacesForDay({ mustVisit: ['甲瀑布'] }, days, 0), []);
  assert.deepEqual(R.requiredPlacesForDay({ mustVisit: ['甲瀑布'] }, days, 1), ['甲瀑布']);
});
test('太阳固定窗口仅作用于真实观景，不把上山和看日落锁成重叠', () => {
  const access = Object.assign(item('徒步上行前往甲山观景台，观赏日落', 'sight', '', '甲山', ''), { startTime: '15:00', endTime: '17:00' });
  const view = Object.assign(item('在甲山等待并观赏日落', 'sight', '', '甲山', ''), { startTime: '17:00', endTime: '18:00' });
  const clean = R.normalizeReviewRows([access, view], 0, { solar: [{ activity: '甲山日落', startTime: '17:30', endTime: '18:20' }] });
  assert.equal(clean[0].startTime, '15:00'); assert.equal(clean[1].startTime, '17:30');
});
test('提醒归并恢复唯一实际使用日期，保留不同铁路段及独立景区/索道票', () => {
  const future = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
  const rows = [item('乘坐D1001从甲站到乙站'), item('乘索道游览', 'sight', '甲索道下站', '甲山', '')];
  const ctx = { startDate: future, items: rows, days: [{ index: 0, title: '甲梯田', lines: [] }] };
  const nominees = [{ type: 'train', title: '订D1001火车票', source: 'ai', fireAt: Date.parse(future + 'T09:00:00+08:00') - 13 * 86400000 },
    { type: 'ticket', title: '订索道票', source: 'ai', fireAt: Date.parse(future + 'T09:00:00+08:00') - 6 * 86400000 }];
  const alarms = A.completeReservationAlarms(ctx, nominees);
  assert.equal(alarms.filter((a) => a.type === 'train').length, 1);
  assert.equal(alarms.filter((a) => a.type === 'ticket').length, 2);
});
test('取回跨日寄存须有真实动作，电动车和去码头不能生成火车/体验票', () => {
  const stored = Object.assign(item('在甲存包处寄存大件行李', 'other', '', '甲存包处', ''), { dayIndex: 0 });
  assert.deepEqual(R.previousStoragePlaces([stored], 2), ['甲存包处']);
  const future = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
  const rows = [item('租电动车骑行至竹筏码头', 'transport', '甲酒店', '甲码头', 'ride'), item('步行前往索道游客中心', 'transport', '', '甲索道游客中心', 'walk')];
  assert(!A.backfillRuleAlarms({ startDate: future, items: rows }, []).some((alarm) => ['train', 'ticket'].includes(alarm.type)));
  const geo = require('../cloudfunctions/generatePlan/geocode');
  assert(!geo.isBookableHotelPoi({ name: '甲城星光酒店自助餐' }, ['甲城']));
});
test('提醒不截前六条，同日不同车次分别保存，已有很多提醒不漏后续票务', () => {
  const rows = Array.from({ length: 8 }, (_, i) => item('普通游览' + i, 'sight', '', '甲景点', ''));
  rows.push(item('乘坐D1001从甲站到乙站'), item('乘坐D1003从乙站到丙站', 'transport', '乙站', '丙站'));
  rows.push(item('乘索道游览', 'sight', '', '甲山', ''));
  const future = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
  const context = { startDate: future, endDate: future, items: rows };
  assert(A.dayBrief(rows, future).includes('D1003'));
  const existing = [{ title: `准备${future} D1001`, type: 'train', fireAt: Date.parse(future + 'T09:00:00+08:00') - 14 * 86400000 }];
  const alarms = A.backfillRuleAlarms(context, existing);
  assert(alarms.some((alarm) => alarm.type === 'train' && alarm.title.includes('D1003')));
  assert(!alarms.some((alarm) => alarm.type === 'train' && alarm.title.includes('D1001')));
  assert(alarms.some((alarm) => alarm.type === 'ticket' && alarm.title.includes('索道')));
});
test('去车站的实际移动不受错误分类影响，候车无需另造接驳', () => {
  const access = Object.assign(item('携带全部行李前往乙站', 'other', '甲酒店', '乙站', ''), { startTime: '06:15', endTime: '06:45' });
  const train = Object.assign(item('乘动车出发', 'transport', '乙站', '丙站', 'train'), { startTime: '07:30', endTime: '09:00' });
  const rows = R.normalizeReviewRows([access, train], 0, { previousHotel: '甲酒店' });
  assert.equal(rows[0].category, 'transport');
  assert(!R.executionIssues(rows, { previousHotel: '甲酒店' }).some((issue) => issue.includes('缺少昨晚酒店')));
});
test('重排后参考铁路组合必须能到家，并保留同站40分钟或跨站90分钟换乘', () => {
  const rows = [item('乘动车', 'transport', '甲站', '乙站'), item('乘动车', 'transport', '乙站', '丙站')];
  const choices = [{ meta: { reference: true, referenceDate: '2026-10-17', sourceUrl: 'https://operator.example' }, list: [
    { code: 'D1001', from: '甲站', to: '乙站', s: '08:00', e: '09:00' }] },
  { meta: { reference: true, referenceDate: '2026-10-17', sourceUrl: 'https://operator.example' }, list: [
    { code: 'D1002', from: '乙站', to: '丙站', s: '09:20', e: '12:00' },
    { code: 'D1004', from: '乙站', to: '丙站', s: '09:50', e: '12:40' },
    { code: 'D1006', from: '乙站', to: '丙站', s: '14:30', e: '18:00' }] }];
  const picked = R.selectExecutionSchedules(rows, choices, { isLast: true, backTime: '16:00', homeAccessMin: 60 });
  assert.equal(picked[1].code, 'D1004'); assert.equal(picked[1].schedSource, 'reference');
});
test('备注提及寄存不是实际寄存，跨日已取回不可再次取回', () => {
  const view = item('游览甲山', 'sight', '', '甲山', ''); view.note = '大件行李已在甲酒店寄存，只带小包';
  const pickup = item('取回行李', 'other', '', '甲山', '');
  assert(R.executionIssues([view, pickup], {}).some((issue) => issue.includes('没有同地点')));
  const second = Object.assign({}, pickup, { startTime: '17:00', endTime: '18:00' });
  assert(R.executionIssues([pickup, second], { previousStorage: ['甲山'] }).some((issue) => issue.includes('没有同地点')));
});
test('汽车提醒按实际线路去重并纠正 AI 购票日和乘车日混淆', () => {
  const date = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
  const ctx = { startDate: date, items: [item('乘大巴从甲城到乙山景区', 'transport', '甲城汽车站', '乙山景区游客中心', 'bus')] };
  const nominee = { type: 'bus', source: 'ai', title: `预订${date}甲城到乙山景区大巴`, fireAt: Date.parse(date + 'T10:00:00+08:00') - 4 * 86400000 };
  const alarms = A.completeReservationAlarms(ctx, [nominee]);
  assert.equal(alarms.filter((alarm) => alarm.type === 'bus').length, 1);
  assert(alarms[0].usageInfo.includes(date));
});
test('原文明示次日票起售时刻优先，不覆盖成提前七天关注时间', () => {
  const date = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
  const ctx = { startDate: date, items: [item('体验竹筏漂流', 'sight', '甲码头', '乙码头', '')],
    days: [{ index: 0, title: '甲河', lines: ['体验竹筏漂流，每天20:00抢第二天的票。'] }] };
  const alarm = A.completeReservationAlarms(ctx, []).find((entry) => entry.type === 'ticket');
  assert(alarm.fireAtStr.endsWith('20:00'));
  assert.equal(new Date(date + 'T00:00:00+08:00').getTime() - alarm.fireAt, 4 * 3600000);
});
test('模型误标游船为 train 时，依据主动作恢复船舶与船票', () => {
  const row = item('乘坐甲江三星游船前往乙城', 'transport', '甲码头', '乙码头', 'train');
  const normalized = require('../cloudfunctions/parseTravelPlan/normalize').sanitizeItems([row]);
  assert.equal(normalized[0].transportType, 'ship');
  const date = new Date(Date.now() + 80 * 86400000).toISOString().slice(0, 10);
  const alarms = A.completeReservationAlarms({ startDate: date, items: [row] }, []);
  assert(!alarms.some((alarm) => alarm.type === 'train'));
  assert(alarms.some((alarm) => alarm.type === 'ticket'));
});
test('改分类和抵达住宿点不能绕过中途非必要折返校验', () => {
  const rows = [item('游览甲山', 'sight', '', '甲山', ''),
    Object.assign(item('抵达住宿点，稍作休息整理仪容', 'other', '', '甲住宿地', ''), { startTime: '16:00', endTime: '16:30' }),
    Object.assign(item('游览乙山', 'sight', '', '乙山', ''), { startTime: '16:30', endTime: '18:00' })];
  assert(R.executionIssues(rows, {}).some((issue) => issue.includes('改分类')));
  assert(!R.executionIssues(rows, { middayRest: true }).some((issue) => issue.includes('改分类')));
});
test('锁定返程班次后只整体提前道路接驳准备，不缩短路程或改变列车', () => {
  const breakfast = Object.assign(item('早餐及退房准备', 'food', '', '甲酒店', ''), { startTime: '06:30', endTime: '07:15' });
  const access = Object.assign(item('乘网约车前往乙站', 'transport', '甲酒店', '乙站', 'ride'), { startTime: '07:15', endTime: '09:15' });
  const wait = Object.assign(item('安检候车', 'other', '', '乙站', ''), { startTime: '09:15', endTime: '09:55' });
  const train = Object.assign(item('乘坐D1001次列车', 'transport', '乙站', '丙站', 'train'), { startTime: '09:25', endTime: '13:56' });
  const context = { isLast: true, accessConstraint: { trainCode: 'D1001' },
    references: [{ code: 'D1001', startLocation: '乙站', endLocation: '丙站', startTime: '09:25', endTime: '13:56' }] };
  const clean = R.fitLockedReturnAccess([breakfast, access, wait, train], context);
  assert.equal(clean[1].startTime, '06:45'); assert.equal(clean[1].endTime, '08:45');
  assert.equal(clean[2].endTime, '09:25'); assert.equal(clean[3].startTime, '09:25');
  assert.equal(R.minute(clean[1].endTime) - R.minute(clean[1].startTime), 120);
  assert.equal(R.fitLockedReturnAccess([breakfast, access, wait, train], { ...context, isFirst: true })[1].startTime, '07:15');
});
test('删除中途纯酒店休整而保留首次入住和用户明确午休', () => {
  const rows = [item('游览甲山', 'sight', '', '甲山', ''),
    Object.assign(item('抵达住宿点，稍作休息整理仪容', 'other', '', '甲住宿地', ''), { startTime: '16:00', endTime: '16:30' }),
    Object.assign(item('游览乙山', 'sight', '', '乙山', ''), { startTime: '16:30', endTime: '18:00' })];
  assert.equal(R.normalizeReviewRows(rows, 0, {}).length, 2);
  assert.equal(R.normalizeReviewRows(rows, 0, { middayRest: true }).length, 3);
});
test('午夜零时长回房只补合理入住并整体提前，不缩短道路下限或掩盖其他重叠', () => {
  const food = Object.assign(item('晚餐', 'food', '', '甲餐馆', ''), { startTime: '22:00', endTime: '23:00' });
  const ride = Object.assign(item('乘网约车前往酒店', 'transport', '甲餐馆', '乙酒店', 'ride'), { startTime: '23:00', endTime: '23:59' });
  const hotel = Object.assign(item('回房休息', 'hotel', '', '乙酒店', ''), { startTime: '23:59', endTime: '23:59' });
  const context = { hotel: '乙酒店', routeFacts: [{ from: '甲餐馆', to: '乙酒店', mode: 'ride', minMinutes: 60 }] };
  const clean = R.normalizeReviewRows([food, ride, hotel], 0, context);
  assert.equal(clean[1].startTime, '22:40'); assert.equal(clean[1].endTime, '23:40');
  assert.equal(clean[2].startTime, '23:40'); assert.equal(clean[2].endTime, '23:55');
  assert(!R.executionIssues(clean, context).some((issue) => /无效|重叠|交通下限/.test(issue)));
  const bad = [{ ...food, endTime: '23:15' }, ride, hotel];
  assert(R.executionIssues(R.normalizeReviewRows(bad, 0, context), context).some((issue) => /重叠/.test(issue)));
  const missing = R.normalizeReviewRows([food, { ...ride, endTime: '00:00' }], 0, context);
  assert.equal(missing.length, 3); assert.equal(missing[2].category, 'hotel');
  assert(!R.executionIssues(missing, context).some((issue) => /无效|重叠|交通下限|缺少当晚/.test(issue)));
});
test('等价字段只恢复明确时间范围，不猜缺失时刻或抹去重叠', () => {
  const clean = R.normalizeReviewRows([{ time: '14:00–16:00', description: '游览甲山', type: 'sight', location: '甲山' },
    { timeRange: '15:00-17:00', title: '游览乙山', type: 'sight', to: '乙山' }], 0, {});
  assert.equal(clean[0].startTime, '14:00'); assert.equal(clean[0].endTime, '16:00');
  assert.equal(clean[1].startTime, '15:00'); assert.equal(clean[1].endTime, '17:00');
  assert(R.executionIssues(clean, {}).some((issue) => issue.includes('重叠')));
  const missing = R.normalizeReviewRows([{ title: '游览甲山', location: '甲山' }], 0, {});
  assert.equal(missing[0].startTime, '');
});
test('已查班次与旧接驳冲突时整天重排，结构错误不能丢失重排状态', () => {
  const context = { references: [{ startTime: '13:32' }] };
  assert(R.needsWholeDayRebuild({ executionReviewIssues: ['时段重叠；13:32早于前段结束14:00'] }, [], context));
  assert(R.needsWholeDayRebuild({ executionReviewIssues: ['铁路进站接驳没有40分钟安检缓冲'] }, [], context));
  assert(R.needsWholeDayRebuild({ executionForceReroute: true, executionReviewIssues: ['输出缺少items'] }, [], context));
  assert(!R.needsWholeDayRebuild({ executionForceReroute: true }, [], { ...context, isLast: true }));
  assert(!R.needsWholeDayRebuild({ executionReviewIssues: ['菜品重复'] }, [], context));
  assert(R.needsWholeDayRebuild({ executionRepairFailures: 1, executionReviewIssues: ['寄存行李未在离开前取回'] }, [], {}));
});
test('长途巴士误分类为other不能绕过真实交通下限', () => {
  const row = item('转场至乙城', 'other', '甲城汽车站', '乙城汽车站', 'bus');
  const context = { routeFacts: [{ from: row.startLocation, to: row.endLocation, mode: 'bus', minMinutes: 360 }] };
  const clean = R.normalizeReviewRows([row], 0, context);
  assert.equal(clean[0].category, 'transport');
  assert(R.minute(clean[0].endTime) - R.minute(clean[0].startTime) >= 360);
  assert(R.executionIssues([{ ...row, category: 'transport' }], context).some((issue) => issue.includes('交通下限')));
});
test('已有实际寄存时不再自动追加必须带走全部行李的矛盾备注', () => {
  const row = item('办理退房，在甲酒店寄存大件行李', 'hotel', '', '甲酒店', '');
  const clean = R.normalizeReviewRows([row], 1, { previousHotel: '甲酒店', hotel: '乙酒店' });
  assert(!clean[0].note.includes('不留在昨晚酒店'));
  assert(clean[0].note.includes('原地取回'));
});
test('寄存备注提及后续取回不能跳过寄存或提前消费行李状态', () => {
  const store = { ...item('在甲存包处寄存大件行李', 'other', '', '甲存包处', ''), startTime: '08:00', endTime: '08:15', note: '游览结束后在原地取回行李' };
  const view = { ...item('体验竹筏漂流', 'sight', '甲码头', '乙码头', 'ship'), startTime: '08:15', endTime: '09:45' };
  const pickup = { ...item('取回寄存的大件行李', 'other', '', '甲存包处', ''), startTime: '10:00', endTime: '10:15' };
  const context = { previousHotel: '甲酒店', hotel: '乙酒店' };
  const issues = R.executionIssues(R.normalizeReviewRows([store, view, pickup], 1, context), context);
  assert(!issues.some((issue) => /没有有效寄存|没有同地点|未在离开前取回|不便随身/.test(issue)));
});
test('已定位的独立核心点不能仅塞进别处的标题充作游览', () => {
  const row = item('游览甲观景台与乙观景台', 'sight', '甲酒店', '甲观景台', '');
  const context = { highlights: ['乙观景台'], points: { '乙观景台': { lon: 110, lat: 25, areaAnchor: false } } };
  assert(R.executionIssues([row], context).some((issue) => issue.includes('缺少实际游览位置')));
  assert(!R.executionIssues([{ ...row, endLocation: '乙观景台' }], context).some((issue) => issue.includes('缺少实际游览位置')));
  assert(!R.executionIssues([row], { highlights: ['乙观景台'], points: { '乙观景台附近酒店': { lon: 110, lat: 25 } } })
    .some((issue) => issue.includes('缺少实际游览位置')));
  assert(!R.executionIssues([{ ...row, activity: '游览甲观景台' }], context).some((issue) => issue.includes('缺少实际游览位置')));
  assert(R.executionIssues([{ ...row, activity: '游览甲观景台' }], { ...context, required: ['乙观景台'] })
    .some((issue) => issue.includes('缺少实际游览位置')));
});
test('电动车和去车站接驳不展示列车班次提示，近期参考提示保留资料日期', () => {
  let component;
  const old = global.Component;
  global.Component = (value) => { component = value; };
  try { require('../miniprogram/components/activity-item/activity-item'); } finally { global.Component = old; }
  const tip = component.methods.schedTip;
  assert.equal(tip({ category: 'transport', activity: '租电动车骑行', transportType: 'ride' }), '');
  assert.equal(tip({ category: 'transport', activity: '网约车前往高铁站', transportType: 'ride' }), '');
  assert(tip({ category: 'transport', activity: '乘D1001', transportType: 'train', schedSource: 'reference', referenceDate: '2026-10-17' })
    .includes('2026-10-17'));
});
test('住宿内晚餐延长后仅顺延回房收尾，不修改其他冲突或固定窗口', () => {
  const dinner = { ...item('晚餐', 'food', '', '甲酒店', ''), startTime: '19:00', endTime: '20:30' };
  const room = { ...item('回房休息', 'hotel', '', '甲酒店', ''), startTime: '19:45', endTime: '20:00' };
  const rows = R.normalizeReviewRows([dinner, room], 1, { hotel: '甲酒店' });
  assert.equal(rows[1].startTime, '20:30'); assert.equal(rows[1].endTime, '20:45');
  assert.equal(R.normalizeReviewRows([dinner, room], 1, { hotel: '甲酒店', isLast: true })[1].startTime, '19:45');
});
test('未保存太阳窗口时用已定位观景位置估算，不用行政中心或明日准备', () => {
  const row = item('观赏甲山日落', 'sight', '', '甲山', '');
  const ctx = { date: '2027-10-01', points: { '甲山': { lon: 110.15, lat: 25.8 } } };
  const facts = R.deriveSolarWindows([row], ctx);
  assert.equal(facts.length, 1); assert(R.minute(facts[0].startTime) > 17 * 60);
  assert.equal(R.deriveSolarWindows([row], { ...ctx, points: { '甲山': { lon: 110.15, lat: 25.8, areaAnchor: true } } }).length, 0);
  assert.equal(R.deriveSolarWindows([{ ...row, activity: '为明日日落拍摄做准备' }], ctx).length, 0);
});
test('已放行李后两个景点间只为随身小件折返住宿的文案规范为直接接续', () => {
  const stay = { ...item('办理入住放下行李', 'hotel', '', '甲酒店', ''), startTime: '10:00', endTime: '10:30' };
  const leg = { ...item('返回甲酒店取回随身物品并前往乙索道站', 'transport', '甲观景台', '乙索道站', 'walk'), startTime: '15:00', endTime: '16:00' };
  const context = { hotel: '甲酒店' };
  const clean = R.normalizeReviewRows([stay, leg], 1, context)[1];
  assert(!clean.activity.includes('返回甲酒店')); assert.equal(clean.startTime, '15:00'); assert.equal(clean.endTime, '16:00');
  assert(R.normalizeReviewRows([stay, { ...leg, activity: '返回甲酒店取回寄存的大件行李并前往乙索道站' }], 1, context)[1].activity.includes('取回寄存'));
});
test('未购中间转场赶不上班次可换实际较晚候选，已购票和首末日不可自动换', () => {
  const access = { ...item('前往甲站', 'transport', '甲景区', '甲站', 'ride'), startTime: '14:00', endTime: '15:00' };
  const rail = { ...item('乘坐G1列车', 'transport', '甲站', '乙站', 'train'), startTime: '14:30', endTime: '15:30' };
  const list = [{ code: 'G1', from: '甲站', to: '乙站', s: '14:30', e: '15:30' },
    { code: 'G2', from: '甲站', to: '乙站', s: '15:30', e: '16:30' },
    { code: 'G3', from: '甲站', to: '乙站', s: '16:00', e: '17:00' }];
  const day = { moves: [{ from: '甲站', to: '乙站', mode: 'train', code: 'G1' }],
    executionCandidate: [access, rail], executionScheduleChoices: [{ list, meta: { reference: true,
      referenceDate: '2026-10-10', sourceUrl: 'https://example.com/rail' } }] };
  const ctx = { references: [{ startLocation: '甲站', endLocation: '乙站' }], official: [] };
  for (const constraint of ['isFirst', 'isLast', 'railAlreadyBooked'])
    assert(!R.deferUnbookedRail(day, [access, rail], { ...ctx, [constraint]: true }));
  assert(R.deferUnbookedRail(day, [access, rail], ctx));
  assert.equal(day.moves[0].code, 'G3'); assert.equal(day.moves[0].startTime, '16:00');
  assert.equal(day.moves[0].endTime, '17:00'); assert.equal(day.moves[0].schedSource, 'reference');
  assert.equal(day.executionCandidate, undefined); assert.equal(day.executionReviewAttempted, false);
  assert(!R.deferUnbookedRail({ ...day, executionRailDeferrals: 2 }, [access, rail], ctx));
});
test('导航扩张上游耗时优先消费多余候车，仍留40分钟且不改固定列车', () => {
  const ride = { ...item('乘网约车前往甲站', 'transport', '甲景区', '甲站', 'ride'), startTime: '12:00', endTime: '14:00' };
  const wait = { ...item('安检及候车', 'other', '', '甲站', ''), startTime: '14:00', endTime: '16:00' };
  const rail = { ...item('乘坐G1列车', 'transport', '甲站', '乙站', 'train'), startTime: '16:00', endTime: '17:00' };
  const context = { references: [{ startLocation: '甲站', endLocation: '乙站', code: 'G1', startTime: '16:00', endTime: '17:00' }],
    routeFacts: [{ from: '甲景区', to: '甲站', mode: 'ride', minMinutes: 150 }] };
  const clean = R.normalizeReviewRows([ride, wait, rail], 1, context);
  assert.equal(clean[0].endTime, '14:30'); assert.equal(clean[1].startTime, '14:30');
  assert.equal(clean[1].endTime, '16:00'); assert.equal(clean[2].startTime, '16:00');
  assert(!R.executionIssues(clean, context).some((issue) => /重叠|安检缓冲/.test(issue)));
  const short = R.normalizeReviewRows([{ ...ride, startTime: '13:00', endTime: '15:00' },
    { ...wait, startTime: '15:00' }, rail], 1, context);
  assert(R.executionIssues(short, context).some((issue) => /重叠|安检缓冲/.test(issue)));
});
console.log(`旅行质量专项：${count} 项通过`);
