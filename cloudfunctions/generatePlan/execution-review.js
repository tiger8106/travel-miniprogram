// 通用的逐日执行复核：知识由模型复核，时间/官方班次/用户边界由代码验收。
// 不包含城市、站点或景区的特例映射。
const llm = require('./llm');
const evidence = require('./route-evidence');
const schedules = require('./schedule');
const { normalizeTicketProducts } = require('./ticket-products');
const { solarEventMinute } = require('./solar-time');
const REVIEW_VERSION = 'v6';
const clock = (n) => `${String(Math.floor(Math.max(0, n) / 60)).padStart(2, '0')}:${String(Math.max(0, n) % 60).padStart(2, '0')}`;

function referenceSchedules(day) {
  return (day.moves || []).filter((move) => move.schedSource === 'reference'
    && move.referenceDate && /^https?:\/\//.test(move.sourceUrl || '')).map((move) => ({
    startLocation: move.from, endLocation: move.to, startTime: move.startTime, endTime: move.endTime,
    code: move.code, referenceDate: move.referenceDate, sourceUrl: move.sourceUrl,
  }));
}

/** 重排新出现的铁路段也须选真实运行图，不能只核查“存在直达”后继续猜时刻。 */
function selectExecutionSchedules(rows, choices, context) {
  const rails = rows.filter((row) => row.transportType === 'train' && row.startLocation && row.endLocation);
  if (!rails.length || choices.length !== rails.length || choices.some((choice) => !choice.list.length)) return [];
  const firstAccess = rows.slice(0, rows.indexOf(rails[0])).filter((row) => row.category === 'transport');
  const accessMinutes = firstAccess.reduce((sum, row) => sum + Math.max(0, minute(row.endTime) - minute(row.startTime)), 0);
  const earliest = Math.max(Number(context.earliestRailDeparture) || 0,
    context.isFirst ? minute(context.goTime || '08:00') + Math.max(40, accessMinutes) + 40 : 0);
  const latest = context.isLast ? minute(context.backTime || '23:00') - Math.max(40, context.homeAccessMin || 40) : 1439;
  let states = [{ picked: [], score: 0 }];
  choices.forEach((choice, index) => {
    const next = [];
    choice.list.forEach((candidate) => {
      const start = minute(candidate.s), end = minute(candidate.e);
      if (start === null || end === null || end <= start || index === 0 && start < earliest
        || index === choices.length - 1 && end > latest) return;
      const compatible = states.filter((state) => {
        const previous = state.picked[state.picked.length - 1];
        if (!previous) return true;
        const gap = schedules.sameStation(previous.to, candidate.from) ? 40 : 90;
        return start >= minute(previous.e) + gap;
      }).sort((a, b) => a.score - b.score)[0];
      if (!compatible) return;
      next.push({ picked: compatible.picked.concat(candidate), score: compatible.score
        + Math.abs(start - (minute(rails[index].startTime) ?? start)) });
    });
    states = next;
  });
  const best = states.sort((a, b) => a.score - b.score)[0];
  return best ? best.picked.map((candidate, index) => ({ from: candidate.from, to: candidate.to,
    mode: 'train', code: candidate.code, startTime: candidate.s, endTime: candidate.e,
    schedSource: choices[index].meta.reference ? 'reference' : '12306',
    referenceDate: candidate.referenceDate || choices[index].meta.referenceDate || '',
    sourceUrl: candidate.sourceUrl || choices[index].meta.sourceUrl || '',
    sched: choices[index].list,
    timingEstimated: choices[index].meta.reference === true, scheduleRequired: false })) : [];
}

function needsExecutionSchedules(day, rows, context) {
  const rails = rows.filter((row) => row.transportType === 'train' && row.startLocation && row.endLocation);
  if (!rails.length || !schedules.canLookupSchedules()) return false;
  const known = (context.official || []).concat(context.references || []);
  const accessMinutes = rows.slice(0, rows.indexOf(rails[0])).filter((row) => row.category === 'transport')
    .reduce((sum, row) => sum + Math.max(0, minute(row.endTime) - minute(row.startTime)), 0);
  const firstProof = known.find((fact) => matchesSchedule(fact, rails[0]));
  const lastProof = known.find((fact) => matchesSchedule(fact, rails[rails.length - 1]));
  const cannotMeetEdges = !context.railAlreadyBooked && (context.isFirst && firstProof
    && minute(firstProof.startTime) < minute(context.goTime || '08:00') + Math.max(40, accessMinutes) + 40
    || context.isLast && lastProof && minute(lastProof.endTime) + Math.max(40, context.homeAccessMin || 40) > minute(context.backTime || '23:00'));
  if (!cannotMeetEdges && rails.every((row) => known.some((fact) => matchesSchedule(fact, row)))) return false;
  const key = JSON.stringify(['v5-edges', day.date, context.goTime, context.backTime, context.homeAccessMin,
    rails.map((row) => [row.startLocation, row.endLocation])]);
  return day.executionScheduleKey !== key;
}
async function collectExecutionSchedules(day, rows, context, deadline) {
  if (!needsExecutionSchedules(day, rows, context)) return false;
  const rails = rows.filter((row) => row.transportType === 'train' && row.startLocation && row.endLocation);
  const key = JSON.stringify(['v5-edges', day.date, context.goTime, context.backTime, context.homeAccessMin,
    rails.map((row) => [row.startLocation, row.endLocation])]);
  if (deadline - Date.now() < 6000) return false;
  const segments = rails.map((row) => ({ from: row.startLocation, to: row.endLocation, date: day.date, mode: 'train' }));
  const found = await schedules.lookupSchedules(segments, Math.min(22000, deadline - Date.now() - 1500));
  const choices = segments.map((segment) => ({ list: found.get(schedules.cacheKeyOf(segment)) || [],
    meta: found.routeMeta && found.routeMeta.get(schedules.cacheKeyOf(segment)) || {} }));
  let selected = selectExecutionSchedules(rows, choices, context);
  delete day.executionAccessConstraint;
  // 前段铁路无法与可到家的末段组合时，至少锁住真实返程班次，再让重排
  // 改用可执行的早班接驳；不能放弃全部证据并把两段列车时刻一起编造。
  if (!selected.length && context.isLast && rails.length > 1) {
    selected = selectExecutionSchedules([rails[rails.length - 1]], [choices[choices.length - 1]],
      Object.assign({}, context, { isFirst: false }));
    if (selected.length) day.executionAccessConstraint = {
      to: selected[0].from, trainCode: selected[0].code,
      arriveBefore: clock(minute(selected[0].startTime) - 40),
      replacedRoutes: rails.slice(0, -1).map((row) => ({ from: row.startLocation, to: row.endLocation })),
      reason: '已查运行图中前段铁路无法衔接可按时到家的返程列车，需重新安排提前出发的道路接驳。',
    };
  }
  day.executionScheduleKey = key;
  day.executionScheduleChoices = choices;
  if (selected.length) {
    // 移除已经弃用的旧铁路方案；保留公路/船舶及当前路段实际已锁定的班次。
    day.moves = (day.moves || []).filter((move) => move.mode !== 'train').concat(selected);
    // 新班次可能比旧估算早几个小时。不能删除候选后重新喂旧时间线，
    // 否则模型会把锁定列车插回旧接驳中，形成倒序和重叠。
    if (!context.isFirst && !context.isLast) day.executionForceReroute = true;
    delete day.executionCandidate;
    console.log('[generatePlan.review] 补查重排铁路段并选定%d段具体班次，下一轮按精确时刻衔接', selected.length);
  }
  return true;
}
function matchesSchedule(fact, row) {
  return sameEndpoint(fact.startLocation, row.startLocation) && sameEndpoint(fact.endLocation, row.endLocation);
}
// 中间转场若反复赶不上自动选择的未购班次，可换用查得的较晚候选。
// 不挪动任何车次时刻，不修改用户已购票、首日启程或末日到家约束。
function deferUnbookedRail(day, rows, context) {
  if (context.isFirst || context.isLast || context.railAlreadyBooked
    || Number(day.executionRailDeferrals || 0) >= 2) return false;
  const rail = rows.find((row) => row.transportType === 'train'
    && (context.references || []).concat(context.official || []).some((fact) => matchesSchedule(fact, row)));
  if (!rail) return false;
  const access = rows.filter((row) => row.category === 'transport' && row.transportType !== 'train'
    && sameEndpoint(row.endLocation, rail.startLocation) && !/安检|候车|检票/.test(row.activity || ''));
  const ready = Math.max(...access.map((row) => minute(row.endTime) + 40));
  if (!access.length || !Number.isFinite(ready) || ready <= minute(rail.startTime)) return false;
  const move = (day.moves || []).find((entry) => entry.mode === 'train'
    && sameEndpoint(entry.from, rail.startLocation) && sameEndpoint(entry.to, rail.endLocation));
  const choice = (day.executionScheduleChoices || []).find((entry) => (entry.list || []).some((candidate) =>
    sameEndpoint(candidate.from, rail.startLocation) && sameEndpoint(candidate.to, rail.endLocation)))
    || move && { list: move.sched || [], meta: { reference: move.schedSource === 'reference', official: move.schedSource === '12306',
      referenceDate: move.referenceDate, sourceUrl: move.sourceUrl } };
  if (!choice || !choice.list.length || !choice.meta || !(choice.meta.reference || choice.meta.official)) return false;
  const selected = selectExecutionSchedules([rail], [choice], { earliestRailDeparture: ready });
  if (!selected.length || selected[0].startTime <= rail.startTime) return false;
  day.moves = (day.moves || []).filter((entry) => entry !== move).concat(selected);
  day.executionRailDeferrals = Number(day.executionRailDeferrals || 0) + 1;
  day.executionForceReroute = true;
  delete day.executionCandidate;
  day.executionReviewIssues = ['旧未购参考班次无法留足进站缓冲，已改选查得的较晚班次；按新时刻完整重排，仍核验游览、行李和入住闭环'];
  day.executionReviewAttempted = false;
  return true;
}
function locatedCorePlaces(context) {
  return (context.highlights || []).filter((place) => Object.entries(context.points || {}).filter(([name, point]) =>
    point && !point.areaAnchor && String(name).includes(place)
    && !/酒店|宾馆|民宿|客栈|餐厅|饭店|停车场|游客(?:服务)?中心|车站/.test(name)).length === 1);
}
function needsWholeDayRebuild(day, rows, context) {
  if (context.isFirst || context.isLast) return false;
  if (day.executionForceReroute === true) return true;
  const issues = day.executionReviewIssues || [];
  const railConflict = (context.official || []).concat(context.references || []).length
    && issues.some((issue) => /时段重叠|早于.*结束|缺少.*接驳|位置凭空跳转|进站接驳|安检缓冲/.test(issue));
  const storageConflict = issues.some((issue) => /寄存行李未在离开前取回|行李取回地点与寄存地点不一致/.test(issue));
  return !!railConflict || storageConflict || issues.some((issue) => /非正时长|交通下限/.test(issue))
    && rows.some((row) => row.category === 'transport' && row.transportType === 'bus'
      && minute(row.endTime) - minute(row.startTime) >= 180);
}
function requiredPlacesForDay(profile, days, dayIndex) {
  const day = days[dayIndex] || {};
  return (profile.mustVisit || []).filter((name) => {
    const matches = (entry) => (entry.highlights || []).some((point) => String(point).includes(name) || name.includes(String(point)));
    // 在景区附近住一晚不是当晚必须游景区；以实际游览日为准，避免逼模型深夜进园。
    if (days.some(matches)) return matches(day);
    return String(day.city || '').replace(/市$/, '') === name.replace(/市$/, '')
      || dayIndex === days.findIndex((candidate) => String(candidate.overnight || '').includes(name.replace(/市$/, '')));
  });
}
function markReference(row, facts) {
  const fact = (facts || []).find((entry) => matchesSchedule(entry, row)
    && entry.startTime === row.startTime && entry.endTime === row.endTime
    && String(row.activity || '').includes(entry.code));
  if (!fact) return;
  row.schedSource = 'reference'; row.timingEstimated = true;
  row.referenceDate = fact.referenceDate; row.sourceUrl = fact.sourceUrl; row.outlineMove = true;
  const note = `按${fact.referenceDate}运行图参考规划；非出行当天确认班次，开售后请在12306核对`;
  if (!String(row.note || '').includes(note)) row.note = [row.note, note].filter(Boolean).join('；');
  if (!row.activity.includes('参考')) row.activity += '（运行图参考）';
}

