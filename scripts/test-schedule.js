/**
 * 班次时刻真实性：代码不许改写模型给的真实班次
 *
 * 起因（2026-09-26）：用户反馈"生成的每班高铁车次和时间都和当天真实车次对不上"。
 * 排查下来不是模型记不住（图定列车是长期稳定的公开信息），而是我们自己的兜底
 * 把班次整体平移了：车次号还是模型给的，时刻却成了算出来的。
 *
 * 三条铁律：
 *   1. 用户填的出发/到家时间与真实班次冲突时，保留班次时刻，改提示人几点出门
 *   2. 时间线重叠时，交通条目不让路也不顺延，让景点/用餐条目先收尾
 *   3. 未核验估算窗口可规整刻度；官方运行图的分钟必须原样保留
 */

const P = require('../cloudfunctions/generatePlan/plan.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra || ''); }
}

// ---------- 1. 冲突时保留真实班次时刻，不平移 ----------
{
  const p = { goTime: '15:30', backTime: '23:00' };
  const outline = {
    days: [
      {
        city: 'A市',
        moves: [{ from: 'A站', to: 'B站', mode: 'train', code: 'G1234', startTime: '08:30', endTime: '13:20' }],
      },
      {
        city: 'B市',
        moves: [{ from: 'B站', to: 'A站', mode: 'train', code: 'G5678', startTime: '18:00', endTime: '23:30' }],
      },
    ],
  };
  const r = P.applyTripEdgeTimes(p, outline);
  const go = r.days[0].moves[0];
  const back = r.days[1].moves[0];
  ok('去程：真实发车时刻不被平移', go.startTime === '08:30' && go.endTime === '13:20', `${go.startTime}-${go.endTime}`);
  ok('返程：真实到站时刻不被平移', back.startTime === '18:00' && back.endTime === '23:30', `${back.startTime}-${back.endTime}`);
  ok('去程：冲突时提示建议几点出发', /建议 \d{2}:\d{2} 前出发/.test(r.days[0].note || ''), r.days[0].note);
  ok('返程：冲突时提示预计几点到家', /预计 \d{2}:\d{2} 到家/.test(r.days[1].note || ''), r.days[1].note);
}

// ---------- 2. 不冲突时不加提示（别啰嗦） ----------
{
  // backTime 20:00 到家 → 期望到站 19:20，与模型给的 19:20 正好对上
  const p = { goTime: '07:00', backTime: '20:00' };
  const outline = {
    days: [
      { city: 'A市', moves: [{ from: 'A站', to: 'B站', mode: 'train', code: 'G1', startTime: '08:25', endTime: '10:10' }] },
      { city: 'B市', moves: [{ from: 'B站', to: 'A站', mode: 'train', code: 'G2', startTime: '17:30', endTime: '19:20' }] },
    ],
  };
  const r = P.applyTripEdgeTimes(p, outline);
  ok('对得上时不去动时刻', r.days[0].moves[0].startTime === '08:25');
  ok('对得上时不啰嗦提示', !/建议|预计/.test(`${r.days[0].note || ''}${r.days[1].note || ''}`));
}

// ---------- 3. 时刻规整到 5 分钟刻度 ----------
{
  const outline = {
    days: [
      { city: 'A市', moves: [{ from: 'A站', to: 'B站', mode: 'train', code: 'G1', startTime: '08:37', endTime: '14:23' }] },
      { city: 'B市', moves: [{ from: 'B站', to: 'C站', mode: 'car', code: '包车', startTime: '09:03', endTime: '11:08' }] },
    ],
  };
  const r = P.snapScheduleMinutes(outline);
  ok('火车发车规整到 5 分刻度', r.days[0].moves[0].startTime === '08:35', r.days[0].moves[0].startTime);
  ok('火车到达规整到 5 分刻度', r.days[0].moves[0].endTime === '14:25', r.days[0].moves[0].endTime);
  ok('包车/自驾不参与规整', r.days[1].moves[0].startTime === '09:03', r.days[1].moves[0].startTime);
  const official = P.snapScheduleMinutes({ days: [{ moves: [{ from: '甲站', to: '乙站', mode: 'train',
    code: 'G123', startTime: '08:37', endTime: '14:23', schedSource: '12306' }] }] });
  ok('官方运行图不因非5分钟刻度而被修改', official.days[0].moves[0].startTime === '08:37'
    && official.days[0].moves[0].endTime === '14:23');
}

