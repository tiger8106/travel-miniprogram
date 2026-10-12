// 虚拟时钟验证并行生成的墙钟预算，不实际等待或调用付费模型。
const assert = require('assert');
const P = require('../cloudfunctions/generatePlan/plan');
const L = require('../cloudfunctions/generatePlan/llm');
(async () => {
  const saved = { now: Date.now, chat: L.chatWithRetry };
  let now = saved.now(), calls = 0;
  try {
    Date.now = () => now;
    const profile = P.normalizeInput({ origin: '用户家', dest: '甲城', startDate: '2027-11-01', endDate: '2027-11-08' });
    const outline = { days: Array.from({ length: 8 }, (_, i) => ({ date: `2027-11-0${i + 1}`,
      city: '甲城', hotel: '甲酒店', overnight: '甲城', highlights: [], moves: [] })) };
    L.chatWithRetry = async () => {
      calls++;
      if (calls === 4) now += 26000; // 四个并行请求的总墙钟26秒，不是每个6.5秒。
      return JSON.stringify([{ startTime: '20:00', endTime: '21:00', category: 'hotel', activity: '回房休息', endLocation: '甲酒店' }]);
    };
    const result = await P.genDayItems(profile, outline, { deadline: now + 38000 });
    assert.equal(calls, 4, '剩12秒不应误发下一整天请求');
    assert(result.partial); assert.equal(result.doneDayIndexes.length, 4);
    assert.equal(result.attempts[4], undefined, '预算接力不消耗未起草日期的重试');
    assert.deepEqual(result.failedDayIndexes, []);
    const before = calls;
    const short = await P.genDayItems(profile, outline, { deadline: now + 19000, doneDayIndexes: [0, 1, 2, 3] });
    assert.equal(calls, before, '首批也须留整天输出预算'); assert(short.partial);
    const resumed = await P.genDayItems(profile, outline, { deadline: now + 38000,
      doneDayIndexes: result.doneDayIndexes, attempts: result.attempts });
    assert.equal(calls, 8); assert(!resumed.partial); assert.equal(resumed.items.length, 4, '新一轮继续剩余四天，不丢日期也不重做已有日期');
    console.log('✓ 并行耗时不除以天数；短预算保存接力不发必然超时请求、不消耗重试，续轮起草完整剩余日期');
    let mixedCalls = 0;
    L.chatWithRetry = async () => {
      mixedCalls++;
      if (mixedCalls === 1) throw new Error('');
      if (mixedCalls === 2) throw undefined;
      if (mixedCalls === 3) throw '连接中断';
      return JSON.stringify([{ startTime: '20:00', endTime: '21:00', category: 'hotel', activity: '回房休息', endLocation: '甲酒店' }]);
    };
    const mixed = await P.genDayItems(profile, outline, { deadline: now + 38000 });
    assert.deepEqual(mixed.failedDayIndexes, [0, 1, 2], '非标准异常及空message也按真实失败保存，不读取不存在的items.length');
    assert.deepEqual(mixed.doneDayIndexes, [3, 4, 5, 6, 7], '同一波次和后续波次成功日期不丢失');
    assert.equal(mixed.items.length, 5);
    assert.deepEqual(mixed.attempts, { 0: 1, 1: 1, 2: 1 });
    assert(mixed.partial, '失败日期待续跑，不伪装完成');
    console.log('✓ 空错误/非Error异常不击穿整批，已成功日期保留，失败日期仅计一次正常续跑');
  } finally { Date.now = saved.now; L.chatWithRetry = saved.chat; }
})().catch((error) => { console.error(error); process.exitCode = 1; });
