// 真实寄存动作与无法按时到家的自动选路：只用虚拟地点和独立查询桩。
const assert = require('assert');
const R = require('../cloudfunctions/generatePlan/execution-review');
const S = require('../cloudfunctions/generatePlan/schedule');
const P = require('../cloudfunctions/generatePlan/plan');
const rail12306 = require('../cloudfunctions/generatePlan/rail12306');
const clone = (value) => JSON.parse(JSON.stringify(value));
const row = (startTime, endTime, category, activity, startLocation, endLocation, transportType = '', note = '') =>
  ({ dayIndex: 1, startTime, endTime, category, activity, startLocation, endLocation, transportType, note });

const store = row('09:00', '09:15', 'other', '办理寄存/准备入园', '甲游客中心寄存处', '甲游客中心寄存处', '',
  '将大件行李存入景区官方寄存柜，轻装入园');
const sight = row('09:15', '11:15', 'sight', '徒步游览甲山', '甲入口', '甲观景台');
const pickup = row('11:15', '11:30', 'other', '取回全部大件行李', '甲游客中心寄存处', '甲游客中心寄存处');
const context = { hotel: '乙酒店', previousHotel: '丙酒店' };
const luggageIssues = (rows) => R.executionIssues(rows, context).filter((issue) => /大件|行李|取回.*寄存/.test(issue));
assert.equal(luggageIssues([store, sight, pickup]).length, 0, '动作标题明确办理，备注补充物品且导航精确，不能漏掉真实寄存');
assert(luggageIssues([{ ...store, activity: '准备入园' }, sight, pickup]).length, '只有备注不能凭空产生寄存动作');
assert(luggageIssues([{ ...store, note: '早上已寄存行李' }, sight, pickup]).length, '备注过去完成不能补造本次存放状态');
assert(luggageIssues([{ ...store, note: '如需寄存大件行李，先询问' }, sight, pickup]).length, '条件安排不是已决定的实际寄存');
assert(luggageIssues([{ ...store, activity: '准备寄存大件行李，需确认' }, sight, pickup]).length, '尚待确认不应生成实际存放状态');
assert(luggageIssues([store, sight, { ...pickup, startLocation: '另一游客中心寄存处', endLocation: '另一游客中心寄存处' }])
  .some((issue) => /不一致/.test(issue)), '实际寄存仍不能在另一地点取回');
assert(R.previousStoragePlaces([{ ...store, dayIndex: 0 }], 1).includes(store.endLocation), '跨日沿用同一动作判据');
assert(!R.previousStoragePlaces([{ ...store, activity: '准备入园', dayIndex: 0 }], 1).includes(store.endLocation));
assert(!R.previousStoragePlaces([{ ...store, dayIndex: 0 }, { ...pickup, dayIndex: 0 }], 1).includes(store.endLocation),
  '已取走的存放状态不能再跨日继承');
const qualifiedPickup = { ...pickup, activity: '取回甲山游客中心寄存的大件行李' };
assert.equal(luggageIssues([store, sight, qualifiedPickup]).length, 0, '取件动词与物品间允许明确的存放地点限定');
assert(!R.previousStoragePlaces([{ ...store, dayIndex: 0 }, { ...qualifiedPickup, dayIndex: 0 }], 1).includes(store.endLocation),
  '带地点限定的取回同样消费跨日状态');
assert(luggageIssues([store, sight, { ...qualifiedPickup, startLocation: '乙中心寄存处', endLocation: '乙中心寄存处' }])
  .some((issue) => /不一致/.test(issue)), '标题中的地点不能代替实际导航');
assert(luggageIssues([store, sight, { ...qualifiedPickup, activity: '明天取回甲山游客中心寄存的大件行李' }])
  .some((issue) => /未在离开前取回/.test(issue)), '未来取件仍不消费状态');
assert(luggageIssues([store, sight, { ...qualifiedPickup, activity: '取回门票并寄存行李' }])
  .some((issue) => /未在离开前取回/.test(issue)), '另一办理动作不能因放宽限定词冒充取件');
assert.equal(luggageIssues([{ ...store, note: '将大件行李存入柜内，之后原地取回' }, sight, pickup]).length, 0,
  '当前明确寄存后备注未来取件，不影响当前真实存放');
