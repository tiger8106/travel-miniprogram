const assert = require('assert');
const P = require('../cloudfunctions/generatePlan/plan');
const L = require('../cloudfunctions/generatePlan/llm');
const R = require('../cloudfunctions/generatePlan/execution-review');
const { validateOutlineHotels } = require('../cloudfunctions/generatePlan/hotel-validation');

(async () => {
  const input = { origin: '用户家', startDate: '2026-12-20', endDate: '2026-12-23', startTime: '12:00' };
  const outline = { executionSuggestions: {}, days: Array.from({ length: 4 }, (_, i) => ({
    date: `2026-12-${20 + i}`, city: '甲城', overnight: '甲城', hotel: '甲城晨光酒店', moves: [], highlights: [],
  })) };
  const room = { dayIndex: 0, startTime: '20:00', endTime: '21:00', category: 'hotel', activity: '回房休息', endLocation: '甲城晨光酒店' };
  const original = L.chatWithRetry;
  let calls = 0;
  try {
    L.chatWithRetry = async (messages) => {
      calls++;
      if (messages[0].content.includes('运营知识')) return JSON.stringify({ scenicRoute: '酒店附近短线', routeFacts: [], warnings: [], sources: [] });
      return JSON.stringify({ timeline: [
        { dayIndex: 0, startTime: '12:00', endTime: '13:00', category: 'transport', activity: '从家出发', startLocation: '用户家', endLocation: '甲城晨光酒店', transportType: 'ride' }, room,
      ] });
    };
    const knowledge = await P.buildPlan(input, { outline }, { reviewItems: [room] });
    assert.deepEqual(knowledge.doneDayIndexes, [0]);
    assert(!knowledge.attempts['review-0'], '检索知识不消耗内容修订次数');
    assert(knowledge.partial); assert.equal(calls, 1);
    const reviewed = await P.buildPlan(input, { outline }, { reviewItems: knowledge.items, attempts: knowledge.attempts });
    assert(reviewed.items.every((row) => row.executionReview === R.REVIEW_VERSION));
    assert.equal(reviewed.progress.done, 1); assert(reviewed.partial);
    assert.deepEqual(reviewed.doneDayIndexes, [0], '不能把尚未生成的三天算完成');
    assert.equal(calls, 2, '只处理已有日期，不生成后续天或重复提名提醒');
  } finally { L.chatWithRetry = original; }
  // 新一批超时必须返回空增量，并且保护上一批的大纲/时刻。
  const acceptedOutline = { days: [
    { date: '2026-12-20', city: '甲城', overnight: '甲城', hotel: '甲城晨光酒店', highlights: [], meals: [], moves: [] },
    { date: '2026-12-21', city: '返程', overnight: '返程', hotel: '', highlights: [], meals: [], moves: [] },
  ] };
  const savedDay = JSON.stringify(acceptedOutline.days[0]);
  try {
    L.chatWithRetry = async () => { throw new Error('测试模拟请求超时'); };
    const empty = await P.buildPlan({ origin: '用户家', startDate: '2026-12-20', endDate: '2026-12-21' },
      { outline: acceptedOutline }, { reviewItems: [
        { dayIndex: 0, startTime: '12:00', endTime: '13:00', category: 'transport', activity: '从家出发', startLocation: '用户家', endLocation: room.endLocation, transportType: 'ride', executionReview: R.REVIEW_VERSION },
        Object.assign({}, room, { executionReview: R.REVIEW_VERSION }),
      ] });
    assert.deepEqual(empty.items, [], '失败新批次不能兜底补出已完成日期');
    assert(empty.partial); assert.deepEqual(empty.doneDayIndexes, [0]);
    assert.equal(JSON.stringify(acceptedOutline.days[0]), savedDay, '失败续跑不能重排已通过日期大纲');
  } finally { L.chatWithRetry = original; }
  // 同批其他日期成功也不能用骨架伪造重试耗尽的日期。
  try {
    L.chatWithRetry = async () => JSON.stringify([room]);
    const failedOutline = { days: [
      { date: '2026-12-20', city: '甲城', overnight: '甲城', hotel: room.endLocation, highlights: [], moves: [] },
      { date: '2026-12-21', city: '返程', overnight: '返程', hotel: '', highlights: [], moves: [] },
    ] };
    const mixed = await P.buildPlan({ origin: '用户家', startDate: '2026-12-20', endDate: '2026-12-21' },
      { outline: failedOutline }, { attempts: { 1: 3 } });
    assert(mixed.partial); assert(mixed.reviewError.includes('第2天'));
    assert(mixed.items.length && mixed.items.every((item) => Number(item.dayIndex || 0) === 0));
    assert.deepEqual(mixed.gaveUpDayIndexes, [1]);
  } finally { L.chatWithRetry = original; }
  const result = { outline: { days: [{ city: '甲城市', overnight: '甲城市', hotel: '晨光酒店' }, { overnight: '返程' }] } };
  await validateOutlineHotels(result, {}, async () => ({ matchedName: '晨光酒店', city: '甲城市', district: '乙县', address: '乙县中心路8号' }), async () => null);
  assert(!result.outline.days[0].hotelPoiVerified, '同属一个城市的下辖县酒店不能冒充市区');
  console.log('逐批生成、知识预算、等价容器、未生成日期、酒店市区边界：通过');
})().catch((error) => { console.error(error); process.exitCode = 1; });
