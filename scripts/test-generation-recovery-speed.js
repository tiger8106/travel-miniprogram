// 实际生成器的离线回归：真实修订计数、接力租约、重复查询与请求总截止时间。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const P = require('../cloudfunctions/generatePlan/plan');
const R = require('../cloudfunctions/generatePlan/execution-review');
const E = require('../cloudfunctions/generatePlan/route-evidence');
const L = require('../cloudfunctions/generatePlan/llm');
const copy = (v) => JSON.parse(JSON.stringify(v));
const item = (activity, category, startTime, endTime, extra = {}) => ({ dayIndex: 1,
  activity, category, startTime, endTime, endLocation: '甲酒店', note: '', ...extra });
const original = [item('早餐', 'food', '09:00', '10:00'), item('休息整理', 'other', '09:30', '10:30'),
  item('回房休息', 'hotel', '20:00', '21:00')];
const input = { origin: '用户家', dest: '甲城周边', startDate: '2027-10-04', endDate: '2027-10-06', extra: '无大件行李' };
const outline = () => ({ executionSuggestions: {}, days: [0, 1, 2].map((i) => ({
  date: `2027-10-0${4 + i}`, city: '甲城', hotel: '甲酒店', overnight: i === 2 ? '返程' : '甲城',
  highlights: [], meals: [], moves: [],
})) });
const completed = (di) => ({ ...original[2], dayIndex: di, executionReview: R.REVIEW_VERSION });