function collectMealNames(rows, knownNames = []) {
  const known = knownNames.flatMap((name) => String(name || '').split(/[、，,；;+/]/))
    .map((name) => name.replace(/[（(].*$/, '').replace(/^(?:早餐|午餐|晚餐)[：:]/, '').trim())
    .filter((name) => name.length >= 2 && name.length <= 20 && !/当地|特色|餐厅|附近|周边|推荐|品尝/.test(name));
  return [...new Set(rows.filter((row) => minute(row.startTime) >= 10 * 60 + 30
    && (row.category === 'food' || /午餐|晚餐|晚饭/.test(row.activity || ''))).flatMap((row) => {
    // “避免和昨日某菜重复”是排除说明，不是今天实际推荐该菜。
    const note = String(row.note || '').split(/[，,。；;]/).filter((part) =>
      !/昨日|昨天|避免.*重复|不再推荐|替换|换掉|不吃|而非/.test(part)).join('；');
    const text = `${row.activity || ''} ${note}`;
    const recommended = ((text.match(/推荐菜品[：:]([^。；;]+)/) || [])[1] || '').split(/[、，,]/);
    return [...(Array.isArray(row.mealNames) ? row.mealNames : []), ...known, ...recommended]
      .map((name) => String(name || '').trim()).filter((name) => name.length >= 2 && name.length <= 20
        && text.includes(name) && !/菜馆|餐厅|农家菜|自助餐|^(?:米饭|时蔬|青菜|当地美食|特色菜)$/.test(name));
  }))];
}

// 并行复核时，下一天不能依赖上一天尚未写入的餐饮结果。合并后再检查一次。
function invalidateRepeatedMeals(days, rows, extra = '', publishedDays = new Set()) {
  const changed = new Set();
  days.forEach((day, di) => {
    const current = rows.filter((row) => Number(row.dayIndex || 0) === di);
    if (!current.length) return;
    const names = collectMealNames(current, day.meals || []);
    day.executionMealNames = names;
    if (!di || publishedDays.has(di) || current.some((row) => row.executionReviewStatus === 'needs_confirmation')
      || !current.every((row) => row.executionReview === REVIEW_VERSION)) return;
    const previous = rows.filter((row) => Number(row.dayIndex || 0) === di - 1);
    const repeats = names.filter((name) => collectMealNames(previous, (days[di - 1] || {}).meals || []).includes(name)
      && !positiveInstructions(extra).includes(name));
    if (!repeats.length) return;
    current.forEach((row) => { delete row.executionReview; });
    day.executionCandidate = current.map((row) => Object.assign({}, row));
    day.executionReviewIssues = repeats.map((name) => `连续两天重复推荐主菜：${name}，仅修改今天餐饮段`);
    changed.add(di);
  });
  return changed;
}

// 新版本续跑旧任务时廉价复查已接受数据，只撤回确实违反新约束的日期。
// 不访问网络、不调用模型；合法日期保持原样。
function invalidateUnsafeAcceptedDays(profile, outline, rows, selfDriveAllowed) {
  const days = outline.days || [], changed = new Set();
  days.forEach((day, di) => {
    const current = rows.filter((row) => Number(row.dayIndex || 0) === di);
    if (!current.length || !current.every((row) => row.executionReview === REVIEW_VERSION)) return;
    if (current.some((row) => row.executionReviewStatus === 'needs_confirmation')) return;
    const previous = days[di - 1] || {};
    const proofs = [...(day.executionNetworkFacts || []), ...(day.executionRoadFacts || []), ...(day.executionTransitFacts || [])];
    const context = {
      isFirst: di === 0, isLast: di === days.length - 1, origin: profile.origin,
      goTime: profile.goTime, backTime: profile.backTime, date: day.date,
      hotel: day.hotel, overnight: day.overnight, previousHotel: previous.hotel,
      sameHotel: !!day.hotel && sameEndpoint(day.hotel, previous.hotel),
      noDrive: profile.transport !== '自驾出行', selfDriveAllowed, preferRail: /高铁|动车/.test(profile.transport || ''),
      lightLuggage: /(?:行李|背包|小包).{0,16}(?:轻便|方便随身|方便携带)|只(?:带|携带).{0,8}(?:小包|背包)|无大件行李/.test(profile.extra || ''),
      middayRest: /(?:每天|中午|午间).{0,10}(?:回酒店|回民宿|午休)/.test(positiveInstructions(profile.extra)),
      points: day.executionPoints || {}, routeFacts: ((day.executionEvidence || {}).routeFacts || []).filter((fact) =>
        !proofs.some((proof) => sameEndpoint(proof.from, fact.from) && sameEndpoint(proof.to, fact.to) && proof.mode === fact.mode)).concat(proofs),
      previousMeals: collectMealNames(rows.filter((row) => Number(row.dayIndex || 0) === di - 1), previous.meals || []),
      knownMeals: day.meals || [], repeatMeals: positiveInstructions(profile.extra),
      visitWindows: (day.executionEvidence || {}).visitWindows || [], sailingWindows: (day.executionEvidence || {}).sailingWindows || [],
      official: (day.moves || []).filter((move) => move.schedSource === '12306').map((move) => ({
        startLocation: move.from, endLocation: move.to, startTime: move.startTime, endTime: move.endTime, code: move.code,
      })),
      references: referenceSchedules(day),
      highlights: day.highlights || [],
      aliases: (day.executionEvidence || {}).aliases || [],
      localMobility: (day.executionEvidence || {}).localMobility || [],
      previousStorage: previousStoragePlaces(rows, di),
    };
    const errors = executionIssues(current, context);
    if (!errors.length) return;
    current.forEach((row) => { delete row.executionReview; });
    day.executionCandidate = current.map((row) => Object.assign({}, row));
    day.executionReviewIssues = errors; changed.add(di);
  });
  return changed;
}

function applyExecutionPatch(candidate, replacements) {
  if (!Array.isArray(replacements) || !replacements.length) return null;
  const patches = replacements.slice().sort((a, b) => a.startIndex - b.startIndex);
  let previousEnd = -1;
  for (const patch of patches) {
    const append = patch.startIndex === candidate.length && patch.endIndex === candidate.length
      && Array.isArray(patch.items) && patch.items.length > 0;
    if (!Number.isInteger(patch.startIndex) || !Number.isInteger(patch.endIndex)
        || patch.startIndex <= previousEnd || patch.endIndex < patch.startIndex
        || (patch.endIndex >= candidate.length && !append) || !Array.isArray(patch.items)) return null;
    previousEnd = patch.endIndex;
  }
  const result = candidate.slice();
  patches.reverse().forEach((patch) => result.splice(patch.startIndex, patch.endIndex - patch.startIndex + 1, ...patch.items));
  return result;
}

function minute(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return match && Number(match[1]) < 24 && Number(match[2]) < 60
    ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function placeKey(value) {
  return String(value || '').replace(/[\s（）()]/g, '')
    .replace(/(站)(?:[东南西北]?广场|候车厅|候车室|进站口|出站口|候车大厅)$/, '$1')
    .replace(/(?:火车站|高铁站|动车站|站)$/g, '');
}

function sameEndpoint(a, b) {
  return !!placeKey(a) && placeKey(a) === placeKey(b);
}

// 条目可以带“漂流起点（准确码头）”这样的展示前缀；只认完整名称或
// 独立括注中的准确码头，不用包含匹配把不同码头合并。
function sameWaterEndpoint(a, b) {
  const aliases = (name) => [name, ...[...String(name || '').matchAll(/[（(]([^）)]+)[）)]/g)].map((match) => match[1])];
  return aliases(a).some((left) => aliases(b).some((right) => sameEndpoint(left, right)));
}

function sameLodging(a, b) {
  if (sameEndpoint(a, b)) return true;
  const area = /^(.*?)\s*(?:经济型|舒适型|品质型)住宿片区$/.exec(String(b || ''));
  return !!(area && area[1] && /片区|区域|市中心|附近|周边/.test(a || '')
    && !/酒店|民宿|宾馆|客栈|饭店/.test(a || '') && String(a).includes(area[1].replace(/市$/, '').trim()));
}

function canonicalNode(value, context) {
  const fact = (context.aliases || []).find((entry) => /^https?:\/\//.test(entry.sourceUrl || '')
    && (entry.names || []).some((name) => sameEndpoint(name, value)));
  return fact ? fact.place : value;
}

function positiveInstructions(value) {
  return String(value || '').split(/[。；;，,]/).filter((part) =>
    !/(?:无需|不用|不必|不要|禁止|严禁|没有|未曾|不重复|不安排|不选择|不采用|不寄存)/.test(part)).join('；');
}

function storageInstruction(value) {
  return positiveInstructions(value).split(/[；;]/).some((part) => /寄存|暂存|寄放/.test(part)
    && !/(?:已|已经|此前|早上).{0,8}(?:寄存|暂存|寄放)/.test(part)
    && !/取回|取出|取件|若需|如需|如果|若有|可能|需确认|后备箱或|寄存点.*若/.test(part));
}

function previousStoragePlaces(items, beforeDay) {
  const storage = new Set();
  (items || []).filter((row) => Number(row.dayIndex || 0) < beforeDay)
    .slice().sort((a, b) => Number(a.dayIndex || 0) - Number(b.dayIndex || 0)
      || (minute(a.startTime) || 0) - (minute(b.startTime) || 0)).forEach((row) => {
      const place = row.endLocation || row.startLocation;
      if (storageInstruction(row.activity) && place && /行李|存包/.test(row.activity)) storage.add(place);
      if (/取回.*行李|取.*寄存.*行李/.test(row.activity || '')) {
        for (const stored of storage) if (sameEndpoint(stored, place) || sameEndpoint(stored, row.startLocation)) storage.delete(stored);
      }
    });
  return [...storage];
}

function fixedWindow(row, context) {
  return (context.official || []).concat(context.references || []).some((fact) => sameEndpoint(row.startLocation, fact.startLocation)
    && sameEndpoint(row.endLocation, fact.endLocation))
    || (context.solar || []).some((fact) => fact.startTime === row.startTime && fact.endTime === row.endTime);
}

function outdoorPoint(row, context) {
  const points = context.points || {};
  const stem = (name) => String(name || '').replace(/风景名胜区|风景区|景区|游客中心|前山|后山|山门|入口|站/g, '');
  const nearby = Object.entries(points).find(([name]) => stem(name).length >= 2
    && [row.startLocation, row.endLocation].some((place) => stem(place) === stem(name)));
  return points[row.endLocation] || points[row.startLocation] || (nearby && nearby[1]);
}

function outdoorSight(row) {
  if (row.category !== 'sight' || /日落|夕阳|夜游|夜景|灯光|夜场|室内|博物馆/.test(row.activity || '')) return false;
  return /登山|山峰|前山|后山|徒步|竹筏|漂流|游览.{0,12}(?:山|沟|瀑布|梯田)/.test(row.activity || '')
    || /(?:山|沟|瀑布|梯田)(?:景区|风景区|前山|后山|游客中心|山门|入口)?$/.test(row.endLocation || '');
}

function deriveSolarWindows(rows, context) {
  if (!context.date) return [];
  const facts = [];
  ['日出', '日落'].forEach((event) => {
    const view = rows.find((row) => row.category === 'sight' && String(row.activity || '').includes(event)
      && !/明天|明日|次日|第二天|不看|不拍|前往|上行|攀登/.test(row.activity));
    if (!view) return;
    const exact = outdoorPoint(view, context);
    // 山地游线缺观景台坐标时，仅用同一住宿基地的已定位点作近似，
    // 明确估算来源，不把城市行政中心或另一城市的位置当作景点坐标。
    const point = exact || context.scenicRoute && (context.points || {})[context.hotel];
    if (!point || point.areaAnchor) return;
    const at = solarEventMinute(context.date, point.lat, point.lon, event === '日落');
    if (at === null || at < 30 || at + 20 >= 1440) return;
    facts.push({ activity: view.activity, startTime: clock(at - 30), endTime: clock(at + 15),
      startLocation: view.startLocation, endLocation: view.endLocation,
      note: `${event}约${clock(at)}，按${exact ? '地图观景位置' : '当晚住宿基地'}坐标估算；地形遮挡和实际观景以当地指引为准`,
      estimated: true });
  });
  return facts;
}

function fitOutdoorDaylight(rows, context) {
  if (context.isFirst || context.isLast || rows.some((row) => fixedWindow(row, context))) return rows;
  let shift = 0;
  rows.filter(outdoorSight).forEach((row) => {
    const point = outdoorPoint(row, context);
    const sunset = point && solarEventMinute(context.date, point.lat, point.lon, true);
    if (sunset !== null && sunset !== undefined) shift = Math.max(shift, minute(row.endTime) - sunset);
  });
  if (shift <= 0 || rows.some((row) => minute(row.startTime) - shift < 6 * 60)) return rows;
  const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return rows.map((row) => Object.assign({}, row, {
    startTime: clock(minute(row.startTime) - shift), endTime: clock(minute(row.endTime) - shift), timingEstimated: true,
  }));
}

// 只修订估算交通造成的不足，不修饰模型本来已有的重叠，也不移动官方班次/太阳窗口。
function fitEstimatedConnections(rows, context) {
  const result = rows.map((row) => Object.assign({}, row));
  const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  let pushed = false;
  result.forEach((row, i) => {
    let start = minute(row.startTime), end = minute(row.endTime);
    if (start === null || end === null || end <= start || fixedWindow(row, context)) { pushed = false; return; }
    const duration = end - start;
    if (pushed && i && start < minute(result[i - 1].endTime)) start = minute(result[i - 1].endTime);
    const next = result[i + 1];
    if (pushed && row.category === 'other' && /候车|安检|检票|等待.*(?:列车|火车)/.test(row.activity || '')
      && next && next.transportType === 'train' && fixedWindow(next, context)
      && end === minute(next.startTime) && end - start >= 40) {
      // 导航扩张了上游耗时后，先消费多余候车时间，不把两小时等待
      // 整段向后推到固定列车之后。只缩等待且仍留40分钟，不缩交通/游览。
      row.startTime = clock(start); row.timingEstimated = true; pushed = false; return;
    }
    if (row.category === 'transport' && /^(?:train|bus|ride|car)$/.test(row.transportType)) {
      if (row.transportType === 'train') {
        const access = result.slice(0, i).reverse().find((entry) => entry.category === 'transport'
          && sameEndpoint(entry.endLocation, row.startLocation));
        if (access) start = Math.max(start, minute(access.endTime) + 40);
      }
      const facts = (context.routeFacts || []).filter((fact) => fact.mode === row.transportType
        && sameEndpoint(fact.from, row.startLocation) && sameEndpoint(fact.to, row.endLocation));
      end = start + Math.max(duration, ...facts.map((fact) => Number(fact.minMinutes) || 0));
    } else end = start + duration;
    if (start !== minute(row.startTime) || end !== minute(row.endTime)) {
      if (end >= 1440) return;
      row.startTime = clock(start); row.endTime = clock(end); row.timingEstimated = true;
      pushed = true;
    }
  });
  return result;
}

function fitEstimatedReturn(rows, context) {
  if (!context.isLast || !context.backTime || !rows.length) return rows;
  const result = rows.map((row) => Object.assign({}, row));
  const last = result[result.length - 1];
  if (last.category !== 'transport' || !sameEndpoint(last.endLocation, context.origin)) return result;
  const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  let nextStart = minute(context.backTime);
  let returnChain = true;
  for (let i = result.length - 1; i >= 0; i--) {
    const row = result[i];
    const start = minute(row.startTime), end = minute(row.endTime);
    if (start === null || end === null || end <= start) return rows;
    const fixed = (context.official || []).concat(context.references || []).some((fact) => sameEndpoint(row.startLocation, fact.startLocation)
      && sameEndpoint(row.endLocation, fact.endLocation));
    if (fixed || (context.solar || []).some((fact) => fact.startTime === row.startTime && fact.endTime === row.endTime)) {
      // 倒排接驳不能回到列车到站之前；保留候选，另选可衔接真实班次或报告冲突。
      if (result[i + 1] && minute(result[i + 1].startTime) < end) return rows;
      break;
    }
    let duration = end - start;
    if (i === result.length - 1) duration = Math.max(duration, context.homeAccessMin || 20);
    if (/安检|候车|检票/.test(row.activity || '') && result[i + 1] && result[i + 1].transportType === 'train') {
      duration = Math.max(duration, 40);
    }
    returnChain = returnChain && (row.category === 'transport' || /安检|候车|检票/.test(row.activity || ''));
    // 未开售的估算返程链按到家时间整体倒排，避免列车早已抵达却空等数小时。
    // 官方时刻在上面直接停止倒排，绝不把真实班次移到一个编造时刻。
    const targetEnd = i === result.length - 1 || returnChain ? nextStart : Math.min(end, nextStart);
    const targetStart = targetEnd - duration;
    if (targetStart < 0) return rows;
    row.startTime = clock(targetStart); row.endTime = clock(targetEnd);
    // 没有显式候车条目，也必须倒推40分钟到站窗口。
    nextStart = targetStart;
    const previous = result[i - 1];
    if (row.transportType === 'train' && previous && previous.category === 'transport'
      && sameEndpoint(previous.endLocation, row.startLocation)) nextStart -= 40;
  }
  return result;
}

// 接续失败后已明确改为返程道路接驳：只整体提前纯准备/接驳段，
// 保留每段耗时与列车精确时刻；不能缩短路程或移动景点/太阳窗口。
function fitLockedReturnAccess(rows, context) {
  if (!context.isLast || context.isFirst || !context.accessConstraint) return rows;
  const fact = (context.official || []).concat(context.references || [])
    .find((entry) => entry.code === context.accessConstraint.trainCode);
  if (!fact) return rows;
  const departure = minute(fact.startTime);
  const lead = rows.filter((row) => !fixedWindow(row, context) && (minute(row.startTime) < departure
    || /安检|进站|候车|检票/.test(row.activity || '')
      && sameEndpoint(row.endLocation, fact.startLocation) && minute(row.endTime) <= departure + 120));
  const access = lead.filter((row) => row.category === 'transport'
    && sameEndpoint(row.endLocation, fact.startLocation));
  if (access.length !== 1 || !/ride|bus|car/.test(access[0].transportType)
    || lead.some((row) => minute(row.startTime) === null || minute(row.endTime) <= minute(row.startTime)
      || row.category === 'sight' || row.transportType === 'train' || row.timingLocked)) return rows;
  const advance = Math.max(0, minute(access[0].endTime) - departure + 40,
    ...lead.map((row) => minute(row.endTime) - departure));
  if (!advance || lead.some((row) => minute(row.startTime) - advance < 0)) return rows;
  return rows.map((row) => lead.includes(row) ? Object.assign({}, row, {
    startTime: clock(minute(row.startTime) - advance), endTime: clock(minute(row.endTime) - advance),
    timingEstimated: true,
  }) : row).sort((a, b) => minute(a.startTime) - minute(b.startTime));
}

function fitLateHotelClosure(rows, context) {
  if (context.isFirst || context.isLast || !rows.length || rows.some((row) => fixedWindow(row, context))) return rows;
  const arrival = rows[rows.length - 1];
  const missingCheckin = arrival.category === 'transport' && sameLodging(arrival.endLocation, context.hotel)
    && minute(arrival.startTime) >= 22 * 60
    && (arrival.endTime === '00:00' || minute(arrival.endTime) >= 23 * 60);
  if (missingCheckin) rows = rows.concat({ ...arrival, category: 'hotel', transportType: '',
    activity: '办理入住，回房休息', startLocation: '', startTime: '23:59', endTime: '23:59', note: '' });
  const last = rows[rows.length - 1];
  if (last.category !== 'hotel' || !sameLodging(last.endLocation, context.hotel)
    || !/休息|入住/.test(last.activity) || minute(last.startTime) < 23 * 60
    || minute(last.endTime) > minute(last.startTime)) return rows;
  // 仅修午夜边界的收尾，不“修好”任意中间无效时段。先补足道路下限，
  // 再将未锁定的整天估算整体提前；开放窗口仍由后续严格验收决定。
  const result = rows.map((row) => Object.assign({}, row));
  const spans = [];
  let end = 0, originalEnd = 0;
  for (let i = 0; i < result.length - 1; i++) {
    const row = result[i], start = minute(row.startTime);
    const finish = missingCheckin && i === result.length - 2 && row.endTime === '00:00' ? 1440 : minute(row.endTime);
    if (start === null || finish === null || finish <= start || start < originalEnd) return rows;
    originalEnd = finish;
    const floor = Math.max(0, ...(context.routeFacts || []).filter((fact) => fact.mode === row.transportType
      && sameEndpoint(fact.from, row.startLocation) && sameEndpoint(fact.to, row.endLocation))
      .map((fact) => Number(fact.minMinutes) || 0));
    const duration = Math.max(finish - start, floor);
    spans.push([Math.max(start, end), Math.max(start, end) + duration]);
    end = Math.max(start, end) + duration;
  }
  const tail = result[result.length - 1];
  const checkin = Math.max(end, minute(tail.startTime));
  const advance = Math.ceil(Math.max(0, checkin + 15 - 1439) / 5) * 5;
  if (!advance || advance > 90 || minute(result[0].startTime) - advance < 6 * 60) return rows;
  spans.push([checkin, checkin + 15]);
  tail.note = [tail.note, '提前向住宿方确认晚到入住及接送安排'].filter(Boolean).join('；');
  return result.map((row, index) => Object.assign({}, row, {
    startTime: clock(spans[index][0] - advance), endTime: clock(spans[index][1] - advance), timingEstimated: true,
  }));
}

// 文档解析的 sanitizeItems 会修补时间并删除同点的两个地址，不能用于
// 执行验收，否则重叠被悄悄掩盖、回房位置和官方站点证据丢失。
function normalizeReviewRows(raw, dayIndex, context = {}) {
  // 等价字段只还原明确提供的值，不估造缺失时刻或修饰原有重叠。
  raw = (raw || []).map((entry) => {
    if (!entry) return entry;
    const row = Object.assign({}, entry);
    const range = String(row.time || row.timeRange || row.time_range || '')
      .match(/^(\d{1,2}:\d{2})\s*[-–—~～至]\s*(\d{1,2}:\d{2})$/);
    row.startTime = row.startTime || row.start_time || (minute(row.start) !== null ? row.start : '') || (range && range[1]) || '';
    row.endTime = row.endTime || row.end_time || (minute(row.end) !== null ? row.end : '') || (range && range[2]) || '';
    row.activity = row.activity || row.action || row.description || row.title || '';
    row.category = row.category || row.type || '';
    row.startLocation = row.startLocation || row.start_location || row.from || '';
    row.endLocation = row.endLocation || row.end_location || row.to || row.location || '';
    row.transportType = row.transportType || row.transport_type || row.mode || '';
    row.note = row.note || row.notes || '';
    return row;
  });
  // 一个太阳窗口只锁一个真实观景动作，不能把上山交通和等待日落都锁成同一时段。
  const solarRows = new Map();
  (context.solar || []).forEach((fact) => {
    const event = /日出/.test(fact.activity || '') ? '日出' : '日落';
    const candidates = (raw || []).filter((row) => row && String(row.activity || '').includes(event)
      && (row.category === 'sight' || row.category === 'other' && /观赏|观看|拍摄|欣赏/.test(row.activity))
      && !/明天|明日|次日|第二天/.test(row.activity));
    candidates.sort((a, b) => Number(/前往|徒步|步行|上行|下行|乘/.test(a.activity))
      - Number(/前往|徒步|步行|上行|下行|乘/.test(b.activity)));
    if (candidates.length) solarRows.set(candidates[0], fact);
  });
  let rows = (raw || []).filter((row) => row && String(row.activity || '').trim()).map((row) => {
    const out = { dayIndex };
    ['startTime', 'endTime', 'category', 'activity', 'startLocation', 'endLocation', 'transportType', 'note']
      .forEach((key) => { out[key] = String(row[key] || '').trim(); });
    if (Array.isArray(row.mealNames)) out.mealNames = row.mealNames.map(String);
    ['ticketRequired', 'reservationRequired', 'ticketPlace', 'ticketProduct', 'visitScope', 'bookingInfo'].forEach((key) => {
      if (row[key] !== undefined) out[key] = row[key];
    });
    const solar = solarRows.get(row);
    if (solar) out.solarFact = solar;
    ['startLocation', 'endLocation'].forEach((key) => {
      const old = out[key], next = canonicalNode(old, context);
      if (old && next !== old) {
        out[key] = next; out.activity = out.activity.split(old).join(next); out.note = out.note.split(old).join(next);
      }
    });
    if (row.sameNodeTransfer === true || (row.startLocation && row.endLocation
      && !sameEndpoint(row.startLocation, row.endLocation)
      && sameEndpoint(out.startLocation, out.endLocation) && out.category === 'transport')) out.sameNodeTransfer = true;
    if (!['sight', 'food', 'hotel', 'transport', 'ticket', 'other'].includes(out.category)) out.category = 'other';
    if (/^(?:taxi|cab)$/.test(out.transportType)) out.transportType = 'ride';
    if (out.category === 'other' && /^(?:train|plane|ship|bus|ride|walk|car)$/.test(out.transportType)
      && out.startLocation && out.endLocation && !sameEndpoint(out.startLocation, out.endLocation)
      && !/寄存|存放|购票|取回/.test(out.activity)) out.category = 'transport';
    if (out.category === 'other' && /^(?:早餐|午餐|晚餐|晚饭|享用.*餐)/.test(out.activity)) out.category = 'food';
    if (out.category === 'other' && /^(?:游览|参观|观赏|漫步|体验|乘坐.*游船)/.test(out.activity)) out.category = 'sight';
    if (out.category === 'other' && /(?:观赏|观看|拍摄|欣赏).{0,30}(?:日出|日落)/.test(out.activity)
        && !/明天|明日|次日|不看|不拍/.test(out.activity)) out.category = 'sight';
    if (out.startLocation && out.endLocation && !sameEndpoint(out.startLocation, out.endLocation)
      && /^(?:徒步|步行|打车|乘车|包车|乘坐大巴|乘地铁|从.*?乘|携带.{0,16}行李前往)/.test(out.activity)
      && !/游览|参观|漂流|观赏|骑行/.test(out.activity)) out.category = 'transport';
    const modeText = `${out.activity}；${out.note}`;
    if (out.transportType === 'train' && !(context.official || []).concat(context.references || []).some((fact) =>
      sameEndpoint(fact.startLocation, out.startLocation) && sameEndpoint(fact.endLocation, out.endLocation))) {
      out.note = out.note.replace(/(?:参考|示例)(?:车次|班次)[^。；;]*[GDCZTK]\d{1,5}[^。；;]*/gi, '未来班次与时刻待官方开售确认');
    }
    if (/乘坐.{0,16}游船|乘游船/.test(out.activity) && out.startLocation && out.endLocation
        && !sameEndpoint(out.startLocation, out.endLocation)) out.transportType = 'ship';
    markReference(out, context.references);
    if (out.transportType === 'ship' && /(?:三星|四星|五星)级?/.test(out.activity)
        && !/(?:三星|四星|五星).{0,4}[\/或].{0,4}(?:三星|四星|五星)/.test(out.activity)) {
      // 船型以这段实际乘坐动作确定，清除旧派生方向附注；对比资料不是新选择。
      out.note = out.note.replace(/(?:三星|四星|五星)级[^；;。]{0,12}游船[：:][^；;。]*/g, '').trim();
    }
    if (out.category === 'transport' && /(?:乘坐|乘|换乘|搭乘|坐).{0,12}(?:地铁|公交|巴士|大巴|客车|旅游专线|接驳车|观光车|公共交通)/.test(modeText)
      && !/^(?:乘坐|搭乘|计划乘|乘).{0,12}(?:高铁|动车|列车)/.test(out.activity)) out.transportType = 'bus';
    if (out.category === 'transport' && /打车|网约车|出租车|包车/.test(out.activity)
      && !/乘.{0,8}(?:高铁|动车|列车)/.test(out.activity)) out.transportType = 'ride';
    if (out.category === 'transport' && /^(?:乘坐|搭乘|乘).{0,12}(?:巴士|大巴|旅游专线)/.test(out.activity)
        && /(?:巴士|大巴|旅游专线)[\/／]包车/.test(out.activity)) {
      out.activity = out.activity.replace(/(巴士|大巴|旅游专线)[\/／]包车/g, '$1'); out.transportType = 'bus';
      out.note = `主方案按专线/巴士规划，先核实运营班次；包车仅作备选且需另确认价格；${out.note}`;
    }
    if (out.category === 'transport' && out.transportType === 'ride'
        && /(?:公交|地铁|公共交通)[^。；;]{0,30}或[^。；;]{0,12}(?:网约车|出租车|打车)/.test(out.activity)) {
      const transit = (context.routeFacts || []).find((fact) => fact.transitEstimate
        && sameEndpoint(fact.from, out.startLocation) && sameEndpoint(fact.to, out.endLocation)
        && Number(fact.minMinutes) <= minute(out.endTime) - minute(out.startTime));
      if (transit) {
        out.activity = `乘公共交通从${out.startLocation}前往${out.endLocation}`; out.transportType = 'bus';
        out.note = `地图参考换乘：${transit.summary || '出行当天地图核实'}；${out.note}`;
      } else {
        out.activity = `乘网约车从${out.startLocation}前往${out.endLocation}`;
        out.note = `本段按网约车用时规划；若改公共交通，请先核实换乘和耗时后调整接驳起始时间；${out.note}`;
      }
    }
    if (out.category === 'transport' && /^(?:步行|徒步)/.test(out.activity)) out.transportType = 'walk';
    if (out.category === 'transport' && /接驳车[\/／]索道/.test(out.activity)) {
      const shuttle = (context.routeFacts || []).some((fact) => fact.mode === 'bus' && fact.direct !== false
        && sameEndpoint(fact.from, out.startLocation) && sameEndpoint(fact.to, out.endLocation));
      if (shuttle) {
        out.activity = out.activity.replace(/接驳车[\/／]索道/g, '接驳车'); out.transportType = 'bus';
        out.note = `${out.note}；本段选已检索接驳车，携行李限制与班次出发前向运营方确认`;
      }
    }
    if (out.category === 'transport' && out.transportType !== 'walk' && /地铁|轨道交通/.test(modeText)
      && !/打车|网约车|出租车|包车/.test(out.activity)
      && !/^(?:乘坐|搭乘|计划乘|乘).{0,12}(?:高铁|动车|列车)/.test(out.activity)) {
      const transit = (context.routeFacts || []).find((fact) => fact.transitEstimate
        && sameEndpoint(fact.from, out.startLocation) && sameEndpoint(fact.to, out.endLocation));
      out.activity = `乘公共交通从${out.startLocation}前往${out.endLocation}`;
      out.transportType = 'bus';
      out.note = transit && transit.summary ? `地图参考换乘：${transit.summary}；出行当天核实运营时间`
        : '公交/轨交线路与班次待出行当天地图核实，不使用未核验的线路号或换乘站';
    }
    // 保留目的地给住宿和跨日继承，只去掉无效的 A→A 导航。
    if (sameEndpoint(out.startLocation, out.endLocation)) { out.startLocation = ''; out.transportType = ''; }
    return out;
  }).map((row) => {
    if (context.sameHotel && /入住|放下(?:大件)?行李/.test(positiveInstructions(row.activity))) {
      row.activity = row.activity.replace(/(?:重新|再次)?(?:办理)?入住[^，。；]*(?:放下(?:大件)?行李)?/g, '回房休息')
        .replace(/放下(?:大件)?行李/g, '整理随身小包');
    }
    if (context.sameHotel) {
      row.activity = row.activity.replace(/(?:办理)?退房(?:或确认续住)?/g, '确认续住')
        .replace(/(?:将|把)?(?:大件)?行李寄存(?:在)?酒店前台/g, '大件行李留在房间');
      row.activity = row.activity.replace(/放置(?:大件)?行李|取(?:回)?(?:寄存的)?行李/g, '整理随身小包');
      row.note = row.note.split(/[。；;，,]/).filter((part) =>
        !/办理入住|重新入住|放下(?:大件)?行李|放置(?:大件)?行李|取回.*行李/.test(part)).join('；');
    }
    if (row.category === 'transport' && sameEndpoint(row.endLocation, context.hotel)
      && /徒步|步行/.test(row.activity) && /上山|登山/.test(row.activity)
      && !context.lightLuggage && !context.sameHotel && !/搬运|托运|协助/.test(row.note)) {
      row.note = `提前联系住宿方协助搬运行李，勿拖箱走登山步道；${row.note}`;
    }
    if (row.category === 'hotel' && /^(?:房间|客房|酒店|民宿|住宿地)$/.test(row.endLocation)
      && context.hotel && (sameEndpoint(row.startLocation, context.hotel) || !row.startLocation)) {
      row.endLocation = context.hotel;
    }
    if (!row.endLocation && sameEndpoint(row.startLocation, context.hotel)
        && /在酒店|在房间|回房|休息|入住/.test(row.activity) && !/出发|离开/.test(row.activity)) {
      row.endLocation = context.hotel; row.startLocation = '';
    }
    // 模型可以扩展前后活动，但太阳窗口不能被改成习惯性的“六点半”。
    const fact = row.solarFact;
    delete row.solarFact;
    if (fact) {
      row.startTime = fact.startTime; row.endTime = fact.endTime;
      row.activity = row.activity.replace(/[（(][^）)]*(?:日出|日落)[^）)]*[）)]/g, '')
        .replace(/[（(]约?\d{1,2}[:：]\d{2}[^）)]*[）)]/g, '')
        .replace(/(?:日出|日落)(?:约|时间约|时间为)\s*\d{1,2}[:：]\d{2}/g, '太阳时刻以备注为准');
      row.note = [fact.note, row.note.replace(/(?:日出|日落)(?:约|时间约|时间为)\s*\d{1,2}[:：]\d{2}/g, '')]
        .filter(Boolean).join('；').slice(0, 180);
    }
    markReference(row, context.references);
    return row;
  }).sort((a, b) => (minute(a.startTime) ?? 1440) - (minute(b.startTime) ?? 1440));
  rows.forEach((row, i) => {
    if (row.category !== 'transport' || row.transportType !== 'train') return;
    const codes = row.activity.match(/[A-Z]\d{1,5}/g) || [];
    const official = (context.official || []).concat(context.references || []);
    const candidates = official.filter((entry) => entry.code && sameEndpoint(row.startLocation, entry.startLocation)
      && sameEndpoint(row.endLocation, entry.endLocation));
    const fact = official.find((entry) => entry.code && codes.includes(entry.code))
      || candidates.find((entry) => entry.startTime === row.startTime && entry.endTime === row.endTime)
      || (candidates.length === 1 ? candidates[0] : null);
    if (!fact) return;
    const oldStart = row.startLocation, oldEnd = row.endLocation;
    row.startLocation = /站$/.test(fact.startLocation) ? fact.startLocation : `${fact.startLocation}站`;
    row.endLocation = /站$/.test(fact.endLocation) ? fact.endLocation : `${fact.endLocation}站`;
    row.startTime = fact.startTime; row.endTime = fact.endTime;
    row.activity = `乘坐${fact.code}次列车从${row.startLocation}前往${row.endLocation}`;
    const previousAccess = rows.slice(0, i).reverse().find((entry) => entry.category === 'transport');
    const onlyWaitingBetween = previousAccess && rows.slice(rows.indexOf(previousAccess) + 1, i)
      .every((entry) => entry.category === 'other' && /安检|候车|检票|取票/.test(entry.activity));
    const stationRoot = (name) => placeKey(name).replace(/[东南西北]$/, '');
    if (previousAccess && previousAccess.transportType !== 'train' && onlyWaitingBetween
        && /站(?:候车厅|[东南西北]?广场)?$/.test(previousAccess.endLocation)
        && !sameEndpoint(previousAccess.endLocation, row.startLocation)
        && (sameEndpoint(previousAccess.endLocation, oldStart)
          || stationRoot(previousAccess.endLocation) === stationRoot(row.startLocation))) {
      const old = previousAccess.endLocation;
      previousAccess.endLocation = row.startLocation;
      previousAccess.activity = previousAccess.activity.split(old).join(row.startLocation);
      previousAccess.note = '按已核验车次的始发站接驳；路线耗时重新核对，不能去酒店附近的另一车站';
    }
    const next = rows[i + 1];
    if (next && oldEnd && sameEndpoint(next.startLocation, oldEnd)) {
      next.activity = next.activity.split(next.startLocation).join(row.endLocation);
      next.startLocation = row.endLocation;
    }
  });
  rows.sort((a, b) => (minute(a.startTime) ?? 1440) - (minute(b.startTime) ?? 1440));
  // 游船既是游览也是位移；已经到终点后，自动补齐的同方向大巴是冗余段。
  rows = rows.filter((row, i, source) => {
    if (row.category !== 'transport' || row.transportType === 'ship') return true;
    const shipIndex = source.findIndex((entry) => entry.transportType === 'ship'
      && sameEndpoint(entry.startLocation, row.startLocation) && sameEndpoint(entry.endLocation, row.endLocation)
      && minute(entry.startTime) <= minute(row.startTime));
    if (shipIndex < 0 || shipIndex >= i) return true;
    return source.slice(shipIndex + 1, i).some((entry) => sameEndpoint(entry.endLocation, row.startLocation));
  });
  rows.forEach((row, i) => {
    if (row.category !== 'transport') return;
    const previous = rows.slice(0, i).reverse().find((entry) => entry.endLocation);
    const next = rows.slice(i + 1).find((entry) => entry.startLocation);
    [['startLocation', previous && previous.endLocation], ['endLocation', next && next.startLocation]].forEach(([key, known]) => {
      if (!/[\/／]|或/.test(row[key])) return;
      const parts = row[key].split(/[\/／]|或/).map((part) => part.trim());
      const specific = parts.filter((part) => !/^(?:接驳车点|换乘点|停车场|入口|出口|出入口|广场|附近|周边|站点|路口)$/.test(part));
      const chosen = parts.find((part) => known && sameEndpoint(part, known))
        || (specific.length === 1 ? specific[0] : '');
      if (chosen) { row.activity = row.activity.split(row[key]).join(chosen); row[key] = chosen; }
    });
  });
  if (context.isLast) {
    rows = rows.filter((row) => !(row.category === 'other' && /(?:抵达|到家|回家|结束行程|行程结束|整理行李|自由安排)/.test(row.activity)
      && (sameEndpoint(row.startLocation, context.origin) || sameEndpoint(row.endLocation, context.origin))));
  }
  // 仅合并相邻且精确同端点的重复交通，不能用同城/包含匹配删除合法往返。
  rows = rows.filter((row, i, source) => {
    const next = source[i + 1];
    if (row.category !== 'transport' || !next || next.category !== 'transport'
      || !sameEndpoint(row.startLocation, next.startLocation) || !sameEndpoint(row.endLocation, next.endLocation)) return true;
    next.startTime = row.startTime;
    return false;
  });
  rows = rows.flatMap((row, i, source) => {
    const train = source[i + 1];
    if (row.category !== 'transport' || row.transportType === 'train' || !train || train.transportType !== 'train'
        || !sameEndpoint(row.endLocation, train.startLocation) || !/安检|候车|检票/.test(row.activity)
        || row.endTime !== train.startTime) return [row];
    const start = minute(row.startTime), departure = minute(train.startTime);
    if (start === null || departure === null || departure - start <= 40) return [row];
    const proof = (context.routeFacts || []).filter((fact) => sameEndpoint(fact.from, row.startLocation)
      && sameEndpoint(fact.to, row.endLocation) && fact.mode === row.transportType);
    const travel = Math.max(departure - start - 40, row.transportType === 'walk' ? 5 : 20,
      ...proof.map((fact) => Number(fact.minMinutes) || 0));
    const leave = context.isFirst && sameEndpoint(row.startLocation, context.origin) ? start : Math.min(start, departure - 40 - travel);
    if (leave < 0) return [row];
    const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    const arrival = leave + travel;
    if (arrival >= departure) return [row];
    return [Object.assign({}, row, { startTime: clock(leave), endTime: clock(arrival),
      activity: row.activity.replace(/(?:并|后|及|然后)?(?:办理)?(?:进站)?安检.*$|(?:并|后|及)?候车.*$/, '').trim(), timingEstimated: true }),
    { dayIndex, startTime: clock(arrival), endTime: train.startTime, category: 'other',
      activity: '进站安检、候车及检票', startLocation: '', endLocation: train.startLocation, transportType: '', note: '携带证件，核对车次和站台' }];
  });
  // 用户未要求午休时，删除明确的中途纯休整，不靠换分类保留绕路。
  const firstVisit = rows.findIndex((row) => row.category === 'sight');
  const lastVisit = rows.map((row) => row.category).lastIndexOf('sight');
  rows = rows.filter((row, i) => !(i > firstVisit && firstVisit >= 0 && i < lastVisit && !context.middayRest
    && ['hotel', 'other'].includes(row.category) && /酒店|民宿|住宿点|住宿地|客栈/.test(row.activity)
    && /抵达|到达|返回|回到|回房/.test(row.activity) && /休息|休整|整理仪容/.test(row.activity)
    && !/首次入住|办理入住|退房|身体不适|疲劳|寄存|取回/.test(row.activity)));
  rows = fitLateHotelClosure(fitEstimatedReturn(fitLockedReturnAccess(fitOutdoorDaylight(fitEstimatedConnections(rows, context), context), context), context), context);
  // 已在住宿内用餐、随后仅回房的派生收尾应接在晚餐后。局部补丁
  // 延长晚餐时不能保留陈旧的回房时刻；只移动此收尾，不抹去其他重叠。
  if (!context.isFirst && !context.isLast && rows.length >= 2) {
    const tail = rows[rows.length - 1], meal = rows[rows.length - 2];
    const start = minute(tail.startTime), end = minute(tail.endTime), mealEnd = minute(meal.endTime);
    if (tail.category === 'hotel' && meal.category === 'food' && /回房|休息|入住/.test(tail.activity)
      && sameEndpoint(tail.endLocation, context.hotel) && sameEndpoint(meal.endLocation, context.hotel)
      && !fixedWindow(tail, context) && start !== null && end > start && mealEnd > start
      && mealEnd + end - start < 1440) {
      tail.startTime = clock(mealEnd); tail.endTime = clock(mealEnd + end - start); tail.timingEstimated = true;
    }
  }
  const lastRow = rows[rows.length - 1];
  const lastEnd = lastRow && minute(lastRow.endTime);
  if (!context.isLast && lastRow && lastRow.category === 'food' && sameLodging(lastRow.endLocation, context.hotel)
    && /回房休息|不再外出/.test(lastRow.note || '') && lastEnd !== null && lastEnd + 15 < 1440) {
    const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    rows.push({ dayIndex, startTime: lastRow.endTime, endTime: clock(lastEnd + 15), category: 'hotel',
      activity: '回房休息', startLocation: '', endLocation: context.hotel, transportType: '', note: '结束当天行程' });
  }
  rows.forEach((row, i) => {
    const previous = rows[i - 1];
    const unnecessaryPickup = !context.middayRest && row.category === 'transport'
      && row.startLocation && row.endLocation && !sameEndpoint(row.endLocation, context.hotel)
      && /(?:返回|回到).*(?:酒店|民宿|客栈).*取回.*(?:随身|小件|小包|用品|摄影|相机)/.test(row.activity)
      && !/大件|寄存|身体不适|疲劳/.test(row.activity)
      && !(row.waypoints || []).some((point) => sameEndpoint(typeof point === 'string' ? point : point.name, context.hotel))
      && rows.slice(0, i).some((entry) => sameEndpoint(entry.endLocation, context.hotel)
        && /入住|放下.*行李|放置.*行李/.test(entry.activity));
    if (unnecessaryPickup) {
      // 起终点本就直接连接两个游览节点，只有文本添加了取小件的无谓
      // 回头路。保留完整交通预算，不缩短为猜测路程，也不改大件取件。
      row.activity = `从${row.startLocation}前往${row.endLocation}`;
      row.note = '随身用品出门前带齐，不中途折返住宿；实际步道/接驳及末班时间出行前核实';
    }
    const earlyDrop = rows.slice(0, i).find((entry) => sameEndpoint(entry.endLocation, context.hotel)
      && /入住.*(?:放下|寄存|放置)/.test(positiveInstructions(entry.activity))
      && minute(row.startTime) - minute(entry.endTime) > 30);
    if (earlyDrop && row.category === 'hotel' && /入住/.test(positiveInstructions(row.activity))) {
      row.activity = '回房休息，整理随身小包'; row.startLocation = ''; row.transportType = '';
    }
    if (row.category === 'hotel' && previous && sameEndpoint(previous.endLocation, context.hotel)
        && sameEndpoint(row.endLocation, context.hotel) && /办理入住/.test(row.activity)) {
      row.startLocation = ''; row.transportType = '';
      row.activity = row.activity.replace(/^(?:前往|到达).*?办理入住/, '办理入住');
    }
    if (row.category === 'hotel' && previous && sameEndpoint(previous.endLocation, row.endLocation)
      && sameEndpoint(row.endLocation, context.hotel) && /返回|回房|回到|休息/.test(row.activity)
      && !/退房|办理入住/.test(row.activity)) {
      // 前一段已到酒店，收尾只是回房，不能再次以车站为起点生成重复接驳。
      row.startLocation = ''; row.transportType = ''; row.activity = '回房休息';
      // 前段已经实际抵达同一酒店，只调整派生回房收尾，不改变交通。
      const arrival = minute(previous.endTime), start = minute(row.startTime), end = minute(row.endTime);
      if (!fixedWindow(row, context) && arrival > start && end > arrival) {
        row.startTime = previous.endTime; row.timingEstimated = true;
      }
    }
  });
  let dropped = context.sameHotel;
  let diningAtHotel = false;
  rows.forEach((row) => {
    if (/退房|取回.*(?:大件)?行李/.test(positiveInstructions(row.activity))) dropped = false;
    if (dropped && sameEndpoint(row.endLocation, context.hotel)
      && /携带(?:全部)?大件行李/.test(row.activity)) row.activity = '轻装返回住宿地';
    if (sameEndpoint(row.endLocation, context.hotel) && /入住|放下(?:大件)?行李|放置行李/.test(row.activity)) dropped = true;
    // 候选明确给了“远处县城或酒店餐厅”两个分支时，选择已知可执行的住宿内用餐。
    // 不把县/市行政区当成餐厅坐标，也不留下接下来凭空“返回县城”的交通。
    if (row.category === 'food' && /(?:若|可|或|直接|不想).*(?:酒店餐厅|酒店用餐)/.test(`${row.activity}；${row.note}`)
      && sameEndpoint(row.startLocation, context.hotel) && /(?:市|县|区)$/.test(row.endLocation)) {
      row.activity = '在酒店餐厅享用晚餐，品尝当地特色菜';
      row.startLocation = ''; row.endLocation = context.hotel; row.transportType = '';
      row.note = '选择住宿内用餐，避免夜间往返县城'; diningAtHotel = true;
    } else if (diningAtHotel && sameEndpoint(row.endLocation, context.hotel)
      && /酒店露台|回房|休息/.test(row.activity)) {
      row.activity = '在住宿地休息，整理次日用品';
      row.startLocation = ''; row.transportType = '';
      diningAtHotel = false;
    } else if (diningAtHotel && row.category === 'transport') diningAtHotel = false;
  });
  let visitScope = '';
  rows.forEach((row) => {
    // 景区内部子点常不重复写父景区名。只有先出现了实际抵达/入园地点
    // 证据才能继承游览范围，不能给任意条目贴上目的地来假装覆盖。
    const location = String(row.endLocation || row.startLocation || '');
    const point = (context.scopeCandidates || context.required || []).slice().sort((a, b) => b.length - a.length)
      .find((name) => location.includes(name.replace(/市$/, '')));
    if (row.category === 'transport' && (/train|plane/.test(row.transportType)
      || (/bus|car|ride/.test(row.transportType) && minute(row.endTime) - minute(row.startTime) >= 60))) {
      visitScope = (context.scopeCandidates || context.required || []).find((name) =>
        String(row.endLocation || '').includes(name.replace(/市$/, ''))) || '';
    } else if (point) visitScope = point;
    if (row.category === 'transport' && visitScope && sameEndpoint(row.startLocation, visitScope)
      && !String(row.endLocation || '').includes(visitScope)
      && /餐馆|餐厅|饭店|酒楼|酒店|民宿|\([^)]*店\)|（[^）]*店）/.test(row.endLocation || '')) visitScope = '';
    // 旧候选的范围不能残留到已经离开景区后的街区游览。
    if (row.category === 'sight' && !visitScope) delete row.visitScope;
    if (row.category === 'sight' && visitScope) row.visitScope = visitScope;
    if (row.category === 'transport' && /离开景区|出景区.*前往|返回.*客运|下山.*客运/.test(row.activity)) visitScope = '';
  });
  rows = rows.filter((row) => {
    if (row.category !== 'transport' || row.startLocation || !row.endLocation) return true;
    const loop = /从([^，。；]{1,60})前往\1/.exec(row.activity || '');
    return !loop || !sameEndpoint(loop[1], row.endLocation); // 明确自环不因起点缺失漏过清洗。
  });
  const last = rows[rows.length - 1];
  const target = context.hotel || context.overnight;
  if (!context.isLast && last && last.category === 'food' && minute(last.endTime) <= 23 * 60
    && target && (sameEndpoint(last.endLocation, target)
      || (!last.endLocation && sameEndpoint(last.startLocation, target)))) {
    // 已在住宿地内吃完饭，只缺回房动作；不凭空补跨片区“十分钟回酒店”。
    const start = minute(last.endTime);
    const time = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    rows.push({ dayIndex, startTime: time(start), endTime: time(start + 15), category: 'hotel',
      activity: '餐后回房休息', startLocation: '', endLocation: target, transportType: '', note: '' });
  }
  if (rows.length && !context.lightLuggage) {
    const plannedStorage = rows.some((row) => storageInstruction(row.activity) && !/取回/.test(row.activity));
    const state = context.sameHotel ? '连住：大件行李留在房间，携带随身小包出门'
      : plannedStorage ? '按当天实际寄存与原地取回安排管理大件行李，离城前取齐'
        : context.previousHotel ? '退房时带走全部行李，不留在昨晚酒店' : '携带行李启程';
    if (!rows[0].note.includes(state)) rows[0].note = [state, rows[0].note].filter(Boolean).join('；').slice(0, 220);
  }
  rows.forEach((row) => {
    row.note = [...new Set(String(row.note || '').split(/[；;。]/)
      .map((part) => part.replace(/^[，,\s]+/, '').trim()).filter(Boolean))].join('；').slice(0, 220);
  });
  return rows;
}

