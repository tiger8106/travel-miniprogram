// 真实后端处理器 + 内存数据库：候选隔离、稳定进度、失败提示清理、限额收尾。
const assert = require('assert');
const Module = require('module');
const vm = require('vm');
const fs = require('fs');
const P = require('../cloudfunctions/generatePlan/plan');
const R = require('../cloudfunctions/generatePlan/execution-review');
const Pub = require('../cloudfunctions/generatePlan/publication');
const L = require('../cloudfunctions/generatePlan/llm');
const copy = (value) => JSON.parse(JSON.stringify(value));
const row = (di, finalized = false) => Object.assign({ dayIndex: di, startTime: '20:00', endTime: '21:00',
  category: 'hotel', activity: '回房休息', endLocation: '甲城晨光酒店', note: '' }, finalized ? { executionReview: R.REVIEW_VERSION } : {});
const input = { origin: '用户家', dest: '甲城', startDate: '2026-12-20', endDate: '2026-12-25', startTime: '12:00', endTime: '17:00' };
const outline = { executionSuggestions: {}, days: Array.from({ length: 6 }, (_, i) => ({
  date: `2026-12-${20 + i}`, city: '甲城', overnight: i === 5 ? '返程' : '甲城',
  hotel: i === 5 ? '' : '甲城晨光酒店', highlights: [], meals: [], moves: [],
})) };
const collections = { trips: [{ _id: 'trip', _openid: 'user', sourceType: 'ai', genStatus: 'generating',
  items: [0, 1, 2, 3].map((di) => row(di, true)), genProgress: { done: 4, total: 6 } }],
gen_jobs: [{ _id: 'job', _openid: 'user', tripId: 'trip', status: 'running', round: 4,
  createdAt: Date.now(), updatedAt: Date.now(), leaseUntil: 0, schedDone: true, hotelDone: false,
  input: Object.assign({}, input, { outline }), attempts: {} }] };