(async () => {
  const saved = { chat: L.chatWithRetry, points: E.collectRoutePoints, topology: E.collectRailTopology,
    roads: E.collectRoadTravelFacts, transits: E.collectUrbanTransitFacts };
  try {
    const stored = item('在甲酒店前台寄存行李', 'other', '08:00', '08:15');
    const pickup = item('打车返回酒店取行李', 'transport', '11:00', '11:45', { startLocation: '甲景点', transportType: 'ride' });
    const baggageIssues = (rows) => R.executionIssues(rows, { hotel: '乙酒店' }).filter((s) => /寄存行李未|取回地点|取回行李前没有/.test(s));
    assert.equal(baggageIssues([stored, pickup]).length, 0, '实际取行李与取回行李是等价动作');
    assert.equal(baggageIssues([stored, { ...pickup, activity: '取回寄存的大件行李' }]).length, 0);
    assert(baggageIssues([stored, { ...pickup, endLocation: '丙酒店' }]).length, '异地取件仍须阻止');
    assert(baggageIssues([stored, { ...pickup, endLocation: '丙酒店', activity: '已从甲酒店取回行李' }]).length,
      '标题声称原地取件不能替代实际起终点到达');
    assert(baggageIssues([stored, { ...pickup, activity: '之后再取回行李' }]).length, '泛泛未来说明不算实际取件');
    assert.equal(R.previousStoragePlaces([stored, pickup], 2).length, 0);
    const morning = { ...pickup, activity: '返回甲酒店取行李并退房' };
    const priorRoomIssues = (rows) => R.executionIssues(rows, { hotel: '乙酒店', previousHotel: '甲酒店' })
      .filter((s) => /取回行李前没有/.test(s));
    assert.equal(priorRoomIssues([morning]).length, 0, '昨晚客房里的行李不需要当天虚构寄存');
    assert(priorRoomIssues([morning, { ...morning, startTime: '12:00', endTime: '12:30' }]).length);
    assert(priorRoomIssues([{ ...morning, endLocation: '丙酒店' }]).length);
    assert.equal(R.previousStoragePlaces([{ ...stored, activity: '购买车票及寄存/搬运协调' }], 2).length, 0);
    const enter = item('抵达甲园游客中心，寄存大件行李，购买门票入园', 'ticket', '09:00', '09:15', {
      city: '甲城', startLocation: '甲城甲园游客中心', endLocation: '甲城甲园入口', transportType: 'walk' });
    const leave = item('从甲园游客中心取回行李', 'other', '11:00', '11:15', {
      startLocation: '甲城甲园出口', endLocation: '甲城甲园游客中心' });
    assert(!R.executionIssues([enter, leave], { city: '甲城', hotel: '甲酒店' }).some((s) => /行李/.test(s)),
      '复合寄存后入园须按明确点名的游客中心存放，不强行取办理条目的终点');
    assert.deepEqual(R.previousStoragePlaces([enter], 2), ['甲城甲园游客中心']);
    assert.equal(R.previousStoragePlaces([enter, leave], 2).length, 0);
    assert(R.executionIssues([enter, { ...leave, endLocation: '甲城甲园入口' }], { city: '甲城', hotel: '甲酒店' })
      .some((s) => /行李取回地点/.test(s)), '真实入口与寄存处没有同址证据时仍不可混用');
    const stationStore = { ...enter, activity: '在甲城站办理大件行李寄存',
      startLocation: '甲城站', endLocation: '甲城站行李寄存处' };
    assert.deepEqual(R.previousStoragePlaces([stationStore], 2), ['甲城站行李寄存处'],
      '泛称车站办理寄存不能覆盖实际导航中的精确寄存服务点');
    assert(!baggageIssues([stationStore, { ...leave, startLocation: '甲景点', endLocation: '甲城站行李寄存处' }]).length);
    const cityRoute = [item('甲城市区夜景散步', 'sight', '18:00', '19:00', { endLocation: '甲湖' }),
      item('回房休息', 'hotel', '20:00', '21:00')];
    const cityContext = { city: '甲城市', required: ['甲城'], highlights: ['甲城'], hotel: '甲酒店',
      points: { 甲湖: { lat: 25, lon: 110 }, 甲城: { lat: 25, lon: 110 } } };
    assert(!R.executionIssues(cityRoute, cityContext).some((s) => /核心点甲城/.test(s)));
    assert(R.executionIssues(cityRoute, { ...cityContext, highlights: ['甲山'], required: ['甲山'],
      points: { 甲山: { lat: 25, lon: 110 } } }).some((s) => /核心点甲山/.test(s)), '真实核心点不能借城市修复漏验');
    assert(R.executionIssues(cityRoute, { ...cityContext, city: '甲山', highlights: ['甲山'], required: ['甲山'],
      points: { 甲山: { lat: 25, lon: 110 } } }).some((s) => /核心点甲山/.test(s)), '大纲把景区填到city也不能豁免');
    const fallbackDay = { city: '甲城', hotel: '甲酒店' };
    assert.equal(R.finalizeWithWarnings(cityRoute, 0, fallbackDay, ['服务资料未知'], {
      enforceRailSchedules: true, isFirst: true, origin: '用户家', goTime: '08:00', hotel: '甲酒店',
    }).length, 0, '已确定缺失首日接驳的骨架不可通过待确认发布');
    const verifiedWalk = { ...pickup, startLocation: '甲街附近餐厅', endLocation: '甲街',
      activity: '步行返回甲街主路', transportType: 'walk', executionReview: R.REVIEW_VERSION };
    assert.equal(P.removeZeroDistanceTransports([verifiedWalk]).length, 1,
      '保存后不能按粗地名清洗删掉已验收的餐厅到主街接驳');
    assert.equal(P.removeZeroDistanceTransports([{ ...verifiedWalk, startLocation: '甲街' }]).length, 0);
    const access = item('乘车到乙园', 'transport', '15:00', '15:20', {
      startLocation: '甲园', endLocation: '乙园', transportType: 'ride' });
    const tour = item('甲园内部步行游线', 'sight', '15:20', '16:30', {
      startLocation: '甲园', endLocation: '甲园出口' });
    assert(R.executionIssues([access, tour], {}).some((s) => /游览却从甲园.*缺少独立接驳/.test(s)),
      '模型取消可选景点后遗留的错误接驳不能凭游览时长或空档通过');
    assert(!R.executionIssues([{ ...access, endLocation: '甲园' }, tour], {})
      .some((s) => /缺少独立接驳/.test(s)), '景区内部入口至出口的真实游线仍有效');
    assert(!R.executionIssues([access, { ...tour, startLocation: '乙园入口' }], {
      aliases: [{ place: '乙园', names: ['乙园入口'], sourceUrl: 'https://operator.example/entry' }],
    }).some((s) => /缺少独立接驳/.test(s)), '有独立证据的同址别名不误拦');
    assert(R.executionIssues([item('午餐', 'food', '12:00', '13:00', { note: '重新规划：此处安排需要调整路线' })], {})
      .some((s) => /未定稿/.test(s)), '备注内的未定稿推演也不可发布');
    const meal = item('晚餐推荐招牌烧鸭', 'food', '18:00', '19:00', { mealNames: ['招牌烧鸭'] });
    assert(R.executionIssues([meal], { followingMeals: ['招牌烧鸭'] }).some((s) => /次日.*重复/.test(s)),
      '后一天先发布时，未完成的前一天也须避开相邻重复主菜');
    assert(R.executionIssues([{ ...meal, mealNames: ['桂花鱼'] }], { followingMeals: ['招牌烧鸭'] })
      .some((s) => /次日.*重复/.test(s)), '相邻已验收主菜仍须扫描实际正文，不能通过改变结构化菜名绕过');
    assert(!R.executionIssues([meal], { followingMeals: ['招牌烧鸭'], repeatMeals: '每天都吃招牌烧鸭' })
      .some((s) => /次日.*重复/.test(s)));
    const avoidMeal = item('享用午餐：桂花鱼', 'food', '12:00', '13:00', {
      note: '避开次日已安排的招牌烧鸭', mealNames: ['桂花鱼'] });
    const lunchAccess = { ...avoidMeal, category: 'transport', activity: '步行前往午餐地点' };
    assert(!R.executionIssues([avoidMeal], { followingMeals: ['招牌烧鸭'] }).some((s) => /重复推荐/.test(s)),
      '避免重复的备注不反向当作实际推荐主菜');
    assert(!R.executionIssues([lunchAccess], { followingMeals: ['招牌烧鸭'] }).some((s) => /重复推荐/.test(s)),
      '去午餐地点的接驳不是一顿实际用餐');
    const outside = R.normalizeReviewRows([access, { ...tour, startLocation: '', endLocation: '乙园', activity: '游览乙园' },
      { ...access, startTime: '16:30', endTime: '16:45', startLocation: '乙园', endLocation: '丙路' },
      { ...tour, startTime: '16:45', endTime: '18:00', startLocation: '', endLocation: '丙路', activity: '漫步丙路' }], 0,
    { scopeCandidates: ['乙园'] });
    assert.equal(outside[outside.length - 1].visitScope, undefined, '离园后街区不继承已结束景区范围和关园窗口');
    const booking = (product, extra = {}) => ({ type: 'ticket', ticketPlace: '甲园', ticketProduct: product,
      linkedItemId: 'visit', fireAt: 100, ...extra });
    const admission = P.dedupeBookingAlarmRecords([
      booking('甲园成人票（淡季）', { sourceUrl: 'https://operator.example/ticket', ticketRequired: true }),
      booking('甲园大门票'), booking('甲城甲园门票（淡季）', { ticketPlace: '甲城甲园' }),
      booking('', { ticketPlace: undefined, title: '甲园门票' }),
    ], [{ itemId: 'visit', city: '甲城' }]);
    assert.equal(admission.length, 1, '同日成人季节票、大门票及泛化入园提醒不重复');
    assert.equal(admission[0].sourceUrl, 'https://operator.example/ticket', '归并不丢已查询票务证据');
    assert.equal(P.dedupeBookingAlarmRecords([booking('甲园前山门票'), booking('甲园后山门票'),
      booking('甲园索道票'), booking('甲园夜间门票')]).length, 4, '独立区域、时段和索道不可误合并');
    console.log('✓ 广西实测暴露的“返回酒店取行李”不再误判未取件；异地/未来说明仍阻止');
    const draft = outline(); draft.days = draft.days.slice(0, 2); draft.days[1].hotel = '乙酒店';
    L.chatWithRetry = async (messages) => {
      const prompt = messages[1].content;
      assert(prompt.includes('昨晚住甲酒店'), '初稿必须传准确酒店，不只传城市');
      assert(!prompt.includes('**今晚回同一家酒店**'), '同城换酒店不能当连住');
      assert(prompt.includes('实际寄存和取件必须在 activity 分条'), '初稿与验收按同一动作口径');
      assert(prompt.includes('不能省略实际游览地点'), '静态游览也保留实际地点');
      return JSON.stringify([item('回房休息', 'hotel', '20:00', '21:00', { endLocation: '乙酒店' })]);
    };
    await P.genDayItems(P.normalizeInput(input), draft, { doneDayIndexes: [0], deadline: Date.now() + 38000 });
    E.collectRoutePoints = async () => ({}); E.collectRailTopology = async () => [];
    E.collectRoadTravelFacts = E.collectUrbanTransitFacts = async () => [];
    let audits = 0, searches = 0;
    L.chatWithRetry = async (messages, opts) => {
      if (opts.enableSearch) { searches++; return '{"routeFacts":[],"scenicRoute":"酒店周边游线"}'; }
      audits++;
      if (audits === 1) assert(messages[1].content.includes('昨晚入住的客房可直接取箱退房'),
        '模型约束与跨日客房状态必须一致');
      if (audits <= 3) return JSON.stringify({ items: original });
      assert(!messages[1].content.includes('本轮改为局部修订'), '三次无效修订后必须自动完整重排');
      return JSON.stringify({ items: original.map((r, i) => i === 1 ? { ...r, startTime: '10:00', endTime: '11:00' } : r) });
    };
    const days = outline(); let rows = [completed(0), ...copy(original), completed(2)], attempts = {};
    for (let round = 0; round < 4; round++) {
      const result = await P.buildPlan(input, { outline: days }, { reviewItems: rows, attempts,
        preservePublishedDays: true, budgetMs: 32000 });
      assert(!result.reviewError, '三次修订后不能把可自动恢复的整单直接置失败');
      attempts = result.attempts;
      const fresh = new Set(result.items.map((r) => r.dayIndex));
      rows = rows.filter((r) => !fresh.has(r.dayIndex)).concat(result.items);
      if (!result.partial) { assert.equal(round, 3); break; }
    }
    assert.equal(audits, 4); assert.equal(searches, 1, '只调整时间不重复查同一运营事实');
    assert(rows.every((r) => r.executionReview === R.REVIEW_VERSION));
    console.log('✓ 前三次无效修订自动转完整重排，第四次完成；固定事实不重复搜索');

    const blocked = outline(); let hardResult;
    L.chatWithRetry = async (_, opts) => opts.enableSearch
      ? '{"routeFacts":[],"scenicRoute":"酒店周边游线"}' : JSON.stringify({ items: original });
    let hardAttempts = {};
    for (let round = 0; round < 6; round++) {
      hardResult = await P.buildPlan(input, { outline: blocked }, { reviewItems: [completed(0), ...original, completed(2)],
        attempts: hardAttempts, preservePublishedDays: true, budgetMs: 32000 });
      hardAttempts = hardResult.attempts;
    }
    assert(hardResult.reviewError, '六次真实失败仍阻止发布已知重叠，不无限重试');
    assert.equal(hardResult.progress.done, 2, '失败不能抹掉已完成日期');
    const duplicateOutline = outline();
    const repeatedFood = { ...meal, startTime: '12:00', endTime: '13:00', dayIndex: 1 };
    const repeatTail = { ...repeatedFood, dayIndex: 2, executionReview: R.REVIEW_VERSION };
    const finalizedRepeat = await P.buildPlan(input, { outline: duplicateOutline }, {
      reviewItems: [completed(0), repeatedFood, completed(1), repeatTail], finalizePending: true,
    });
    assert(finalizedRepeat.partial && finalizedRepeat.reviewError,
      '预算最终收尾须传相同相邻餐饮约束，不把真实重复通过待确认发布');
    const transient = outline(); let transientAttempts = { 'review-1': 2 };
    L.chatWithRetry = async (_, opts) => {
      if (opts.enableSearch) return '{"routeFacts":[],"scenicRoute":"酒店周边游线"}';
      throw new Error('network unavailable');
    };
    for (let i = 0; i < 2; i++) {
      const result = await P.buildPlan(input, { outline: transient }, { reviewItems: [completed(0), ...original, completed(2)],
        attempts: transientAttempts, preservePublishedDays: true, budgetMs: 32000 });
      transientAttempts = result.attempts;
      assert.equal(transientAttempts['review-1'], 2, '断网没有语义答复，不算修订失败');
      assert(!result.reviewError);
    }
    console.log('✓ 真实错误有界阻止发布；断网不消耗语义次数，已完成日期不回退');

    const deferred = outline();
    deferred.days[1].executionReviewAttempted = true; deferred.days[1].executionReviewIssues = ['旧时段重叠'];
    const postponed = await P.buildPlan(input, { outline: deferred }, { reviewItems: [completed(0), ...original, completed(2)],
      attempts: { 'review-1': 2 }, budgetMs: 1, preservePublishedDays: true });
    assert.equal(postponed.attempts['review-1'], 2); assert(!postponed.attempts['review-round-1']);
    assert(!postponed.reviewError, '没时间调用模型不能消耗旧的失败次数');
    console.log('✓ 查询/预算接力与真实语义失败分开，旧 attempted 标记不会误计');

    let operating = 0, ticket = 0, roads = 0;
    let cachedAudits = 0;
    L.chatWithRetry = async (messages, opts) => {
      if (messages[0].content.includes('旅行票务')) { ticket++; return '{"ticketProducts":[],"ticketPolicies":[{"place":"甲湖","activity":"甲湖散步","ticketRequired":false,"reservationRequired":false,"sourceUrl":"https://www.glljsh.com/category/164.html"}]}'; }
      if (opts.enableSearch) { operating++; return '{"routeFacts":[],"scenicRoute":"市区步行线路"}'; }
      cachedAudits++; return '{"acceptOriginal":true}';
    };
    E.collectRoadTravelFacts = async () => { roads++; return [{ from: '甲酒店', to: '甲湖', mode: 'ride', minMinutes: 10 }]; };
    const cached = outline(), route = [item('乘车去甲湖', 'transport', '10:00', '10:30', { startLocation: '甲酒店', endLocation: '甲湖', transportType: 'ride' }),
      item('甲湖散步', 'sight', '10:30', '11:30', { endLocation: '甲湖', note: '自由拍照' }),
      item('回房休息', 'hotel', '20:00', '21:00')];
    // 避免该测试引入另一个需要接驳的真实位置跳跃。
    route.splice(2, 0, item('返回甲酒店', 'transport', '11:30', '12:00', { startLocation: '甲湖', endLocation: '甲酒店', transportType: 'ride' }));
    await R.reviewExecutionItems(P.normalizeInput(input), cached, route, Date.now() + 35000);
    cached.days[1].executionCandidate = copy(route);
    cached.days[1].executionCandidateUnaudited = true;
    const beforeAudit = cachedAudits;
    await R.reviewExecutionItems(P.normalizeInput(input), cached, route, Date.now() + 35000);
    assert.equal(cachedAudits, beforeAudit + 1, '原始兜底候选硬验收通过也不能跳过模型完整审计');
    const initial = [operating, ticket, roads];
    const beforeShortAudit = cachedAudits;
    await R.reviewExecutionItems(P.normalizeInput(input), cached, route, Date.now() + 25000);
    assert.equal(cachedAudits, beforeShortAudit, '查询后仅余二十余秒不发起易超时的整天审计');
    assert.equal(cached.days[1].executionReviewPhase, 'deferred');
    assert.deepEqual([operating, ticket, roads], initial, '预算接力仍保留可复用证据');
    await R.reviewExecutionItems(P.normalizeInput(input), cached, route.map((r) => ({ ...r, note: r.category === 'sight' ? '欣赏风景并拍照留念' : r.note })), Date.now() + 35000);
    assert.deepEqual([operating, ticket, roads], initial, '仅非事实备注润色不重查运营/票务/成功导航');
    await R.reviewExecutionItems(P.normalizeInput(input), cached, route.map((r) => r.category === 'sight' ? { ...r, note: '需要购买门票，价格60元' } : r), Date.now() + 35000);
    assert.equal(ticket, initial[1] + 1, '收费证据变化必须重查，不能用免费缓存覆盖');
    await R.reviewExecutionItems(P.normalizeInput(input), cached, route.map((r) => r.category === 'sight'
      ? { ...r, note: '未满14周岁不可参与，需要核对证件' } : r), Date.now() + 35000);
    assert.equal(ticket, initial[1] + 2, '年龄等限制及未知事实也参与键，不能仅保留收费关键词');
    console.log('✓ 文案润色复用证据，收费事实变化使缓存失效，成功导航跨轮持久化');
  } finally {
    L.chatWithRetry = saved.chat; E.collectRoutePoints = saved.points; E.collectRailTopology = saved.topology;
    E.collectRoadTravelFacts = saved.roads; E.collectUrbanTransitFacts = saved.transits;
  }

  const env = { provider: process.env.LLM_PROVIDER, key: process.env.LLM_API_KEY, base: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL };
  const timers = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200); const timer = setInterval(() => res.write(' '), 15); timers.add(timer);
    req.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.LLM_API_KEY = 'offline-test'; process.env.LLM_MODEL = 'offline-test';
    process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const start = Date.now();
    await assert.rejects(() => L.chat([{ role: 'user', content: 'test' }], { timeoutMs: 120 }), /总时限/);
    assert(Date.now() - start < 1200, '持续慢回包也必须按总时限终止');
    await assert.rejects(() => L.chatWithRetry([], { deadline: Date.now() + 100 }), /时间预算不足/);
    console.log('✓ 请求总截止时间覆盖持续慢回包；预算不足不发起必然超时请求');
  } finally {
    timers.forEach(clearInterval); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries({ LLM_PROVIDER: env.provider, LLM_API_KEY: env.key, LLM_BASE_URL: env.base, LLM_MODEL: env.model })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }

  const storage = new Map();
  let job = { jobId: 'job', tripId: 'trip', status: 'running', round: 2 };
  let onStatus = async () => ({ job });
  const context = { module: { exports: {} }, exports: {}, Date, Math,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    wx: { getStorageSync: (k) => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: (k) => storage.delete(k) },
    require: () => ({ startGen: async () => { throw new Error('poll result expired'); }, genJobStatus: (...args) => onStatus(...args),
      resumeGen: async () => { throw new Error('network temporarily unavailable'); } }),
  };
  vm.runInNewContext(fs.readFileSync('miniprogram/utils/genrunner.js', 'utf8'), context);
  const runner = context.module.exports;
  assert((await runner.start({})).partial); assert.equal(runner.get().status, 'running');
  await runner.sync(); assert.equal(runner.get().status, 'running');
  runner.reset(); job = { ...job, status: 'done', itemCount: 9 };
  assert.equal((await runner.start({})).partial, false);
  assert.equal(runner.get().status, 'done'); assert.equal(runner.get().itemCount, 9);
  runner.reset(); job = { ...job, status: 'failed', error: '真实执行失败' };
  await assert.rejects(() => runner.start({}), /真实执行失败/);
  assert.equal(runner.get().status, 'failed');
  runner.reset();
  let resolveOld;
  onStatus = () => new Promise((resolve) => { resolveOld = resolve; });
  const oldStart = runner.start({});
  await new Promise((resolve) => setImmediate(resolve));
  runner.reset(); resolveOld({ job }); await oldStart;
  assert.equal(runner.get().status, 'idle', '换账号后在途首次恢复结果不能回写旧任务');
  console.log('✓ 前台结果过期/连续断网不冒充生成失败，服务端真实失败仍保留');
})().catch((error) => { console.error(error); process.exitCode = 1; });