function executionIssues(rows, context) {
  const issues = [];
  const sorted = rows.slice().sort((a, b) => (minute(a.startTime) ?? 1440) - (minute(b.startTime) ?? 1440));
  if (!sorted.length) return ['没有行程条目'];
  sorted.forEach((row, i) => {
    const start = minute(row.startTime), end = minute(row.endTime);
    if (start === null || end === null || end <= start) issues.push('存在无效或非正时长');
    if (i && start < minute(sorted[i - 1].endTime)) {
      issues.push('时段重叠');
      issues.push(`索引${i}（${row.startTime}-${row.endTime} ${row.activity}）早于索引${i - 1}结束${sorted[i - 1].endTime}；仅修订相邻冲突段，官方班次和太阳窗口不平移`);
    }
    if (context.isLast && context.backTime && i && start - minute(sorted[i - 1].endTime) > 120) {
      issues.push(`返程日索引${i - 1}到${i}之间有超过两小时未说明的空档，请在原片区安排休息或游览、用餐并按时退房，不能到家后填时间`);
    }
    if (row.category === 'transport' && /[\/／]|或/.test(`${row.startLocation || ''} ${row.endLocation || ''}`)) {
      issues.push('导航起终点必须明确为一个地点，不能保留多个备选');
      issues.push(`导航索引${i}（${row.startTime}）：${row.startLocation}→${row.endLocation}，请在此条选择一个实际地点并同步相邻段`);
    }
    if (row.category === 'transport' && (row.transportType === 'train' || /^(?:乘坐|搭乘|计划乘|乘).{0,12}(?:高铁|动车|列车)/.test(row.activity || ''))
      && /汽车站|客运站|码头|机场|游客中心/.test(`${row.startLocation || ''} ${row.endLocation || ''}`)) {
      issues.push('铁路使用了非铁路上车/下车点');
    }
    if (row.category === 'transport' && row.transportType === 'train') {
      if (context.enforceRailSchedules && !(context.official || []).concat(context.references || []).some((fact) =>
        matchesSchedule(fact, row) && fact.startTime === row.startTime && fact.endTime === row.endTime
          && /^[GDCKTZ]\d{1,5}$/i.test(fact.code || '')
          && ((String(row.activity || '').match(/\b[GDCKTZ]\d{1,5}\b/i) || [''])[0].toUpperCase() === String(fact.code).toUpperCase()))) {
        issues.push('铁路缺少匹配的具体车次及精确运行时间，须查询班次后重排，不能用估算列车验收通过');
      }
      const queried = (context.scheduleChoices || []).find((choice) => (choice.list || []).some((candidate) =>
        schedules.sameStation(candidate.from, row.startLocation) && schedules.sameStation(candidate.to, row.endLocation)));
      if (queried && !(queried.list || []).some((candidate) => candidate.s === row.startTime
        && candidate.e === row.endTime && String(row.activity || '').includes(candidate.code))) {
        const first = queried.list[0];
        issues.push(`铁路段${row.startLocation}→${row.endLocation}已有运行图候选，当前${row.startTime}–${row.endTime}未命中具体车次；最早候选${first.code} ${first.s}–${first.e}，若无法衔接须更换接驳而非猜班次`);
      }
      if (/[\/／]|或|最近|待选/.test(`${row.startLocation || ''} ${row.endLocation || ''}`)) issues.push('铁路站点仍是模糊占位或多个备选');
      const endpoints = [row.startLocation, row.endLocation];
      if (endpoints.some((place) => !/站$/.test(place || '') && !(context.official || []).concat(context.references || []).some((fact) =>
        sameEndpoint(place, fact.startLocation) || sameEndpoint(place, fact.endLocation)))) issues.push('铁路上车/下车点没有明确车站');
      const access = sorted.slice(0, i).reverse().find((entry) => entry.category === 'transport'
        && sameEndpoint(entry.endLocation, row.startLocation));
      if (access && minute(access.endTime) > start - 40) {
        issues.push('铁路进站接驳没有40分钟安检缓冲');
        const deadlineMinute = start - 40;
        issues.push(`索引${sorted.indexOf(access)}去${row.startLocation}的接驳须在${String(Math.floor(deadlineMinute / 60)).padStart(2, '0')}:${String(deadlineMinute % 60).padStart(2, '0')}前结束；列车${row.startTime}发车不可移动，请提前该接驳及必要的上游准备`);
      }
      if (!access && context.previousHotel && !sorted.slice(0, i).some((entry) => entry.transportType === 'train')
          && !sameEndpoint(context.previousHotel, row.startLocation)) issues.push('首段列车前缺少昨晚酒店到车站的接驳');
    }
    const activity = String(row.activity || '');
    if (row.sameNodeTransfer) issues.push(`索引${i}同址游客中心/停车场无需二次乘车转场，须修订实际执行动作`);
    if (row.category === 'transport' && /(?:前往|抵达|到达).{1,50}(?:并|后|及|然后)(?:游览|参观|游玩)/.test(activity))
      issues.push(`索引${i}交通与景区游览合并，请拆成到达交通及独立游览窗口，不把接驳耗时算入纯游览`);
    if (row.category === 'transport' && row.startLocation && row.endLocation
        && sameEndpoint(canonicalNode(row.startLocation, context), canonicalNode(row.endLocation, context))
        && !/环线|环游|往返|循环|骑行游览/.test(activity)) issues.push(`索引${i}同址游客中心/停车场无需二次乘车转场，改为入园办理或实际下一段接驳`);
    if (row.transportType === 'train' && /(?:参考|示例)(?:车次|班次)[^。；;]*[GDCZTK]\d{1,5}/i.test(row.note || '')
        && !(context.official || []).concat(context.references || []).some((fact) => sameEndpoint(fact.startLocation, row.startLocation)
          && sameEndpoint(fact.endLocation, row.endLocation))) issues.push(`索引${i}未核验参考车次不能作为实际班次展示，保留明确的开售后核验说明`);
    const next = sorted[i + 1];
    if (row.category === 'ticket' && /(?:索道|缆车)票/.test(activity)
        && /下站/.test(row.endLocation || '') && next && next.category === 'sight'
        && /观景|日落|山顶/.test(`${next.activity} ${next.endLocation}`)
        && !sameEndpoint(row.endLocation, next.endLocation)
        && !/乘(?:坐)?(?:索道|缆车)|搭乘(?:索道|缆车)|(?:索道|缆车)上行/.test(activity)) {
      issues.push(`索引${i}在${row.endLocation}仅购票排队，下一段却已到${next.endLocation}；缺少实际索道上行或步行连接，须预留排队和上山用时`);
    }
    if (/无索道|没有索道|只能徒步/.test(`${activity} ${row.note}`)
        && /(?:实际|应为|应当).{0,12}索道下山/.test(row.note || '')) issues.push(`索引${i}下山方式在动作和备注中矛盾，请选定实际可执行方案并核对酒店位置`);
    if (row.category === 'transport' && row.transportType === 'ride'
        && /^(?:乘坐|搭乘|乘).{0,12}(?:巴士|大巴|旅游专线)/.test(activity)
        && /(?:巴士|大巴|旅游专线)[\/／]包车/.test(activity)) issues.push(`索引${i}巴士主方案被包车备选覆盖，应按主动作统一交通类型`);
    if (row.category === 'transport'
        && /(?:公交|地铁|公共交通)[^。；;]{0,30}或[^。；;]{0,12}(?:网约车|出租车|打车)/.test(activity)) {
      issues.push(`索引${i}混写公共交通与网约车，须选定一种主方式并匹配该方式耗时，其他方案只作备注备选`);
    }
    if (row.transportType === 'walk' && /[（(][^）)]*店[）)]/.test(row.endLocation || '')
        && /餐厅|餐馆|米粉|面馆|饭店|小吃/.test(row.endLocation || '')
        && (context.points || {})[row.startLocation] && !(context.points || {})[row.endLocation]) {
      issues.push(`索引${i}指定餐饮门店${row.endLocation}的定位未核验，不能断言从${row.startLocation}短程步行可达；请查实门店位置与接驳，或改为酒店附近用餐，不编具体门店及步行距离`);
    }
    if (row.transportType === 'bus') {
      const roadFloor = (context.routeFacts || []).find((fact) => /^(?:ride|car)$/.test(fact.mode)
        && sameEndpoint(fact.from, row.startLocation) && sameEndpoint(fact.to, row.endLocation)
        && Number(fact.minMinutes) > end - start);
      if (roadFloor) issues.push(`索引${i}公共交通用时${end - start}分钟短于同路接驳保守参考${roadFloor.minMinutes}分钟，请核查公交/轨交换乘、候车和步行时间，不能直接沿用打车时长`);
    }
    if (/日落|夕阳|落日/.test(activity) && !/日落之后|错过|不看/.test(activity) && start < 15 * 60) issues.push('上午观看日落');
    if (/日出(?!行|发|游|站)/.test(activity.replace(/(?:明|次|翌)日出发|[^，。；;]*(?:明天|明日|次日|翌日|明早|次晨|第二天)[^，。；;]*日出[^，。；;]*/g, ''))
      && !/不看|错过/.test(activity) && start > 9 * 60) issues.push('日出安排过晚');
    if (row.category === 'hotel' && /退房/.test(activity) && start > 16 * 60) issues.push('晚上错误退房');
    if (row.category === 'sight' && start >= 19 * 60
      && /登山|山峰|瀑布|溶洞|徒步|竹筏|漂流|景区/.test(activity)
      && !/夜游|夜景|灯光|演出|夜场/.test(activity)) issues.push('日间景区被排到深夜');
    if (outdoorSight(row)) {
      const point = outdoorPoint(row, context);
      const sunset = point && solarEventMinute(context.date, point.lat, point.lon, true);
      if (sunset !== null && sunset !== undefined && end > sunset + 15) issues.push('户外游览超过当地日落，应提前或缩短游线');
      if (/山|登山/.test(`${activity} ${row.endLocation || ''}`) && end - start < 60
          && /[^\s（）()\-→—]{2,}[\-→—][^\s（）()\-→—]{2,}[\-→—][^\s（）()\-→—]{2,}/.test(activity)) {
        issues.push(`索引${i}多节点山地游线不足一小时，请核对步行、索道和返回用时，不能仅删路线说明冒充完成核心游览`);
      }
    }
    const ownsDrive = /自行驾驶|自驾|开车|驾车|驱车/.test(activity);
    if (context.noDrive && ownsDrive && !(context.selfDriveAllowed && context.selfDriveAllowed(row))) issues.push('未授权自驾');
    if (ownsDrive && row.category === 'transport' && !/停车|泊车/.test(`${activity} ${row.note || ''}`)
      && !(sorted[i + 1] && /停车|泊车/.test(sorted[i + 1].activity || ''))) issues.push('自驾到达后缺少停车安排');
    if (context.preferRail && row.category === 'transport' && row.transportType === 'plane') issues.push('铁路优先需求被未经授权的航班替代');
  });
  if (context.isFirst) {
    const access = sorted.find((row) => row.category === 'transport' && sameEndpoint(row.startLocation, context.origin));
    if (!access || (context.goTime && access.startTime !== context.goTime)) issues.push('首日未从用户指定地点/时间启程');
  }
  if (context.isLast) {
    const last = sorted[sorted.length - 1];
    sorted.forEach((row, i) => {
      const next = sorted[i + 1];
      const finalRail = sorted.reduce((index, entry, j) => entry.transportType === 'train' ? j : index, -1);
      if (finalRail >= 0 && i >= finalRail && next && minute(next.startTime) - minute(row.endTime) > 120) {
        issues.push('返程到站后的未安排时间超过两小时，应调整估算班次或说明实际安排');
      }
      if (row.transportType === 'train' && next && next.category === 'transport'
          && sameEndpoint(row.endLocation, next.startLocation)
          && minute(next.startTime) - minute(row.endTime) > 120) {
        issues.push('返程列车到站后空等超过两小时才接驳，应调整估算班次或安排明确活动');
      }
    });
    if (!sameEndpoint(last.endLocation, context.origin) || (context.backTime && last.endTime !== context.backTime)) {
      issues.push('返程未按指定地点/时间结束');
      if (context.origin) issues.push(`末项索引${sorted.length - 1}必须是到${context.origin}的交通，结束时间${context.backTime || '按需求'}；当前${last.startTime}-${last.endTime} ${last.activity}。到家后的餐饮/休息不能作为行程末项，请删除或移至返程前`);
    }
    const access = sorted.slice().reverse().find((row) => row.category === 'transport'
      && sameEndpoint(row.endLocation, context.origin));
    if (access && context.homeAccessMin && minute(access.endTime) - minute(access.startTime) < context.homeAccessMin) {
      issues.push('返家接驳被压缩得短于原有通勤耗时');
    }
    if (context.preferRail && !sorted.some((row) => row.category === 'transport' && row.transportType === 'train')) {
      issues.push('铁路优先返程缺少实际列车交通，不能用机场片段或到家后自由活动填补');
    }
  } else {
    const last = sorted[sorted.length - 1];
    const target = context.hotel || context.overnight;
    const atLodging = target ? sameLodging(last.endLocation, target)
      : /酒店|民宿|客栈|宾馆|饭店|住宿/.test(last.endLocation || '');
    // 分类只是展示标签；有真实回房动作和正确住宿终点同样构成闭环。
    if (last.category !== 'hotel' && !(atLodging && /休息|回房|返回|回到/.test(last.activity || ''))) {
      issues.push('缺少当晚回住宿地休息');
    }
    if (target && last.category === 'hotel' && !sameLodging(last.endLocation, target)) {
      issues.push('当晚收尾住宿地错误');
      issues.push(`末项索引${sorted.length - 1}的endLocation须为${target}，当前是${last.endLocation || '空值'}`);
    }
  }
  (context.required || []).forEach((name) => {
    if (!sorted.some((row) => row.category === 'sight'
      && minute(row.endTime) - minute(row.startTime) >= 30
      && (`${row.activity || ''} ${row.startLocation || ''} ${row.endLocation || ''}`.includes(name)
        || row.visitScope === name
        || (String(context.city || '').replace(/市$/, '') === name.replace(/市$/, '')
          && !/抵达|车览|途经/.test(row.activity || ''))))) {
      issues.push(`缺少实际游览：${name}`);
    }
  });
  (context.official || []).concat(context.references || []).forEach((fact) => {
    if (!sorted.some((row) => row.category === 'transport' && sameEndpoint(row.startLocation, fact.startLocation)
      && sameEndpoint(row.endLocation, fact.endLocation) && row.startTime === fact.startTime && row.endTime === fact.endTime
      && String(row.activity || '').includes(fact.code))) issues.push('修改或遗漏了官方班次');
  });
  (context.solar || []).forEach((fact) => {
    const event = /日出/.test(fact.activity || '') ? '日出' : '日落';
    if (!sorted.some((row) => row.category === 'sight' && String(row.activity || '').includes(event)
      && row.startTime === fact.startTime && row.endTime === fact.endTime)) issues.push('未保留太阳光线固定窗口');
  });
  (context.visitWindows || []).forEach((fact) => {
    if (!fact.place || !/^https?:\/\//.test(fact.sourceUrl || '')) return;
    const visits = sorted.filter((row) => row.category === 'sight'
      && `${row.activity} ${row.startLocation} ${row.endLocation} ${row.visitScope || ''}`.includes(fact.place));
    if (!visits.length) return;
    const opening = minute(fact.openTime), lastEntry = minute(fact.lastEntryTime), closing = minute(fact.closeTime);
    const first = visits[0], last = visits[visits.length - 1];
    const sightseeingMinutes = visits.reduce((total, row) => total + minute(row.endTime) - minute(row.startTime), 0);
    if (Number(fact.minVisitMinutes) > 0 && sightseeingMinutes < Number(fact.minVisitMinutes)) {
      issues.push(`${fact.place}实际游览仅${sightseeingMinutes}分钟，少于已核查游线的保守用时${fact.minVisitMinutes}分钟；请调整上游出发和接驳，不缩写核心游线冒充游完`);
    }
    const entry = sorted.find((row) => minute(row.startTime) <= minute(first.startTime)
      && /入园|购买门票|购票.*观光车|换乘景区观光车/.test(row.activity || '')
      && `${row.activity} ${row.startLocation} ${row.endLocation}`.includes(fact.place));
    if (opening !== null && minute(first.startTime) < opening) issues.push(`${fact.place}游览早于开放时间${fact.openTime}`);
    if (lastEntry !== null && minute((entry || first).startTime) > lastEntry) issues.push(`${fact.place}入园晚于停止入园时间${fact.lastEntryTime}`);
    if (closing !== null && minute(last.endTime) + Math.max(0, Number(fact.exitMinutes) || 0) > closing) {
      issues.push(`${fact.place}游览和出园接驳应在${fact.closeTime}前完成`);
    }
  });
  // 已定位的独立核心节点须有真实游览位置。把多个名字塞进一个
  // 指向别处的标题不等于完成游线；父景区对应多个子点时不强行拆分。
  locatedCorePlaces(context).forEach((place) => {
    const required = (context.required || []).some((name) => name === place);
    const claimed = sorted.some((row) => row.category === 'sight' && positiveInstructions(row.activity).includes(place));
    // 自动候选可因接续限制不选；用户明确必去或声称已游览才须落实。
    if (!required && !claimed) return;
    if (!sorted.some((row) => row.category === 'sight'
      && [row.startLocation, row.endLocation].some((name) => String(name || '').includes(place))))
      issues.push(`已定位核心点${place}缺少实际游览位置，不能只在其他地点的标题里提及；请安排独立游览和前后接驳`);
  });
  sorted.forEach((row, index) => {
    if (row.transportType !== 'ship' && !(row.category === 'sight' && /(?:体验|乘坐|乘).*(?:竹筏|游船|漂流)/.test(row.activity || ''))) return;
    const routes = (context.sailingWindows || []).filter((fact) => fact.from && fact.to
      && /^https?:\/\//.test(fact.sourceUrl || '') && sameWaterEndpoint(row.startLocation, fact.from));
    if (!routes.length) return; // 未检索到运营资料时，不编造码头映射。
    const selected = routes.filter((fact) => !fact.grade || String(row.activity || '').includes(fact.grade));
    if (!selected.length) issues.push(`该出发码头对应${[...new Set(routes.map((fact) => fact.grade))].join('、')}，船型必须明确且与预约一致`);
    if (/(?:三星|四星|五星).{0,4}[\/或].{0,4}(?:三星|四星|五星)/.test(row.activity || '')) issues.push('实际船程只能选择一种明确船型，不能混写多个等级');
    const arrivals = (selected.length ? selected : routes).filter((fact) => sameWaterEndpoint(row.endLocation, fact.to));
    if (!arrivals.length) {
      issues.push(`水上路线索引${index}的终点${row.endLocation}不符合运营资料：${row.startLocation}应到${[...new Set((selected.length ? selected : routes).map((fact) => fact.to))].join('或')}；不能跨路线拼接，需同步修改下船接驳和行李取回路线`);
      return;
    }
    const departures = [...new Set(arrivals.flatMap((fact) => Array.isArray(fact.departures) ? fact.departures : []))];
    if (departures.length && !departures.includes(row.startTime)) issues.push(`游船索引${index}发船${row.startTime}不在已检索运营窗口${departures.join('、')}内，请调整前序接驳或选择可赶上的真实船型/码头`);
  });
  const firstSight = sorted.findIndex((row) => row.category === 'sight' && !/日出/.test(row.activity));
  const lastSight = sorted.reduce((index, row, i) => row.category === 'sight' ? i : index, -1);
  let checkins = 0;
  let checkouts = 0;
  let storage = '';
  const earlierStorage = new Set(context.previousStorage || []);
  sorted.forEach((row, i) => {
    const text = positiveInstructions(`${row.activity || ''}；${row.note || ''}`);
    const action = positiveInstructions(row.activity || '');
    if (context.isLast && storageInstruction(row.note) && /酒店|民宿|客栈/.test(row.note)
      && !sorted.slice(i + 1).some((entry) => /取回.*行李/.test(entry.activity || ''))) issues.push('末日错误寄存行李');
    if (/退房/.test(action) && ++checkouts > 1) issues.push('同一天重复退房');
    if (storageInstruction(row.activity) && !/取回/.test(action)
        && !(sameEndpoint(row.endLocation, context.hotel) && /入住|回房/.test(action))) {
      const destination = row.endLocation || row.startLocation || '';
      if (storage && destination && !sameEndpoint(storage, destination)) issues.push(`上一处${storage}的寄存行李未取回，不能直接在${destination}再次寄存`);
      storage = destination;
      if (!storage) issues.push('行李寄存缺少明确地点');
    }
    if (/取回.*行李|取.*寄存.*行李/.test(action) && !storage
        && ![...earlierStorage].some((place) => sameEndpoint(place, row.startLocation) || sameEndpoint(place, row.endLocation))) {
      issues.push(`索引${i}取回行李前没有同地点的实际寄存记录；请在游览前安排存放并预留办理时间，不能仅添加泛泛备注`);
    }
    if (/取回.*行李|取.*寄存.*行李/.test(action)) {
      for (const place of earlierStorage) if (sameEndpoint(place, row.startLocation)
        || sameEndpoint(place, row.endLocation)) earlierStorage.delete(place);
    }
    if (/取回.*行李|取.*寄存.*行李/.test(action) && storage) {
      const aliases = [storage, ...[...storage.matchAll(/[（(]([^）)]+)[）)]/g)].map((match) => match[1])];
      if (!sameEndpoint(storage, row.startLocation) && !sameEndpoint(storage, row.endLocation)
          && !aliases.some((name) => name.length >= 2 && text.includes(name))) issues.push('行李取回地点与寄存地点不一致');
      else storage = '';
    }
    if (!context.middayRest && minute(row.startTime) >= 16 * 60 && minute(row.startTime) < 19 * 60
        && /(?:返回|回到|回).*?(?:酒店|民宿|客栈).*?(?:休息|整理)/.test(action)
        && !/入住|取回|身体|疲劳/.test(text)
        && sorted.slice(i + 1).some((next) => next.category === 'food' && /晚餐|晚饭/.test(next.activity || '')))
      issues.push('晚餐前非必要折返酒店，应保留附近游览或按用户休息需求安排');
    const actualCheckin = /办理入住|入住.*(?:放下|寄存)/.test(positiveInstructions(row.activity || ''));
    if (row.category === 'hotel' && /入住/.test(action) && sorted.slice(0, i).some((entry) =>
      sameEndpoint(entry.endLocation, context.hotel) && /入住.*(?:放下|寄存|放置)/.test(positiveInstructions(entry.activity))
      && minute(row.startTime) - minute(entry.endTime) > 30)) issues.push('到达时已入住并放下行李，晚间应回房而非再次入住');
    if (actualCheckin && ((row.category === 'hotel' && ++checkins > 1)
      || (row.category === 'transport' && checkins > 0))) {
      issues.push('同一天重复办理入住或重复放下大件行李');
    }
    if (context.sameHotel && /办理入住|重新入住|放下(?:大件)?行李/.test(text)) issues.push('连住期间重复入住或放下大件行李');
    if (i > firstSight && firstSight >= 0 && i < lastSight
      && /(?:返回|回到|回).*?(?:酒店|民宿|住宿|客栈)/.test(row.activity || '')
      && !/取回|退房|首次入住|身体不适|疲劳/.test(row.activity || '') && !context.middayRest) issues.push(context.scenicRoute
        ? '景区核心游线中途折返住宿地' : '游览中途非必要折返住宿地，优先就近休息，起早时晚上提前收尾');
    if (i > firstSight && firstSight >= 0 && i < lastSight && !context.middayRest
      && /酒店|民宿|住宿点|住宿地|客栈/.test(action)
      && /休息|休整|整理仪容|取回随身|取回.*小件/.test(action)
      && !/首次入住|办理入住|退房|身体不适|疲劳|取回.*大件|取回.*寄存/.test(action))
      issues.push('游览中途非必要住宿折返，改分类或写成抵达住宿点不能绕过；就近休息或夜间提前回房');
    if (/携带(?:全部|所有|大件).{0,10}行李/.test(text)
        && /只(?:带|携带).{0,12}(?:小包|随身|摄影)|轻装/.test(text)
        && !storage && !context.sameHotel && !/寄存|放下|放置/.test(action)) issues.push(`索引${i}全部行李随身与只带小包矛盾，必须先落实真实寄存`);
    if (/允许随身携带至|随身携带在.*(?:酒店|前台)/.test(text)) issues.push(`索引${i}将寄存错误替换成随身携带，需重新表述实际行李方案`);
    if (!context.lightLuggage && !context.sameHotel && ['sight', 'transport', 'ticket', 'other'].includes(row.category)
      && !(row.category === 'ticket' && !/乘坐|登山|上山|漂流体验|骑行体验/.test(row.activity || ''))
      && !(row.category === 'transport' && sameEndpoint(row.endLocation, context.hotel)
        && /入住|放置|放下|搬运/.test(`${row.activity} ${row.note}`))
      && (/竹筏|漂流|骑行|骑.*电动车|登山|登顶|上山|深度.*山|攀登|索道|缆车|雪地徒步|高海拔徒步/.test(String(row.activity || '')
          .replace(/(?:竹筏|漂流|索道|缆车)(?:起点|终点|出口|入口|游客中心|码头|上站|下站|结束后)/g, '接驳点'))
        || (row.category === 'sight' && /(?:山|沟|瀑布|梯田)(?:风景区|景区)?(?:内|入口|游客中心)?$/.test(row.endLocation || ''))
        || (row.category === 'sight' && row.transportType !== 'ship' && minute(row.endTime) - minute(row.startTime) >= 60
          && /景区|博物馆|纪念馆|古街|寺|庙|祠/.test(`${row.activity} ${row.endLocation}`))
        || /^(?:sight|other)$/.test(row.category) && minute(row.endTime) - minute(row.startTime) >= 30
          && /散步|漫步|逛街|街区游览/.test(row.activity || ''))
      && !/山脚|不上山|不登山|不登顶/.test(row.activity || '')) {
      const hasDrop = sorted.slice(0, i).some((entry) => !/退房/.test(entry.activity || '')
        && sameEndpoint(entry.endLocation, context.hotel)
        && (entry.category === 'hotel' || /入住|放下(?:大件)?行李|放置行李/.test(entry.activity || '')))
        || (!!context.previousHotel && !sorted.slice(0, i).some((entry) => /退房|携带全部|携带大件/.test(positiveInstructions(entry.activity)))
          && sorted.slice(i + 1).some((entry) => sameEndpoint(entry.endLocation, context.previousHotel)
            || sameEndpoint(entry.startLocation, context.previousHotel)));
      const hasStore = !!storage; // 已取回后又去骑行/登山，不能继续借用早上的寄存状态。
      if (!hasDrop && !hasStore) {
        issues.push('携带大件行李安排了不便随身携带的活动');
        issues.push(`索引${i}（${row.startTime} ${row.activity}）：此时没有有效寄存，大件仍随身。请在此游览之前安排具体地点寄存、游览之后原地取回，并在原时间预算内留办理和接驳时间。`);
      }
    }
  });
  if (storage && !(sameEndpoint(storage, context.hotel) && !context.isLast
      && sameEndpoint(sorted[sorted.length - 1].endLocation, storage))) {
    issues.push(context.isLast ? '末日错误寄存行李' : '寄存行李未在离开前取回');
  }
  collectMealNames(sorted, context.knownMeals || []).forEach((name) => {
    if ((context.previousMeals || []).includes(name) && !String(context.repeatMeals || '').includes(name)) {
      issues.push(`连续两天重复推荐主菜：${name}，请更换当地特色主菜`);
    }
  });
  sorted.forEach((row, i) => {
    if ((row.category !== 'transport' && row.transportType !== 'ship') || !row.startLocation || !row.endLocation) return;
    const duplicate = sorted.slice(0, i).findIndex((earlier) => (earlier.category === 'transport' || earlier.transportType === 'ship')
      && sameEndpoint(earlier.startLocation, row.startLocation) && sameEndpoint(earlier.endLocation, row.endLocation));
    if (duplicate >= 0 && !sorted.slice(duplicate + 1, i).some((entry) =>
      sameEndpoint(entry.endLocation, row.startLocation))) issues.push('同方向交通重复执行且没有返回起点');
  });
  issues.push(...evidence.geometryIssues(sorted, context.points || {}));
  let location = context.previousHotel || (context.isFirst ? context.origin : '');
  let lastEnd = null;
  sorted.forEach((row) => {
    const start = row.startLocation;
    const previous = sorted[sorted.indexOf(row) - 1];
    if (previous && previous.category === 'food' && row.category === 'sight' && !start
      && location && row.endLocation && !sameEndpoint(location, row.endLocation)) {
      issues.push(`${location}→${row.endLocation}之间缺少独立接驳；用餐后前往新景点的移动和游览须分条`);
    }
    const distance = evidence.distanceKm((context.points || {})[location], (context.points || {})[start]);
    if (location && start && !sameEndpoint(location, start) && distance > 1.5) {
      const gap = lastEnd === null ? 0 : minute(row.startTime) - lastEnd;
      if (gap + 3 < distance / 120 * 60) issues.push(`${location}→${start}之间缺少接驳，位置凭空跳转`);
    }
    location = row.endLocation || row.startLocation || location;
    lastEnd = minute(row.endTime);
  });
  (context.routeFacts || []).forEach((fact) => {
    sorted.filter((row) => row.category === 'transport' && sameEndpoint(row.startLocation, fact.from)
      && sameEndpoint(row.endLocation, fact.to) && row.transportType === fact.mode).forEach((row) => {
      if ((context.official || []).concat(context.references || []).some((proof) => sameEndpoint(proof.startLocation, row.startLocation)
        && sameEndpoint(proof.endLocation, row.endLocation) && proof.startTime === row.startTime
        && proof.endTime === row.endTime)) return;
      if (row.transportType === 'train' && fact.direct === false && (fact.networkOnly || (fact.via || []).length)) {
        issues.push(`${fact.from}→${fact.to}当前运行网络无直达，需真实换乘，不能伪造直达`);
      }
      if (Number(fact.minMinutes) > 0 && minute(row.endTime) - minute(row.startTime) + 5 < Number(fact.minMinutes)) {
        issues.push(`${fact.from}→${fact.to}时长短于检索到的交通下限${fact.minMinutes}分钟`);
      }
    });
  });
  return [...new Set(issues)];
}

