const assert = require('assert');
const P = require('../cloudfunctions/generatePlan/plan');
const R = require('../cloudfunctions/generatePlan/execution-review');
const { solarViewingAction } = require('../cloudfunctions/generatePlan/solar-view');
const prep = { dayIndex: 1, startTime: '05:30', endTime: '06:00', category: 'other',
  activity: '起床洗漱，整理随身小包，准备前往西山韶乐观景台看日出',
  startLocation: '龙脊住宿地', endLocation: '', transportType: '', note: '' };
const view = { ...prep, startTime: '06:00', endTime: '07:00', category: 'sight',
  activity: '在西山韶乐观景台拍摄日出', endLocation: '西山韶乐观景台' };
assert(!solarViewingAction(prep, '日出'));
assert(!solarViewingAction({ ...prep, category: 'sight' }, '日出'), '改分类不把准备变成观景');
assert(!solarViewingAction({ ...view, category: 'transport', activity: '乘车前往观景台看日出' }));
assert(!solarViewingAction({ ...view, activity: '明天在观景台拍摄日出' }));
assert(!solarViewingAction({ ...view, activity: '取消日出观景，直接下山' }), '取消光线窗口不算实际观景');
assert(!solarViewingAction({ ...view, activity: '放弃日出，改为村寨徒步' }));
assert(solarViewingAction(view));
const approach = { ...view, startTime: '14:00', endTime: '15:00',
  activity: '继续上行到甲山观景台，寻找最佳机位等待日落光线变化', endLocation: '甲山观景台' };
assert(!solarViewingAction(approach), '到达与等未来光线不是实际观景，不能抢占固定窗口');
assert(!R.executionIssues([approach], {}).some((issue) => /上午观看日落/.test(issue)),
  '下午上山寻找机位不等于此时看到了日落');
assert(R.executionIssues([{ ...approach, activity: '观赏日落' }], {}).some((issue) => /上午观看日落/.test(issue)),
  '实际观赏日落排到光线窗口前仍拦截');
assert(R.executionIssues([{ ...approach, activity: '欣赏夕阳' }], {}).some((issue) => /上午观看日落/.test(issue)),
  '兼容原来的夕阳/落日实观景检查，不因共用判据漏掉等价动作');
assert(solarViewingAction({ ...view, category: 'other', activity: '起床洗漱后拍摄甲观景台日出' }),
  '复合标题中确有拍摄动作时仍保留实际观景，不只判断起床前缀');
const outline = { days: [
  { date: '2027-10-01', city: '龙脊梯田', overnight: '龙脊金坑大寨', hotel: '龙脊住宿地', moves: [] },
  { date: '2027-10-02', city: '桂林', overnight: '桂林市区', hotel: '桂林住宿地',
    moves: [{ from: '龙脊景区', to: '桂林', startTime: '09:00', endTime: '11:30' }] },
] };
const fixed = P.ensureLongjiSunriseDetail([prep, view], outline);
assert(fixed.includes(prep) && fixed.includes(view), '不能把真正日出条目当重复项删掉');
assert.equal(prep.startTime, '05:30'); assert.equal(prep.endTime, '06:00');
assert(!prep.timingLocked); assert.equal(view.timingLocked, 'sunrise');
assert.equal(fixed.filter((r) => r.timingLocked).length, 1);
const normalized = R.normalizeReviewRows(fixed, 1, { solar: [view] });
assert.equal(normalized[0].category, 'other'); assert.equal(normalized[0].endTime, '06:00');
assert(!R.executionIssues(normalized, {}).some((issue) => /时段重叠/.test(issue)));
assert(R.executionIssues([{ ...view, activity: '取消日出观景，直接下山' }], { solar: [view] })
  .some((issue) => /未保留太阳/.test(issue)), '最终执行验收不能把取消观景当保留固定事实');
const fixedView = { ...view, startTime: '06:00', endTime: '07:00', startLocation: '' };
const access = { ...prep, startTime: '05:30', endTime: '06:30', category: 'transport',
  activity: '步行前往观景台', endLocation: fixedView.endLocation, transportType: 'walk' };
const earlyPrep = { ...prep, startTime: '04:45', endTime: '05:30' };
const solarContext = { solar: [fixedView] };
const solarAccess = R.normalizeReviewRows([earlyPrep, access, fixedView], 1, solarContext);
assert.equal(solarAccess[0].startTime, '04:15'); assert.equal(solarAccess[1].startTime, '05:00');
assert.equal(solarAccess[1].endTime, '06:00'); assert.equal(solarAccess[2].startTime, '06:00');
assert.equal(R.minute(solarAccess[1].endTime) - R.minute(solarAccess[1].startTime), 60, '倒排不压缩到观景点路程');
assert(!R.executionIssues(solarAccess, solarContext).some((issue) => /重叠|太阳/.test(issue)));
assert.equal(access.startTime, '05:30', '不改原始候选');
assert.equal(R.normalizeReviewRows([earlyPrep, access, fixedView], 1, { ...solarContext, isFirst: true })[1].endTime,
  '06:30', '首日用户启程边界不能倒排');
assert.equal(R.normalizeReviewRows([{ ...earlyPrep, category: 'transport', transportType: 'train',
  activity: '乘坐真实列车', startLocation: '甲站', endLocation: '乙站' }, access, fixedView], 1, solarContext)[1].endTime,
  '06:30', '真实铁路交通不能为太阳接驳倒排而移动');
assert.equal(R.normalizeReviewRows([{ ...earlyPrep, timingLocked: 'sunrise' }, access, fixedView], 1, solarContext)[1].endTime,
  '06:00', '旧候选错锁准备不应冒充真实固定事实阻碍倒排');
console.log('✓ 准备与接驳不锁太阳窗口、不删除真正日出；明确复合观景仍识别，只有一个实际观景窗口');

(async () => {
  const lockedView = { ...view, dayIndex: 0, timingLocked: 'sunrise' };
  const candidate = { dayIndex: 0, startTime: '06:00', endTime: '07:00', category: 'sight',
    activity: '村寨徒步', endLocation: '甲村寨' };
  const warningOutline = { executionSuggestions: {}, days: [{ date: '2027-11-01', city: '甲村寨',
    hotel: '', overnight: '', highlights: [], moves: [], executionCandidate: [candidate],
    executionReviewIssues: ['运营资料暂缺，请出行前确认'] }] };
  const result = await P.buildPlan({ origin: '甲村寨', dest: '甲村寨', startDate: '2027-11-01', endDate: '2027-11-01',
    startTime: '05:00', endTime: '20:00' }, { outline: warningOutline },
  { reviewItems: [lockedView], finalizePending: true, preservePublishedDays: true });
  assert(result.partial && result.reviewError, '到预算收尾仍不能用候选中已消失的太阳窗口代替原固定事实');
  assert.equal(result.items.length, 0, '实际光线窗口丢失不能标待确认发布');
  assert(warningOutline.days[0].executionReviewIssues.some((issue) => /未保留太阳/.test(issue)));
  console.log('✓ 预算收尾传递原固定太阳窗口，候选删掉观景仍严格阻止发布');
})().catch((error) => { console.error(error); process.exitCode = 1; });