const pickupArea = '甲站出租车/网约车上客区';
const stationAccess = [row('14:00', '14:20', 'other', '出站前往上客区', '甲站', pickupArea),
  row('14:20', '15:00', 'transport', '乘网约车回家', pickupArea, '用户家', 'ride')];
const chosen = R.normalizeReviewRows(stationAccess, 1);
assert.equal(chosen[0].endLocation, '甲站网约车上客区'); assert.equal(chosen[1].startLocation, chosen[0].endLocation);
assert.equal(R.normalizeReviewRows(stationAccess.map((r) => ({ ...r, activity: r.activity.replace('网约车回家', '出租车回家') })), 1)[0].endLocation,
  '甲站出租车上客区');
assert.equal(R.normalizeReviewRows(stationAccess.map((r) => ({ ...r, activity: '乘出租车或网约车' })), 1)[0].endLocation,
  pickupArea, '实际方式未选定不能猜服务点');
assert.equal(R.normalizeReviewRows(stationAccess.map((r) => ({ ...r, startLocation: r.category === 'transport' ? '另一站' : r.startLocation })), 1)[0].endLocation,
  pickupArea, '另一枢纽的交通不能决定当前服务点');
assert.equal(stationAccess[0].endLocation, pickupArea, '不改原候选');

const preparingCheckout = row('07:00', '07:30', 'food', '早餐并整理行李准备退房', '', '丙酒店');
const actualCheckout = row('07:30', '07:45', 'hotel', '办理退房并携带全部行李', '', '丙酒店');
const checkoutIssues = (rows) => R.executionIssues(rows, {}).filter((issue) => /退房/.test(issue));
assert.equal(checkoutIssues([preparingCheckout, actualCheckout]).length, 0, '准备不是第二次实际办理退房');
assert(checkoutIssues([actualCheckout, { ...actualCheckout, startTime: '08:00', endTime: '08:15' }]).length,
  '两次实际办理退房仍拒绝');
assert(checkoutIssues([{ ...preparingCheckout, activity: '准备退房并办理退房手续' }, actualCheckout]).length,
  '复合实际办理仍消费退房状态');
const stationWaits = [row('08:00', '08:30', 'transport', '打车前往甲站', '丙酒店', '甲站', 'ride'),
  row('08:30', '08:50', 'other', '进站安检并候车', '', '甲站'),
  row('08:50', '09:20', 'other', '前往检票口并候车', '', '甲站'),
  row('09:20', '10:20', 'transport', '乘D2001到乙站', '甲站', '乙站', 'train')];
const waitContext = { official: [{ code: 'D2001', startLocation: '甲站', endLocation: '乙站', startTime: '09:20', endTime: '10:20' }] };
assert(!R.executionIssues(R.normalizeReviewRows(stationWaits, 1, waitContext), waitContext).some((issue) => /40分钟/.test(issue)),
  '站内候车不当成09:20才到站的外部接驳');
assert(R.executionIssues(R.normalizeReviewRows(stationWaits.map((r, i) => i === 0 ? { ...r, endTime: '08:50' } : r), 1, waitContext), waitContext)
  .some((issue) => /40分钟/.test(issue)), '真实到站过晚仍拦截');
const combinedCheckout = [row('07:30', '08:10', 'hotel', '退房并携行李前往甲站', '丙酒店', '甲站', 'ride'), stationWaits.at(-1)];
assert(R.executionIssues(combinedCheckout, { ...waitContext, previousHotel: '丙酒店' })
  .some((issue) => /索引0把退房与跨地点接驳合在hotel条目/.test(issue)), '反馈指出实际合并索引，不让模型反复认为已有接驳');
const lateStationStages = [row('07:50', '08:20', 'transport', '打车前往甲站', '丙酒店', '甲站', 'ride'),
  row('08:20', '08:35', 'other', '进站安检', '甲站', '甲站进站口'),
  row('08:35', '08:45', 'transport', '步行前往检票口', '甲站进站口', '甲站检票口', 'walk'),
  row('08:45', '08:50', 'other', '检票候车', '甲站检票口', '甲站'),
  row('08:50', '09:50', 'transport', '乘D2001到乙站', '甲站', '乙站', 'train'),
  row('09:50', '10:20', 'transport', '乘车前往乙酒店', '乙站', '乙酒店', 'ride'),
  row('10:20', '10:35', 'hotel', '办理入住并休息', '乙酒店', '乙酒店')];