async function collectOperatingEvidence(profile, day, previous, original, deadline) {
  const routes = original.filter((row) => row.category === 'transport' && row.startLocation && row.endLocation)
    .map((row) => ({ from: row.startLocation, to: row.endLocation, mode: row.transportType }));
  const references = (day.operatingReferences || []).filter((reference) => reference && /^https?:\/\//.test(reference.sourceUrl || ''));
  const visits = original.filter((row) => ['sight', 'ticket'].includes(row.category) || row.transportType === 'ship');
  const key = JSON.stringify(['operating-windows-v8-tickets', day.date, day.highlights, previous.hotel, day.hotel, routes,
    visits.map((row) => [row.endLocation || row.startLocation, row.visitScope, (row.activity || '').match(/索道|缆车|游船|游轮|船票|竹筏|漂流|演出|观光车/g)]), references]);
  const usable = (value) => value && ((value.routeFacts || []).length || (value.visitWindows || []).length
    || (value.sailingWindows || []).length || (value.ticketProducts || []).length || value.scenicRoute || value.notes || (value.warnings || []).length);
  const addReferences = (result) => {
    result.visitWindows = (result.visitWindows || []).concat(references.flatMap((reference) =>
      (Array.isArray(reference.visitWindows) ? reference.visitWindows : []).map((fact) => Object.assign({}, fact, { sourceUrl: reference.sourceUrl }))));
    result.sailingWindows = (result.sailingWindows || []).concat(references.flatMap((reference) =>
      (Array.isArray(reference.sailingWindows) ? reference.sailingWindows : []).map((fact) => Object.assign({}, fact, { sourceUrl: reference.sourceUrl }))));
    if (references.length) result.references = references;
    return result;
  };
  if (day.executionEvidence && day.executionEvidence.key === key && usable(day.executionEvidence)) return day.executionEvidence;
  const end = Math.min(deadline, Date.now() + 40000);
  if (end - Date.now() < 5000) return {};
  try {
    const ticketRequest = original.some((row) => ['sight', 'ticket'].includes(row.category) || row.transportType === 'ship') ? llm.chatWithRetry([
      { role: 'system', content: '联网核查旅行票务，只输出JSON，不编造链接，不制定时间线。优先运营方和政府公开资料。' },
      { role: 'user', content: `日期${day.date}，区域${day.city}。实际游览：${JSON.stringify(original.filter((row) =>
        ['sight', 'ticket'].includes(row.category) || row.transportType === 'ship').map((row) => ({ activity: row.activity, place: row.endLocation || row.startLocation, note: row.note })))}。
逐个核对所有确定需要门票的实际景点（不按名称关键词猜收费），免费需预约也保留；免费无需预约不列。独立入园票、索道、观光车、游船、竹筏和演出按收费产品分别列出，包含在同一通票的项目不重复购票。仅途经/外观不提取。返回{"ticketProducts":[{"place":"实际景区名","product":"完整景区及单一票种名","ticketRequired":true,"reservationRequired":false,"sourceUrl":"真实运营/售票来源URL，不得用示例或编造域名","basisDate":"资料日期","note":"是否包含内部项目、有效期、免费预约等注意事项"}]}。不确定不要断言收费；未来政策待官方确认。必须逐一检查下列实际游览地点，不能只提取第一处；每个收费地点及独立收费产品均必须返回：${JSON.stringify([...new Set(visits.map((row) => row.endLocation || row.activity))])}。` },
    ], { deadline: Math.min(end, Date.now() + 35000), enableSearch: true, temperature: 0.1 })
      .then((text) => normalizeTicketProducts(llm.parseJSONFromText(text).ticketProducts)).catch(() => []) : Promise.resolve([]);
    const text = await llm.chatWithRetry([
      { role: 'system', content: '你只核查旅行运营知识，不制定时间线。联网查运营方、属地政府、运营公众号/小程序的公开发布；无正规官方渠道时可参考可信旅行平台及多份近期实地资料，但标注来源层级、日期、待确认，不能冒称官方。找不到就明确未知，不复制候选的地理假设。只输出JSON。' },
      { role: 'user', content: `核查日期${day.date}，昨晚在${previous.hotel || profile.origin}，今晚在${day.hotel || profile.origin}。景点${JSON.stringify(day.highlights)}。待核查路线${JSON.stringify(routes)}。
实际游览条目（逐个核对票务，不只检查大纲）：${JSON.stringify(original.filter((row) => ['sight', 'ticket'].includes(row.category)).map((row) => ({ activity: row.activity, place: row.endLocation, note: row.note })))}。
逐项核对景区入园、独立收费景点、索道、观光车、船筏、演出的门票/预约要求，不根据名字是否含景区/山/公园猜收费。返回ticketProducts数组，每个产品格式为{"place":"该产品实际景区/地点","product":"准确购票产品名，如入园票/前山门票/索道往返票","ticketRequired":true,"reservationRequired":false,"sourceUrl":"售票/运营证据URL","basisDate":"资料日期","note":"是否包含内部观光车/索道、有效期或免费预约说明"}。确定需要票的全部列出；免费但需预约的ticketRequired:false、reservationRequired:true；免费且无需预约的不列；未知不可伪称已确定。不同收费区域及门票/索道等独立产品分开，游览途中仅经过、不实际进入的不催购票。
已有外部检索的运营资料（资料不是旅行路线答案；适用日期/季节与当前行程一致才使用）：${JSON.stringify(references)}
补充核查：当地短途游览最合适的工具（租自行车/合规电动自行车、步行、公交等）、按天或按次租赁、续航/禁行/头盔/还车点及截止时间，纳入localMobility；不能把“禁止自驾汽车”等同禁止合法自行车，用户明确不会骑或拒绝骑行时提供替代。旅游专线和景区观光车可用运营公众号、小程序及近期网上资料交叉核对，写清sourceKind/operator/sourceUrl/basisDate/estimated，不保证未来班次。景区入口、游客中心和停车场可能在同一节点，核对同址aliases，禁止在同址间安排虚假长距离转场。深夜山路徒步要考虑照明、安全和末班索道，不把追日落之后夜行当默认可行。
返回JSON还须包含localMobility:[{"area":"片区","mode":"bike|ebike|walk|bus|ride","rentalPeriod":"按天/按次","notes":"归还地点、续航、安全限制与资料层级","sourceUrl":"来源URL","basisDate":"资料日期","estimated":true}]及aliases:[{"place":"准确节点","names":["同址别名"],"sourceUrl":"同址证据URL"}]；visitWindows须包括minVisitMinutes（纯游览分钟），不得用一句游线描述代替时长字段。无证据的字段留空或数组为空，不冒称运营方已确认。
游线用时也要核查：有来源支持的当前核心游线保守耗时可在visitWindows增加minVisitMinutes，统计纯游览（不含买票、行李、用餐）；规划估算明确estimated:true并说明依据，不冒称官方最低用时。没有可信依据时不填。不能用几分钟到门口或压缩路线名称冒充完成整段核心游览。
水上游览包括竹筏/漂流：独立核对运营方公布的准确起终点，不能拼接不同线路，也不能把不在该河段的景点写成沿途经过。即使无需固定发船时刻，也在sailingWindows填写真实起终点、船型和sourceUrl，此时departures留空；一处起点允许多条真实航线时分别列出。路线改变后需核对下船接驳和行李取回路径。
独立核对：各铁路段是否真实直达，若不能直达给区域铁路枢纽的换乘链；各交通段通常至少多少分钟；步行段是否过远；景区内部实际入口、观光车、索道上下站及核心游览顺序；游船等级对应的出发码头/方向及官方发船窗口；冬季开放窗口与末班交通，特别是停止入园和观光车下山的时间。优先查运营方和属地政府公告；未来日期尚未公告时，引用同季历史公告并标记estimated:true和basisDate，说明出行前确认，不能用夏季营业时间安排冬季。没有证据不要给班次号或未来售票时刻。公路省道长途/山区不能按高速最高速度算时间。小型城际站不能凭空开往远方城市，市内地铁站不可作为长途高铁枢纽。说明实际可执行的替代路径，但不要编时间线。输出简短JSON：{"routeFacts":[{"from":"候选起点","to":"候选终点","mode":"train|bus|ride|walk|ship","direct":true,"via":[],"minMinutes":0,"sourceUrl":"证据链接，无证据留空"}],"visitWindows":[{"place":"景区准确名称","openTime":"HH:mm","lastEntryTime":"HH:mm","closeTime":"HH:mm","exitMinutes":30,"sourceUrl":"公告链接，无证据不填本项","estimated":false,"basisDate":"公告日期"}],"sailingWindows":[{"from":"准确出发码头，与条目一致","to":"准确到达码头","grade":"准确船型等级","departures":["HH:mm"],"sourceUrl":"运营公告，无证据不填本项","estimated":true}],"scenicRoute":"核查后的游线和索道/步行/接驳连接，不确定项明确待确认","warnings":["事实矛盾或执行限制"],"sources":["运营方/交通官网链接"]}` },
    ], { deadline: end, enableSearch: true, temperature: 0.1 }).catch((error) => {
      // 运营检索超时不能连带丢弃并行返回的票务核查结果。
      console.warn('[generatePlan.review] 运营检索暂不可用：%s', error.message);
      return '';
    });
    let parsed;
    try { parsed = llm.parseJSONFromText(text); } catch (_) { parsed = null; }
    const ticketProducts = await ticketRequest;
    if (ticketProducts.length) parsed = Object.assign({}, parsed && !Array.isArray(parsed) ? parsed : {},
      { routeFacts: Array.isArray(parsed) ? parsed : parsed && parsed.routeFacts || [],
        ticketProducts: [...ticketProducts, ...(parsed && parsed.ticketProducts || [])] });
    if (Array.isArray(parsed)) parsed = { routeFacts: parsed };
    else if (parsed && parsed.from && parsed.to) parsed = { routeFacts: [parsed] };
    if (parsed && !Array.isArray(parsed.routeFacts) && Array.isArray(parsed.ticketProducts)) parsed.routeFacts = [];
    if (!parsed || !Array.isArray(parsed.routeFacts)) {
      // 检索报告有时不用约定字段或返回说明文；它仍可作为未核验的知识
      // 提示，但不能伪装成结构化事实，也不因此反复丢掉整轮检索成果。
      const result = addReferences({ key, routeFacts: [], scenicRoute: '', warnings: [],
        notes: String(text || '').slice(0, 5000), sources: [] });
      if (!result.notes) return {};
      day.executionEvidence = result;
      return result;
    }
    if (!parsed.routeFacts.length && !parsed.scenicRoute && !(parsed.warnings || []).length
        && !(parsed.visitWindows || []).length && !(parsed.sailingWindows || []).length && !(parsed.ticketProducts || []).length && !references.length) {
      console.warn('[generatePlan.review] 运营知识返回空内容，不能视为已核查');
      return {};
    }
    // 后续换接驳导致重查运营资料时，不能抹掉已核查的收费产品。
    // 最终按实际游览再筛，弃用景点不会留下提醒。
    const ticketProductsByKey = new Map();
    [...(day.ticketProducts || []), ...((day.executionEvidence || {}).ticketProducts || []), ...normalizeTicketProducts(parsed.ticketProducts)]
      .forEach((fact) => ticketProductsByKey.set(`${fact.place}|${fact.product}`, fact));
    day.ticketProducts = [...ticketProductsByKey.values()];
    const result = { key, ticketProducts: day.ticketProducts,
    localMobility: Array.isArray(parsed.localMobility) ? parsed.localMobility.filter((fact) =>
      fact && fact.area && /^https?:\/\//.test(fact.sourceUrl || '')).slice(0, 5) : [],
    aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((fact) => fact && fact.place
      && Array.isArray(fact.names) && /^https?:\/\//.test(fact.sourceUrl || '')).slice(0, 10) : [],
    routeFacts: Array.isArray(parsed.routeFacts) ? parsed.routeFacts.filter((fact) =>
      fact && fact.from && fact.to) : [],
    visitWindows: (Array.isArray(parsed.visitWindows) ? parsed.visitWindows : []).filter((fact) =>
      fact && fact.place && /^https?:\/\//.test(fact.sourceUrl || '')).slice(0, 10),
    sailingWindows: (Array.isArray(parsed.sailingWindows) ? parsed.sailingWindows : []).filter((fact) =>
      fact && fact.from && fact.to && /^https?:\/\//.test(fact.sourceUrl || '')).slice(0, 10),
    scenicRoute: String(parsed.scenicRoute || '').slice(0, 1600), warnings: (parsed.warnings || []).slice(0, 8),
    sources: (parsed.sources || []).filter((url) => /^https?:\/\//.test(url)).slice(0, 5) };
    addReferences(result);
    day.executionEvidence = result;
    return result;
  } catch (error) {
    console.warn('[generatePlan.review] 独立运营核查暂不可用：%s', error.message);
    return {};
  }
}

function syncAcceptedMoves(day, rows) {
  if (!rows.length || !rows.every((row) => row.executionReview === REVIEW_VERSION)) return false;
  const previous = day.moves || [];
  if (previous.filter((move) => ['12306', 'reference'].includes(move.schedSource)).some((move) => !rows.some((row) =>
    row.category === 'transport' && sameEndpoint(row.startLocation, move.from) && sameEndpoint(row.endLocation, move.to)
    && row.startTime === move.startTime && row.endTime === move.endTime && String(row.activity || '').includes(move.code)))) return false;
  day.moves = rows.filter((row) => (row.category === 'transport' || row.transportType === 'ship')
    && row.startLocation && row.endLocation).map((row) => {
    const locked = previous.find((move) => ['12306', 'reference'].includes(move.schedSource) && row.activity.includes(move.code)
      && sameEndpoint(move.from, row.startLocation) && sameEndpoint(move.to, row.endLocation));
    if (locked) return Object.assign({}, locked, { from: row.startLocation, to: row.endLocation });
    const local = /地铁|轨道|公交|轨交|观光车|景区.*接驳|索道|缆车/.test(`${row.activity} ${row.note}`);
    return { from: row.startLocation, to: row.endLocation, mode: row.transportType || 'bus', code: '',
      startTime: row.startTime, endTime: row.endTime, transfer: '', timingEstimated: true,
      scheduleRequired: row.transportType === 'train', bookingRequired: row.transportType === 'bus'
        && !local && (/大巴|巴士|旅游专线|长途|直通车|班车|客车/.test(row.activity || '')
          || minute(row.endTime) - minute(row.startTime) >= 60) };
  });
  return true;
}

function acceptExecutionRows(rows, dayIndex, day, context) {
  const official = context.official || [];
  rows.forEach((row) => {
    row.city = day.city || '';
    const fact = official.find((entry) => sameEndpoint(entry.startLocation, row.startLocation)
      && sameEndpoint(entry.endLocation, row.endLocation) && entry.startTime === row.startTime && entry.endTime === row.endTime);
    if (fact) { row.schedSource = '12306'; row.outlineMove = true; }
    markReference(row, context.references);
    if ((context.solar || []).some((entry) => entry.startTime === row.startTime && entry.endTime === row.endTime)) row.timingLocked = true;
    row.executionReview = REVIEW_VERSION;
    row.executionReviewStatus = 'passed';
  });
  syncAcceptedMoves(day, rows);
  delete day.executionReviewIssues; delete day.executionCandidate;
  day.executionReviewStatus = 'passed';
  delete day.executionReviewWarnings;
  delete day.executionForceReroute;
  day.executionNetworkFacts = context.routeFacts.filter((fact) => fact.networkOnly || fact.scheduleEvidence);
  day.executionRoadFacts = context.routeFacts.filter((fact) => fact.drivingEstimate);
  day.executionTransitFacts = context.routeFacts.filter((fact) => fact.transitEstimate);
  day.executionPoints = context.points;
  day.executionMealNames = collectMealNames(rows, day.meals || []);
  console.log('[generatePlan.review] 第%d天执行复核通过，%d条', dayIndex + 1, rows.length);
  return rows;
}

function finalizeWithWarnings(rows, dayIndex, day, issues, context = {}) {
  context = Object.assign({}, context, { solar: context.solar || rows.filter((row) => row.timingLocked) });
  const result = normalizeReviewRows(rows, dayIndex, context);
  if (!result.length) return result;
  // 严格铁路模式不能靠“待确认”发布虚构列车或改坏的到发时刻。
  const scheduleIssues = executionIssues(result, context).filter((issue) => /铁路缺少匹配|修改或遗漏了官方班次/.test(issue));
  if (context.enforceRailSchedules && scheduleIssues.length) {
    day.executionReviewIssues = [...new Set([...(issues || []), ...scheduleIssues])];
    day.executionCandidate = result;
    return [];
  }
  const warnings = [...new Set([...(issues || []), ...executionIssues(result, context)]
    .map((message) => String(message).replace(/请调整.*$/, '请核实后调整')))].slice(0, 6);
  if (!warnings.length) warnings.push('此日运营资料暂未完成核验，请出行前确认交通、开放时间和接驳。');
  result.forEach((row) => {
    row.executionReview = REVIEW_VERSION; // 已完成处理，不表示事实已核实。
    row.executionReviewStatus = 'needs_confirmation';
    row.city = day.city || '';
    markReference(row, context.references);
    if ((context.official || []).some((fact) => sameEndpoint(fact.startLocation, row.startLocation)
      && sameEndpoint(fact.endLocation, row.endLocation) && fact.startTime === row.startTime && fact.endTime === row.endTime)) {
      row.schedSource = '12306'; row.outlineMove = true;
    }
    if (context.solar.some((fact) => fact.startTime === row.startTime && fact.endTime === row.endTime)) row.timingLocked = true;
  });
  warnings.forEach((warning) => {
    const match = /索引(\d+)/.exec(warning);
    const target = match && result[Number(match[1])] || result.find((row) =>
      row.category === 'transport' && /车次|交通|铁路|班次|接驳/.test(warning)) || result[0];
    const concise = warning.slice(0, 160);
    target.validationWarnings = [...new Set([...(target.validationWarnings || []), concise])];
    if (!String(target.note || '').includes(concise)) target.note = [target.note, `待确认：${concise}`].filter(Boolean).join('；');
  });
  day.executionReviewWarnings = warnings;
  day.executionReviewStatus = 'needs_confirmation';
  delete day.executionCandidate;
  syncAcceptedMoves(day, result);
  return result;
}

async function reviewExecutionItems(profile, outline, items, deadline, options = {}) {
  const days = outline.days || [];
  const indexes = [...new Set(items.map((row) => Number(row.dayIndex || 0)))];
  const results = await Promise.all(indexes.map(async (dayIndex) => {
    const original = items.filter((row) => Number(row.dayIndex || 0) === dayIndex);
    if (original.every((row) => row.executionReview === REVIEW_VERSION)) return original;
    if (deadline - Date.now() < 5000) return original;
    const day = days[dayIndex] || {};
    day.executionReviewAttempted = false;
    const previous = days[dayIndex - 1] || {};
    const official = (day.moves || []).filter((move) => move.schedSource === '12306').map((move) => ({
      startLocation: move.from, endLocation: move.to, startTime: move.startTime, endTime: move.endTime, code: move.code,
    }));
    const required = requiredPlacesForDay(profile, days, dayIndex);
    const context = {
      enforceRailSchedules: true,
      isFirst: dayIndex === 0, isLast: dayIndex === days.length - 1,
      origin: profile.origin, goTime: profile.goTime, backTime: profile.backTime,
      noDrive: String(profile.transport || '').trim() !== '自驾出行', selfDriveAllowed: options.selfDriveAllowed,
      preferRail: /高铁|动车|铁路/.test(profile.transport || '')
        && !/飞机|航班|航空|接受飞行/.test(positiveInstructions(profile.extra)),
      required, highlights: day.highlights || [], scopeCandidates: profile.mustVisit || [], official, references: referenceSchedules(day), city: day.city, date: day.date, hotel: day.hotel, overnight: day.overnight,
      previousStorage: previousStoragePlaces(options.allItems || items, dayIndex),
      scheduleChoices: day.executionScheduleChoices || [],
      sameHotel: !!day.hotel && sameEndpoint(day.hotel, (days[dayIndex - 1] || {}).hotel),
      previousHotel: previous.hotel,
      // 任何明确已订说明均保守视为不可自动换车，避免误改用户订单。
      railAlreadyBooked: /已(?:经)?(?:购|买|订|预约|出票)/.test(positiveInstructions(profile.extra)),
      accessConstraint: day.executionAccessConstraint,
      previousMeals: previous.executionMealNames || [], knownMeals: day.meals || [], repeatMeals: positiveInstructions(profile.extra),
      lightLuggage: /(?:行李|背包|小包).{0,16}(?:轻便|方便随身|方便携带)|只(?:带|携带).{0,8}(?:小包|背包)|无大件行李/.test(profile.extra || ''),
      scenicRoute: original.filter((row) => row.category === 'sight'
        && /梯田|山顶|观景|山峰|徒步|天梯/.test(`${row.activity} ${row.endLocation}`)).length >= 2,
      middayRest: /(?:每天|中午|午间).{0,10}(?:回酒店|回民宿|午休)/.test(positiveInstructions(profile.extra)),
      homeAccessMin: dayIndex === days.length - 1 ? Math.min(60, Math.max(20, ...original.filter((row) =>
        row.category === 'transport' && sameEndpoint(row.endLocation, profile.origin))
        .map((row) => minute(row.endTime) - minute(row.startTime)))) : 0,
    };
    const facts = original.filter((row) => row.timingLocked).map((row) => ({
      activity: row.activity, startTime: row.startTime, endTime: row.endTime,
      startLocation: row.startLocation, endLocation: row.endLocation, note: row.note,
    }));
    context.solar = facts;
    const candidate = Array.isArray(day.executionCandidate) ? day.executionCandidate : original;
    // 此轮只补查班次并持久化，下轮再请求重排，避免长查询挤占云函数预算。
    if (await collectExecutionSchedules(day, candidate, context, deadline)) return original;
    const regions = [profile.origin, profile.dest, previous.overnight, day.overnight, day.city].filter(Boolean).join(' ');
    // 运营检索与整天重排拆轮，不能把两个约20秒的联网请求挤进一个云函数。
    // 首轮仅缓存独立知识，下一轮重排；未核查的日期不提前标成通过。
    const hadEvidence = !!day.executionEvidence && ((day.executionEvidence.routeFacts || []).length
      || (day.executionEvidence.visitWindows || []).length || (day.executionEvidence.sailingWindows || []).length
      || (day.executionEvidence.ticketProducts || []).length || day.executionEvidence.scenicRoute || day.executionEvidence.notes || (day.executionEvidence.warnings || []).length);
    const accessProbe = context.accessConstraint ? [{ category: 'transport', transportType: 'ride',
      startLocation: previous.hotel || previous.overnight || previous.city,
      endLocation: context.accessConstraint.to }, { category: 'transport', transportType: 'ride',
      startLocation: previous.city, endLocation: context.accessConstraint.to }] : [];
    const [operating, freshPoints, topology] = await Promise.all([
      collectOperatingEvidence(profile, day, previous, candidate, deadline),
      evidence.collectRoutePoints(accessProbe.concat(candidate), regions, Math.min(deadline - 20000, Date.now() + 5000)),
      evidence.collectRailTopology(candidate, Math.min(deadline, Date.now() + 12000)),
    ]);
    const points = Object.assign({}, day.executionPoints || {}, freshPoints);
    day.executionPoints = points;
    const roads = await evidence.collectRoadTravelFacts(accessProbe.concat(candidate), points, Math.min(deadline - 15000, Date.now() + 3500));
    const transits = await evidence.collectUrbanTransitFacts(candidate, points, Math.min(deadline - 15000, Date.now() + 2000));
    if (!operating.key || !hadEvidence) {
      console.log('[generatePlan.review] 第%d天%s，下一轮执行时间线复核', dayIndex + 1,
        operating.key ? '运营知识已检索' : '运营知识暂未取得');
      return original;
    }
    // 精确运行图比泛泛运营检索优先，不能把列车经停站误解为必须换乘。
    const railFacts = context.official.concat(context.references).map((fact) => ({
      from: fact.startLocation, to: fact.endLocation, mode: 'train', direct: true,
      scheduleEvidence: true,
      minMinutes: minute(fact.endTime) - minute(fact.startTime), sourceUrl: fact.sourceUrl || 'https://www.12306.cn/',
    }));
    context.routeFacts = (operating.routeFacts || []).filter((fact) => !railFacts.concat(topology, roads, transits).some((proof) =>
      sameEndpoint(proof.from, fact.from) && sameEndpoint(proof.to, fact.to) && proof.mode === fact.mode)).concat(topology, roads, transits);
    context.routeFacts = context.routeFacts.filter((fact) => !railFacts.some((proof) =>
      sameEndpoint(proof.from, fact.from) && sameEndpoint(proof.to, fact.to) && proof.mode === fact.mode)).concat(railFacts);
    context.points = points;
    context.visitWindows = operating.visitWindows || [];
    context.sailingWindows = operating.sailingWindows || [];
    context.aliases = operating.aliases || [];
    context.localMobility = operating.localMobility || [];
    if (!facts.length) facts.push(...deriveSolarWindows(candidate, context));
    const requirements = {};
    ['origin', 'dest', 'startDate', 'endDate', 'goTime', 'backTime', 'party', 'people', 'budget', 'pace',
      'interests', 'transport', 'mustVisit', 'mustGo', 'extra'].forEach((key) => { requirements[key] = profile[key]; });
    if (Array.isArray(day.executionCandidate)) {
      let checked = normalizeReviewRows(candidate, dayIndex, context);
      const locations = (rows) => JSON.stringify(rows.map((row) => [row.startLocation || '', row.endLocation || '']));
      if (locations(checked) !== locations(candidate)) {
        const additional = await evidence.collectRoutePoints(checked, regions, Math.min(deadline - 1500, Date.now() + 2500));
        context.points = Object.assign({}, context.points, additional);
        const updatedRoads = await evidence.collectRoadTravelFacts(checked, context.points, Math.min(deadline - 1500, Date.now() + 3000));
        context.routeFacts = context.routeFacts.filter((fact) => !updatedRoads.some((proof) =>
          sameEndpoint(proof.from, fact.from) && sameEndpoint(proof.to, fact.to) && proof.mode === fact.mode)).concat(updatedRoads);
        checked = normalizeReviewRows(checked, dayIndex, context);
      }
      if (!executionIssues(checked, context).length) return acceptExecutionRows(checked, dayIndex, day, context);
    }
    const prompt = `你是旅行执行审计员，逐段复核并重排这一天，返回完整可执行时间线，不要解释。当前条目是未经信任的候选，可能包含错误地理、编造铁路或地铁、错误游船方向。请用联网检索核对运营知识，再重排，不能直接复制这些错误。已核验铁路事实和太阳窗口除外。
用户需求：${JSON.stringify(requirements)}
本日（第${dayIndex + 1}天）：${JSON.stringify({ date: day.date, city: day.city, theme: day.theme,
      hotel: day.hotel, overnight: day.overnight, highlights: day.highlights, note: day.note,
      moves: (day.moves || []).map(({ from, to, mode, startTime, endTime }) => ({ from, to, mode, startTime, endTime })) })}
昨晚住宿：${JSON.stringify({ overnight: previous.overnight, hotel: previous.hotel })}
后续日：${JSON.stringify({ date: (days[dayIndex + 1] || {}).date, city: (days[dayIndex + 1] || {}).city,
      hotel: (days[dayIndex + 1] || {}).hotel, highlights: (days[dayIndex + 1] || {}).highlights })}
当前条目（index为局部修订索引）：${JSON.stringify(candidate.map((row, index) => ({ index, startTime: row.startTime, endTime: row.endTime,
      category: row.category, activity: String(row.activity || '').slice(0, 160), startLocation: row.startLocation,
      endLocation: row.endLocation, transportType: row.transportType, note: String(row.note || '').slice(0, 80) })))}
已核验、绝对不能修改的铁路事实：${JSON.stringify(official)}
近期运行图参考班次（按已检索具体车次和发到时刻安排行程与接驳，不可任意挪动；不是未来确认开行，活动/备注保留“运行图参考、开售后12306确认”）：${JSON.stringify(context.references)}
太阳光线固定窗口：${JSON.stringify(facts)}
代码检查（针对当前候选，不重复报告已修复的旧问题）：${JSON.stringify(executionIssues(candidate, context))}
上一轮未通过的验收项：${JSON.stringify(day.executionReviewIssues || [])}
独立运营核查（与候选冲突时，必须重新选真实路径，不只是删去车次）：${JSON.stringify(operating)}
实际铁路候选：${JSON.stringify(day.executionScheduleChoices || [])}。已查得候选的铁路必须从对应真实班次中选，不能继续猜时间。查询已返回空候选的路线必须改用有导航耗时依据的道路接驳或真实铁路换乘，不得继续写估算列车/“C字头城际”；“待核实”不能让虚构列车验收通过。若前段铁路无法赶上已选返程列车，提前安排合理道路接驳到返程上车站，或明确方案不可行；高铁优先不是强制每一段都坐火车，不得伪造直达班次。
当前12306运行网络核查（只证明连接及耗时下限，不是未来班次；无直达必须换实际区域枢纽）：${JSON.stringify(topology)}
地图公路导航估算（不可缩短为高速直线距离；公交/班车另加候车、停靠及节假日余量）：${JSON.stringify(roads)}
已核查市内公共交通（其他线路号/换乘站不可编造）：${JSON.stringify(transits)}
地图定位证据（直线距离只是下限，不能冒充实际路程）：${JSON.stringify(points)}
当地日落估算（由地图坐标计算，户外山地游线应在此前完成，不替代开放公告）：${JSON.stringify(Object.fromEntries(Object.entries(points).map(([name, point]) => [name, solarEventMinute(day.date, point.lat, point.lon, true)])))}
规则：
1. 首日必须在${profile.goTime || '用户指定时间'}从${profile.origin}启程；不是此时列车发车。返程日必须在${profile.backTime || '用户指定时间'}到${profile.origin}结束。市内去车站至少留交通耗时和40分钟安检缓冲。返家接驳至少${context.homeAccessMin || '实际交通所需'}分钟，不能为凑到家时间随意压缩通勤耗时。
2. 补齐真实游览，抵达/买票不算游玩。先交通后游览。同日只办理一次退房；连续住同酒店时大件留房，晚上只是回房，不重复入住或放行李。换城时带走全部行李；当天实际寄存过才写取回行李。包括末日在内，景区游玩需要时可在游客中心寄存，但必须在原地点取回，预留办理时间，取回后才去下一城市；不能把行李留在不再返回的酒店。不能拖箱登山、坐竹筏、漂流或骑行，不把大件行李解释为轻便双肩包。每日餐饮更换当地特色主菜，参照全程餐饮分配：${JSON.stringify(days.map((entry) => ({ date: entry.date, meals: entry.meals })))}。晚餐前不要为了整理行李无必要折返酒店又出门；用户明确需要休息时保留。所有景区在开放且光线合理时段游玩，不能早上等待日落。
3. 路线按实际距离和游览时长安排，禁止折返折叠和凭空换城。景区核心点可同日，但步行、接驳、排队和下山时间必须足够；放行李在游线开始前，游线中途不要再回住宿地，沿途用餐后继续前进，最后回住宿地收尾。删除非必要点，不得删用户必去点。不得将A景点贴到B条目上假装已经游览。末日最后一段交通直接以用户到家时间结束，不要提前到家再用整理行李填满时间。
4. 铁路不能到汽车站/码头/游客中心，需实际可检索的铁路枢纽；没有直达应写真实换乘链，到发站只能选一个准确站名，不能“X站/Y站”二选一。小型城际站到远方城市先回区域高铁枢纽再换乘，不要把城际站伪装成长途高铁始发站。联网检索与候选安排冲突时，以运营方和交通官网为准重新选线。已提供近期参考运行图时保留具体车次和对应时刻，明确参考性质，不清空；没有任何班次证据不得发布估算列车，应查询真实换乘或改用合理道路接驳。不要仅因尚未开售就放弃铁路；但已检索的前段候选无法赶上返程列车时，必须改用提前出发的合理道路接驳，锁住已选长途返程铁路，不能猜一班不存在的早班车。无铁路的景区段用旅游专线、大巴或司机接送。城市没有地铁时不能编造地铁线路；距离较远不能写成步行十分钟。只有明确选择自驾或点名具体段自驾才可安排本人驾驶。普通市内返家不得写景区接驳。不要在任何备注中编造后续日期车次。
6. 严格分开到景点的交通与景区内部游览两条，不把“乘车前往并游览”装在一个时段；内部路线和纯游览时长依运营资料与普遍推荐综合选择。停车场与同址游客中心只办理进出园，不发明二次到达或长途接驳。船本身完成城市转移，抵达后从实际下船码头接续，不重复执行起点码头到终点码头的汽车段。参考localMobility适合骑行的目的地优先按天租合规电动自行车，取车、续航、租用时段、归还同一地点都安排清楚；竹筏单向路线要考虑还车衔接。无特殊需要不在游线中途回酒店休整，早起可夜间提前返回休息。
5. 旅游游船的等级、码头、方向须符合运营实际；下船后不要再走船上的景点。住宿只能用本日已有核验酒店的准确名称或明确的住宿片区，不要新造酒店/餐馆。不要改过夜城市。非末日最终回本晚住宿地休息。
已安排的特色主菜：${JSON.stringify(days.map((entry) => ({ date: entry.date, dishes: entry.executionMealNames || [] })))}。今天换不同主菜，餐饮条目mealNames列出活动中实际推荐的主菜名称，不列米饭/青菜等配菜。
输出JSON（完整收尾，优先保留必去游览而非可选夜宵；回房必须写准确酒店名称，不能只填“房间”）：{"items":[{"startTime":"HH:mm","endTime":"HH:mm","category":"transport|hotel|food|sight|ticket|other","activity":"简明活动","startLocation":"准确起点","endLocation":"准确终点","transportType":"train|ship|bus|ride|walk|car或空","note":"简短执行要点","mealNames":[]}],"moves":[{"from":"主交通起点","to":"主交通终点","mode":"train|ship|bus|ride|car","code":"仅官方事实可填","startTime":"HH:mm","endTime":"HH:mm","transfer":"接驳方式及预计耗时"}]}
所有时间在00:00至23:59内且结束晚于开始；不要24:00或跨至翌日00:00的条目。长途转场优先按用户交通偏好选可执行列车，当前大巴方案若令入住跨午夜，必须提前出发、压缩可选休整与用餐等待或更换真实路线，不要仅修最后一段或压缩导航下限。`;
    try {
      const previousIssues = day.executionReviewIssues || [];
      // 无效补丁和整天动线冲突应重新给完整时间线，不能对错误索引反复局修。
      const repairing = !context.accessConstraint && Array.isArray(day.executionCandidate) && previousIssues.length
        && previousIssues.length < 6 && Number(day.executionRepairFailures || 0) < 2
        && !previousIssues.some((issue) => /索引无效|输出缺少|已有运行图候选|非正时长|交通下限/.test(issue));
      // 已证实接续不可行时不用重复喂入那组错误列车时间线，防止模型锚定旧方案。
      const infeasibleDay = needsWholeDayRebuild(day, candidate, context);
      if (infeasibleDay) day.executionForceReroute = true;
      const requestPrompt = infeasibleDay ? `从零重排这一天，只输出完整JSON。旧估算窗口与已查班次或交通下限冲突，不能复用旧时间线、只修最后一项或压缩路程。尤其用户选择高铁/动车优先，应优先从实际铁路车站经真实枢纽转场，景区段用司机接送。
用户需求：${JSON.stringify(requirements)}。日期${day.date}，昨晚住${previous.hotel || previous.overnight}，今晚必须回${day.hotel || day.overnight}。用户本日必须覆盖：${JSON.stringify(required)}。大纲景点候选：${JSON.stringify(day.highlights || [])}；按真实剩余时间择取，不能把模型自动候选全当用户必去点、为了塞满候选而编造接驳或省略整天后半段。已核验的本日核心游线与用户明确要求优先，可选点来不及则注明舍弃/改日建议。
本日已定位的独立核心候选：${JSON.stringify(locatedCorePlaces(context))}；用户明确必去的不可遗漏，自动候选时间不足可不安排；凡宣称游览了就须分别有sight条目并填实际地点，不能只在别处标题里提及。昨日前一天已推荐主菜：${JSON.stringify(context.previousMeals)}，今日换其他当地菜。最后必须有返回今晚住宿休息的hotel条目，endLocation完整填写“${day.hotel || day.overnight}”，不能用不带城市的“经济型片区”等泛称替代，也不能停在晚餐结束。
大纲游线说明（保持明确的游览顺序）：${day.note || '按实际节点顺路游览，避免折返'}。
交通下限证据：${JSON.stringify(context.routeFacts)}；景区开放/纯游览窗口：${JSON.stringify(context.visitWindows)}；船舶起终点：${JSON.stringify(context.sailingWindows)}；同址别名：${JSON.stringify(context.aliases)}；骑行资料：${JSON.stringify(context.localMobility)}。
已选具体铁路及其不可挪动时刻：${JSON.stringify(context.official.concat(context.references))}；其他新选铁路暂不填车次号，代码将补查近期运行图并进一步排接续，不准编造列车号。不要因为未开售就放弃铁路。
太阳固定观景窗口：${JSON.stringify(facts)}；不要将上山接驳和实际观景同时锁成重叠。每个具名核心观景点分成独立游览条目，地点填实际观景点，点间步行/接驳分条，不能把几个名字塞进一个标题而不实际经过。原位置的未取回寄存不能延续到另一个基地；若当天换住处又要上山游览，可从入口安排司机接送/住宿搬运协助把大件送到本晚住宿，再轻装开始游线，说明服务仍需联系核实，不编造已预约或已送达。
先从列车发车时刻倒推：进站安检至少40分钟、再留真实路程、取回行李和还车办理时间，之前才是游览可用窗口。新选铁路已锁定，不能继续使用旧估算的接驳时间。早餐、退房带走行李、到景点交通与内部游览分条；需要寄存须同地点取回，全部竹筏/骑行结束后才取回大件，取回后直接转场。骑行明确按天租车、取车和原地点还车，不得只写骑行而不交代车的去向。没有必要不回旧酒店。上午提前出发安排必要游览与沿途简餐，缩短可选等待而非游览下限。必须安排晚餐并在午夜前入住回房，所有startTime/endTime为HH:mm且结束大于开始，不允许24:00或00:00收尾。
上轮问题：${JSON.stringify(previousIssues)}。输出 {"items":[{"startTime":"HH:mm","endTime":"HH:mm","category":"transport|hotel|food|sight|other","activity":"活动","startLocation":"一个准确起点","endLocation":"一个准确终点","transportType":"train|bus|ride|ship|walk或空","note":"简短执行要点","mealNames":[]}]}。删除旧大巴链重选实际路线，保留必须游览和正确酒店，不能复制旧方案。输出完整当天至回房，备注每条最多60字，不输出推理、冲突风险长文或截断的半日。`
        : context.accessConstraint ? `重新制作纯交通返程日的完整时间线，仅输出JSON。不要复用旧铁路接驳：${JSON.stringify(context.accessConstraint)}
用户需求：${JSON.stringify(requirements)}；日期：${day.date}；昨晚住宿：${previous.hotel || previous.overnight}。
必须保留且不能挪动的长途列车：${JSON.stringify(context.official.concat(context.references))}。参考班次活动及备注必须注明运行图参考、开售后12306确认。
实际铁路候选：${JSON.stringify(day.executionScheduleChoices)}；前段没有可衔接班次，所以删除这些前段铁路及对应候车，改为由司机驾驶的道路接驳，禁止自驾或伪造早班车。
实际道路导航估算：${JSON.stringify(roads)}。若仅城市锚点有导航值，住宿到锚点额外预留至少30分钟，标明具体酒店位置及预约接送仍需确认，不能声称已预约。无导航证据时保守估算并注明待核实，不冒充官方时刻。
从昨晚住宿开始，依次早餐（独立food条目，可提前准备早餐盒）、退房带走全部行李、提前出发道路接驳至${context.accessConstraint.to}（不晚于${context.accessConstraint.arriveBefore}）、至少40分钟安检候车、已选长途列车、实际出站及用餐、返家接驳至少${context.homeAccessMin || 40}分钟。提前起床以保证衔接，不再去原城际车站，不中途折返酒店、不安排取回未寄存的行李。铁路到站后合理安排用餐等待，不留下两小时空档，也不提前到家再填时间，最终在${profile.backTime}到${profile.origin}。时间不得重叠；道路行驶不可压缩导航时间。
上轮问题：${JSON.stringify(previousIssues)}。
输出 {"items":[{"startTime":"HH:mm","endTime":"HH:mm","category":"transport|hotel|food|other","activity":"活动","startLocation":"起点","endLocation":"终点","transportType":"train|ride|walk或空","note":"执行要点","mealNames":[]}]}，包含完整当天，不能只返回修改片段。`
        : repairing ? `${prompt}\n本轮改为局部修订，禁止复制整天！以上输出格式由本条覆盖：返回 {"replacements":[{"startIndex":0,"endIndex":0,"items":[修改后的完整条目]}]}。索引是当前条目数组的0起始下标，闭区间；可替换连续几段，但不要改没有问题的段。代码会自动保留其他条目并验收整天。寄存问题要在游览前安排明确地点寄存并在同一地点取回，可从该游览窗口中留出办理时间；不能只补泛泛备注。修订重点：${JSON.stringify(day.executionReviewIssues)}` : prompt;
      let text = await llm.chatWithRetry([
        { role: 'system', content: '仅输出合法JSON；按时间与地点依赖逐段审核旅行，不能用改标签冒充解决问题。' },
        { role: 'user', content: requestPrompt },
      // 运营知识已在独立轮检索，班次和导航也已有证据。确定性重排不
      // 再重复联网，避免模型输出检索推理长文而忽略结构与接续约束。
      ], { deadline, enableSearch: !infeasibleDay && !context.accessConstraint, temperature: 0.1 });
      day.executionReviewAttempted = true;
      let parsed = llm.parseJSONFromText(text);
      if (Array.isArray(parsed)) parsed = { items: parsed };
      // 等价容器名不值得重做整天；内部字段仍走同一套严格验收。
      if (parsed && !Array.isArray(parsed.items) && Array.isArray(parsed.timeline)) parsed.items = parsed.timeline;
      if (parsed && !Array.isArray(parsed.items) && Array.isArray(parsed.schedule)) parsed.items = parsed.schedule;
      if (parsed && Array.isArray(parsed.replacements)) parsed.items = applyExecutionPatch(candidate, parsed.replacements);
      if (!parsed || !Array.isArray(parsed.items)) {
        day.executionReviewAttempted = false;
        day.executionReviewIssues = [parsed && Array.isArray(parsed.replacements)
          ? `局部修订索引无效：当前仅${candidate.length}项，索引须为0到${candidate.length - 1}的整数闭区间且不能重叠。收到：${JSON.stringify(parsed.replacements.map((patch) => ({ startIndex: patch.startIndex, endIndex: patch.endIndex, hasItems: Array.isArray(patch.items) })))}`
          : '复核输出缺少完整 items 数组，必须按指定JSON结构输出完整时间线'];
        console.warn('[generatePlan.review] 第%d天复核结构错误：%s', dayIndex + 1, JSON.stringify(Object.keys(parsed || {})));
        return original;
      }
      let cleaned = normalizeReviewRows(parsed.items, dayIndex, context);
      const [additional, updatedRail] = await Promise.all([
        evidence.collectRoutePoints(cleaned, regions, Math.min(deadline - 1500, Date.now() + 2500)),
        evidence.collectRailTopology(cleaned, Math.min(deadline - 1500, Date.now() + 8000)),
      ]);
      context.points = Object.assign({}, context.points, additional);
      const updatedRoads = await evidence.collectRoadTravelFacts(cleaned, context.points, Math.min(deadline - 1500, Date.now() + 3000));
      context.routeFacts = context.routeFacts.filter((fact) => !updatedRail.concat(updatedRoads).some((proof) =>
        sameEndpoint(proof.from, fact.from) && sameEndpoint(proof.to, fact.to) && proof.mode === fact.mode)).concat(updatedRail, updatedRoads);
      cleaned = normalizeReviewRows(cleaned, dayIndex, context);
      // 新铁路路线必须先补查，再验收/计算失败次数；不能在最后一次模型
      // 修订提出正确铁路后立即耗尽尝试，带着未查询班次降级发布。
      if (needsExecutionSchedules(day, cleaned, context)) {
        day.executionCandidate = cleaned;
        day.executionReviewAttempted = false;
        console.log('[generatePlan.review] 第%d天重排新增铁路，保存候选后下一轮补查运行图', dayIndex + 1);
        return original;
      }
      let errors = executionIssues(cleaned, context);
      if (errors.length) { day.executionReviewIssues = errors; day.executionCandidate = cleaned; }
      if (errors.length && !repairing && deadline - Date.now() >= 25000) {
        text = await llm.chatWithRetry([
          { role: 'system', content: '仅输出完整合法JSON，修复明确的执行验收问题，不要解释。' },
          { role: 'user', content: requestPrompt }, { role: 'assistant', content: text },
          { role: 'user', content: `验收没有通过：${errors.join('；')}。逐项修正后重新输出完整JSON，保留其他合理安排。` },
        ], { deadline, enableSearch: !infeasibleDay && !context.accessConstraint, temperature: 0.1 });
        const retry = llm.parseJSONFromText(text);
        if (retry && Array.isArray(retry.items)) {
          parsed = retry;
          cleaned = normalizeReviewRows(parsed.items, dayIndex, context);
          errors = executionIssues(cleaned, context);
        }
      }
      if (errors.length) {
        if (errors.some((issue) => /铁路进站接驳没有40分钟/.test(issue))) {
          day.executionBufferFailures = Number(day.executionBufferFailures || 0) + 1;
          if (day.executionBufferFailures >= 2 && deferUnbookedRail(day, cleaned, context)) {
            console.log('[generatePlan.review] 第%d天未购车次接续失败，改选实际较晚班次后下一轮重排', dayIndex + 1);
            return original;
          }
        }
        day.executionRepairFailures = repairing ? Number(day.executionRepairFailures || 0) + 1 : 0;
        day.executionReviewIssues = errors;
        day.executionCandidate = cleaned;
        console.warn('[generatePlan.review] 第%d天复核未通过验收：%s；末项=%s', dayIndex + 1, errors.join('；'),
          JSON.stringify(cleaned[cleaned.length - 1] || {}));
        return original;
      }
      return acceptExecutionRows(cleaned, dayIndex, day, context);
    } catch (error) {
      console.warn('[generatePlan.review] 第%d天复核暂不可用：%s', dayIndex + 1, error.message);
      return original;
    }
  }));
  return results.flat();
}

module.exports = { REVIEW_VERSION, referenceSchedules, selectExecutionSchedules, deferUnbookedRail, needsWholeDayRebuild, deriveSolarWindows, fitLockedReturnAccess, requiredPlacesForDay, previousStoragePlaces, collectMealNames, invalidateRepeatedMeals, invalidateUnsafeAcceptedDays, syncAcceptedMoves, finalizeWithWarnings, applyExecutionPatch, minute, sameEndpoint, fitEstimatedReturn, fitEstimatedConnections, normalizeReviewRows, executionIssues, reviewExecutionItems };