let tripReadError = null;
const db = { command: { lt: (value) => ({ lt: value }) }, collection(name) {
  const rows = collections[name] || (collections[name] = []);
  const apply = (target, data) => Object.entries(copy(data)).forEach(([key, value]) => {
    const parts = key.split('.'); let obj = target;
    parts.slice(0, -1).forEach((part) => { obj = obj[part] || (obj[part] = {}); }); obj[parts[parts.length - 1]] = value;
  });
  const query = (conditions) => {
    let cap = Infinity;
    const matches = () => rows.filter((entry) => Object.entries(conditions).every(([key, value]) =>
      value && typeof value === 'object' && value.lt !== undefined ? entry[key] < value.lt : entry[key] === value));
    return { limit(n) { cap = n; return this; }, orderBy() { return this; },
      async get() { return { data: copy(matches().slice(0, cap)) }; },
      async update({ data }) { const selected = matches(); selected.forEach((entry) => apply(entry, data)); return { stats: { updated: selected.length } }; },
      async remove() { const selected = new Set(matches()); for (let i = rows.length - 1; i >= 0; i--) if (selected.has(rows[i])) rows.splice(i, 1); return { stats: { removed: selected.size } }; },
    };
  };
  return { where: query, orderBy() { return query({}); },
    async add({ data }) { const id = `${name}-${rows.length}`; rows.push(Object.assign({ _id: id }, copy(data))); return { _id: id }; },
    doc(id) { return {
      async get() {
        if (name === 'trips' && tripReadError) throw tripReadError;
        return { data: copy(rows.find((entry) => entry._id === id) || null) };
      },
      async update({ data }) { const target = rows.find((entry) => entry._id === id); if (!target) throw new Error('not found'); apply(target, data); return { stats: { updated: 1 } }; },
      async remove() { const i = rows.findIndex((entry) => entry._id === id); if (i >= 0) rows.splice(i, 1); },
    }; },
  };
} };
let buildCalls = 0;
let outlineCalls = 0;
const fakeCloud = { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext: () => ({ OPENID: 'user' }),
  database: () => db, callFunction: async () => ({ result: { code: 0, data: {} } }) };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
  if (parent && /generatePlan\/index\.js$/.test(parent.filename) && request === './plan') return Object.assign({}, P, {
    generateOutline: async (profile, options) => {
      outlineCalls++;
      assert.equal(collections.gen_jobs.find((entry) => entry.kind === 'outline').outlineAttempts, outlineCalls,
        '模型请求前须记录尝试次数，以便硬超时后续跑');
      if (outlineCalls === 1) throw new Error('模拟大纲首轮超时');
      assert(options.compact, '续跑大纲应采用更短输出');
      return { outline: copy(outline), title: '续跑后大纲', summary: '可编辑路线',
        startDate: profile.startDate, endDate: profile.endDate, days: 6 };
    },
    buildPlan: async (profile, data, opts) => {
      buildCalls++;
      assert(opts.preservePublishedDays);
      if (opts.finalizePending) return P.buildPlan(profile, data, opts);
      assert.equal(opts.reviewItems.filter((it) => it.dayIndex < 4).length, 4);
      if (buildCalls === 2) assert(opts.reviewItems.some((it) => it.dayIndex === 4), '未发布的候选须可恢复');
      return Object.assign({}, input, { title: '测试攻略', items: [row(4, buildCalls > 1)], alarms: [],
        partial: false, dayCities: [], doneDayIndexes: [0, 1, 2, 3, 4], attempts: {},
        progress: { done: 5, total: 6 }, gaveUpDayIndexes: [] });
    },
  });
  if (parent && /generatePlan\/index\.js$/.test(parent.filename) && request === './schedule') return { canLookupSchedules: () => false, canSearch: () => false };
  if (parent && /generatePlan\/index\.js$/.test(parent.filename) && request === './hotel-validation') {
    return { validateOutlineHotels: async (result) => result };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const generate = require('../cloudfunctions/generatePlan/index');
const itinerary = require('../cloudfunctions/itinerary/index');
Module._load = originalLoad;

(async () => {
  const trip = collections.trips[0], job = collections.gen_jobs[0];
  let result = await generate.main({ action: 'resume', jobId: 'job', expectRound: 4, runnerId: 'test' });
  assert.equal(result.code, 0); assert.equal(job.hotelDone, true);
  assert.equal(buildCalls, 0, '酒店核验须占独立一轮，不能挤进细化轮');
  result = await generate.main({ action: 'resume', jobId: 'job', expectRound: job.round, runnerId: 'test' });
  assert.equal(result.code, 0); assert.equal(trip.items.length, 4); assert.equal(trip.genProgress.done, 4);
  assert.equal(job.status, 'running', '生成器误报完成仍以已发布天数为准');
  assert.equal(trip.genDraftItems.length, 1); assert.equal(trip.genDraftItems[0].dayIndex, 4);
  const publicGet = await itinerary.main({ action: 'get', tripId: 'trip' });
  assert(!('genDraftItems' in publicGet.data)); assert(!('genDraftOutline' in publicGet.data));
  const publicList = await itinerary.main({ action: 'list', compact: true, fullTripId: 'trip' });
  assert(!('genDraftItems' in publicList.data[0]));
  result = await generate.main({ action: 'resume', jobId: 'job', expectRound: job.round, runnerId: 'test' });
  assert.equal(result.code, 0); assert.equal(trip.genProgress.done, 5); assert.equal(trip.items.length, 5);
  const accepted = JSON.stringify(trip.items);
  job.createdAt = Date.now() - 26 * 60000;
  result = await generate.main({ action: 'resume', jobId: 'job', expectRound: job.round, runnerId: 'test' });
  assert.equal(result.code, 0); assert.equal(job.status, 'done'); assert.equal(trip.genStatus, 'done');
  assert.equal(trip.genProgress.done, 6); assert.equal(trip.genDraftItems.length, 0);
  assert.equal(JSON.stringify(trip.items.filter((it) => it.dayIndex < 5)), accepted, '已发布的五天不能被兜底修改');
  assert(trip.items.some((it) => it.dayIndex === 5 && /待确认/.test(it.note)));
  assert.equal(trip.genWarningCount, 1);
  console.log('✓ 实际云函数续跑：候选隐藏、4→5→6进度不回退、限时收尾完整且备注待确认');

  const tripCount = collections.trips.length;
  const madeOutline = await generate.main(Object.assign({ action: 'outlineStart' }, input));
  assert.equal(madeOutline.code, 0);
  const outlineJobId = madeOutline.data.jobId;
  assert.equal((await generate.main({ action: 'jobStatus' })).data.job, null,
    '大纲任务不能出现在详细行程进度列表');
  let outlineRun = await generate.main({ action: 'resume', jobId: outlineJobId, expectRound: 0, runnerId: 'outline-test' });
  assert.equal(outlineRun.data.status, 'running');
  assert.equal(collections.trips.length, tripCount, '大纲超时不能创建详细行程');
  outlineRun = await generate.main({ action: 'resume', jobId: outlineJobId, expectRound: 1, runnerId: 'outline-test' });
  assert.equal(outlineRun.data.status, 'done');
  const savedOutline = await generate.main({ action: 'outlineStatus', jobId: outlineJobId });
  assert.equal(savedOutline.data.outlineResult.outline.days.length, 6);
  assert.equal(collections.trips.length, tripCount, '大纲完成仍需用户确认才可细化');
  console.log('✓ 大纲首轮超时后自动续跑，保存并返回可编辑大纲，无自动入库');

  Object.assign(job, { status: 'failed', revivals: 2, round: 30, createdAt: Date.now() - 3600000, leaseUntil: 0 });
  Object.assign(trip, { genStatus: 'failed' });
  result = await generate.main({ action: 'resume', jobId: 'job', expectRound: 30, runnerId: 'test' });
  assert.equal(result.code, 0); assert.equal(job.revivals, 3); assert.notEqual(job.status, 'failed');
  job.status = 'failed'; trip.genStatus = 'failed';
  tripReadError = new Error('network temporarily unavailable');
  assert.equal((await generate.main({ action: 'jobStatus' })).code, -1, '查询失败不能冒充任务不存在');
  await assert.rejects(() => generate.main({ action: 'resume', jobId: 'job' }), /network/);
  assert.equal(job.status, 'failed', '瞬时读取异常不能取消任务');
  tripReadError = null;
  result = await generate.main({ action: 'dismissJob', jobId: 'job' });
  assert.equal(result.code, 0); assert(job.dismissed);
  assert.equal((await generate.main({ action: 'jobStatus' })).data.job, null);
  job.status = 'failed'; job.dismissed = false;
  assert.equal((await itinerary.main({ action: 'delete', tripId: 'trip' })).code, 0);
  assert.equal(job.status, 'cancelled'); assert.equal((await generate.main({ action: 'jobStatus' })).data.job, null);
  job.status = 'failed'; job.dismissed = false;
  assert.equal((await generate.main({ action: 'jobStatus' })).data.job, null, '旧孤儿任务不显示');
  tripReadError = new Error('document does not exist');
  assert.equal((await generate.main({ action: 'resume', jobId: 'job' })).data.status, 'cancelled');
  tripReadError = null;
  collections.gen_jobs.push({ _id: 'other', _openid: 'another-user', status: 'failed' });
  assert.equal((await generate.main({ action: 'dismissJob', jobId: 'other' })).code, -1);
  console.log('✓ 失败任务不限终生两次；清除、级联删除、旧孤儿过滤与跨账号保护');

  const originalChat = L.chatWithRetry;
  let calls = 0;
  try {
    L.chatWithRetry = async () => { calls++; throw new Error('测试模拟模型不可用'); };
    const detail = copy(outline); detail.days = detail.days.slice(0, 2);
    const candidate = Object.assign(row(1), { activity: '携带大件行李登山游览', category: 'sight' });
    detail.days[1].executionCandidate = [candidate];
    detail.days[1].executionReviewIssues = ['索引0：大件行李未寄存，登山前需核实寄存并原地取回。'];
    const finalized = await P.buildPlan(input, { outline: detail }, { reviewItems: [row(0, true), candidate],
      attempts: { 'review-1': 3 }, preservePublishedDays: true });
    assert(!finalized.partial); assert(!finalized.reviewError); assert.equal(finalized.progress.done, 2);
    assert(finalized.items.some((it) => it.executionReviewStatus === 'needs_confirmation' && /待确认/.test(it.note)));
    assert(calls <= 2, '运营和票务独立检索有界，各最多一轮');
    const again = await P.buildPlan(input, { outline: detail }, { reviewItems: [row(0, true), ...finalized.items], preservePublishedDays: true });
    assert(!again.partial); assert.equal(calls, 2, '已收尾日期不再反复请求模型');
  } finally { L.chatWithRetry = originalChat; }
  console.log('✓ 连续复核失败不终止整单，完成后不再重做');

  const proofDay = { city: '甲城', hotel: '甲城晨光酒店', moves: [] };
  const warningRows = R.finalizeWithWarnings([
    { ...row(1), category: 'sight', startTime: '05:38', endTime: '06:12', activity: '观赏日出', timingLocked: true },
    { ...row(1), category: 'transport', startTime: '13:00', endTime: '15:00', activity: '乘坐G123次列车',
      transportType: 'train', startLocation: '甲城站', endLocation: '乙城站' },
  ], 1, proofDay, ['自动修订达到预算，请确认此段寄存服务'], {
    official: [{ startLocation: '甲城站', endLocation: '乙城站', startTime: '13:46', endTime: '14:47', code: 'G123' }],
  });
  assert(warningRows.some((it) => it.activity.includes('日出') && it.startTime === '05:38' && it.timingLocked));
  assert(warningRows.some((it) => it.transportType === 'train' && it.startTime === '13:46'
    && it.endTime === '14:47' && it.schedSource === '12306'));
  console.log('✓ 带警示收尾仍保留官方精确班次和太阳窗口，不冒充全部核验通过');

  const edges = copy(outline); edges.days = edges.days.slice(0, 2); edges.executionSuggestions = {};
  edges.days[0].moves = [{ mode: 'train', from: '出发站', to: '甲城站', startTime: '19:00', endTime: '21:00',
    code: 'D1001', schedSource: '12306', sched: [{ code: 'D1001', from: '出发站', to: '甲城站', s: '19:00', e: '21:00' }] }];
  edges.days[0].highlights = ['甲景点']; edges.days[1].hotel = ''; edges.days[1].overnight = '返程';
  const edgePlan = await P.buildPlan({ ...input, startTime: '17:00' }, { outline: edges }, { reviewItems: [],
    finalizePending: true, preservePublishedDays: true });
  assert(!edgePlan.partial); assert.equal(edgePlan.progress.done, 2);
  const first = edgePlan.items.filter((it) => it.dayIndex === 0);
  assert(first.every((it) => it.startTime >= '17:00'), '补全首日不能把游玩放到用户启程之前');
  assert(first.some((it) => it.startLocation === input.origin && it.startTime === '17:00'));
  console.log('✓ 全部详情不可用仍补齐各天；首日启程边界与返家收口保留');

  let serverJob = { jobId: 'stale', tripId: 'deleted', status: 'failed', error: '旧失败' }, statusError = false;
  const storage = new Map();
  const homeApp = { globalData: { currentTripId: 'chosen-other', currentTrip: { _id: 'chosen-other' } } };
  const context = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Date, Math,
    getApp: () => homeApp,
    wx: { getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key) },
    require: (name) => name.includes('services/api') ? {
      genJobStatus: async () => { if (statusError) throw new Error('网络暂时不可用'); return { job: serverJob }; },
      dismissGen: async () => { serverJob = null; },
      startGen: async () => ({ jobId: 'new-job', tripId: 'new-trip', round: 1, partial: true, status: 'running' }),
      resumeGen: async () => {
        // 用户在生成过程中切到另一份行程；本轮结束不能强行切回新生成的行程。
        homeApp.globalData.currentTripId = 'chosen-other';
        return { jobId: 'new-job', tripId: 'new-trip', round: 2, partial: false, status: 'done', itemCount: 42 };
      },
    } : { clear() {} } };
  vm.runInNewContext(fs.readFileSync('miniprogram/utils/genrunner.js', 'utf8'), context);
  const runner = context.module.exports;
  await runner.sync(); assert.equal(runner.get().status, 'failed');
  assert.equal(homeApp.globalData.currentTripId, 'chosen-other', '启动时恢复旧任务不能覆盖首页选中行程');
  statusError = true; await runner.sync(); assert.equal(runner.get().jobId, 'stale'); statusError = false;
  serverJob = null; await runner.sync(); assert.equal(runner.get().status, 'idle');
  serverJob = { jobId: 'stale', tripId: 'deleted', status: 'failed' };
  await runner.sync(); await runner.dismiss(); assert.equal(runner.get().jobId, '');
  serverJob = { jobId: 'stale', tripId: 'deleted', status: 'failed' };
  await runner.sync(); runner.forgetTrip('deleted'); assert.equal(runner.get().status, 'idle');
  assert(!storage.has('gen_running_job'));
  await runner.start({ outline: { days: [{ date: '2026-12-20' }] } });
  assert.equal(homeApp.globalData.currentTripId, 'chosen-other', '新行程每轮生成与完成均不能覆盖用户手动切换的行程');
  assert.equal(homeApp.globalData.currentTrip._id, 'chosen-other');
  console.log('✓ 本地失败态/缓存清除，不因账号或已删除行程恢复旧横幅');

  const planner = fs.readFileSync('miniprogram/pages/planner/planner.wxml', 'utf8');
  assert(!/bindlongpress|onDayTouch|dragging|manualOffset/.test(planner));
  assert(!/onDayLongPress|applyDayOrder/.test(fs.readFileSync('miniprogram/pages/planner/planner.js', 'utf8')));
  assert(/onEditDay/.test(planner) && /onConfirmOutline/.test(planner));
  assert.equal(Pub.publicationState({ items: [row(0, true)] }, { items: [row(0)] }, outline).progress.done, 1);
  const legacy = Pub.publicationState({ items: [row(0, true), row(1)] }, { items: [], partial: true }, outline);
  assert.equal(legacy.progress.done, 1); assert.equal(legacy.pending.length, 1, '旧未复核内容迁移为候选而非丢弃重做');
  let page, submitted, outlineShouldTimeout = false, timedOut = false, finishInBackground = false;
  const localStorage = new Map();
  const plannerApp = { globalData: { currentTripId: 'chosen-other' } };
  const outlineResponse = { title: '原路线标题', summary: '原摘要', outline: { days: [
    { d: '2026-12-20', t: '抵达', city: '甲城', ov: '甲城', hl: ['甲景点'], mv: [{ f: '起点站', to: '终点站', s: '13:00', e: '16:00' }], hotel: '原酒店' },
    { date: '2026-12-21', theme: '返程', city: '乙城', overnight: '返程', highlights: ['乙景点'], moves: [], sched: [{ code: '官方班次' }] },
  ] } };
  vm.runInNewContext(fs.readFileSync('miniprogram/pages/planner/planner.js', 'utf8'), {
    Date, Math, setInterval: () => 1, clearInterval() {}, setTimeout(callback) { callback(); }, Page(value) { page = value; },
    getApp: () => plannerApp, wx: {
      showToast() {}, getStorageSync(key) { return localStorage.get(key); },
      setStorageSync(key, value) { localStorage.set(key, value); }, removeStorageSync(key) { localStorage.delete(key); },
    },
    require(name) {
      if (name.includes('/auth')) return { requireLogin: async () => true };
      if (name.includes('services/api')) return {
        startOutline: async () => ({ jobId: 'outline-job', round: 0 }),
        outlineStatus: async () => outlineShouldTimeout && !timedOut
          ? { status: 'running', round: 0, resumable: true }
          : { status: 'done', outlineResult: copy(outlineResponse) },
        resumeOutline: async () => {
          timedOut = true;
          throw new Error('「generatePlan」本轮执行超时');
        },
      };
      if (name.includes('/eta')) return { estimate: () => 1000, footerText: () => '', record() {} };
      if (name.includes('/genrunner')) return { subscribe: () => () => {}, start: async (payload) => {
        submitted = payload;
        if (finishInBackground) { page.onHide(); return { partial: false, tripId: 'new-trip', itemCount: 42 }; }
        return { partial: true, tripId: 'new-trip' };
      } };
      if (name.includes('/alarm')) return { getAdvanceMin: () => 12 };
      if (name.includes('/homecache')) return { clear() {}, setSelectedTripId() { throw new Error('离开页面后不应改首页选择'); } };
      if (name.includes('/quota')) return { clear() {} };
      return {};
    },
  });
  page.setData = (patch, callback) => {
    Object.entries(patch).forEach(([path, value]) => {
      const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.'); let obj = page.data;
      parts.slice(0, -1).forEach((key) => { obj = obj[key]; }); obj[parts[parts.length - 1]] = value;
    });
    if (callback) callback();
  };
  page.data = copy(page.data);
  page._outlineToken = 0;
  page._destroyed = false;
  Object.assign(page.data, { origin: input.origin, dest: input.dest, startDate: input.startDate, endDate: input.endDate,
    goTime: '12:00', backTime: '17:00', extra: '已购票，优先公共交通', interestItems: [{ name: '当地美食', on: true }] });
  page._input = page.buildInput();
  outlineShouldTimeout = true;
  await page.genOutline();
  assert(timedOut, '第一轮大纲请求应模拟 60 秒超时');
  assert.equal(page.data.step, 'outline', '超时续跑完成后仍须展示可编辑大纲');
  assert.equal(page.data.generating, false);
  assert.equal(submitted, undefined, '未确认大纲不得启动详情生成');
  localStorage.set('planner_outline_job', { jobId: 'outline-job', input: page._input });
  page.setData({ step: 'form', outline: null });
  await page.onShow();
  assert.equal(page.data.step, 'outline', '返回页面后仍能恢复并展示后台完成的大纲');
  assert.equal(localStorage.has('planner_outline_job'), false);
  outlineShouldTimeout = false;
  timedOut = false;
  await page.genOutline();
  assert.deepStrictEqual(copy(page.data.outline), outlineResponse.outline, '去掉拖动不改模型原始大纲');
  assert.deepStrictEqual(page.data.outlineDays.map((day) => day.date).join(','), '2026-12-20,2026-12-21');
  assert.equal(page.data.outlineDays[0].moveText, '起点站→终点站 13:00-16:00');
  page.onEditDay({ currentTarget: { dataset: { idx: 1 } } });
  page.onDayFormInput({ currentTarget: { dataset: { field: 'highlights' } }, detail: { value: '乙景点、丙景点' } });
  page.onSaveDayForm();
  await page.onConfirmOutline();
  assert.deepStrictEqual(copy(submitted.outline.days[0]), outlineResponse.outline.days[0]);
  assert.deepStrictEqual(copy(submitted.outline.days[1].highlights), ['乙景点', '丙景点']);
  assert.deepStrictEqual(copy(submitted.outline.days[1].sched), outlineResponse.outline.days[1].sched);
  assert.equal(submitted.extra, page._input.extra); assert.equal(submitted.leadMinutes, 12);
  assert.equal(submitted.startTime, '12:00'); assert.equal(submitted.endTime, '17:00');
  finishInBackground = true;
  await page.onConfirmOutline();
  assert.equal(plannerApp.globalData.currentTripId, 'chosen-other', '规划页离开后完成生成不覆盖首页选择');
  console.log('✓ 大纲无拖动，原日期/交通/酒店保留；编辑后按原顺序和完整需求提交');
})().catch((error) => { console.error(error); process.exitCode = 1; });