const stationStageContext = { hotel: '乙酒店', previousHotel: '丙酒店', official: [
  { code: 'D2001', startLocation: '甲站', endLocation: '乙站', startTime: '08:50', endTime: '09:50' }] };
const earlyStationStages = R.advanceFlexibleRailAccess(lateStationStages, stationStageContext);
assert.notEqual(earlyStationStages, lateStationStages, '多条安检/站内步行/候车可以整体倒排，不反复交模型局修');
assert.equal(earlyStationStages[0].endTime, '08:10');
assert.equal(R.minute(earlyStationStages[2].endTime) - R.minute(earlyStationStages[2].startTime), 10, '不能压缩站内实际移动');
assert.equal(earlyStationStages[4].startTime, '08:50'); assert.equal(earlyStationStages[4].endTime, '09:50');
assert.equal(earlyStationStages[3].endTime, '08:50', '只补足候车等待，不移动班次');
assert.equal(R.executionIssues(earlyStationStages, stationStageContext).length, 0, '采用前完整验收');
const platformStages = lateStationStages.map((r, i) => i === 3 ? { ...r, endLocation: '甲站2号站台' } : r);
const advancedPlatform = R.advanceFlexibleRailAccess(platformStages, stationStageContext);
assert.notEqual(advancedPlatform, platformStages, '候车最后导航到同一真实车站的站台也能倒排，不反复交模型修缓冲');
assert.equal(advancedPlatform[0].endTime, '08:10');
assert.equal(advancedPlatform[3].endTime, '08:50');
assert.equal(R.executionIssues(advancedPlatform, stationStageContext).length, 0, '站台倒排仍完整验收40分钟、真实班次及每段移动');
const otherPlatform = platformStages.map((r, i) => i === 3 ? { ...r, endLocation: '另一站2号站台' } : r);
assert.equal(R.advanceFlexibleRailAccess(otherPlatform, stationStageContext), otherPlatform, '不能把另一站站台当成同一枢纽');
const wrongHubStages = lateStationStages.map((r, i) => i === 2 ? { ...r, endLocation: '另一站检票口' } : r);
assert.equal(R.advanceFlexibleRailAccess(wrongHubStages, stationStageContext), wrongHubStages, '不同车站不是站内流程');

const meal = row('12:00', '13:00', 'food', '午餐：甲城砂锅鱼', '', '甲餐厅', '', '推荐菜品：甲城砂锅鱼');
meal.mealNames = ['甲城砂锅鱼'];
const mealIssues = (r, c) => R.executionIssues([r], c).filter((issue) => /重复推荐主菜/.test(issue));
assert(mealIssues(meal, { followingMeals: ['砂锅鱼'] }).length, '地区前缀不能掩盖与后日同一道主菜');
assert(mealIssues({ ...meal, activity: '午餐：砂锅鱼', note: '推荐菜品：砂锅鱼', mealNames: ['砂锅鱼'] },
  { previousMeals: ['甲城砂锅鱼'] }).length, '同菜名的识别方向对称');
assert.equal(mealIssues(meal, { followingMeals: ['砂锅鱼'], repeatMeals: '连续两天都要吃砂锅鱼' }).length, 0, '用户明确重复偏好仍保留');
assert.equal(mealIssues(meal, { followingMeals: ['清蒸鱼'] }).length, 0, '共同短词不代表同一道菜');
const lakeNight = row('20:00', '21:00', 'sight', '游览甲湖景区沿湖步道', '', '甲湖步道', '',
  '无需乘船，沿湖步道观赏灯光夜景');
const nightIssues = (r, c = {}) => R.executionIssues([r], c).filter((issue) => /日间景区被排到深夜|超过景区/.test(issue));
assert.equal(nightIssues(lakeNight).length, 0, '标题含景区但实际备注明确沿湖夜景，不误报深夜入园');
assert(nightIssues({ ...lakeNight, note: '明天安排灯光夜景' }).length, '未来夜景说明不豁免当前深夜游览');
assert(nightIssues({ ...lakeNight, note: '禁止夜游' }).length, '否定夜游不能豁免');
assert(R.executionIssues([lakeNight], { visitWindows: [{ place: '甲湖', closeTime: '18:00',
  sourceUrl: 'https://operator.example/opening' }] }).some((issue) => /游览和出园接驳应在18:00/.test(issue)),
  '备注明确夜景也不能覆盖已核查的实际闭园窗口');