// ---------- 4. 时间线重叠：交通不让路，让别的条目先收尾 ----------
{
  const items = [
    { dayIndex: 0, category: 'sight', activity: '逛博物馆', startTime: '10:00', endTime: '15:00' },
    { dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 G99 次列车从A站前往B站', startTime: '14:00', endTime: '17:00' },
  ];
  const out = P.fixDayTimeOverlaps(items);
  const train = out.find((x) => x.category === 'transport');
  const sight = out.find((x) => x.category === 'sight');
  ok('交通条目的发车时刻不被顺延', train.startTime === '14:00', train.startTime);
  ok('改为让前一条行程提前收尾', sight.endTime === '14:00', sight.endTime);
}

// ---------- 5. 交通 vs 交通：仍然顺延（否则全天时间线崩） ----------
{
  const items = [
    { dayIndex: 0, category: 'transport', transportType: 'car', activity: '打车去车站', startTime: '10:00', endTime: '14:30' },
    { dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 G88 次列车', startTime: '14:00', endTime: '17:00' },
  ];
  const out = P.fixDayTimeOverlaps(items);
  const train = out.find((x) => /G88/.test(x.activity));
  ok('同为交通时仍保底顺延（时间线不断）', train.startTime === '14:30', train.startTime);
}

// ---------- 4. 联网检索到的真实班次：回写大纲 + 细化兜底 ----------
console.log('== 4. 真实班次（联网检索） ==');
{
  const S = require('../cloudfunctions/generatePlan/schedule.js');
  const rail = require('../cloudfunctions/generatePlan/rail12306.js');

  const stationFixture = [
    { name: '南宁东', code: 'NNZ', city: '南宁' },
    { name: '崇左南', code: 'CZN', city: '崇左' },
  ];
  const forwardRepair = rail.routePairs({ from: '南宁东站', to: '大新南站', dayCity: '崇左' }, stationFixture);
  ok('非铁路目的地补站时保持南宁→崇左方向',
    forwardRepair.some((pair) => pair.from.name === '南宁东' && pair.to.name === '崇左南'),
    JSON.stringify(forwardRepair));
  const reverseRepair = rail.routePairs({ from: '大新南站', to: '南宁东站', dayCity: '崇左' }, stationFixture);
  ok('反向非铁路起点补站时保持崇左→南宁方向',
    reverseRepair.some((pair) => pair.from.name === '崇左南' && pair.to.name === '南宁东'),
    JSON.stringify(reverseRepair));

  // 4.1 脏数据清洗：时刻不合法 / 车次号不成型的一律丢掉
  const cleaned = S.normalizeList([
    { code: 'G2249', from: 'A站', to: 'B站', s: '08:30', e: '13:20' },
    { code: 'G99999', from: 'A站', to: 'B站', s: '09:00', e: '14:00' },  // 车次号不成型
    { code: 'D1234', from: 'A站', to: 'B站', s: '25:00', e: '26:00' },   // 时刻非法
    { code: '', from: 'A站', to: 'B站', s: '10:00', e: '15:00' },        // 没车次号
    { code: 'G100', from: 'A站', to: 'B站', s: '7:05', e: '12:00' },     // 时刻要补零
  ]);
  ok('脏数据被洗掉、时刻补零、按出发时间排序',
    cleaned.length === 2 && cleaned[0].code === 'G100' && cleaned[0].s === '07:05'
      && cleaned[1].code === 'G2249', JSON.stringify(cleaned));
  const routeCleaned = S.normalizeList([
    { code: 'G2249', from: 'A站', to: 'B站', s: '08:30', e: '13:20' },
    { code: 'G2251', from: '别的站', to: 'B站', s: '09:00', e: '14:00' },
    { code: 'G2252', from: 'A站', to: 'B站', s: '14:00', e: '13:00' },
    { code: 'G2253', from: '', to: 'B站', s: '15:00', e: '16:00' },
  ], { from: 'A站', to: 'B站' });
  ok('带路线校验时拒绝串站、缺站和倒序时刻',
    routeCleaned.length === 1 && routeCleaned[0].code === 'G2249', JSON.stringify(routeCleaned));

  // 4.2 只收集城际段，且同方向只查一次
  const outline = {
    days: [
      {
        date: '2026-12-20', city: 'A市',
        moves: [
          { from: 'A站', to: 'B站', mode: 'train', code: 'G1', startTime: '08:00', endTime: '12:00' },
          { from: 'B站', to: 'B酒店', mode: 'car', startTime: '12:20', endTime: '12:50' },
        ], sched: [],
      },
      {
        date: '2026-12-22', city: 'B市',
        moves: [{ from: 'B站', to: 'A站', mode: 'train', code: 'G2', startTime: '09:00', endTime: '13:00' }],
        sched: [],
      },
    ],
  };
  const segs = P.collectSegments(outline);
  ok('只收集火车/飞机段（市内包车不算）', segs.length === 2, JSON.stringify(segs.map((s) => s.key)));
  ok('往返是两个不同的段（方向不同）',
    segs[0].key !== segs[1].key, segs.map((s) => s.key).join(' / '));
  const sameRouteDifferentDates = P.collectSegments({
    days: [
      { date: '2026-12-20', moves: [{ from: 'A站', to: 'B站', mode: 'train' }] },
      { date: '2026-12-21', moves: [{ from: 'A站', to: 'B站', mode: 'train' }] },
    ],
  });
  ok('同线路不同日期分开检索和缓存',
    sameRouteDifferentDates.length === 2
      && sameRouteDifferentDates[0].scheduleKey !== sameRouteDifferentDates[1].scheduleKey,
    JSON.stringify(sameRouteDifferentDates));

  // 4.3 写回大纲：挑离原意最近的那一班，车站对得上才改站名
  const found = new Map([
    ['A站→B站', [
      { code: 'G2249', from: 'A站', to: 'B站', s: '08:30', e: '13:20' },
      { code: 'G2251', from: 'A站', to: 'B站', s: '18:00', e: '22:50' },
    ]],
  ]);
  const stat = P.applyRealSchedules(outline, found);
  ok('命中 1 段并换成了真实车次',
    stat && stat.segments === 1 && stat.replaced === 1, JSON.stringify(stat));
  ok('车次与时刻用的是检索结果',
    outline.days[0].moves[0].code === 'G2249'
      && outline.days[0].moves[0].startTime === '08:30'
      && outline.days[0].moves[0].endTime === '13:20',
    JSON.stringify(outline.days[0].moves[0]));
  ok('候选列表塞进了当天（细化阶段照着挑）',
    (outline.days[0].sched || []).length === 2, JSON.stringify(outline.days[0].sched));
  ok('标记了来源，前端才能写"已核对"',
    outline.days[0].moves[0].schedSource === 'search', outline.days[0].moves[0].schedSource);

  const returnDeadlineOutline = { days: [{ date: '2026-12-22', city: '成都', moves: [
    { from: '成都东站', to: '重庆西站', mode: 'train', code: 'G0001', startTime: '14:00', endTime: '16:00' },
  ], sched: [] }] };
  const returnOptions = new Map([['成都东站→重庆西站', [
    { code: 'G0001', from: '成都东站', to: '重庆西站', s: '14:00', e: '16:00' },
    { code: 'G0002', from: '成都东站', to: '重庆西站', s: '12:30', e: '15:10' },
  ]]]);
  P.applyRealSchedules(returnDeadlineOutline, returnOptions, { endTime: '16:00' });
  ok('末日按到家截止时间挑选能留出 40 分钟接驳的官方返程班次',
    returnDeadlineOutline.days[0].moves[0].code === 'G0002'
      && returnDeadlineOutline.days[0].moves[0].endTime === '15:10',
    JSON.stringify(returnDeadlineOutline.days[0].moves[0]));

  // 4.4 检索结果串到别的城市时：整条候选丢弃，不能把错车次写进攻略
  const o2 = { days: [{ moves: [{ from: '甲城站', to: '乙城站', mode: 'train', code: 'G1', startTime: '08:00', endTime: '12:00' }], sched: [] }] };
  P.applyRealSchedules(o2, new Map([['甲城站→乙城站', [
    { code: 'G7777', from: '完全不相干的站', to: '另一个站', s: '08:00', e: '12:00' },
  ]]]));
  ok('车站对不上时不写入车次、不乱改地名',
    o2.days[0].moves[0].code === 'G1' && o2.days[0].moves[0].from === '甲城站'
      && !o2.days[0].moves[0].schedSource,
    JSON.stringify(o2.days[0].moves[0]));

  // 4.4.1 同一天多段官方铁路移动必须按顺序衔接，不能各自挑最近班次
  const timelineOutline = {
    days: [{ date: '2027-01-02', moves: [
      { from: '甲站', to: '乙站', mode: 'train', code: 'C100', startTime: '14:24', endTime: '15:32' },
      { from: '乙站', to: '丙站', mode: 'train', code: 'G200', startTime: '14:23', endTime: '15:46' },
    ] }],
  };
  const timelineFound = new Map([
    ['甲站→乙站', [
      { code: 'C100', from: '甲站', to: '乙站', s: '14:24', e: '15:32' },
    ]],
    ['乙站→丙站', [
      { code: 'G200', from: '乙站', to: '丙站', s: '14:23', e: '15:46' },
      { code: 'G201', from: '乙站', to: '丙站', s: '16:05', e: '17:30' },
    ]],
  ]);
  timelineFound.routeMeta = new Map([
    ['甲站→乙站', { attempted: true, official: true, from: '甲站', to: '乙站' }],
    ['乙站→丙站', { attempted: true, official: true, from: '乙站', to: '丙站' }],
  ]);
  const timelineStat = P.applyRealSchedules(timelineOutline, timelineFound);
  const timelineMoves = timelineOutline.days[0].moves;
  ok('同日多段官方铁路按顺序重新选班',
    timelineStat.timelineAdjusted === 1 && timelineMoves[1].code === 'G201',
    JSON.stringify(timelineMoves));
  ok('官方铁路班次不会互相重叠',
    Number(timelineMoves[1].startTime.replace(':', '')) >= Number(timelineMoves[0].endTime.replace(':', '')),
    JSON.stringify(timelineMoves));
  const fixedOfficial = P.enforceOfficialRailItems([
    { dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 C100 次列车',
      startTime: '14:24', endTime: '15:32', startLocation: '甲站', endLocation: '乙站' },
    { dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 G200 次列车',
      startTime: '14:23', endTime: '15:46', startLocation: '乙站', endLocation: '丙站' },
  ], timelineOutline);
  ok('细化结果也跟随统一选出的官方班次',
    /G201/.test(fixedOfficial[1].activity) && fixedOfficial[1].startTime === '16:05',
    JSON.stringify(fixedOfficial[1]));

  const unavailable = {
    days: [{ date: '2027-01-01', moves: [{ from: '甲站', to: '乙站', mode: 'train', code: 'G9999', startTime: '08:00', endTime: '10:00' }] }],
  };
  const noOfficial = new Map([[S.cacheKeyOf({ from: '甲站', to: '乙站', date: '2027-01-01' }), []]]);
  noOfficial.routeMeta = new Map([[S.cacheKeyOf({ from: '甲站', to: '乙站', date: '2027-01-01' }), {
    attempted: true, official: true,
  }]]);
  P.applyRealSchedules(unavailable, noOfficial);
  ok('未取得未来官方班次时清空车次，时段明确标为估算且要求再次查询',
    unavailable.days[0].moves[0].code === ''
      && unavailable.days[0].moves[0].timingEstimated === true
      && unavailable.days[0].moves[0].scheduleRequired === true
      && unavailable.days[0].moves[0].schedSource === 'official-unavailable',
    JSON.stringify(unavailable.days[0].moves[0]));

  const unresolved = {
    days: [{ date: '2027-01-01', moves: [{ from: '非铁路地点甲', to: '非铁路地点乙', mode: 'train', code: 'G0000',
      startTime: '08:00', endTime: '10:00' }] }],
  };
  const unresolvedKey = S.cacheKeyOf({ from: '非铁路地点甲', to: '非铁路地点乙', date: '2027-01-01' });
  const unresolvedLookup = new Map([[unresolvedKey, []]]);
  unresolvedLookup.routeMeta = new Map([[unresolvedKey, { attempted: true, official: true, unresolvedStations: true }]]);
  P.applyRealSchedules(unresolved, unresolvedLookup);
  ok('铁路站点无法解析时不擅自改为大巴，清除虚构车次并要求重新确认站名',
    unresolved.days[0].moves[0].mode === 'train'
      && !unresolved.days[0].moves[0].code
      && unresolved.days[0].moves[0].timingEstimated === true
      && unresolved.days[0].moves[0].scheduleRequired === true
      && /站名待确认/.test(unresolved.days[0].moves[0].transfer),
    JSON.stringify(unresolved.days[0].moves[0]));
  const invalid = unresolved.days[0].moves[0];
  const { executionIssues } = require('../cloudfunctions/generatePlan/execution-review');
  ok('未确认铁路站名不能通过最终执行复核', executionIssues([{
    category: 'transport', transportType: invalid.mode, activity: '乘动车前往目的地',
    startTime: invalid.startTime, endTime: invalid.endTime, startLocation: invalid.from, endLocation: invalid.to,
  }], {}).includes('铁路上车/下车点没有明确车站'));

  // 4.5 细化兜底：模型自创了候选里没有的车次 → 拽回真实班次
  const o3 = { days: [{ sched: [
    { code: 'G2249', from: 'A站', to: 'B站', s: '08:30', e: '13:20' },
    { code: 'G2251', from: 'A站', to: 'B站', s: '18:00', e: '22:50' },
  ] }] };
  const items = [
    { dayIndex: 0, category: 'transport', transportType: 'train', startTime: '08:40', endTime: '13:20',
      activity: '08:40 乘 G9999 前往B站', note: '' },
    { dayIndex: 0, category: 'transport', transportType: 'train', startTime: '18:10', endTime: '22:50',
      activity: '18:10 乘 G2251 前往B站', note: '' },
  ];
  const fixed = P.enforceRealSchedule(items.map((x) => Object.assign({}, x)), o3);
  ok('自创车次被拽回真实班次',
    /G2249/.test(fixed[0].activity) && !/G9999/.test(fixed[0].activity), fixed[0].activity);
  ok('本来就在候选里的不动、并标记已核对',
    /G2251/.test(fixed[1].activity) && fixed[1].schedSource === 'search', fixed[1].activity);
  ok('拽回后时刻与检索结果一致', fixed[0].startTime === '08:30', fixed[0].startTime);

  const envBackup = {};
  ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_ENABLE_SEARCH', 'LLM_SEARCH_CAPABLE'].forEach((k) => {
    envBackup[k] = process.env[k];
    delete process.env[k];
  });
  process.env.LLM_PROVIDER = 'deepseek';
  ok('不确认支持联网的端点不标记班次已核对', !S.canSearch());
  process.env.LLM_SEARCH_CAPABLE = '1';
  ok('自定义端点明确声明联网能力后才开启检索', S.canSearch());
  Object.keys(envBackup).forEach((k) => {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  });
}

{
  const candidate = { code: 'G100', from: '甲站', to: '乙站', s: '09:00', e: '11:00' };
  const outline = { days: [{ moves: [{ from: '甲站', to: '乙站', mode: 'train',
    code: 'G100', startTime: '09:00', endTime: '11:00', schedSource: '12306', sched: [candidate] }] }] };
  const feeder = { dayIndex: 0, category: 'transport', transportType: 'bus',
    startLocation: '乙站', endLocation: '丙景区', startTime: '12:00', endTime: '14:00',
    activity: '下高铁后乘旅游大巴前往丙景区' };
  const unrelated = { ...feeder, transportType: 'train', startLocation: '丁站', endLocation: '戊站', activity: '乘列车' };
  const fixed = P.enforceOfficialRailItems(P.enforceRealSchedule([feeder, unrelated], outline), outline);
  ok('一段官方铁路不能污染下车后的公路接驳', fixed[0].endLocation === '丙景区' && fixed[0].startTime === '12:00');
  ok('起终点不匹配的其他铁路段不能套用当天唯一候选', fixed[1].startLocation === '丁站' && fixed[1].endTime === '14:00');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
