// 线上失败同类回归：住宿占位标签、真实入住动作、末日起草与重排上下文。
const assert = require('assert');
const P = require('../cloudfunctions/generatePlan/plan');
const R = require('../cloudfunctions/generatePlan/execution-review');
const L = require('../cloudfunctions/generatePlan/llm');
const E = require('../cloudfunctions/generatePlan/route-evidence');
const H = require('../cloudfunctions/generatePlan/lodging-location');
const { validateOutlineHotels } = require('../cloudfunctions/generatePlan/hotel-validation');
const clone = (value) => JSON.parse(JSON.stringify(value));

(async () => {
  const hotel = '甲山田头寨（观景台附近民宿） 经济型住宿片区';
  const bare = H.lodgingAreaOf(hotel);
  const rows = [
    { dayIndex: 1, startTime: '09:00', endTime: '09:15', category: 'other', activity: '民宿办理入住及行李安置', endLocation: bare },
    { dayIndex: 1, startTime: '09:15', endTime: '10:15', category: 'sight', activity: '攀登甲山', endLocation: '甲山观景台' },
    { dayIndex: 1, startTime: '10:15', endTime: '11:00', category: 'transport', activity: '步行返回住宿', startLocation: '甲山观景台', endLocation: bare, transportType: 'walk' },
    { dayIndex: 1, startTime: '20:00', endTime: '21:00', category: 'hotel', activity: '回房休息', endLocation: bare },
  ];
  const issues = R.executionIssues(rows, { hotel, overnight: bare });
  assert(!issues.some((s) => /收尾住宿地错误|大件仍随身|不便随身携带/.test(s)));
  const normalized = R.normalizeReviewRows(rows, 1, { hotel });
  assert.equal(normalized[0].endLocation, hotel); assert.equal(normalized.at(-1).endLocation, hotel);
  assert.equal(H.canonicalLodgingLocation(bare + '附近', hotel), bare + '附近', '附近不是酒店原地');
  assert.equal(H.canonicalLodgingLocation('乙山田头寨', hotel), '乙山田头寨', '异地不归并');
  assert.equal(H.canonicalLodgingLocation('甲山真实酒店', hotel), '甲山真实酒店', '不能把具体物业当片区别名');
  assert.equal(H.canonicalLodgingLocation(bare + '房间', hotel), hotel, '住宿名后的客房仍属于该住宿');
  assert.equal(H.canonicalLodgingLocation('房间', hotel), '房间', '不能凭泛称房间猜住宿');
  assert(H.insideLodging(hotel + '露台', hotel)); assert(!H.insideLodging(hotel + '附近观景台', hotel));
  const terraceDay = [...rows.slice(0, 2), { ...rows[2], startTime: '17:00', endTime: '18:00', activity: '返回民宿', endLocation: bare },
    { ...rows[1], startTime: '18:00', endTime: '18:30', activity: '民宿露台观景', endLocation: hotel + '露台' }, rows.at(-1)];
  assert(!R.executionIssues(terraceDay, { hotel, scenicRoute: true }).some((s) => /核心游线中途折返/.test(s)));
  assert(R.executionIssues(terraceDay.map((r) => r.activity === '民宿露台观景'
    ? { ...r, endLocation: '甲山另一观景台' } : r), { hotel, scenicRoute: true }).some((s) => /核心游线中途折返/.test(s)),
  '之后仍去独立景点时，不允许借住宿露台例外绕过折返验收');
  assert(R.executionIssues([{ ...rows[0], endLocation: '甲山真实酒店' }, ...rows.slice(1)], { hotel })
    .some((s) => /不便随身携带/.test(s)), '在另一物业安放不能冒充今晚片区的存放处');
  assert(R.executionIssues([rows[0], { ...rows[0], startTime: '11:00', endTime: '11:15' }, rows.at(-1)], { hotel })
    .some((s) => /重复办理入住/.test(s)), '入住按真实动作计数，不因other分类漏掉重复');
  const alternatives = { hotel: '甲城市（中心广场/火车站片区） 经济型住宿片区', overnight: '甲城市（中心广场/火车站片区）',
    hotelPoiVerified: false, executionCandidate: [rows[0]] };
  const old = alternatives.hotel;
  H.prepareFallbackLodging(alternatives);
  assert.equal(alternatives.hotel, '甲城市（中心广场片区） 经济型住宿片区');
  assert.equal(alternatives.overnight, '甲城市（中心广场片区）');
  assert.equal(H.canonicalLodgingLocation(old, alternatives.hotel, alternatives.hotelLocationAliases), alternatives.hotel);
  assert.equal(H.canonicalLodgingLocation('甲城市（火车站片区）', alternatives.hotel, alternatives.hotelLocationAliases), '甲城市（火车站片区）');
  assert(alternatives.executionCandidateUnaudited, '改变实际住宿范围须重新完整语义审计');
  const known = { hotel: '甲城中心广场/火车站酒店', hotelPoiVerified: true };
  H.prepareFallbackLodging(known); assert.equal(known.hotel, '甲城中心广场/火车站酒店');
  const result = { outline: { days: [{ overnight: '甲城市（中心广场/火车站片区）', hotel: '待核验民宿' }, { overnight: '返程' }] } };
  await validateOutlineHotels(result, { budget: '经济实惠' }, async () => null, async () => null);
  assert(!result.outline.days[0].hotel.includes('/'), '生成器自己产生的降级片区须满足单地点要求');
  console.log('✓ 档次不是地点；实际入住存放被识别，附近/异地/具体物业仍不可串点，多选片区收敛后重新审计');

  const saved = { chat: L.chatWithRetry, points: E.collectRoutePoints, roads: E.collectRoadTravelFacts,
    transits: E.collectUrbanTransitFacts, topology: E.collectRailTopology };
  try {
    E.collectRoutePoints = async () => ({});
    E.collectRoadTravelFacts = E.collectUrbanTransitFacts = E.collectRailTopology = async () => [];
    const profile = { origin: '用户家', dest: '甲城', startDate: '2027-11-01', endDate: '2027-11-03', startTime: '08:00', endTime: '20:00' };
    const outline = { executionSuggestions: {}, days: [1, 2, 3].map((i) => ({ date: `2027-11-0${i}`, city: i === 3 ? '返程' : '甲城',
      hotel: i === 3 ? '' : '甲酒店', overnight: i === 3 ? '返程' : '甲城', highlights: [], moves: [], meals: [] })) };
    const accepted = { dayIndex: 0, startTime: '20:00', endTime: '21:00', category: 'hotel', activity: '回房休息',
      endLocation: '甲酒店', executionReview: R.REVIEW_VERSION };
    const pending = { ...accepted, dayIndex: 1, executionReview: undefined };
    outline.days[1].executionReviewPhase = 'audit';
    let drafts = 0, audits = 0;
    L.chatWithRetry = async (messages, opts) => {
      assert(!opts.phase && !opts.enableSearch, '缺少末日草稿时须先起草，而非再次占用整轮修早期日期');
      drafts++; assert(messages[1].content.includes('dayIndex 全部填 2'));
      return JSON.stringify([{ dayIndex: 2, startTime: '19:00', endTime: '20:00', category: 'transport', activity: '打车返回用户家',
        startLocation: '甲酒店', endLocation: '用户家', transportType: 'ride' }]);
    };
    const snapshot = JSON.stringify(accepted);
    const draftOutlineSnapshot = JSON.stringify(outline.days[1]);
    const draftResult = await P.buildPlan(profile, { outline }, { reviewItems: [accepted, pending], preservePublishedDays: true,
      doneDayIndexes: [0, 1], budgetMs: 38000 });
    assert.equal(drafts, 1); assert(draftResult.items.some((row) => row.dayIndex === 2));
    assert(draftResult.items.filter((row) => row.dayIndex === 2).every((row) => !row.executionReview), '末日起草不是发布完成');
    assert.equal(JSON.stringify(accepted), snapshot, '起草其他日期不修改已通过日期');
    assert.equal(JSON.stringify(outline.days[1]), draftOutlineSnapshot, '起草缺少日期不改写另一日期的私有修订大纲');
    console.log('✓ 早期未通过候选不饿死最后一天，已完成日期保留，新草稿只存私有区');

    const reviewing = clone(outline);
    reviewing.days[1].executionForceReroute = true;
    reviewing.days[1].executionReviewIssues = ['重复推荐主菜'];
    const food = { ...pending, category: 'food', activity: '午餐：招牌烧鸭', startTime: '12:00', endTime: '13:00', mealNames: ['招牌烧鸭'] };
    const following = { ...food, dayIndex: 2, executionReview: R.REVIEW_VERSION };
    L.chatWithRetry = async (messages, opts) => {
      if (opts.enableSearch) return '{"routeFacts":[],"scenicRoute":"市区游线","warnings":["末班接驳须确认"]}';
      audits++;
      assert(messages[1].content.includes('后一天["招牌烧鸭"]'), '完整重排也要明确避开倒序已验收日期的主菜');
      assert(messages[1].content.includes('末班接驳须确认'), '完整重排不丢独立运营风险提示');
      return JSON.stringify({ items: [{ ...food, activity: '午餐：清蒸鱼', mealNames: ['清蒸鱼'] },
        { ...pending, category: 'sight', activity: '甲城街区游览', startTime: '14:00', endTime: '15:00' }, pending] });
    };
    const reviewed = await P.buildPlan(profile, { outline: reviewing }, { reviewItems: [accepted, food, pending, following],
      preservePublishedDays: true, budgetMs: 32000 });
    assert.equal(audits, 1); assert(!reviewed.reviewError); assert(!reviewed.partial);
    console.log('✓ 完整重排直接带相邻餐饮及运营警示，修当前日不撤销已发布日期');

    const repairedLabels = clone(outline);
    const repairDay = repairedLabels.days[1];
    repairDay.hotel = hotel; repairDay.overnight = bare; repairDay.executionForceReroute = true;
    repairDay.executionRepairFailures = 2;
    repairDay.executionReviewIssues = ['当晚收尾住宿地错误', '与次日已验收行程重复推荐主菜：招牌烧鸭'];
    const repairRows = [{ ...pending, category: 'other', activity: '办理入住并放下大件行李', startTime: '09:00', endTime: '09:15', endLocation: bare },
      { ...food, endLocation: bare }, { ...pending, category: 'sight', activity: '甲城街区游览',
      startTime: '14:00', endTime: '14:30', endLocation: bare }, { ...pending, endLocation: bare }];
    repairDay.executionCandidate = repairRows;
    L.chatWithRetry = async (messages, opts) => {
      if (opts.enableSearch) return '{"routeFacts":[],"warnings":["住宿片区不是已确认物业"]}';
      assert(messages[1].content.includes('本轮改为局部修订'), '地点误判已消除且仅余餐饮重复时，不因陈旧强制状态重做整天');
      assert(messages[1].content.includes('完整审计所有原候选'), '局修也必须完整审计，并非只审餐饮');
      return JSON.stringify({ replacements: [{ startIndex: 1, endIndex: 1,
        items: [{ ...repairRows[1], activity: '午餐：清蒸鱼', mealNames: ['清蒸鱼'] }] }] });
    };
    const labelsResult = await P.buildPlan(profile, { outline: repairedLabels }, { reviewItems: [accepted, ...repairRows, following],
      preservePublishedDays: true, budgetMs: 32000 });
    assert(!labelsResult.partial); assert(!labelsResult.reviewError);
    assert(!repairDay.executionForceReroute);
    console.log('✓ 已修复住宿标签误判后，只修剩余餐饮；完整语义审计与硬校验仍执行');

    const returning = clone(outline);
    returning.days[2].executionForceReroute = true;
    returning.days[2].executionReviewPhase = 'audit';
    const returned = { ...pending, dayIndex: 2, startTime: '19:00', endTime: '20:00', category: 'transport',
      activity: '打车返回用户家', startLocation: '甲酒店', endLocation: '用户家', transportType: 'ride' };
    L.chatWithRetry = async (messages, opts) => {
      if (opts.enableSearch) return '{"routeFacts":[],"warnings":["返程接驳预留真实路程和进站缓冲"]}';
      const prompt = messages[1].content;
      assert(prompt.includes('最终接驳在20:00回到用户家'), '末日完整重排仍按实际返家边界收尾');
      assert(!prompt.includes('最后必须有返回今晚住宿休息的hotel条目'), '末日不套用普通日的酒店闭环');
      return JSON.stringify({ items: [returned] });
    };
    const returningResult = await P.buildPlan({ ...profile, transport: '大巴/直通车' }, { outline: returning }, {
      reviewItems: [accepted, { ...pending, executionReview: R.REVIEW_VERSION }, returned],
      preservePublishedDays: true, budgetMs: 32000,
    });
    assert(!returningResult.partial); assert(!returningResult.reviewError);
    assert(returningResult.items.every((row) => row.category !== 'hotel'));
    console.log('✓ 末日完整重排遵守返家时间与地点，不新增当晚入住或凑晚餐');
  } finally {
    L.chatWithRetry = saved.chat; E.collectRoutePoints = saved.points; E.collectRoadTravelFacts = saved.roads;
    E.collectUrbanTransitFacts = saved.transits; E.collectRailTopology = saved.topology;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