const reviewedHotelRows = [
  row('07:30', '07:45', 'hotel', '退房并携带全部行李', '丙酒店', '丙酒店'),
  row('07:45', '10:15', 'transport', '乘大巴前往乙城', '丙酒店', '乙城汽车站', 'bus'),
  row('10:15', '10:45', 'transport', '打车前往今晚酒店', '乙城汽车站', '乙酒店', 'ride'),
  row('10:45', '11:00', 'hotel', '办理入住并安放行李', '乙酒店', '乙酒店'),
].map((r) => ({ ...r, executionReview: R.REVIEW_VERSION, executionReviewStatus: 'passed' }));
const reviewedSnapshot = clone(reviewedHotelRows);
const hotelOutline = { days: [{ hotel: '丙酒店' }, { hotel: '乙酒店', hotelPoiVerified: true }] };
assert.deepEqual(P.annotateHotelItems(reviewedHotelRows, hotelOutline), reviewedSnapshot,
  '保存前酒店整理不改写已验收的旧酒店/真实跨城交通/正文和备注');
assert.deepEqual(reviewedHotelRows, reviewedSnapshot, '不得旁路修改已验收对象');
assert.equal(P.annotateHotelItems([row('19:00', '19:15', 'hotel', '入住', '', '乙酒店')], hotelOutline)[0].bookingInfo,
  '乙酒店', '未验收初稿仍正常补酒店展示信息');
const specificStore = '甲古镇游客服务中心/指定寄存处';
const placeholderRows = [row('09:00', '09:15', 'transport', '前往寄存处', '甲站', specificStore, 'ride'),
  { ...store, startTime: '09:15', endTime: '09:30', startLocation: '', endLocation: specificStore },
  { ...pickup, startTime: '11:00', endTime: '11:15', startLocation: '', endLocation: specificStore },
  row('11:15', '12:00', 'transport', '前往酒店', specificStore, '乙酒店', 'ride')];
const definiteStoreRows = R.normalizeReviewRows(placeholderRows, 1);
assert(definiteStoreRows.every((r) => !String(r.startLocation + r.endLocation).includes('/')),
  '唯一具名地点选定后统一实际寄存/取件/接驳，不把泛称备选当另一具名地点');
assert(!luggageIssues(definiteStoreRows).length);
const twoNamed = placeholderRows.map((r) => ({ ...r, startLocation: r.startLocation?.replace(specificStore, '甲中心/乙中心'),
  endLocation: r.endLocation?.replace(specificStore, '甲中心/乙中心') }));
assert(R.executionIssues(R.normalizeReviewRows(twoNamed, 1), {}).some((issue) => /多个备选/.test(issue)),
  '两个具名设施仍须实际选定，不能默认同址');
for (const generic of ['指定停车点', '指定上车点', '指定集合点']) {
  const picked = R.normalizeReviewRows([row('09:00', '09:15', 'transport', '前往集合', '甲站', `甲游客中心/${generic}`, 'ride'),
    row('09:15', '09:30', 'transport', '乘车离开', `甲游客中心/${generic}`, '乙酒店', 'ride')], 1);
  assert.equal(picked[0].endLocation, '甲游客中心'); assert.equal(picked[1].startLocation, '甲游客中心');
}
const stations = [{ name: '甲城', city: '甲城', code: 'AAA' }, { name: '乙城东', city: '乙城', code: 'BBB' }];
for (const place of ['甲城商场地铁站', '甲城轻轨站', '甲城市轨道交通中心站']) {
  assert.equal(rail12306.resolveStationCandidates(place, stations).length, 0, '城市名不得让地铁站命中同城火车站');
  assert.equal(rail12306.routePairs({ from: place, to: '乙城东站', dayCity: '乙城', origin: '甲城市某路' }, stations).length, 0,
    '城市/出发地兜底也不能把明确地铁站改成铁路站');
  assert.equal(rail12306.routePairs({ from: '乙城东站', to: place, destinationCity: '甲城' }, stations).length, 0);
  assert(R.executionIssues([row('09:00', '10:00', 'transport', '乘D2001列车', '乙城东站', place, 'train')], {})
    .some((issue) => /地铁\/轻轨站/.test(issue)), '没有错误班次也应明确反馈身份错误供审计重排');
}
assert.equal(rail12306.resolveStationCandidates('乙城东站（地铁换乘）', stations)[0].name, '乙城东',
  '真实铁路站的括号接驳说明不改变站点身份');
assert.equal(rail12306.routePairs({ from: '丙县汽车站', to: '乙城东站', dayCity: '乙城', origin: '甲城市某路' }, stations).length, 0,
  '外地无法识别的路段不能改成从用户家乡出发的铁路');
assert.equal(rail12306.routePairs({ from: '甲城市某路', to: '乙城东站', dayCity: '乙城', origin: '甲城市某路' }, stations)[0].from.name,
  '甲城', '真实总出发地的去程仍可补对应枢纽');
const existingReturnMove = { from: '南宁东站', to: '重庆西站', mode: 'train', code: 'G1001',
  startTime: '09:00', endTime: '14:00', schedSource: 'reference', referenceDate: '2026-10-12' };
const prematureOutline = { days: [{ city: '桂林', overnight: '桂林', moves: [] },
  { city: '重庆', overnight: '重庆', moves: [{ from: '桂林站', to: '重庆西站', mode: 'train' }] },
  { city: '南宁', overnight: '南宁市中心', moves: [] },
  { city: '返程', overnight: '返程', moves: [existingReturnMove] }] };
P.deferPrematureReturn({ origin: '重庆市金童路', transport: '高铁/动车优先', backTime: '16:00' }, prematureOutline, [1]);
assert.equal(prematureOutline.days[3].moves[0], existingReturnMove,
  '修中途提前返家不覆盖末日同片区已查询的真实返程枢纽和时刻');

(async () => {
  const saved = { can: S.canLookupSchedules, lookup: S.lookupSchedules };
  try {
    S.canLookupSchedules = () => true;
    const rail = row('17:00', '23:00', 'transport', '乘D1001返程', '甲城站', '乙城西站', 'train');
    const oldMove = { from: rail.startLocation, to: rail.endLocation, mode: 'train', code: 'D1001',
      startTime: '17:00', endTime: '23:00', schedSource: 'reference', referenceDate: '2026-10-12',
      sourceUrl: 'https://rail.example/timetable' };
    const returnRows = [rail, row('23:00', '23:40', 'transport', '打车回家', rail.endLocation, '用户家', 'ride')];
    const profile = { origin: '用户家', goTime: '08:00', backTime: '16:00', transport: '高铁/动车优先' };
    let list = [{ from: rail.startLocation, to: rail.endLocation, code: 'D1001', s: '17:00', e: '23:00' }];
    let meta = { reference: true, referenceDate: '2026-10-12', sourceUrl: 'https://rail.example/timetable' };
    let calls = 0;
    S.lookupSchedules = async (segments) => {
      calls++;
      const found = new Map(), routeMeta = new Map();
      segments.forEach((segment) => { found.set(S.cacheKeyOf(segment), clone(list)); routeMeta.set(S.cacheKeyOf(segment), clone(meta)); });
      found.routeMeta = routeMeta; return found;
    };
    const makeDay = () => ({ date: '2027-11-02', city: '返程', moves: [clone(oldMove), { from: '前夜酒店', to: '甲城站', mode: 'ride' }] });
    const review = async (day, extra = {}, candidate = returnRows) => R.reviewExecutionItems({ ...profile, ...extra },
      { days: [{ hotel: '前夜酒店' }, day] }, clone(candidate), Date.now() + 10000);
    const day = makeDay(), snapshot = JSON.stringify(returnRows);
    const result = await review(day);
    assert.equal(calls, 1); assert(day.executionForceReroute);
    assert.equal(day.moves.filter((move) => move.mode === 'train').length, 0);
    assert.equal(day.moves.filter((move) => move.mode === 'ride').length, 1, '不删公路与其他方案');
    assert(day.executionScheduleBlockedRoutes[0].reason.includes('其他真实枢纽'));
    assert.equal(JSON.stringify(returnRows), snapshot); assert(result.every((r) => !r.executionReview), '查询不等于审计通过');
    assert.equal(profile.backTime, '16:00');
    const trimmed = makeDay(); await review(trimmed, {}, [returnRows[1]]);
    assert(!trimmed.moves.some((move) => move.mode === 'train'), '到家裁剪删掉列车条目后仍查大纲真实晚到班次，不等模型先复制一次错误方案');
    assert(trimmed.executionScheduleBlockedRoutes);

    list = []; meta = {};
    const empty = makeDay(); await review(empty);
    assert.equal(empty.moves[0].code, 'D1001'); assert(!empty.executionScheduleBlockedRoutes,
      '网络或空查询不能冒充已证实不可行，不能丢失旧证据');

    list = [{ from: rail.startLocation, to: rail.endLocation, code: 'D1001', s: '17:00', e: '23:00' }];
    meta = { reference: true, referenceDate: '2026-10-12', sourceUrl: 'https://rail.example/timetable' };
    const booked = makeDay(); booked.moves[0].schedSource = 'unknown';
    await review(booked, { extra: '已购买车票D1001' });
    assert.equal(booked.moves[0].code, 'D1001'); assert(!booked.executionScheduleBlockedRoutes, '已购票不自动解除或换号');

    list.push({ from: rail.startLocation, to: rail.endLocation, code: 'G1002', s: '08:00', e: '14:00' });
    const viable = makeDay(); viable.executionScheduleBlockedRoutes = [{ from: '旧站', to: '旧终点' }];
    await review(viable);
    assert.equal(viable.moves.find((m) => m.mode === 'train').code, 'G1002');
    assert.equal(viable.moves.find((m) => m.mode === 'train').startTime, '08:00');
    assert.equal(viable.moves.find((m) => m.mode === 'train').endTime, '14:00');
    assert(!viable.executionScheduleBlockedRoutes, '可行真实班次选定后清理陈旧不可行路线提示');
    const prefixRail = row('10:01', '10:55', 'transport', '乘C2001前往甲城站', '丙城南站', '甲城站', 'train');
    const mainRail = row('09:25', '13:56', 'transport', '乘G2002返家', '甲城站', '乙城西站', 'train');
    const reversed = [mainRail, prefixRail, row('15:20', '16:00', 'transport', '乘车返家', '乙城西站', '用户家', 'ride')];
    S.lookupSchedules = async (segments) => {
      const found = new Map(), routeMeta = new Map();
      segments.forEach((segment) => {
        const first = segment.from === '丙城南站';
        found.set(S.cacheKeyOf(segment), [{ from: segment.from, to: segment.to, code: first ? 'C2001' : 'G2002',
          s: first ? '10:01' : '09:25', e: first ? '10:55' : '13:56' }]);
        routeMeta.set(S.cacheKeyOf(segment), clone(meta));
      });
      found.routeMeta = routeMeta; return found;
    };
    const wrongTimeOrder = { date: '2027-11-02', city: '返程', moves: [{ ...oldMove, from: '甲城站', to: '乙城西站',
      code: 'G2002', startTime: '09:25', endTime: '13:56' }] };
    await review(wrongTimeOrder, {}, reversed);
    assert.equal(wrongTimeOrder.moves.filter((m) => m.mode === 'train').length, 1);
    assert.equal(wrongTimeOrder.moves.find((m) => m.mode === 'train').code, 'G2002',
      '时刻倒序不能把赶不上的短途接驳当末段选定，再触发相反查询循环');
    assert.equal(wrongTimeOrder.executionAccessConstraint.to, '甲城站');
    assert.equal(wrongTimeOrder.executionAccessConstraint.arriveBefore, '08:45');
    assert.deepEqual(wrongTimeOrder.executionAccessConstraint.replacedRoutes, [{ from: '丙城南站', to: '甲城站' }]);
    console.log('✓ 真实办理寄存及跨日状态一致；未购返程全部过晚才解除自动选路，空查询/已购保持，替代班次锁定真实时刻');
  } finally { S.canLookupSchedules = saved.can; S.lookupSchedules = saved.lookup; }
})().catch((error) => { console.error(error); process.exitCode = 1; });
