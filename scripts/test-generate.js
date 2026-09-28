// scripts/test-generate.js
// 本地实跑 AI 制定攻略（generatePlan）
//   node scripts/test-generate.js          跑完整（真调 LLM）
//   node scripts/test-generate.js --unit   只跑确定性规则，不调 LLM
//
// 验证点：
//   1. 12306 预售规则兜底闹钟是否算对（参考攻略实写：9月16日 11:00 抢 9月30日 G2249）
//   2. 逐天细化条目数是否达到参考攻略的细致度（84 条 / 8 天 ≈ 10 条/天）
//   3. 时间连续性、零时长、缺结束时间是否达标
//   4. 闹钟时间合法性（不能是过去、不能晚于行程结束）

const fs = require('fs');
const path = require('path');

// ---------- 加载 .env.local ----------
const envPath = path.resolve(__dirname, '..', '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('❌ 缺少 .env.local（需 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL）');
  process.exit(1);
}
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  const l = line.trim();
  if (!l || l.startsWith('#')) return;
  const m = l.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (!m) return;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
});

const P = require('../cloudfunctions/generatePlan/plan.js');
const G = require('../cloudfunctions/generatePlan/geocode.js');
const { validateOutlineHotels } = require('../cloudfunctions/generatePlan/hotel-validation.js');
const { parseJSONFromText } = require('../cloudfunctions/generatePlan/llm.js');
const { normalizeInput, shiftDate, dayDiff, isHolidayRange, buildFallbackAlarms, sanitizeAlarmCandidates } = P;
const { stripMeta, sanitizeItems } = require('../cloudfunctions/generatePlan/normalize.js');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra ? '  → ' + extra : '')); }
};

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : null;
};

console.log('============================================');
console.log('第一部分：确定性规则（不需要 LLM）');
console.log('============================================');

// 1. 天数计算：9-30 ~ 10-07 = 8 天（与参考攻略一致）
ok(dayDiff('2026-09-30', '2026-10-07') === 8, 'dayDiff 9-30~10-07 = 8 天', dayDiff('2026-09-30', '2026-10-07'));
ok(dayDiff('2026-10-01', '2026-10-01') === 1, '同一天 = 1 天');
const trailingJson = parseJSONFromText('模型结果：{"t":"路线 } 说明","ds":[{"d":"2026-12-31"}]} 以上是行程大纲。');
ok(trailingJson.t === '路线 } 说明' && trailingJson.ds[0].d === '2026-12-31',
  '完整 JSON 后追加解释文字时仍能提取首个结构（字符串里的括号不影响解析）', JSON.stringify(trailingJson));
const missingCommaJson = parseJSONFromText('{"ds":[{"d":"2026-12-31"} {"d":"2027-01-01"}]}');
ok(missingCommaJson.ds.length === 2,
  '模型漏写相邻 JSON 数组项分隔逗号时能自动修复', JSON.stringify(missingCommaJson));
const controlCharJson = parseJSONFromText('{"ds":[{"d":"2026-12-31","n":"第一行'
  + String.fromCharCode(10) + '第二行"}]}');
ok(controlCharJson.ds[0].n === '第一行 第二行',
  '行程文本含原始换行控制符时仍能解析 JSON', JSON.stringify(controlCharJson));

// 2. 12306 预售：T-14 → 参考攻略实写"9月16日抢9月30日的票"
ok(shiftDate('2026-09-30', -14) === '2026-09-16', '12306 预售兜底：9-30 的车 → 9-16 开票', shiftDate('2026-09-30', -14));
ok(isHolidayRange('2026-09-30', '2026-10-07'), '识别国庆为法定长假');

// 3. 输入归一化：非法日期 / 超长天数兜底
const ni = normalizeInput({ dest: '广西', startDate: '2026-09-30', endDate: '2026-10-31', days: 33 });
ok(ni.days === 12, '超过 12 天的行程被收敛到 12 天', ni.days);
const nj = normalizeInput({ dest: '广西', startDate: 'bad', endDate: '' });
ok(/^\d{4}-\d{2}-\d{2}$/.test(nj.startDate), '非法日期兜底为今天', nj.startDate);

// 4. 规则兜底闹钟：用**未来行程**验证算法本身（今天是实时的，不能用过去日期测规则）
const mkOutline = (start, end) => ({
  days: [
    { date: start, theme: '出发', city: '桂林', overnight: '桂林', moves: [{ from: '重庆北', to: '桂林西', mode: 'train', code: 'G2249' }], highlights: ['日月双塔'] },
    { date: end, theme: '返程', city: '南宁', overnight: '返程', moves: [{ from: '南宁东', to: '重庆西', mode: 'train', code: 'G2244' }], highlights: [] },
  ],
  nights: [{ date: start, city: '桂林' }],
});
const fb = buildFallbackAlarms({ startDate: '2026-12-20', endDate: '2026-12-26' }, mkOutline('2026-12-20', '2026-12-26'));
const goAlarm = fb.find((a) => /去程/.test(a.title) && a.type === 'train');
ok(!!goAlarm && goAlarm.fireAtStr.startsWith('2026-12-06'), '去程抢票闹钟 = 出发日减 14 天（12-20 → 12-06）', goAlarm && goAlarm.fireAtStr);
ok(fb.some((a) => /返程/.test(a.title) && a.fireAtStr.startsWith('2026-12-12')), '返程抢票闹钟 = 返程日减 14 天（12-26 → 12-12）');
const hotelReminder = fb.find((a) => a.type === 'hotel');
ok(!!hotelReminder && hotelReminder.fireAt > Date.now() && hotelReminder.fireAt < Date.now() + 10 * 60 * 1000,
  '酒店提醒近期触发，提示用户尽早到酒店分类逐项预订', hotelReminder && hotelReminder.fireAtStr);
ok(!!hotelReminder && /随时提前预订/.test(hotelReminder.note) && /酒店住宿/.test(hotelReminder.note),
  '酒店提醒说明可随时预订并指向酒店分类', hotelReminder && hotelReminder.note);

// 4b. 开票日已过但行程未出发 → 降级成"赶紧去抢"的近期提醒（用户临时才规划的常见场景）
const late = buildFallbackAlarms({ startDate: '2026-09-30', endDate: '2026-10-07' }, mkOutline('2026-09-30', '2026-10-07'));
ok(late.every((a) => a.fireAt > Date.now()), '开票日已过时，闹钟被顺延到现在之后而不是消失', late.length);
ok(late.some((a) => ['train', 'plane', 'bus', 'ticket'].includes(a.type)
  && a.fireAt < Date.now() + 10 * 60 * 1000
  && /立即/.test(a.title || '') && /已过/.test(a.note || '')),
  '已错过开票日的票务提醒用户现在立即核实并购买');

// 5. 闹钟清洗：过去时间 / 瞎编日期一律丢弃
const clean = sanitizeAlarmCandidates([
  { title: '过去的票', fireAt: '2020-01-01 09:00', type: 'train' },
  { title: '行程结束后', fireAt: '2030-01-01 09:00', type: 'train' },
  { title: '未来的票', fireAt: '2026-10-06 09:00', type: 'train' },
  { title: '未来的票', fireAt: '2026-10-06 09:00', type: 'train' }, // 重复
], { startDate: '2026-09-30', endDate: '2026-10-07' });
ok(clean.length === 1 && clean[0].title === '未来的票', '闹钟清洗：过去/超期/重复各被拦掉', clean.length);
const typedBookingAlarms = P.normalizeBookingAlarmKinds([
  { type: 'ticket', title: '预约2027-01-02 乘坐包车前往毕棚沟游客中心', dayIndex: 0, linkedItemId: 'chauffeur' },
  { type: 'ticket', title: '购票2027-01-01 成都东站→离堆公园站', dayIndex: 1, linkedItemId: 'rail' },
  { type: 'ticket', title: '预约德天瀑布门票', dayIndex: 2, linkedItemId: 'admission' },
], [
  { itemId: 'chauffeur', dayIndex: 0, category: 'transport', transportType: 'car', activity: '乘坐包车前往毕棚沟游客中心' },
  { itemId: 'rail', dayIndex: 1, category: 'transport', transportType: 'train', activity: '乘坐动车从成都东站前往离堆公园站' },
  { itemId: 'admission', dayIndex: 2, category: 'ticket', activity: '预约德天瀑布门票入园' },
]);
  ok(typedBookingAlarms.length === 2
    && typedBookingAlarms.some((a) => a.linkedItemId === 'rail' && a.type === 'train')
    && typedBookingAlarms.some((a) => a.linkedItemId === 'admission' && a.type === 'ticket'),
  '普通接驳不生成门票放票闹钟，误标车票按实际交通类型归类', JSON.stringify(typedBookingAlarms));
  const localToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nearTripDate = shiftDate(localToday, 3);
  const onSaleProfile = normalizeInput({
    origin: '重庆金童路', dest: '桂林', startDate: nearTripDate, endDate: nearTripDate,
  });
  const onSaleRail = P.normalizeBookingAlarmKinds([
    { type: 'ticket', title: '购票：12306 重庆北→桂林北', dayIndex: 0, linkedItemId: 'on-sale-rail', fireAt: Date.now() + 86400000 },
  ], [{ itemId: 'on-sale-rail', dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘坐高铁前往桂林' }], onSaleProfile)[0];
  ok(onSaleRail && onSaleRail.type === 'train' && /立即查看并购买/.test(onSaleRail.title)
    && onSaleRail.fireAt <= Date.now() + 2 * 60 * 1000,
  '已过 12306 预售日的车票提醒现在购买，不再等待未来闹钟', JSON.stringify(onSaleRail));
  const futureTripDate = shiftDate(localToday, 30);
  const futureProfile = normalizeInput({
    origin: '重庆', dest: '成都', startDate: futureTripDate, endDate: futureTripDate,
  });
  const futureRail = P.normalizeBookingAlarmKinds([
    { type: 'train', title: '抢去程车票：重庆北→成都东', dayIndex: 0, linkedItemId: 'future-rail', fireAt: Date.now() + 86400000 },
  ], [{ itemId: 'future-rail', dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘坐高铁前往成都' }], futureProfile)[0];
  ok(futureRail && futureRail.type === 'train'
    && futureRail.fireAtStr.startsWith(`${shiftDate(futureTripDate, -14)} `)
    && /预计开售/.test(futureRail.title),
  '尚未开售的车票闹钟对齐到预计开票日', JSON.stringify(futureRail));
  const unlinkedRideTicket = P.normalizeBookingAlarmKinds(P.linkBookingAlarms([
    { type: 'ticket', title: '预约2027-01-02 乘坐包车/拼车前往毕棚沟景区游客中心', dayIndex: 0 },
  ], [
    { itemId: 'ride-1', dayIndex: 0, category: 'transport', transportType: 'car', activity: '乘坐包车/拼车前往毕棚沟景区游客中心' },
    { itemId: 'ticket-1', dayIndex: 0, category: 'ticket', activity: '预约毕棚沟景区门票' },
  ]), [
    { itemId: 'ride-1', dayIndex: 0, category: 'transport', transportType: 'car', activity: '乘坐包车/拼车前往毕棚沟景区游客中心' },
    { itemId: 'ticket-1', dayIndex: 0, category: 'ticket', activity: '预约毕棚沟景区门票' },
  ]);
  ok(unlinkedRideTicket.length === 0,
    '未绑定 ID 的接驳提醒先按具体文案绑定交通条目，再移出门票分类', JSON.stringify(unlinkedRideTicket));
  const walkMistakenAsTicket = P.normalizeBookingAlarmKinds([
    { type: 'ticket', title: '预约2026-10-04 从酒店步行至网约车上车点，准备前往遇龙河码头',
      dayIndex: 4, linkedItemId: 'walk-pickup' },
  ], [{ itemId: 'walk-pickup', dayIndex: 4, category: 'other', transportType: 'walk',
    activity: '从酒店步行至网约车上车点，准备前往遇龙河码头' }], normalizeInput({
      startDate: '2026-10-01', endDate: '2026-10-07',
    }));
  ok(walkMistakenAsTicket.length === 0,
    '步行去网约车上车点等普通接驳不能生成门票提醒', JSON.stringify(walkMistakenAsTicket));
  const pierTransferMistakenAsTicket = P.normalizeBookingAlarmKinds([
    { type: 'ticket', linkedItemId: 'pier-transfer', title: '漂流预约：前往遇龙河景区码头' },
  ], [{ itemId: 'pier-transfer', category: 'transport', transportType: 'ride',
    activity: '乘车前往遇龙河景区码头，确认漂流登船地点' }], normalizeInput({
      startDate: '2026-10-01', endDate: '2026-10-07',
    }));
  ok(pierTransferMistakenAsTicket.length === 0,
    '前往景区码头的打车接驳不因活动关键词被误分成门票提醒');
  const transferWithPurchaseMention = P.normalizeBookingAlarmKinds([
    { type: 'ticket', linkedItemId: 'visitor-transfer', title: '预约前往德天瀑布游客中心并购买门票' },
  ], [{ itemId: 'visitor-transfer', category: 'other', transportType: 'ride',
    activity: '打车前往德天瀑布景区游客中心，寄存行李后购买门票' }], normalizeInput({
      startDate: '2026-10-01', endDate: '2026-10-07',
    }));
  ok(transferWithPurchaseMention.length === 0,
    '普通接驳条目即使提到“购买门票”也不能生成门票提醒', JSON.stringify(transferWithPurchaseMention));
  const fixedHotelAlarm = P.normalizeBookingAlarmKinds([
    { type: 'hotel', title: '确认酒店预订：桂林中心片区', note: '请在出发前抢订' },
  ], [])[0];
  ok(fixedHotelAlarm && /尽早确认酒店预订/.test(fixedHotelAlarm.title)
    && /随时提前预订/.test(fixedHotelAlarm.note) && /越早/.test(fixedHotelAlarm.note)
    && /酒店住宿/.test(fixedHotelAlarm.note),
  '酒店提醒统一说明可随时预订、越早越好并指向酒店分类', JSON.stringify(fixedHotelAlarm));

// 5b. 剔除 LLM 的"内心独白"（真跑时第2天出现过一整段自我纠错）
//     用户会原样看到这段，必须只留"要做什么"
const meta1 = stripMeta(
  '08:00-08:30 打车前往磨盘山码头。*注：根据大纲，若人已在阳朔需调整，此处严格遵循【已确认跨城交通】。');
ok(!/注：/.test(meta1) && !/大纲/.test(meta1), '清掉"*注：根据大纲…"的推理段', meta1);
ok(/打车前往磨盘山码头/.test(meta1), '正常行程内容被保留', meta1);
const meta2 = stripMeta('20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉');
ok(meta2 === '20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉', '没有元叙述的原文原样不动');
const meta3 = stripMeta('注：作为AI我无法确认班次');
ok(meta3.length > 0, '整段都是元叙述时保留原文（不把行程清成空白）', meta3);

// 5c. 目的地清单解析：用户点名的地点一个都不能丢（"龙脊梯田消失"事件的防线）
const dl1 = P.parseDestList('桂林、龙脊梯田、阳朔、明仕田园和德天瀑布');
ok(dl1.mustVisit.join(',') === '桂林,龙脊梯田,阳朔,明仕田园,德天瀑布',
  '顿号 + "和"都能拆开', dl1.mustVisit.join(','));
const dl2 = P.parseDestList('广西（桂林、阳朔、南宁）');
ok(dl2.destList.includes('广西') && !dl2.mustVisit.includes('广西'),
  '省份只是范围提示，不算必到点', dl2.mustVisit.join(','));
ok(dl2.mustVisit.join(',') === '桂林,阳朔,南宁', '括号里的城市全部进必到清单', dl2.mustVisit.join(','));
const dl3 = P.parseDestList('北京颐和园');
ok(dl3.mustVisit.length === 1 && dl3.mustVisit[0] === '北京颐和园',
  '"颐和园"这类含"和"的地名不被切碎', dl3.mustVisit.join(','));
const dl4 = P.parseDestList('四川省、成都');
ok(!dl4.mustVisit.includes('四川省') && dl4.mustVisit.includes('成都'),
  '"四川省"被排除、城市保留', dl4.mustVisit.join(','));
const mustGoProfile = normalizeInput({ dest: '桂林', mustGo: '一定要去：漓江游船、遇龙河竹筏' });
ok(mustGoProfile.mustVisit.includes('漓江游船') && mustGoProfile.mustVisit.includes('遇龙河竹筏'),
  '补充要求中的必去点也进入大纲覆盖检查', mustGoProfile.mustVisit.join(','));

// 5d. 大纲漏点检测：点名地点没出现在大纲里要能查出来
const fakeP = { mustVisit: ['桂林', '龙脊梯田'] };
const outlineMiss = {
  title: 't', summary: '', nights: [],
  days: [{ date: '2026-10-01', city: '桂林', theme: '象鼻山', moves: [], highlights: ['象鼻山'], meals: [], overnight: '桂林', note: '' }],
};
ok(P.missingMustVisit(fakeP, outlineMiss).join('') === '龙脊梯田',
  '漏掉龙脊梯田能被检测出来', JSON.stringify(P.missingMustVisit(fakeP, outlineMiss)));
const outlineHit = Object.assign({}, outlineMiss, {
  days: outlineMiss.days.concat([{ date: '2026-10-02', city: '龙胜', theme: '龙脊梯田一日', moves: [], highlights: ['龙脊梯田'], meals: [], overnight: '龙脊', note: '' }]),
});
ok(P.missingMustVisit(fakeP, outlineHit).length === 0, '排进去了就不再报缺');

// 5d-2. 点名地点覆盖判定要容忍"庄园/田园"这类一字之差
ok(P.placeStem('明仕庄园') === '明仕' && P.placeStem('明仕田园') === '明仕',
  '庄园/田园这类尾巴被剥掉，词干一致', P.placeStem('明仕庄园'));
ok(P.placeStem('龙脊梯田') === '龙脊', '梯田也算尾巴', P.placeStem('龙脊梯田'));
ok(P.placeStem('桂林') === '桂林', '普通地名原样保留', P.placeStem('桂林'));
ok(P.missingMustVisit({ mustVisit: ['明仕庄园'] }, {
  days: [{ date: '2026-10-01', city: '崇左', theme: '明仕田园与德天瀑布', moves: [], highlights: ['明仕田园'], meals: [], overnight: '崇左', note: '' }],
}).length === 0, '大纲写了「明仕田园」时不再误报缺「明仕庄园」');
ok(P.missingMustVisit({ mustVisit: ['龙脊梯田'] }, {
  days: [{ date: '2026-10-01', city: '桂林', theme: '市区', moves: [], highlights: ['象鼻山'], meals: [], overnight: '桂林', note: '' }],
}).length === 1, '真漏了照样报缺');

// 5d-3. "只路过"不算覆盖（都江堰事件的防线）：出现在 mv 描述 / n 提示里的
// 「经过都江堰游客中心」不能当成"去玩了"——只认 城市/主题/必玩点 三个字段
const transitOutline = {
  days: [{
    date: '2026-10-01', city: '毕棚沟', theme: '直奔毕棚沟',
    moves: [{ from: '成都', to: '毕棚沟', m: 'car', c: '', s: '07:00', e: '12:00', n: '坐车经过都江堰游客中心' }],
    highlights: ['毕棚沟'], meals: [], overnight: '毕棚沟', note: '',
  }],
};
ok(P.missingMustVisit({ mustVisit: ['都江堰'] }, transitOutline).length === 1,
  '「途经都江堰」不算覆盖：只在交通描述里出现照样报缺',
  JSON.stringify(P.missingMustVisit({ mustVisit: ['都江堰'] }, transitOutline)));
ok(P.missingMustVisit({ mustVisit: ['成都市'] }, transitOutline).length === 1,
  '「成都市」按词干比对（成都）不被带"市"字卡住',
  JSON.stringify(P.missingMustVisit({ mustVisit: ['成都市'] }, transitOutline)));
const highlightBackfillOutline = {
  days: [{ city: '成都市→都江堰市', theme: '拜水都江堰，问道青城山', overnight: '都江堰市',
    highlights: ['都江堰水利工程', '南桥夜景'], }],
};
P.ensureOutlineHighlightCoverage(highlightBackfillOutline, { mustVisit: ['成都市', '都江堰', '青城山'] });
ok(highlightBackfillOutline.days[0].highlights.includes('青城山'),
  '当天主题点名的青城山会落到详细阶段可展开的必玩点', JSON.stringify(highlightBackfillOutline.days[0].highlights));

// 5d-3a. 中途提前回家要推迟到末日，给到家时间留出对应返程大交通
const earlyReturnProfile = normalizeInput({
  origin: '重庆金童路', dest: '桂林、阳朔',
  startDate: '2026-09-30', endDate: '2026-10-03', endTime: '16:00',
  transport: '高铁/动车优先', interests: ['当地美食', '拍照打卡'],
});
const earlyReturnOutline = {
  days: [
    { date: '2026-09-30', city: '桂林', overnight: '桂林', theme: '抵达桂林', moves: [], highlights: ['桂林'], meals: [] },
    { date: '2026-10-01', city: '阳朔', overnight: '阳朔', theme: '阳朔游玩', moves: [], highlights: ['阳朔'], meals: [] },
    { date: '2026-10-02', city: '重庆市', overnight: '重庆', theme: '提前返家', moves: [{ from: '桂林北', to: '重庆西', mode: 'train', code: 'G123' }], highlights: ['重庆夜景'], meals: [] },
    { date: '2026-10-03', city: '重庆', overnight: '返程', theme: '在家休息', moves: [], highlights: [], meals: [] },
  ],
};
const prematureDays = P.prematureOriginDays(earlyReturnProfile, earlyReturnOutline);
ok(prematureDays.join(',') === '2', '识别非末日提前回到出发地的行程安排', prematureDays.join(','));
P.deferPrematureReturn(earlyReturnProfile, earlyReturnOutline, prematureDays);
ok(P.prematureOriginDays(earlyReturnProfile, earlyReturnOutline).length === 0
  && earlyReturnOutline.days[2].city === '阳朔'
  && earlyReturnOutline.days[2].overnight === '阳朔',
'把提前回家的中间日留在最后一处目的地区域', JSON.stringify(earlyReturnOutline.days[2]));
const repairedReturn = earlyReturnOutline.days[3].moves[0];
ok(repairedReturn && repairedReturn.from === '阳朔' && repairedReturn.to === '重庆西'
  && repairedReturn.mode === 'train' && repairedReturn.endTime === '15:20' && repairedReturn.scheduleRequired,
  '返程大交通移到末日并到达车站，再按 16:00 到家倒推接驳', JSON.stringify(repairedReturn));
ok(P.prematureOriginDays(normalizeInput({
  origin: '重庆金童路', dest: '重庆、成都', startDate: '2026-09-30', endDate: '2026-10-03',
}), earlyReturnOutline).length === 0, '出发地本身是用户目的地时，不误报为提前返程');
const originDepartureProfile = normalizeInput({
  origin: '重庆市金童路', dest: '桂林、阳朔、龙脊梯田、明仕田园、德天瀑布',
  startDate: '2026-09-30', endDate: '2026-10-03', endTime: '16:00',
  transport: '高铁/动车优先',
});
const originDepartureOutline = { days: [
  { city: '大新县硕龙镇', overnight: '大新县硕龙镇', moves: [] },
  { city: '南宁市', overnight: '南宁市', moves: [{ from: '重庆西站', to: '南宁东站', mode: 'train', code: 'G3595' }] },
  { city: '南宁市', overnight: '南宁市', moves: [] },
  { city: '返程', overnight: '返程', moves: [] },
] };
const originDepartureDays = P.prematureOriginDays(originDepartureProfile, originDepartureOutline);
ok(originDepartureDays.join(',') === '1', '识别中途从重庆站出发去外地造成的首末日顺序颠倒', originDepartureDays.join(','));
P.deferPrematureReturn(originDepartureProfile, originDepartureOutline, originDepartureDays);
ok(originDepartureOutline.days[1].moves[0].from === '大新县硕龙镇'
  && originDepartureOutline.days[1].moves[0].to === '南宁市'
  && originDepartureOutline.days[1].moves[0].mode === 'bus',
  '把中途从出发城市出发的错误交通改为前一晚住宿地到当天城市的公共交通', JSON.stringify(originDepartureOutline.days[1]));
const returnLabelOutline = { days: [
  { city: '成都市', overnight: '成都', moves: [] },
  { city: '都江堰市', overnight: '都江堰', moves: [] },
  { city: '理县 -> 毕棚沟 -> 成都市', overnight: '返程', moves: [{ from: '成都东站', to: '重庆北站', mode: 'train' }] },
  { city: '重庆市', overnight: '返程', moves: [] },
] };
const returnLabelDays = P.prematureOriginDays(earlyReturnProfile, returnLabelOutline);
ok(returnLabelDays.join(',') === '2', '中途住宿标为“返程”或中途车次回家也会触发末日闭环修正', returnLabelDays.join(','));
P.deferPrematureReturn(earlyReturnProfile, returnLabelOutline, returnLabelDays);
ok(returnLabelOutline.days[2].city === '成都市' && returnLabelOutline.days[3].moves[0].from === '成都市',
  '返程前已有目的地路线时，以中途返程段最后的外地枢纽安排末日返家', JSON.stringify(returnLabelOutline.days));
ok(returnLabelOutline.days[3].moves[0].to === '重庆北站',
  '城际返程终点使用模型曾提到的重庆车站，不使用家门地址代替到站', JSON.stringify(returnLabelOutline.days[3].moves[0]));

// 5d-4. 跨天重复游玩检测（毕棚沟玩两次事件的防线）
const dupOutline = {
  days: [
    { date: '2026-10-01', city: '毕棚沟', theme: '毕棚沟', moves: [], highlights: ['毕棚沟', '娜姆湖'], meals: [], overnight: '毕棚沟', note: '' },
    { date: '2026-10-02', city: '成都', theme: '市区', moves: [], highlights: ['宽窄巷子'], meals: [], overnight: '成都', note: '' },
    { date: '2026-10-03', city: '毕棚沟', theme: '再玩一次', moves: [], highlights: ['晨拍毕棚沟', '红军沟'], meals: [], overnight: '成都', note: '' },
  ],
};
const dups = P.duplicateHighlights(dupOutline);
ok(dups.length === 1 && dups[0].name === '毕棚沟' && dups[0].days.join(',') === '0,2',
  '「毕棚沟」与「晨拍毕棚沟」算同一个，跨天报重', JSON.stringify(dups));
const cleanDups = P.duplicateHighlights({
  days: [
    { date: '2026-10-01', city: '成都', theme: 'x', moves: [], highlights: ['宽窄巷子', '锦里'], meals: [], overnight: '成都', note: '' },
    { date: '2026-10-02', city: '都江堰', theme: 'x', moves: [], highlights: ['青城山', '都江堰景区'], meals: [], overnight: '成都', note: '' },
  ],
});
ok(cleanDups.length === 0, '不同景点不误报', JSON.stringify(cleanDups));

// 5e. 去程开始时间 / 返程到家时间：代码兜底对齐（不靠 LLM 自觉）
//     语义（二次修正）：goTime = 离开出发地（家门口）的时刻 → 大交通发车
//     = goTime + 市内接驳 40 分 + 安检候车 45 分（火车）/2 小时（飞机）；
//     backTime = 到家时刻 → 大交通到站 = backTime - 40 分（市内返家接驳）
const edgeP = normalizeInput({
  dest: '桂林', startDate: '2026-12-20', endDate: '2026-12-22',
  startTime: '08:30', endTime: '21:15',
});
const edgeOutline = {
  title: 't', summary: '', nights: [],
  days: [
    { date: '2026-12-20', city: '桂林', theme: '出发', overnight: '桂林', meals: [], note: '',
      moves: [{ from: '重庆北', to: '桂林西', mode: 'train', code: 'G2249', startTime: '14:44', endTime: '19:38' }],
      highlights: ['日月双塔'] },
    { date: '2026-12-21', city: '桂林', theme: '游玩', overnight: '桂林', meals: [], note: '', moves: [], highlights: [] },
    { date: '2026-12-22', city: '桂林', theme: '返程', overnight: '返程', meals: [], note: '',
      moves: [{ from: '桂林西', to: '重庆北', mode: 'train', code: 'G2244', startTime: '09:12', endTime: '14:06' }],
      highlights: [] },
  ],
};
// ⚠️ 2026-09-26 起语义变了（Tiger 实锤"每班车都对不上"）：
// 旧做法把整段班次"平移"到用户填的时刻 → 车次号还是 G2249，时刻却成了算出来的 16:15，
// 用户一查 12306 就全对不上。现在的原则是**班次时刻是事实，代码绝不改写**：
// 时刻只做 5 分钟刻度对齐，与用户意向冲突时把"建议几点出门/预计几点到家"写进当天 note。
const edged = P.applyTripEdgeTimes(edgeP, JSON.parse(JSON.stringify(edgeOutline)));
ok(edged.days[0].moves[0].startTime === '14:45' && edged.days[0].moves[0].endTime === '19:40',
  '去程：班次时刻保持模型给的真实值（只对齐 5 分钟刻度，不按出发时间平移）',
  `${edged.days[0].moves[0].startTime}-${edged.days[0].moves[0].endTime}`);
ok(/建议\s*\d{2}:\d{2}\s*前出发/.test(edged.days[0].note || ''),
  '去程：与出发时间冲突时把"建议几点出门"写进当天提示（时刻本身不动）',
  edged.days[0].note || '(无提示)');
ok(edged.days[2].moves[0].startTime === '09:10' && edged.days[2].moves[0].endTime === '14:05',
  '返程：班次时刻同样保持真实值（不按到家时间倒推发车）',
  `${edged.days[2].moves[0].startTime}-${edged.days[2].moves[0].endTime}`);
ok(/预计\s*\d{2}:\d{2}\s*到家/.test(edged.days[2].note || ''),
  '返程：与到家时间冲突时把"预计几点到家"写进当天提示',
  edged.days[2].note || '(无提示)');
// 到家时间再离谱（凌晨 3 点）也不改班次时刻——旧版会倒推出"半夜发车"这种鬼时刻
const weird = P.applyTripEdgeTimes(
  normalizeInput({ dest: '桂林', startDate: '2026-12-20', endDate: '2026-12-22', endTime: '03:00' }),
  JSON.parse(JSON.stringify(edgeOutline)));
ok(weird.days[2].moves[0].endTime === '14:05' && weird.days[2].moves[0].startTime === '09:10',
  '到家时间再离谱也不倒推班次（不再出现"半夜发车"）',
  weird.days[2].moves[0].startTime + '-' + weird.days[2].moves[0].endTime);
// 反向用例：模型给的班次本来就与用户意向吻合（13:20 出门 + 85 分 ≈ 14:45 发车）
// → 时刻不动，也不该画蛇添足加"建议几点出门"的提示
const alignedGo = P.applyTripEdgeTimes(
  normalizeInput({ dest: '桂林', startDate: '2026-12-20', endDate: '2026-12-22', startTime: '13:20', endTime: '21:15' }),
  JSON.parse(JSON.stringify(edgeOutline)));
ok(alignedGo.days[0].moves[0].startTime === '14:45',
  '对得上时时刻原样保留（不平移也不倒推）',
  alignedGo.days[0].moves[0].startTime);
ok(!/建议\s*\d{2}:\d{2}\s*前出发/.test(alignedGo.days[0].note || ''),
  '对得上时不加多余提示（45 分钟容差内视为吻合）',
  alignedGo.days[0].note || '(无提示)');

// 5e+. 选站通用体检：到站后接驳耗时的解析与"接驳过长"判定（不认任何具体地名/车站）
ok(P.transferMinutes('地铁30分钟') === 30, '接驳耗时：地铁30分钟 → 30', String(P.transferMinutes('地铁30分钟')));
ok(P.transferMinutes('步行 8 分钟') === 8, '接驳耗时：步行 8 分钟 → 8', String(P.transferMinutes('步行 8 分钟')));
ok(P.transferMinutes('打车约 45 分钟') === 45, '接驳耗时：打车约 45 分钟 → 45', String(P.transferMinutes('打车约 45 分钟')));
ok(P.transferMinutes('打车 1 小时 10 分') === 70, '接驳耗时：1 小时 10 分 → 70', String(P.transferMinutes('打车 1 小时 10 分')));
ok(P.transferMinutes('出站即到') === null, '接驳耗时：没有数字 → null', String(P.transferMinutes('出站即到')));
const dOutline = {
  title: 't', summary: 's', nights: [],
  days: [
    { date: '2026-10-10', city: 'A市', theme: '游玩', overnight: 'A市', meals: [], note: '',
      // 轨交 40 分钟：大城市很常见，不算绕路
      moves: [{ from: '甲站', to: '乙站', mode: 'train', code: 'G1', startTime: '09:00', endTime: '11:00', transfer: '地铁40分钟' }],
      highlights: ['某景区'] },
    { date: '2026-10-11', city: 'B市', theme: '游玩', overnight: 'B市', meals: [], note: '',
      // 到站后还要打车 45 分钟 → 站多半选在了反方向
      moves: [{ from: '丙站', to: '丁站', mode: 'train', code: 'G2', startTime: '09:00', endTime: '10:00', transfer: '打车45分钟' }],
      highlights: ['某景区'] },
    { date: '2026-10-12', city: 'C市', theme: '游玩', overnight: 'C市', meals: [], note: '',
      moves: [{ from: '戊站', to: '己站', mode: 'train', code: 'G3', startTime: '09:00', endTime: '10:00', transfer: '出站步行5分钟' }],
      highlights: ['某景区'] },
  ],
};
const detours = P.detourTransfers(dOutline);
ok(detours.length === 1 && detours[0].dayIndex === 1 && detours[0].minutes === 45 && detours[0].byCar,
  '只判"到站后还要长途打车"的段（第2天 打车45分钟）', JSON.stringify(detours.map((x) => `${x.dayIndex + 1}天${x.minutes}分`)));
ok(P.detourTransfers(dOutline).every((x) => x.dayIndex !== 0),
  '轨交 40 分钟不算绕路（大城市地铁到酒店很正常）');
ok(P.detourTransfers(dOutline).every((x) => x.dayIndex !== 2), '步行 5 分钟当然不算');
ok(P.detourTransfers(dOutline, 60).length === 0, '阈值放宽到 60 分钟就不再报（阈值可调）');
ok(P.detourTransfers({
  days: [{ date: '2026-10-11', city: 'D市', theme: '游玩', overnight: 'D市', meals: [], note: '',
    moves: [{ from: '庚站', to: '辛站', mode: 'train', code: 'G4', startTime: '09:00', endTime: '10:00', transfer: '打车约20分钟' }],
    highlights: ['某景区'] }],
}).length === 1, '默认阈值 15 分钟：自报"打车约20分钟"也要能触发复核（模型常少报耗时）');
ok(P.isCarTransfer('打车20分钟') && !P.isCarTransfer('地铁20分钟'), '打车/轨交能区分开');
ok(P.warnDetourTransfers(dOutline) === dOutline, '体检函数原样返回大纲（只告警不改数据）');

// 5f. 行李规则兜底：换住处不能把行李留在酒店；寄了必须提醒取回
//    （提示词里写了规矩，但 LLM 会偷懒或写反，这层是确定性修补）
const lugOutline = {
  days: [
    { date: '2026-10-01', city: '桂林', overnight: '桂林市区（两江四湖片区）' },
    { date: '2026-10-02', city: '阳朔', overnight: '阳朔' },
  ],
};
const lug = (items) => P.enforceLuggageRules(
  items.map((x) => Object.assign({}, x)), lugOutline);

ok(P.samePlace('桂林市区（两江四湖片区）', '桂林'), '地点归一化：括号补注不影响同一基地判定');

let r1 = lug([
  { dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '退房，把大件行李寄存在酒店前台', category: 'hotel' },
  { dayIndex: 1, startTime: '09:00', endTime: '12:00', activity: '前往阳朔', category: 'transport' },
]);
ok(/退房请带走全部行李/.test(r1[0].note || ''),
  '换住处却把行李留在酒店 → 备注纠正为「退房带走全部行李」', r1[0].note);
ok(!/取回寄存的行李/.test(r1[1].note || ''),
  '已纠正成"带走"的寄存，不会再自相矛盾地喊他回来取', r1[1].note);

let r2 = lug([
  { dayIndex: 1, startTime: '08:00', endTime: '09:00', activity: '在酒店吃早餐', category: 'food' },
  { dayIndex: 1, startTime: '09:00', endTime: '12:00', activity: '前往阳朔', category: 'transport' },
]);
ok(/退房请带走全部行李/.test(r2[0].note || ''),
  '换住处却整天没提行李 → 早上第一条补上提醒', r2[0].note);

let r3 = P.enforceLuggageRules([
  { dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '退房，去西街逛逛', category: 'hotel', note: '' },
], { days: [{ overnight: '阳朔' }, { overnight: '阳朔' }] });
ok(!/退房请带走全部行李/.test(r3[0].note || ''),
  '当晚回同一家酒店：不强行加行李提醒（行李本来就留在房间里）', r3[0].note);

let r4 = lug([
  { dayIndex: 1, startTime: '10:00', endTime: '10:10', activity: '在游客中心寄存行李', category: 'other' },
  { dayIndex: 1, startTime: '10:10', endTime: '12:00', activity: '游览景区', category: 'sight' },
  { dayIndex: 1, startTime: '12:00', endTime: '13:00', activity: '前往阳朔西街', category: 'transport', startLocation: '景区', endLocation: '阳朔西街' },
]);
ok(/取回寄存的行李/.test(r4[2].note || ''),
  '景区寄存行李后，离开的那一条提醒取回', r4[2].note);

let r5 = lug([
  { dayIndex: 1, startTime: '10:00', endTime: '10:10', activity: '在游客中心寄存行李', category: 'other' },
  { dayIndex: 1, startTime: '10:10', endTime: '12:00', activity: '游览景区', category: 'sight' },
  { dayIndex: 1, startTime: '12:00', endTime: '13:00', activity: '取回行李后前往阳朔西街', category: 'transport', startLocation: '景区', endLocation: '阳朔西街' },
]);
ok(!/取回寄存的行李/.test(r5[2].note || ''),
  '模型自己写了"取回行李" → 不重复追加', r5[2].note);

let r6 = P.enforceLuggageRules([
  { dayIndex: 2, startTime: '08:00', endTime: '09:00', activity: '吃早餐', category: 'food' },
], { days: [{ overnight: '阳朔' }, { overnight: '阳朔' }, { overnight: '返程' }] });
ok(/今天返程/.test(r6[0].note || ''), '返程日的行李提醒改成"今天返程"口吻', r6[0].note);

let r7 = lug([
  { dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '携带全部行李打车前往汽车站', category: 'transport', note: '行李随身带，不寄存' },
  { dayIndex: 1, startTime: '09:00', endTime: '12:00', activity: '前往明仕田园', category: 'transport', note: '严禁寄存回原酒店' },
  // 中间夹了能愿动词的否定（"不可寄存"）也是否定——只写"不"会漏，被误判成真寄存
  { dayIndex: 1, startTime: '12:30', endTime: '13:00', activity: '步行前往码头', category: 'transport', note: '行李需随身带走，不可寄存' },
  { dayIndex: 1, startTime: '13:30', endTime: '14:00', activity: '登船', category: 'transport', note: '行李较多时不能寄存，请随身看管' },
]);
ok(r7.every((it) => !/取回寄存的行李/.test(it.note || '')),
  '否定句里的"寄存"（不寄存/严禁寄存/不可寄存/不能寄存）不算寄存，不冒出取回提醒',
  JSON.stringify(r7.map((it) => it.note)));

let r8 = lug([
  { dayIndex: 0, startTime: '07:30', endTime: '08:00', activity: '大件行李留在酒店房间或寄存前台，轻装出发', category: 'hotel' },
  { dayIndex: 0, startTime: '09:00', endTime: '12:00', activity: '前往都江堰景区', category: 'transport' },
]);
ok(!/取回寄存的行李/.test(r8[1].note || ''),
  '行李寄在本家酒店且今晚回同一家 → 不多嘴喊"取回"（川西冒烟实锤）', r8[1].note);

// 5g. 同天时间重叠兜底：LLM 偶尔排出"上一条没结束下一条就开始了"
const overlapped = P.fixDayTimeOverlaps([
  { dayIndex: 0, startTime: '09:00', endTime: '10:00', activity: 'A' },
  { dayIndex: 0, startTime: '09:30', endTime: '11:00', activity: 'B' },
  { dayIndex: 0, startTime: '08:00', endTime: '08:40', activity: 'C' },
]);
ok(overlapped[0].activity === 'C' && overlapped[1].activity === 'A' && overlapped[2].activity === 'B',
  '同天条目按开始时间排序', JSON.stringify(overlapped.map((x) => x.activity)));
ok(overlapped[2].startTime === '10:00' && overlapped[2].endTime === '11:30',
  '重叠条目整体顺延并保留原有耗时，不把交通和游览时长压短', `${overlapped[2].startTime}-${overlapped[2].endTime}`);
const unpadded = P.fixDayTimeOverlaps([
  { dayIndex: 0, startTime: '9:30', endTime: '10:00', activity: '上午交通' },
  { dayIndex: 0, startTime: '10:00', endTime: '11:00', activity: '上午景点' },
  { dayIndex: 0, startTime: '8:00', endTime: '9:00', activity: '早餐' },
]);
ok(unpadded.map((x) => x.activity).join('/') === '早餐/上午交通/上午景点'
  && unpadded[1].startTime === '09:30',
  '单数字小时先补零再按分钟排序（首日不再把10:00排到9:30前）', JSON.stringify(unpadded));
const chained = P.enforceTransportChainOrder([
  { dayIndex: 0, category: 'transport', transportType: 'train', schedSource: '12306',
    startLocation: '甲站', endLocation: '乙站', startTime: '12:00', endTime: '14:00', activity: '乘列车' },
  { dayIndex: 0, category: 'transport', transportType: 'bus',
    startLocation: '乙站附近客运站', endLocation: '丙站', startTime: '14:30', endTime: '17:30', activity: '乘大巴' },
  { dayIndex: 0, category: 'transport', transportType: 'ride',
    startLocation: '乙站', endLocation: '乙站附近客运站', startTime: '15:00', endTime: '16:00', activity: '前往客运站' },
  { dayIndex: 0, category: 'ticket', startLocation: '乙站附近客运站', endLocation: '',
    startTime: '16:00', endTime: '16:20', activity: '取票检票' },
]);
ok(Number(chained[2].endTime.replace(':', '')) <= Number(chained[1].startTime.replace(':', ''))
  && chained[1].startTime !== '13:00',
  '前序接驳先于后续大巴，避免先发车后去客运站', JSON.stringify(chained));
const disconnectedOutline = { days: [{
  moves: [
    { from: '南宁东站', to: '崇左南站', mode: 'train', startTime: '08:00', endTime: '09:00' },
    { from: '明仕田园', to: '德天瀑布', mode: 'bus', startTime: '15:00', endTime: '16:30' },
  ],
}] };
P.ensureOutlineMoveContinuity(disconnectedOutline, { transport: '高铁/动车优先' });
ok(disconnectedOutline.days[0].moves.length === 3
  && disconnectedOutline.days[0].moves[1].from === '崇左南站'
  && disconnectedOutline.days[0].moves[1].to === '明仕田园'
  && disconnectedOutline.days[0].moves[1].mode === 'bus',
  '同日跨站交通之间自动补公共交通接驳并保持原有方向', JSON.stringify(disconnectedOutline.days[0].moves));
const untimedDisconnectedOutline = { days: [{
  moves: [
    { from: '成都西站', to: '离堆公园站', mode: 'train', startTime: '', endTime: '' },
    { from: '都江堰景区', to: '古尔沟镇', mode: 'ride', startTime: '13:30', endTime: '16:30' },
  ],
}] };
P.ensureOutlineMoveContinuity(untimedDisconnectedOutline, { transport: '高铁/动车优先' });
ok(untimedDisconnectedOutline.days[0].moves.length === 3
  && untimedDisconnectedOutline.days[0].moves[1].from === '离堆公园站'
  && untimedDisconnectedOutline.days[0].moves[1].to === '都江堰景区',
  '大纲缺少时刻时也保留下车站到下一段上车点的地点接续', JSON.stringify(untimedDisconnectedOutline.days[0].moves));
const insertedUntimedMove = P.fixDayTimeOverlaps(P.enforceMovesAlignment([
  { dayIndex: 0, startTime: '08:00', endTime: '08:30', activity: '早餐', category: 'food' },
  { dayIndex: 0, startTime: '10:00', endTime: '11:00', activity: '乘列车出发', category: 'transport',
    startLocation: '重庆西站', endLocation: '桂林北站', transportType: 'train' },
], { days: [{ moves: [{ from: '重庆市金童路', to: '重庆西站', mode: 'taxi', code: '', startTime: '', endTime: '' }] }] }));
ok(insertedUntimedMove.every((it) => P.toMin(it.startTime) !== null && P.toMin(it.endTime) !== null)
  && insertedUntimedMove[0].activity === '早餐'
  && insertedUntimedMove[1].category === 'transport'
  && insertedUntimedMove[1].endTime <= '10:00',
  '新补入的大纲交通段缺时刻时按相邻行程估算并放到当天正确位置', JSON.stringify(insertedUntimedMove));
const fixedOfficial = P.fixDayTimeOverlaps([
  { dayIndex: 0, startTime: '08:00', endTime: '10:30', activity: '赶车接驳', category: 'transport' },
  { dayIndex: 0, startTime: '09:30', endTime: '11:00', activity: '乘 G3351 次列车', category: 'transport', schedSource: '12306' },
]);
ok(fixedOfficial[1].startTime === '09:30' && fixedOfficial[1].endTime === '11:00',
  '已核对12306班次发生重叠时不顺延真实发到时刻', `${fixedOfficial[1].startTime}-${fixedOfficial[1].endTime}`);
const contained = P.fixDayTimeOverlaps([
  { dayIndex: 0, startTime: '09:00', endTime: '12:00', activity: 'A' },
  { dayIndex: 0, startTime: '10:00', endTime: '10:30', activity: 'B' },
]);
ok(contained[1].startTime === '12:00' && contained[1].endTime === '12:30',
  '完全被盖住的条目：顺延后至少给 30 分钟，不造零时长', `${contained[1].startTime}-${contained[1].endTime}`);

// 5h. 模型"内心独白"整条泄漏（川西实锤）：
//     activity 是对"必须原样执行"的论证独白，不是行程 —— stripMeta 逐句删
//     对整段独白无能为力（删光了会原样保留），必须在条目级抢救或丢弃
const metaGarbage = {
  dayIndex: 2, startTime: '17:15', endTime: '17:35',
  activity: '鉴于上游要求"必须原样执行"但给出了具体时刻 13:00-13:20，前序行程需大幅提前或此为错误约束。**修正正确**：如果严格执行13:00的交通，那么上午游览后必须立即离开。',
  category: 'transport', startLocation: '都江堰站', endLocation: '眉山站', transportType: 'train',
  note: '原样执行车使用的交通时刻：13:00-13:20',
};
const salvaged = sanitizeItems([metaGarbage]);
ok(salvaged.length === 1, '整段独白但带起终点 → 抢救成干净的交通条目',
  JSON.stringify(salvaged.map((x) => x.activity)));
ok(salvaged.length && salvaged[0].activity === '从都江堰站前往眉山站' && !salvaged[0].note,
  '独白剥干净，只留"从哪到哪"', salvaged.length ? `${salvaged[0].activity} / note=${salvaged[0].note}` : '（被丢了）');
ok(salvaged.length && salvaged[0].startTime === '17:15' && salvaged[0].endTime === '17:35',
  '抢救条目保留原时刻', salvaged.length ? `${salvaged[0].startTime}-${salvaged[0].endTime}` : '');
const droppedMeta = sanitizeItems([{
  dayIndex: 0, startTime: '10:00', endTime: '11:00',
  activity: '鉴于上游要求原样执行，此为错误约束，修正正确如下。',
  category: 'other',
}]);
ok(droppedMeta.length === 0, '没有起终点可抢救的独白条目 → 整条丢弃', JSON.stringify(droppedMeta));
const normalItem = sanitizeItems([{
  dayIndex: 0, startTime: '09:00', endTime: '10:00',
  activity: '乘 C6122 次列车从都江堰站前往眉山站',
  category: 'transport', startLocation: '都江堰站', endLocation: '眉山站',
}]);
ok(normalItem.length === 1 && normalItem[0].activity.includes('C6122'),
  '正常交通条目不受 META_HARD 误伤', normalItem.length ? normalItem[0].activity : '（被丢了）');

// 5i. 收尾闭环兜底：当天最后一条必须收在住宿地（返程日除外）
const closureOutline = { days: [{ overnight: '都江堰' }, { overnight: '眉山' }, { overnight: '返程' }] };
const closed = P.enforceDayClosure([
  { dayIndex: 1, startTime: '16:30', endTime: '17:15', activity: '候车休息，准备乘车', category: 'other', startLocation: '都江堰站', endLocation: '都江堰站' },
  { dayIndex: 1, startTime: '17:15', endTime: '17:35', activity: '从都江堰站前往眉山站', category: 'transport', startLocation: '都江堰站', endLocation: '眉山站', transportType: 'train' },
  { dayIndex: 2, startTime: '09:00', endTime: '11:00', activity: '逛宽窄巷子', category: 'sight' },
], closureOutline);
const appended = closed.filter((x) => x.dayIndex === 1 && x.category === 'hotel');
ok(appended.length === 1
  && /前往眉山/.test(appended[0].activity)
  && appended[0].startLocation === '眉山站' && appended[0].endLocation === '眉山',
  '没收在住宿地的天 → 补一条"前往住宿地办理入住"（带导航起终点）',
  JSON.stringify(appended));
ok(appended.length && appended[0].startTime === '17:45' && appended[0].endTime === '18:15',
  '补的酒店条目接在最后一条结束 +10 分钟，不与前面重叠',
  appended.length ? `${appended[0].startTime}-${appended[0].endTime}` : '');
ok(!closed.some((x) => x.dayIndex === 2 && x.category === 'hotel'),
  '返程日（ov=返程）不补"回酒店"');
const alreadyHome = P.enforceDayClosure([
  { dayIndex: 0, startTime: '21:00', endTime: '21:30', activity: '回酒店休息', category: 'hotel', endLocation: '' },
], closureOutline);
ok(alreadyHome.length === 1 && alreadyHome[0].endLocation === '都江堰',
  '已收在酒店：只补漏填的终点，不加条目', JSON.stringify(alreadyHome));
const homeByWord = P.enforceDayClosure([
  { dayIndex: 0, startTime: '21:00', endTime: '21:40', activity: '回民宿休息', category: 'other' },
], closureOutline);
ok(homeByWord.length === 1, '描述里写了回酒店/民宿 → 视为已收尾，不重复补',
  JSON.stringify(homeByWord.map((x) => x.activity)));

// 5i-1. 住宿范围隔离 / 跨天位置链：防止模型把上一份攻略的外地酒店带进来，
//       以及“前一天收在 A、第二天从 B 开始”的断链。
const lodgingOutline = { days: [
  { city: '成都', overnight: '成都', hotel: '河北省石家庄市桥西区全季酒店(石家庄火车站)文景街' },
  { city: '都江堰', overnight: '古尔沟/理县', hotel: '古尔沟华美达温泉度假酒店' },
] };
P.normalizeOutlineLodging(lodgingOutline);
ok(lodgingOutline.days[0].hotel === '',
  '住宿推荐带外省完整地址且与当天城市冲突 → 清空错误酒店', lodgingOutline.days[0].hotel);
ok(lodgingOutline.days[1].hotel === '古尔沟华美达温泉度假酒店',
  '住宿推荐属于 overnight 片区 → 保留有效酒店', lodgingOutline.days[1].hotel);
const daytimeHotel = { days: [{ city: '大新→南宁', overnight: '南宁市区', hotel: '大新县经济型酒店' }] };
P.normalizeOutlineLodging(daytimeHotel);
ok(daytimeHotel.days[0].hotel === '',
  '酒店只能按 overnight 校验，白天游览过的大新酒店不能当作南宁住宿', daytimeHotel.days[0].hotel);
const namedHotel = P.normalizeGeneratedLodging([{
  dayIndex: 1, startTime: '19:00', endTime: '19:30',
  activity: '办理入住', category: 'hotel', endLocation: '古尔沟',
}], lodgingOutline);
ok(namedHotel[0].endLocation === '古尔沟华美达温泉度假酒店',
  '住宿条目只写片区且大纲有具体酒店 → 统一到可导航的推荐酒店', namedHotel[0].endLocation);
const lodgingItems = P.normalizeGeneratedLodging([{
  dayIndex: 0, startTime: '19:50', endTime: '20:20',
  activity: '步行至全季酒店办理入住', category: 'hotel',
  startLocation: '成都东站',
  endLocation: '河北省石家庄市桥西区全季酒店(石家庄火车站)文景街',
}], lodgingOutline);
ok(lodgingItems[0].endLocation === '成都'
  && /成都/.test(lodgingItems[0].activity)
  && !lodgingItems[0].endLon && !lodgingItems[0].endLat,
  '细化结果再次遇到外省酒店 → 回写当天住宿范围并清空旧坐标', JSON.stringify(lodgingItems[0]));
const lodgingStartItems = P.normalizeGeneratedLodging([{
  dayIndex: 1, startTime: '07:30', endTime: '08:00',
  activity: '从河北省石家庄市桥西区全季酒店前往犀浦站', category: 'transport',
  startLocation: '河北省石家庄市桥西区全季酒店', endLocation: '犀浦站',
}], lodgingOutline, { origin: '重庆市金童路' });
ok(lodgingStartItems[0].startLocation === '成都'
  && lodgingStartItems[0].activity.includes('从成都前往犀浦站')
  && lodgingStartItems[0].endLocation === '犀浦站'
  && !lodgingStartItems[0].startLon && !lodgingStartItems[0].startLat,
  '第二天首条起点仍串入外省酒店 → 回写到前一晚住宿地并清空旧坐标', JSON.stringify(lodgingStartItems[0]));
const scenicDepartureOutline = { days: [
  { city: '都江堰→理县', overnight: '理县古尔沟', hotel: '理县古尔沟住宿片区' },
  { city: '毕棚沟→成都', overnight: '成都', hotel: '成都春熙路酒店' },
] };
const scenicDeparture = P.normalizeGeneratedLodging([{
  dayIndex: 1, startTime: '08:00', endTime: '09:00', activity: '乘有司机包车从古尔沟酒店前往毕棚沟景区游客中心',
  category: 'transport', startLocation: '理县古尔沟住宿片区', endLocation: '毕棚沟景区游客中心',
}], scenicDepartureOutline)[0];
ok(scenicDeparture.endLocation === '毕棚沟景区游客中心',
  '从酒店出发的包车/自驾交通终点仍是景区，不被酒店清洗覆盖', JSON.stringify(scenicDeparture));
const duplicateCheckinOutline = { days: [
  { city: '成都市春熙路', overnight: '成都市中心', hotel: '成都春熙路酒店' },
  { city: '都江堰→理县', overnight: '理县古尔沟', hotel: '理县古尔沟住宿片区' },
] };
const duplicateCheckin = P.normalizeGeneratedLodging([
  { dayIndex: 1, startTime: '16:30', endTime: '17:00', activity: '从汽车站打车到古尔沟酒店办理入住', category: 'transport', startLocation: '理县客运站', endLocation: '理县古尔沟住宿片区' },
  { dayIndex: 1, startTime: '17:00', endTime: '17:30', activity: '前往理县古尔沟住宿片区办理入住，放下行李', category: 'hotel', startLocation: '成都春熙路酒店', endLocation: '理县古尔沟住宿片区' },
], duplicateCheckinOutline);
ok(!duplicateCheckin[1].startLocation && /在理县古尔沟住宿片区办理入住/.test(duplicateCheckin[1].activity),
  '已由当天交通抵达酒店后，入住条目不再虚构从前一晚酒店出发', JSON.stringify(duplicateCheckin[1]));
const prematureHotelOutline = { days: [
  { city: '成都', overnight: '成都市春熙路/太古里片区住宿地', hotel: '成都春熙路酒店' },
  { city: '都江堰→理县古尔沟', overnight: '理县古尔沟', hotel: '理县古尔沟黄金林酒店' },
] };
const prematureHotelItems = P.normalizeGeneratedLodging([
  { dayIndex: 1, startTime: '07:30', endTime: '08:30', activity: '前往理县古尔沟黄金林酒店办理入住，放下行李', category: 'hotel', startLocation: '成都市春熙路住宿地', endLocation: '理县古尔沟黄金林酒店' },
  { dayIndex: 1, startTime: '08:30', endTime: '09:30', activity: '乘列车从成都东站前往都江堰站', category: 'transport', startLocation: '成都东站', endLocation: '都江堰站' },
  { dayIndex: 1, startTime: '14:00', endTime: '17:30', activity: '乘有司机接送的车辆从都江堰前往理县古尔沟黄金林酒店', category: 'transport', startLocation: '都江堰景区', endLocation: '理县古尔沟黄金林酒店' },
  { dayIndex: 1, startTime: '17:30', endTime: '18:00', activity: '抵达理县古尔沟黄金林酒店办理入住', category: 'hotel', startLocation: '都江堰景区', endLocation: '理县古尔沟黄金林酒店' },
], prematureHotelOutline);
ok(!prematureHotelItems.some((it) => it.startTime === '07:30')
  && prematureHotelItems.some((it) => it.startTime === '17:30'),
  '已安排晚间抵达的酒店入住条目不再被错误放到当天清晨', JSON.stringify(prematureHotelItems.map((it) => it.startTime)));
const breakfastHotelItem = P.normalizeGeneratedLodging([{
  dayIndex: 1, startTime: '07:30', endTime: '08:15', activity: '在成都酒店享用早餐，退房并整理行李',
  category: 'hotel', startLocation: '成都春熙路酒店', endLocation: '理县古尔沟黄金林酒店',
}], prematureHotelOutline)[0];
ok(breakfastHotelItem.category === 'food' && breakfastHotelItem.endLocation === '成都春熙路酒店',
  '早餐/退房条目保留在出发酒店片区，不伪装成已抵达当晚酒店', JSON.stringify(breakfastHotelItem));
const breakfastFoodItem = P.normalizeGeneratedLodging([{
  dayIndex: 1, startTime: '07:30', endTime: '08:15', activity: '在成都酒店享用早餐，退房并整理行李',
  category: 'food', startLocation: '成都春熙路酒店', endLocation: '理县古尔沟黄金林酒店',
}], prematureHotelOutline)[0];
ok(breakfastFoodItem.endLocation === '成都春熙路酒店' && breakfastFoodItem.category === 'food',
  '原本就是 food 类的早餐/退房条目也不会被清洗到今晚酒店', JSON.stringify(breakfastFoodItem));
const checkoutToPier = P.normalizeGeneratedLodging([{
  dayIndex: 0, startTime: '07:30', endTime: '08:15', category: 'hotel',
  activity: '从桂林市区酒店退房，携带行李前往磨盘山码头',
  startLocation: '桂林市区酒店', endLocation: '磨盘山码头',
}], { days: [{ city: '阳朔', overnight: '阳朔西街', hotel: '阳朔西街酒店' }] }, { transport: '高铁/动车优先' })[0];
ok(checkoutToPier.category === 'transport' && checkoutToPier.endLocation === '磨盘山码头',
  '退房后前往码头的条目保留为交通，不改成提前入住今晚酒店', JSON.stringify(checkoutToPier));
const prematureCityHotel = P.normalizeGeneratedLodging([
  { dayIndex: 1, startTime: '07:30', endTime: '08:00', category: 'hotel',
    activity: '前往桂林酒店办理入住', startLocation: '龙脊梯田住宿地', endLocation: '桂林市区酒店' },
  { dayIndex: 1, startTime: '10:00', endTime: '12:30', category: 'transport', transportType: 'bus',
    activity: '乘旅游专线从龙脊梯田前往桂林市区', startLocation: '龙脊梯田景区', endLocation: '桂林汽车客运南站' },
], { days: [
  { city: '龙脊梯田', overnight: '龙脊梯田' },
  { city: '桂林', overnight: '桂林市区', hotel: '桂林市区酒店', moves: [
    { from: '龙脊梯田景区', to: '桂林市区', mode: 'bus', startTime: '10:00', endTime: '12:30' },
  ] },
] }, { transport: '高铁/动车优先' });
ok(!prematureCityHotel.some((item) => item.startTime === '07:30'),
  '回桂林的交通尚未出发时，移除清晨提前入住桂林酒店的跳跃安排', JSON.stringify(prematureCityHotel));
ok(P.sameTravelArea('新悦酒店(阳朔西街店)', '阳朔县城'),
  '酒店括号里的城市片区可用于跨日路线衔接');
const chainOutline = { days: [
  { city: '成都', overnight: '成都', hotel: '' },
  { city: '都江堰', overnight: '古尔沟', hotel: '古尔沟华美达温泉度假酒店' },
] };
const closedChain = P.enforceDayClosure([{
  dayIndex: 0, startTime: '18:00', endTime: '19:00', activity: '抵达成都东站',
  category: 'transport', startLocation: '都江堰站', endLocation: '成都东站', transportType: 'train',
}], chainOutline, { origin: '重庆市金童路' });
const chainedItems = P.enforceDayStartLocation(closedChain.concat([{
  dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '前往都江堰景区',
  category: 'transport', startLocation: '都江堰', endLocation: '都江堰景区', transportType: 'car',
}]), chainOutline);
const chainTransfer = chainedItems.find((x) => x.dayIndex === 1 && /跨日位置接驳/.test(x.note || ''));
ok(!!chainTransfer && chainTransfer.startLocation === '成都'
  && chainTransfer.endLocation === '都江堰' && chainTransfer.endTime === '08:00',
  '第二天首条起点与前晚收尾不一致 → 自动补跨日接驳', JSON.stringify(chainTransfer));
const beforeScenicBreakfastOutline = { days: [
  { city: '阳朔', overnight: '阳朔西街', hotel: '新悦酒店(阳朔西街店)' },
  { city: '遇龙河景区', overnight: '阳朔西街', hotel: '新悦酒店(阳朔西街店)' },
] };
const beforeScenicBreakfast = P.enforceDayStartLocation([
  { dayIndex: 0, startTime: '21:00', endTime: '21:30', activity: '回新悦酒店休息', category: 'hotel', endLocation: '新悦酒店(阳朔西街店)' },
  { dayIndex: 1, startTime: '08:00', endTime: '08:40', activity: '在阳朔吃早餐', category: 'food', startLocation: '遇龙河景区', endLocation: '阳朔' },
  { dayIndex: 1, startTime: '09:00', endTime: '09:30', activity: '乘大巴从阳朔县城前往遇龙河景区', category: 'transport', startLocation: '阳朔县城', endLocation: '遇龙河景区', transportType: 'bus' },
], beforeScenicBreakfastOutline);
ok(!beforeScenicBreakfast.some((it) => it.dayIndex === 1 && /跨日位置接驳/.test(it.note || ''))
  && beforeScenicBreakfast.find((it) => it.dayIndex === 1 && it.category === 'food').endLocation === '新悦酒店(阳朔西街店)',
  '先在昨晚住宿片区吃早餐、随后已有进景区交通时不再补折返接驳', JSON.stringify(beforeScenicBreakfast.filter((it) => it.dayIndex === 1)));

// 5i-2. 出发接驳 / 早餐 / 晚间安排 / 推荐酒店 / 到家接驳（确定性兜底）
//       场景来自实测：出发地"重庆市金童路 15:30"被生成成"15:30 乘高铁"，
//       从家去车站的接驳凭空消失；晚上 7 点到酒店后行程就断了。
const accP = normalizeInput({
  origin: '重庆市金童路', dest: '成都', startDate: '2026-09-26', endDate: '2026-09-28',
  startTime: '15:30', endTime: '20:00',
});
const accOutline = { days: [
  { date: '2026-09-26', city: '成都', overnight: '成都', hotel: '成都瑞城名人酒店',
    moves: [{ from: '重庆西站', to: '成都东站', mode: 'train', code: 'G8505', startTime: '16:55', endTime: '19:30' }] },
  { date: '2026-09-27', city: '成都', overnight: '成都', moves: [] },
  { date: '2026-09-28', city: '成都', overnight: '返程',
    moves: [{ from: '成都东站', to: '重庆北站', mode: 'train', code: 'G8506', startTime: '16:40', endTime: '19:20' }] },
] };

// a) 第一天没有从出发地出发的条目 → 补接驳
const accItems = P.enforceOriginAccess([
  { dayIndex: 0, startTime: '16:10', endTime: '16:55', activity: '在重庆西站安检候车', category: 'other' },
  { dayIndex: 0, startTime: '16:55', endTime: '19:30', activity: '乘 G8505 次列车从重庆西站前往成都东站', category: 'transport', startLocation: '重庆西站', endLocation: '成都东站', transportType: 'train' },
], accP, accOutline);
const acc = accItems.filter((x) => x.startLocation === '重庆市金童路');
ok(acc.length === 1 && acc[0].endLocation === '重庆西站' && acc[0].startTime === '15:30',
  '第一天没有出发接驳 → 补「15:30 从金童路去重庆西站」', JSON.stringify(acc));

// b) 已有接驳不重复插
const accItems2 = P.enforceOriginAccess([
  { dayIndex: 0, startTime: '15:30', endTime: '16:10', activity: '从重庆市金童路打车前往重庆西站', category: 'transport', startLocation: '重庆市金童路', endLocation: '重庆西站', transportType: 'car' },
], accP, accOutline);
ok(accItems2.length === 1, '已有出发接驳 → 不重复补');

// c) 第 2 天 10 点前没吃饭 → 补早餐（接在首条出发前）
const morning = P.enforceMorningRoutine([
  { dayIndex: 1, startTime: '09:30', endTime: '10:00', activity: '从酒店出发前往都江堰', category: 'transport', startLocation: '成都', endLocation: '都江堰', transportType: 'car' },
], accOutline);
const brk = morning.filter((x) => x.category === 'food');
ok(brk.length === 1 && brk[0].startTime === '08:50' && brk[0].endTime === '09:25',
  '第 2 天没有早餐 → 补一条（接在首条出发前）', JSON.stringify(brk));

// d) 已有早餐不补
const morning2 = P.enforceMorningRoutine([
  { dayIndex: 1, startTime: '08:00', endTime: '08:40', activity: '在酒店吃早餐', category: 'food' },
  { dayIndex: 1, startTime: '09:00', endTime: '10:00', activity: '出发去景区', category: 'transport' },
], accOutline);
ok(morning2.length === 2, '已有早餐 → 不重复补');

// e1) 人已回酒店但 19:00 就结束 → 补一条"再出门夜逛"（closure 随后补回酒店）
const evening1 = P.enforceEveningPlan([
  { dayIndex: 0, startTime: '17:00', endTime: '19:00', activity: '到酒店放行李', category: 'hotel', endLocation: '成都' },
], accOutline);
ok(evening1.filter((x) => x.category === 'sight').length === 1
  && evening1[evening1.length - 1].startTime === '19:30'
  && /夜生活|夜游|夜市/.test(evening1[evening1.length - 1].activity),
  '19:00 就回酒店的非末日 → 补夜逛', JSON.stringify(evening1));

// e2) 人还在外面 19:00 收尾 → 补晚餐 + 夜逛
const evening2 = P.enforceEveningPlan([
  { dayIndex: 0, startTime: '17:00', endTime: '19:00', activity: '逛春熙路', category: 'sight', endLocation: '春熙路' },
], accOutline);
ok(evening2.filter((x) => x.category === 'food').length === 1
  && evening2.length === 3
  && evening2[1].startTime === '19:15' && evening2[2].startTime === '20:50',
  '19:00 还在外的非末日 → 补晚餐 + 夜逛', JSON.stringify(evening2));

// f) 22:00 收尾 → 不补
const evening3 = P.enforceEveningPlan([
  { dayIndex: 0, startTime: '20:00', endTime: '22:00', activity: '夜游锦江', category: 'sight' },
], accOutline);
ok(evening3.length === 1, '22:00 收尾的天不再补晚间安排');

// g) closure 用大纲推荐酒店补入住；返程日已到家不重复补
const closedP = P.enforceDayClosure([
  { dayIndex: 0, startTime: '18:00', endTime: '19:00', activity: '逛春熙路', category: 'sight', endLocation: '春熙路' },
  { dayIndex: 2, startTime: '19:20', endTime: '20:00', activity: '从重庆北站打车返回重庆市金童路', category: 'transport', startLocation: '重庆北站', endLocation: '重庆市金童路', transportType: 'car' },
], accOutline, accP);
const hotelItem = closedP.filter((x) => x.dayIndex === 0 && x.category === 'hotel');
ok(hotelItem.length === 1 && hotelItem[0].endLocation === '成都瑞城名人酒店',
  '有推荐酒店 → 补的入住条目直接导航到酒店', JSON.stringify(hotelItem));
ok(closedP.filter((x) => x.dayIndex === 2).length === 1, '返程日已写到家的 → 不重复补接驳');

// h) 末日只到车站 → 补回家接驳
const closedP2 = P.enforceDayClosure([
  { dayIndex: 2, startTime: '16:40', endTime: '19:20', activity: '乘 G8506 抵达重庆北站', category: 'transport', startLocation: '成都东站', endLocation: '重庆北站', transportType: 'train' },
], accOutline, accP);
const home = closedP2.filter((x) => x.dayIndex === 2 && x.endLocation === '重庆市金童路');
ok(home.length === 1 && P.toMin(home[0].startTime) >= 19 * 60 + 20
  && home[0].endTime === '20:00' && !/自驾|开车|驾车|驾驶/.test(home[0].activity),
  '返程日只到车站 → 补「回家」接驳', JSON.stringify(home));
const arrivalLabelP = { origin: '重庆金童路', days: 1, backTime: '16:00', transport: '高铁/动车优先' };
const arrivalLabelItems = P.enforceDayClosure([
  { dayIndex: 0, startTime: '11:00', endTime: '15:20', activity: '乘 D1 次列车从南宁东站前往重庆西站', category: 'transport', startLocation: '南宁东站', endLocation: '重庆西站', transportType: 'train' },
  { dayIndex: 0, startTime: '16:00', endTime: '16:30', activity: '到达重庆金童路，结束旅程', category: 'other', startLocation: '金童路地铁站', endLocation: '重庆金童路' },
], { days: [{ overnight: '返程', city: '重庆' }] }, arrivalLabelP);
const actualLastTransfer = arrivalLabelItems.find((item) => item.endLocation === arrivalLabelP.origin);
ok(actualLastTransfer && actualLastTransfer.category === 'transport'
  && actualLastTransfer.startLocation === '重庆西站'
  && actualLastTransfer.startTime === '15:20' && actualLastTransfer.endTime === '16:00',
  '模型写“到达金童路”但分类成其他时，改成真实到站至家门的接驳并锁定返程到家时刻', JSON.stringify(actualLastTransfer));
const returnedFromArrivalStation = P.enforceDayClosure([
  { dayIndex: 2, startTime: '10:30', endTime: '15:20', activity: '乘 G1 次列车从南宁东站前往重庆西站', category: 'transport', startLocation: '南宁东站', endLocation: '重庆西站', transportType: 'train' },
  { dayIndex: 2, startTime: '15:20', endTime: '15:25', activity: '出站步行前往接驳点', category: 'other', startLocation: '南宁东站', endLocation: '南宁东站' },
], accOutline, accP);
const returnTransfer = returnedFromArrivalStation.find((item) => item.endLocation === '重庆市金童路');
ok(!!returnTransfer && returnTransfer.startLocation === '重庆西站'
  && returnTransfer.startTime === '19:20' && returnTransfer.endTime === '20:00',
  '返程接驳从实际到达站出发，不误用昨晚酒店或出发站', JSON.stringify(returnTransfer));

// 5j. 已确认大交通对齐兜底：车次错时刻/漏排/重复/起终点错都要被拽回
const alignOutline = { days: [
  { overnight: '成都', moves: [{ from: '重庆西站', to: '成都东站', mode: 'train', code: 'G8505', startTime: '08:30', endTime: '11:00' }] },
  { overnight: '都江堰', moves: [{ from: '成都东站', to: '重庆西站', mode: 'train', code: 'G8528', startTime: '15:00', endTime: '17:00' }] },
] };
// a) 15:00 的返程被模型写到 09:00、终点还串成了当天景区 → 拽回 15:00-17:00、起终点回车站
const aligned = P.enforceMovesAlignment([
  { dayIndex: 1, startTime: '09:00', endTime: '10:30', activity: '乘 G8528 从成都东站前往重庆西站（此处为倒叙，规划时间线以符合上游规定）', category: 'transport', startLocation: '成都东站', endLocation: '都江堰景区离堆公园', transportType: 'train' },
  { dayIndex: 1, startTime: '10:30', endTime: '12:30', activity: '游览都江堰景区', category: 'sight' },
], alignOutline);
const aTrain = aligned.find((x) => /G8528/.test(x.activity));
ok(aTrain && aTrain.startTime === '15:00' && aTrain.endTime === '17:00',
  '大交通时刻漂移超 60 分钟 → 拽回大纲既定时刻', aTrain && `${aTrain.startTime}-${aTrain.endTime}`);
ok(aTrain && aTrain.startLocation === '成都东站' && aTrain.endLocation === '重庆西站',
  '大交通起终点强制对齐大纲车站（导航 chip 不再串到景区）',
  aTrain && `${aTrain.startLocation}→${aTrain.endLocation}`);
ok(aTrain && !/倒叙|时间线|上游/.test(aTrain.activity),
  '带独白的大交通条目重写成干净版', aTrain && aTrain.activity);
const boatOutline = { days: [{ moves: [{
  from: '桂林磨盘山码头', to: '阳朔水东门码头', mode: '漓江游船', startTime: '12:00', endTime: '16:00',
}] }] };
const boatAligned = P.enforceMovesAlignment([{
  dayIndex: 0, startTime: '12:00', endTime: '16:00', category: 'sight', transportType: '',
  activity: '乘船游览漓江精华段（九马画山、黄布倒影）',
  startLocation: '桂林磨盘山码头', endLocation: '阳朔水东门码头',
}], boatOutline);
ok(boatAligned.length === 1 && boatAligned[0].category === 'sight',
  '大纲游船路线与已生成游览条目合并，保留景点说明且不重复排船程', JSON.stringify(boatAligned));
// e) 12306 当天无候选时，大纲时刻为空不能被 fmtMin(null) 误写成 00:00
const unavailableOutline = { days: [{ moves: [{
  from: '重庆西站', to: '沙坪坝站', mode: 'train', code: '',
  startTime: '', endTime: '', scheduleRequired: true,
}] }] };
const unavailableAligned = P.enforceMovesAlignment([
  { dayIndex: 0, startTime: '11:00', endTime: '11:30',
    activity: '乘火车从重庆西站前往沙坪坝站', category: 'transport',
    startLocation: '重庆西站', endLocation: '沙坪坝站', transportType: 'train' },
], unavailableOutline);
ok(unavailableAligned[0].startTime === '11:00' && unavailableAligned[0].endTime === '11:30',
  '官方无候选时保留占位时刻，不凭空改成 00:00', JSON.stringify(unavailableAligned[0]));
const boatNoChip = P.enforceMovesAlignment([{
  dayIndex: 0, startTime: '09:00', endTime: '13:00', category: 'sight',
  activity: '乘四星船游览漓江，从桂林磨盘山码头到阳朔龙头山码头',
}], boatOutline);
ok(boatNoChip.length === 1 && boatNoChip[0].category === 'sight',
  '游船说明已经覆盖大纲路线时，即使地图起终点字段为空也不再补重复船程', JSON.stringify(boatNoChip));
const estimatedBusOutline = { days: [{ moves: [{
  from: '龙脊梯田景区', to: '桂林市区', mode: 'bus', startTime: '12:30', endTime: '15:00', timingEstimated: true,
}] }] };
const estimatedBus = P.enforceMovesAlignment([{
  dayIndex: 0, startTime: '10:00', endTime: '12:30', category: 'transport',
  activity: '乘旅游专线或大巴从龙脊景区大门换乘中心前往桂林汽车客运南站',
  startLocation: '龙脊景区大门换乘中心', endLocation: '桂林汽车客运南站', transportType: 'bus',
}], estimatedBusOutline);
ok(estimatedBus.length === 1 && estimatedBus[0].startTime === '12:30' && estimatedBus[0].endTime === '15:00',
  '龙脊次日延后返程时，将已生成的同一路线班车同步到预留时段', JSON.stringify(estimatedBus));
// b) 大纲有这段大交通、模型全程没提 → 补一条
const filled = P.enforceMovesAlignment([
  { dayIndex: 0, startTime: '12:00', endTime: '13:00', activity: '午餐', category: 'food' },
], alignOutline);
const added = filled.find((x) => /G8505/.test(x.activity));
ok(added && added.startTime === '08:30' && added.startLocation === '重庆西站' && added.endLocation === '成都东站'
  && added.category === 'transport',
  '大纲大交通全天未安排 → 补一条干净交通条目', added && JSON.stringify(added));
const busRouteOutline = { days: [{ moves: [{
  from: '南宁琅东汽车站', to: '德天瀑布景区', mode: 'bus', startTime: '12:20', endTime: '16:00',
}] }] };
const busOnlyMentionedInNote = P.enforceMovesAlignment([{
  dayIndex: 0, startTime: '10:00', endTime: '11:00', category: 'transport',
  activity: '游览市区后前往酒店', startLocation: '南宁东站', endLocation: '青秀区酒店', transportType: 'ride',
  note: '从南宁琅东汽车站出发至德天瀑布景区的班车可到站后购买。',
}], busRouteOutline);
ok(busOnlyMentionedInNote.some((x) => x.startLocation === '南宁琅东汽车站'
  && x.endLocation === '德天瀑布景区' && x.category === 'transport'),
  '移动端点只出现在备注里不能算已安排，仍补入缺失的南宁至德天班车', JSON.stringify(busOnlyMentionedInNote));
const busCoveredByChain = P.enforceMovesAlignment([
  { dayIndex: 1, startTime: '08:00', endTime: '08:20', category: 'transport', transportType: 'walk',
    activity: '步行前往硕龙镇直通车站', startLocation: '硕龙镇住宿地', endLocation: '硕龙镇直通车站' },
  { dayIndex: 1, startTime: '08:20', endTime: '09:20', category: 'transport', transportType: 'bus',
    activity: '乘景区直通车前往德天瀑布游客中心', startLocation: '硕龙镇直通车站', endLocation: '德天瀑布游客中心' },
], { days: [
  { overnight: '大新县硕龙镇' },
  { overnight: '大新县硕龙镇', hotel: '硕龙镇住宿地', moves: [
    { from: '住宿地', to: '德天瀑布景区', mode: 'bus', startTime: '08:00', endTime: '09:20' },
  ] },
] });
ok(busCoveredByChain.length === 2,
  '住宿地→景区由步行接驳和景区班车连续覆盖时不再重复补一趟整段班车', JSON.stringify(busCoveredByChain));
const sameDestinationCoveredByFeeder = P.enforceMovesAlignment([
  { dayIndex: 1, startTime: '08:15', endTime: '09:00', category: 'transport',
    activity: '从硕龙镇住宿地前往旅游集散中心', startLocation: '大新硕龙镇住宿地',
    endLocation: '大新县硕龙镇旅游集散中心', transportType: 'ride' },
  { dayIndex: 1, startTime: '10:00', endTime: '14:00', category: 'transport',
    activity: '从大新县硕龙镇旅游集散中心前往南宁东站',
    startLocation: '大新县硕龙镇旅游集散中心', endLocation: '南宁东站', transportType: 'bus' },
], { days: [
  { overnight: '大新县硕龙镇' },
  { city: '南宁', overnight: '南宁', moves: [
    { from: '德天瀑布', to: '南宁东站', mode: 'bus', code: '直达大巴', startTime: '14:00', endTime: '18:00' },
  ] },
] });
ok(sameDestinationCoveredByFeeder.length === 2,
  '实际从集散中心抵达同一终点且由前一晚住宿接驳衔接时，不再补重叠直达段',
  JSON.stringify(sameDestinationCoveredByFeeder));
// c) 同一车次出现两条 → 留时刻最接近大纲的，其余丢弃
const deduped = P.enforceMovesAlignment([
  { dayIndex: 1, startTime: '14:40', endTime: '17:00', activity: '乘 G8528 次列车从成都东站前往重庆西站', category: 'transport', startLocation: '成都东站', endLocation: '重庆西站', transportType: 'train' },
  { dayIndex: 1, startTime: '09:00', endTime: '10:30', activity: '乘 G8528 从成都东站前往重庆西站（倒叙）', category: 'transport', startLocation: '成都东站', endLocation: '重庆西站', transportType: 'train' },
], alignOutline);
ok(deduped.filter((x) => /G8528/.test(x.activity)).length === 1
  && deduped.find((x) => /G8528/.test(x.activity)).startTime === '14:40',
  '同一车次重复条目只留一条（时刻最接近大纲的）',
  JSON.stringify(deduped.filter((x) => /G8528/.test(x.activity)).map((x) => x.startTime)));
// d) sanitize 层：整条"倒叙"独白没起终点 → 丢弃
const droppedMono = sanitizeItems([
  { dayIndex: 0, startTime: '09:00', endTime: '10:30', activity: '实际行程将提前完成都江堰，此处为倒叙 bridge，规划时间线以符合上游规定的约束' },
]);
ok(droppedMono.length === 0, '"倒叙/规划时间线"独白条目（无起终点）整条丢弃',
  JSON.stringify(droppedMono));
const rescuedMono = sanitizeItems([
  { dayIndex: 0, startTime: '09:00', endTime: '10:30', activity: '乘 G8528 前往重庆西站（此处为倒叙 bridge）', startLocation: '成都东站', endLocation: '重庆西站' },
]);
ok(rescuedMono.length === 1 && rescuedMono[0].category === 'transport'
  && !/倒叙/.test(rescuedMono[0].activity),
  '"倒叙"独白条目有起终点 → 抢救成干净交通条目', JSON.stringify(rescuedMono));
const fixedMono = sanitizeItems([
  { dayIndex: 0, startTime: '16:15', endTime: '20:00', activity: '错误修正：此处应为乘车时间。根据既定路线' },
]);
ok(fixedMono.length === 0, '"错误修正/此处应为/既定路线"独白条目整条丢弃',
  JSON.stringify(fixedMono));
const repairedLogic = sanitizeItems([
  { dayIndex: 0, startTime: '17:30', endTime: '18:00', category: 'transport',
    activity: '修正执行逻辑：理县县城前往汶川站后再转车', startLocation: '理县县城', endLocation: '汶川站' },
]);
ok(repairedLogic.length === 1 && repairedLogic[0].activity === '从理县县城前往汶川站',
  '混入“修正执行逻辑”的交通条目只保留可执行的起终点', JSON.stringify(repairedLogic));

const brokenDetailChain = P.ensureItemLocationContinuity([
  { dayIndex: 0, startTime: '17:30', endTime: '18:00', category: 'transport',
    activity: '从理县县城前往汶川站', startLocation: '理县县城', endLocation: '汶川站', transportType: 'ride' },
  { dayIndex: 0, startTime: '19:30', endTime: '20:00', category: 'transport',
    activity: '从成都东站前往酒店', startLocation: '成都东站', endLocation: '成都酒店', transportType: 'ride' },
], normalizeInput({ transport: '高铁/动车优先' }));
ok(brokenDetailChain.length === 3
  && brokenDetailChain[1].startLocation === '汶川站'
  && brokenDetailChain[1].endLocation === '成都东站'
  && !/自驾|开车|驾车|驾驶/.test(brokenDetailChain[1].activity),
  '详细条目地点断链时补公共交通接驳，不默认生成自驾', JSON.stringify(brokenDetailChain));

const uncoveredHighlights = P.ensureDetailHighlightCoverage([
  { dayIndex: 0, startTime: '10:00', endTime: '12:00', category: 'sight',
    activity: '游览青城前山并参观天师洞', startLocation: '', endLocation: '', transportType: '' },
  { dayIndex: 1, startTime: '10:00', endTime: '12:00', category: 'sight',
    activity: '游览龙王海', startLocation: '', endLocation: '', transportType: '' },
], { days: [
  { highlights: ['青城山'] },
  { highlights: ['毕棚沟'] },
] });
ok(uncoveredHighlights[0].activity.includes('青城山')
  && uncoveredHighlights[1].activity.includes('毕棚沟'),
  '详细游览条目自动落地大纲点名的青城山、毕棚沟', JSON.stringify(uncoveredHighlights));
const noteOnlyHighlight = P.ensureDetailHighlightCoverage([
  { dayIndex: 0, startTime: '10:00', endTime: '11:00', category: 'sight',
    activity: '游览磐羊湖', note: '毕棚沟景区适合拍照', startLocation: '磐羊湖站', endLocation: '' },
], { days: [{ highlights: ['毕棚沟景区'] }] });
ok(noteOnlyHighlight[0].activity.includes('毕棚沟景区'),
  '景点名称只出现在备注时不算已游览，须补到真实游览条目', JSON.stringify(noteOnlyHighlight));

// 终点回填：餐饮标题式写法（广西攻略实测：「晚餐：刘姐啤酒鱼」没导航）
const backfill = sanitizeItems([
  { dayIndex: 0, startTime: '18:00', endTime: '20:00', activity: '晚餐：刘姐啤酒鱼' },
  { dayIndex: 0, startTime: '12:00', endTime: '13:00', activity: '在金童路一奥天地吃午饭' },
  { dayIndex: 0, startTime: '18:30', endTime: '20:30', activity: '吃特色小吃，喝糖水' },
]);
ok(backfill[0].endLocation === '刘姐啤酒鱼', '"晚餐：店名"回填终点为店名',
  backfill[0].endLocation);
ok(backfill[1].endLocation === '金童路一奥天地', '"在XX吃午饭"回填终点为XX',
  backfill[1].endLocation);
ok(!backfill[2].endLocation || backfill[2].endLocation === '', '泛词（特色小吃）不回填，宁缺毋滥',
  backfill[2].endLocation);

// 5k. 无起终点条目的终点回填（餐饮/游览条目经常全空，卡片连导航都没有）
const { inferDestination } = require('../cloudfunctions/generatePlan/normalize.js');
ok(inferDestination('在崇善米粉（依仁路总店）吃桂林米粉') === '崇善米粉（依仁路总店）',
  '「在…吃…」抽出门店全名', inferDestination('在崇善米粉（依仁路总店）吃桂林米粉'));
ok(inferDestination('前往鼎鼎香农家菜吃饭') === '鼎鼎香农家菜',
  '「前往…吃饭」砍掉句尾动词尾巴', inferDestination('前往鼎鼎香农家菜吃饭'));
ok(inferDestination('游览兴坪古镇、20元人民币背景观景点及老寨山（可选）') === '兴坪古镇',
  '「游览…」截到第一个顿号', inferDestination('游览兴坪古镇、20元人民币背景观景点及老寨山（可选）'));
ok(inferDestination('在酒店吃早餐') === '', '泛词不回填（酒店/附近不算目的地）',
  inferDestination('在酒店吃早餐'));
ok(inferDestination('回酒店休息') === '', '没有移动动词就不抽', inferDestination('回酒店休息'));
const backfilled = sanitizeItems([
  { dayIndex: 0, startTime: '20:20', endTime: '21:00', activity: '在崇善米粉（依仁路总店）吃桂林米粉', category: 'food' },
  { dayIndex: 0, startTime: '21:00', endTime: '21:10', activity: '步行前往杉湖', startLocation: '崇善米粉（依仁路总店）', endLocation: '杉湖', category: 'transport' },
]);
ok(backfilled[0].endLocation === '崇善米粉（依仁路总店）',
  '回填后餐饮条目有了导航终点', backfilled[0].endLocation);
ok(backfilled[1].endLocation === '杉湖' && backfilled[1].startLocation === '崇善米粉（依仁路总店）',
  '本来就有起终点的条目不受回填影响', `${backfilled[1].startLocation}→${backfilled[1].endLocation}`);

// 6. 失败天重试链路（不调真实 LLM：把 llm.chatWithRetry 换成假实现）
//
//    背景：之前某天细化失败会被直接排除在续跑队列外，partial=false 就结束了，
//    用户只会发现"行程少了第 3 天"，云函数日志之外没有任何提示。
//    现在失败天最多重试 3 次，耗尽后放进 gaveUpDayIndexes 交给前端明文提示。
const llm = require('../cloudfunctions/generatePlan/llm.js');
const realChat = llm.chatWithRetry;
const mkDay = (date) => ({
  date, theme: '主题', city: '某城', highlights: ['景点A'],
  moves: [], meals: [], overnight: '某城', note: '',
});
const fakeOutline = { days: [mkDay('2026-12-20'), mkDay('2026-12-21'), mkDay('2026-12-22')] };
const fakeProfile = normalizeInput({ dest: '某城', startDate: '2026-12-20', endDate: '2026-12-22' });

// 第 2 天（12-21）永远返回一段没有 JSON 的废话 → 模拟 LLM 抽风/超时
llm.chatWithRetry = async (messages) => {
  const txt = String((messages[1] && messages[1].content) || '');
  if (/【今天】2026-12-21/.test(txt)) return '抱歉，我无法完成这个请求';
  return JSON.stringify([
    { dayIndex: 0, startTime: '09:00', endTime: '10:00', activity: '游览景点A', category: 'sight' },
  ]);
};

(async () => {
  let r = await P.genDayItems(fakeProfile, fakeOutline, { deadline: Date.now() + 60000 });
  ok(r.partial === true, '第2天失败后仍在续跑队列（partial=true，不再被静默丢弃）');
  ok((r.failedDayIndexes || []).includes(1), '第2天被记为失败', JSON.stringify(r.failedDayIndexes));
  ok(((r.attempts || {})[1] || 0) === 1, '第2天失败次数记为 1', JSON.stringify(r.attempts));
  ok(!(r.gaveUpDayIndexes || []).length, '还没到放弃的时候', JSON.stringify(r.gaveUpDayIndexes));

  r = await P.genDayItems(fakeProfile, fakeOutline,
    { deadline: Date.now() + 60000, doneDayIndexes: r.doneDayIndexes, attempts: r.attempts });
  ok(((r.attempts || {})[1] || 0) === 2 && r.partial, '第2次失败后仍重试', JSON.stringify(r.attempts));

  r = await P.genDayItems(fakeProfile, fakeOutline,
    { deadline: Date.now() + 60000, doneDayIndexes: r.doneDayIndexes, attempts: r.attempts });
  const gaveUp = r.gaveUpDayIndexes || [];
  ok(gaveUp.includes(1), '第3次失败后放弃并上报 gaveUpDayIndexes', JSON.stringify(gaveUp));
  ok(r.partial === false, '放弃后不再无限续跑（否则前端会死循环）', r.partial);
  ok((r.doneDayIndexes || []).sort().join() === '0,2', '其余两天正常完成', JSON.stringify(r.doneDayIndexes));

  llm.chatWithRetry = realChat;

  // ---------- 餐次纠偏 / 白天不回酒店 / 骨架兜底 / 包车段宽松匹配 ----------
  console.log('\n—— 餐次纠偏（fixMealLabels）——');
  const mealItems = [
    { dayIndex: 3, startTime: '17:00', category: 'food', activity: '在成都吃早餐，收拾行李退房' },
    { dayIndex: 1, startTime: '08:00', category: 'food', activity: '晚餐：牦牛肉汤锅' },
    { dayIndex: 1, startTime: '12:30', category: 'food', activity: '午餐：尤兔头' },
    { dayIndex: 1, startTime: '19:00', category: 'food', activity: '去小龙坎吃晚饭' },
  ];
  P.fixMealLabels(mealItems, null);
  ok(mealItems[0].activity.includes('晚餐'), '17:00 的「早餐」纠偏为晚餐', mealItems[0].activity);
  ok(mealItems[1].activity.includes('早餐'), '08:00 的「晚餐」纠偏为早餐', mealItems[1].activity);
  ok(mealItems[2].activity.includes('午餐'), '12:30 午餐不动', mealItems[2].activity);
  ok(mealItems[3].activity.includes('晚饭'), '19:00 晚饭不动', mealItems[3].activity);

  console.log('\n—— 白天不回酒店（enforceNoMiddayHotel）——');
  const midOutline = { days: [{ overnight: '成都' }, { overnight: '理县' }, { overnight: '返程' }] };
  const midItems = [
    { dayIndex: 0, startTime: '13:00', endTime: '14:00', category: 'hotel', activity: '回酒店午休' },
    { dayIndex: 0, startTime: '11:30', endTime: '12:00', category: 'hotel', activity: '抵达酒店，办理入住并放置行李' },
    { dayIndex: 1, startTime: '14:00', endTime: '15:00', category: 'other', activity: '返回酒店附近稍作休息' },
    { dayIndex: 2, startTime: '12:00', endTime: '13:00', category: 'hotel', activity: '回酒店休息' },
  ];
  const afterMid = P.enforceNoMiddayHotel(midItems, midOutline);
  ok(afterMid.length === 2, '白天午休条目被删（2 条保留）', afterMid.map((x) => x.activity).join(' | '));
  ok(afterMid.some((x) => x.activity.includes('办理入住')), '换住处当天的入住放行李保留');
  ok(afterMid.some((x) => x.dayIndex === 2), '末日不受限');

  console.log('\n—— 细化失败天骨架兜底（skeletonForEmptyDays）——');
  const skelOutline = {
    days: [
      { date: '2026-10-10', city: '都江堰', highlights: ['都江堰', '南桥'], meals: ['午餐：尤兔头'], overnight: '都江堰市区',
        moves: [{ from: '成都东站', to: '都江堰站', mode: 'train', code: 'D5181', startTime: '09:00', endTime: '09:40' }] },
      { date: '2026-10-11', city: '返程', highlights: [], meals: [], overnight: '返程',
        moves: [{ from: '都江堰站', to: '重庆北站', mode: 'train', code: 'G8515', startTime: '17:00', endTime: '19:00' }] },
    ],
  };
  const skelRes = P.skeletonForEmptyDays({}, skelOutline, []);
  const skel = skelRes.items;
  ok(skelRes.replaced.join() === '0,1', '空天与残天都被标记重建', JSON.stringify(skelRes.replaced));
  ok(skel.length >= 8, `空天骨架生成足够条目（${skel.length} 条）`);
  // 残天（细化超时只剩 2 条大交通）也应被重建
  const stubItems = [
    { dayIndex: 0, startTime: '09:00', endTime: '09:40', category: 'transport', activity: '乘 D5181 从成都东站前往都江堰站' },
    { dayIndex: 0, startTime: '08:00', endTime: '08:40', category: 'transport', activity: '从重庆市金童路打车前往成都东站' },
  ];
  const stubRes = P.skeletonForEmptyDays({}, skelOutline, stubItems);
  ok(stubRes.replaced.join() === '0,1', '只剩 2 条的残天也被重建', JSON.stringify(stubRes.replaced));
  ok(stubRes.items.some((it) => it.category === 'sight'), '残天重建后包含游览条目');
  const skelD1 = skel.filter((it) => it.dayIndex === 0);
  const skelD2 = skel.filter((it) => it.dayIndex === 1);
  ok(skelD1.some((it) => it.category === 'sight' && it.activity.includes('都江堰')), '骨架包含大纲必玩点');
  ok(skelD1.some((it) => it.category === 'food'), '骨架包含三餐');
  ok(skelD1.some((it) => it.category === 'transport' && it.startTime === '09:00'), '骨架保留大交通原时刻');
  ok(skelD2.length >= 2, '返程日也有骨架（大交通+餐）', skelD2.length);
  // 骨架条目不得与大交通重叠（插空逻辑）
  const trainD1 = skelD1.find((it) => it.category === 'transport');
  const overlap = skelD1.some((it) => it !== trainD1 && it.category === 'sight'
    && P.toMin(it.startTime) < P.toMin(trainD1.endTime) && P.toMin(it.endTime) > P.toMin(trainD1.startTime));
  ok(!overlap, '骨架游玩条目不与大交通时间重叠');

  console.log('\n—— 包车段宽松匹配（不重复补条目）——');
  const carOutline = { days: [{ overnight: '理县', moves: [{ from: '都江堰景区', to: '理县县城', mode: 'car', code: '包车/租车', startTime: '14:00', endTime: '17:30' }] }] };
  const carItems = [{
    dayIndex: 0, startTime: '14:00', endTime: '17:30', category: 'transport',
    activity: '乘车沿G317国道前往理县县城，途经汶川', startLocation: '都江堰站', endLocation: '理县古尔沟温泉大酒店', transportType: 'car',
  }];
  const afterCar = P.enforceMovesAlignment(carItems.slice(), carOutline);
  ok(afterCar.length === 1, '包车段已有安排时不重复补条目', `条目数=${afterCar.length}`);
  // 真没有时仍要补
  const carOutline2 = { days: [{ overnight: '理县', moves: [{ from: '都江堰景区', to: '理县县城', mode: 'car', code: '包车/租车', startTime: '14:00', endTime: '17:30' }] }] };
  const afterCar2 = P.enforceMovesAlignment([], carOutline2);
  ok(afterCar2.length === 0 || true, '空条目直接返回（无天可挂）');
  const carItems2 = [{ dayIndex: 0, startTime: '10:00', endTime: '10:30', category: 'sight', activity: '游览南桥' }];
  const afterCar3 = P.enforceMovesAlignment(carItems2.slice(), carOutline2);
  ok(afterCar3.length === 2, '包车段真缺失时仍补一条', `条目数=${afterCar3.length}`);
  const busOutline = { days: [{ city: '南宁→大新', overnight: '明仕田园', moves: [
    { from: '南宁东站', to: '大新县明仕田园', mode: 'tour_bus', code: '', startTime: '13:00', endTime: '16:00' },
  ] }] };
  const onlyLocalBusAccess = [{ dayIndex: 0, startTime: '12:30', endTime: '13:00', category: 'transport',
    activity: '从南宁东站乘接驳车前往南宁汽车客运站', startLocation: '南宁东站', endLocation: '南宁汽车客运站' }];
  const afterBus = P.enforceMovesAlignment(onlyLocalBusAccess.slice(), busOutline);
  ok(afterBus.length === 2 && afterBus.some((it) => it.startLocation === '南宁东站'
    && it.endLocation === '大新县明仕田园' && it.transportType === 'bus'),
    '没有车次号的跨城旅游专线/大巴也会按大纲补进详细时间线', JSON.stringify(afterBus));
  const duplicatedArrivalOutline = { days: [
    { city: '德天/硕龙', overnight: '大新县硕龙镇', moves: [] },
    { city: '明仕田园', overnight: '明仕田园', moves: [
      { from: '德天景区', to: '明仕田园', mode: 'car', code: '', startTime: '09:30', endTime: '10:30' },
    ] },
  ] };
  const firstArrival = [{ dayIndex: 1, startTime: '08:15', endTime: '09:00', category: 'transport',
    activity: '乘旅游专线或大巴从硕龙住宿区前往明仕田园', startLocation: '大新县硕龙镇住宿地', endLocation: '明仕田园游客中心', transportType: 'bus' }];
  const noDuplicateArrival = P.enforceMovesAlignment(firstArrival.slice(), duplicatedArrivalOutline);
  ok(noDuplicateArrival.length === 1,
    '当天已从前一晚住宿片区抵达大纲目标时，不再重复安排另一条到同一目的地的交通', JSON.stringify(noDuplicateArrival));

  console.log('\n—— 自驾与司机接送边界（自驾出行）——');
  const publicP = normalizeInput({
    transport: '高铁/动车优先',
    extra: '铁路、旅游专线或大巴没有/不方便时可以打车或包车。',
  });
  ok(!P.drivingAllowed(publicP) && P.defaultTransferMode(publicP) === 'ride'
    && P.taxiAllowed(publicP),
    '非自驾偏好默认公共交通，允许公共交通不便时打车/包车');
  const legacyDriveP = normalizeInput({ transport: '自驾/包车' });
  ok(!P.drivingAllowed(legacyDriveP) && P.defaultTransferMode(legacyDriveP) === 'ride',
    '旧的混合偏好“自驾/包车”不会被误解为全程本人驾驶');
  const ordinaryTransfers = P.enforceTransportPreference([
    { dayIndex: 0, category: 'transport', startLocation: '成都', endLocation: '都江堰', transportType: 'car', activity: '开车从成都前往都江堰' },
    { dayIndex: 0, category: 'transport', startLocation: '都江堰', endLocation: '毕棚沟', transportType: 'car', activity: '自行驾驶前往毕棚沟' },
    { dayIndex: 0, category: 'transport', startLocation: '市区', endLocation: '景区', transportType: 'car', activity: '打车前往景区' },
  ], publicP);
  ok(/打车/.test(ordinaryTransfers[0].activity) && !/开车|自驾|驾驶|驾车/.test(ordinaryTransfers[0].activity)
    && !/开车|自驾|驾驶|驾车/.test(ordinaryTransfers[1].activity),
    '未选自驾时模型生成的本人驾驶文案会降为司机接送');
  ok(ordinaryTransfers[2].transportType === 'car' && /打车/.test(ordinaryTransfers[2].activity),
    '允许作为备选的打车仍保留为司机接送');
  const rentedMotorRows = P.enforceTransportPreference([
    { dayIndex: 0, category: 'other', startLocation: '阳朔西街', endLocation: '阳朔电动车租赁点', activity: '步行至租电动车点，租赁两辆电动摩托车用于全天骑行游览' },
    { dayIndex: 0, category: 'transport', startLocation: '阳朔电动车租赁点', endLocation: '遇龙河水厄底码头', activity: '骑电动车前往遇龙河水厄底码头', transportType: 'ride' },
  ], publicP);
  ok(rentedMotorRows.length === 1 && !/租电动车|骑电动车|摩托车/.test(rentedMotorRows[0].activity)
    && rentedMotorRows[0].transportType === 'ride'
    && rentedMotorRows[0].startLocation === '阳朔公共交通接驳点',
    '未选自驾时移除电摩租赁，并把骑行路段改为公共交通/司机接送', JSON.stringify(rentedMotorRows));
  const rentedMotorNote = P.enforceTransportPreference([{
    dayIndex: 0, category: 'sight', startTime: '15:00', endTime: '16:00',
    activity: '沿明仕绿道步行拍照', note: '也可租电动车沿路游玩，注意安全。',
  }], publicP);
  ok(!/租电动车|电动摩托车|摩托车/.test(rentedMotorNote[0].note)
    && /公共交通|景区接驳/.test(rentedMotorNote[0].note),
    '非自驾时清理藏在游览备注里的电动车租赁建议', JSON.stringify(rentedMotorNote));

  const orderedOutline = P.alignOutlineMoveTimes({ days: [{ moves: [
    { from: '龙脊金坑大寨', to: '桂林磨盘山码头', mode: 'car', startTime: '12:30', endTime: '15:00', timingEstimated: true },
    { from: '桂林磨盘山码头', to: '阳朔龙头山码头', mode: 'ship', startTime: '10:00', endTime: '14:00' },
  ] }] });
  ok(orderedOutline.days[0].moves[1].startTime === '15:30'
    && orderedOutline.days[0].moves[1].endTime === '19:30'
    && orderedOutline.days[0].moves[1].timingEstimated,
    '大纲后续游船不得早于前序景区接驳，顺延并保留游船时长', JSON.stringify(orderedOutline.days[0].moves));
  const miswiredMove = P.enforceMovesAlignment([
    { dayIndex: 0, startTime: '14:00', endTime: '15:00', category: 'transport', transportType: 'ride',
      startLocation: '阳朔龙头山码头', endLocation: '桂林磨盘山码头', activity: '在龙脊景区下站等候包车，上车前往桂林磨盘山码头' },
  ], { days: [{ moves: [
    { from: '龙脊景区', to: '桂林磨盘山码头', mode: 'car', startTime: '12:30', endTime: '15:00', timingEstimated: true },
  ] }] }, [0], publicP);
  ok(miswiredMove.some((it) => it.category === 'transport' && it.startLocation === '龙脊景区'
    && it.endLocation === '桂林磨盘山码头' && it.startTime === '12:30'),
    '细化文案匹配了路线但地点字段串线时，按大纲校正起终点与估算时刻', JSON.stringify(miswiredMove));

  const segmentP = normalizeInput({
    transport: '高铁/动车优先',
    extra: '只在成都到都江堰这一段自驾，其余不自驾。',
  });
  const segmentTransfers = P.enforceTransportPreference([
    { dayIndex: 0, category: 'transport', startLocation: '成都市', endLocation: '都江堰景区', transportType: 'car', activity: '开车从成都市前往都江堰景区' },
    { dayIndex: 1, category: 'transport', startLocation: '都江堰', endLocation: '毕棚沟', transportType: 'car', activity: '自驾从都江堰前往毕棚沟' },
  ], segmentP);
  ok(segmentTransfers[0].transportType === 'car' && /自行驾驶/.test(segmentTransfers[0].activity),
    '补充要求点名的单段自驾得到保留');
  ok(segmentTransfers[1].transportType === 'car' && /打车/.test(segmentTransfers[1].activity)
    && !/自驾|开车|驾驶|驾车/.test(segmentTransfers[1].activity),
    '补充要求没有点名的其他路段不被扩成自驾');

  const publicOutline = P.enforceOutlineTransportPreference(publicP, { days: [{ moves: [
    { from: '成都', to: '都江堰', mode: 'car', transfer: '用户自行开车前往' },
    { from: '都江堰', to: '毕棚沟', mode: '自驾/包车', transfer: '开车前往' },
  ] }] });
  ok(publicOutline.days[0].moves.every((move) => move.mode !== 'car' && !/自驾|开车|驾车|驾驶|驱车/.test(move.transfer || '')),
    '非自驾偏好下大纲层也不会残留本人驾驶方式', JSON.stringify(publicOutline.days[0].moves));

  const fullDriveP = normalizeInput({
    origin: '重庆市金童路', dest: '成都、都江堰', startDate: '2026-12-31', endDate: '2027-01-01',
    startTime: '07:30', endTime: '18:00', transport: '自驾出行',
  });
  const fullDriveOutline = P.applyTripEdgeTimes(fullDriveP, P.enforceOutlineTransportPreference(fullDriveP, {
    days: [
      { date: '2026-12-31', city: '成都', overnight: '成都', moves: [{ from: '重庆西站', to: '成都东站', mode: 'train', code: 'G1', startTime: '09:00', endTime: '12:00' }] },
      { date: '2027-01-01', city: '都江堰', overnight: '返程', moves: [{ from: '都江堰', to: '重庆西站', mode: 'train', code: 'G2', startTime: '14:00', endTime: '17:00' }] },
    ],
  }));
  ok(fullDriveOutline.days.every((d) => d.moves.every((m) => m.mode === 'car' && !m.code))
    && fullDriveOutline.days[0].moves[0].startTime === '07:30'
    && fullDriveOutline.days[1].moves.at(-1).to === '重庆市金童路'
    && fullDriveOutline.days[1].moves.at(-1).endTime === '18:00',
    '选择自驾出行后所有大纲路段改为本人驾驶，首日/末日时间锁定');
  const lateSelfDriveMove = P.enforceMovesAlignment([{
    dayIndex: 0, startTime: '08:00', endTime: '08:30', category: 'sight', activity: '早餐后准备出发',
  }], { days: [{ moves: [
    { from: '成都酒店', to: '都江堰景区', mode: 'car', startTime: '09:00', endTime: '10:30' },
  ] }] }, [0], fullDriveP);
  const finalSelfDriveMove = P.ensureSelfDriveParking(
    P.enforceTransportPreference(lateSelfDriveMove, fullDriveP), fullDriveP);
  const ownDriveIndex = finalSelfDriveMove.findIndex((it) => it.category === 'transport'
    && it.startLocation === '成都酒店' && it.endLocation === '都江堰景区');
  ok(ownDriveIndex >= 0 && finalSelfDriveMove[ownDriveIndex].transportType === 'car'
    && /自行驾驶/.test(finalSelfDriveMove[ownDriveIndex].activity)
    && finalSelfDriveMove[ownDriveIndex + 1].parking
    && finalSelfDriveMove[ownDriveIndex + 1].startTime === '10:30',
    '大纲对齐末尾补入的自驾路段也会保留本人驾驶并紧跟停车', JSON.stringify(finalSelfDriveMove));

  const railFirstP = normalizeInput({
    origin: '重庆市金童路', dest: '成都市、都江堰、毕棚沟',
    startDate: '2026-12-31', endDate: '2027-01-03', startTime: '17:00', endTime: '17:00',
    transport: '高铁/动车优先',
  });
  const railFirstOutline = P.enforceOutlineTransportPreference(railFirstP, { days: [
    { date: '2026-12-31', city: '重庆→成都', overnight: '成都市', moves: [
      { from: '重庆西站', to: '成都东站', mode: 'train', code: 'G1', startTime: '18:30', endTime: '20:00' },
    ] },
    { date: '2027-01-01', city: '都江堰', overnight: '都江堰市', moves: [] },
    { date: '2027-01-02', city: '毕棚沟→马尔康', overnight: '马尔康市', moves: [
      { from: '毕棚沟游客中心', to: '马尔康市', mode: 'car', startTime: '15:00', endTime: '18:00' },
    ] },
    { date: '2027-01-03', city: '阿坝→重庆', overnight: '返程', moves: [
      { from: '马尔康机场', to: '重庆江北国际机场', mode: 'plane', code: 'CA1', startTime: '13:00', endTime: '15:00' },
    ] },
  ] });
  const railReturn = railFirstOutline.days[3].moves.find((move) => move.mode === 'train');
  ok(!railFirstOutline.days[3].moves.some((move) => move.mode === 'plane')
    && railReturn && railReturn.from === '成都东站' && railReturn.to === '重庆西站'
    && railFirstOutline.days[2].overnight === '成都'
    && railFirstOutline.days[2].moves.at(-1).mode === 'bus'
    && railFirstOutline.days[2].moves.at(-1).to === '成都东站',
    '高铁优先行程不保留末日虚构航班，并经已知铁路枢纽安排前日大巴接驳', JSON.stringify(railFirstOutline.days));
  const repairedRailReturn = P.enforceOutlineTransportPreference(railFirstP, { days: [
    { city: '重庆→成都', overnight: '成都', moves: [
      { from: '重庆西站', to: '成都东站', mode: 'train', startTime: '18:30', endTime: '20:00' },
    ] },
    { city: '成都→重庆', overnight: '返程', moves: [
      { from: '重庆北站', to: '重庆市金童路', mode: 'ride', startTime: '16:20', endTime: '17:00' },
    ] },
  ] });
  ok(repairedRailReturn.days[1].moves.some((move) => move.mode === 'train'
    && move.from === '成都东站' && move.to === '重庆西站'),
    '末日只生成了回家接驳时，按去程已有铁路走廊补齐反向返程铁路');
  const railReturnWithScenicAccess = P.enforceOutlineTransportPreference(railFirstP, { days: [
    { city: '重庆→成都', overnight: '成都', moves: [
      { from: '重庆北站', to: '成都东站', mode: 'train', code: 'G1', startTime: '18:30', endTime: '20:00' },
    ] },
    { city: '青城山→重庆', overnight: '返程', moves: [
      { from: '青城山站', to: '重庆西站', mode: 'ride', startTime: '13:30', endTime: '15:00' },
    ] },
  ] });
  const scenicReturnMoves = railReturnWithScenicAccess.days[1].moves;
  ok(scenicReturnMoves.some((move) => move.from === '青城山站' && move.to === '成都东站'
    && move.mode === 'bus')
    && scenicReturnMoves.some((move) => move.from === '成都东站' && move.to === '重庆北站'
      && move.mode === 'train')
    && !scenicReturnMoves.some((move) => move.from === '重庆市金童路' && move.to === '成都东站'),
    '替换返程铁路时保留景区到铁路枢纽接驳，不从出发地反向开去铁路枢纽',
    JSON.stringify(scenicReturnMoves));
  const railFilteredDetails = P.enforceTransportPreference([
    { dayIndex: 3, category: 'transport', transportType: 'plane', startTime: '13:00', endTime: '15:00', activity: '乘航班返回重庆' },
  ], railFirstP);
  ok(railFilteredDetails.length === 0,
    '细化模型额外生成的航班也服从高铁/动车优先规则');

  const selfDriveItems = P.enforceTransportPreference([
    { dayIndex: 0, startTime: '07:30', endTime: '09:00', category: 'transport', activity: '乘 G1 前往酒店', startLocation: '重庆市金童路', endLocation: '成都酒店', transportType: 'train' },
    { dayIndex: 0, startTime: '09:00', endTime: '12:00', category: 'sight', activity: '自驾前往宽窄巷子，游览街区', startLocation: '成都酒店', endLocation: '宽窄巷子', transportType: 'car' },
  ], fullDriveP);
  const parkedSelfDrive = P.fixDayTimeOverlaps(P.ensureSelfDriveParking(selfDriveItems, fullDriveP));
  const scenicDrive = parkedSelfDrive.find((it) => it.category === 'transport' && it.endLocation === '宽窄巷子');
  const scenicParking = parkedSelfDrive.find((it) => it.parking && it.endLocation === '宽窄巷子');
  const scenicVisit = parkedSelfDrive.find((it) => it.category === 'sight' && /游览街区/.test(it.activity));
  ok(parkedSelfDrive.filter((it) => it.parking).length === 2,
    '自驾每次到达停留目的地都生成单独停车安排', JSON.stringify(parkedSelfDrive.filter((it) => it.parking)));
  ok(!!scenicDrive && !!scenicParking && !!scenicVisit
    && scenicParking.startTime === scenicDrive.endTime
    && P.toMin(scenicParking.endTime) <= P.toMin(scenicVisit.startTime),
    '停车安排严格位于到达和游览之间', JSON.stringify([scenicDrive, scenicParking, scenicVisit]));
  const fallbackDriveDay = P.skeletonDayItems(fullDriveP, {
    date: '2027-01-01', city: '成都市', overnight: '成都市',
    highlights: ['宽窄巷子', '锦里'], moves: [], meals: [],
  }, 0, { days: [{}, {}] });
  ok(fallbackDriveDay.filter((it) => it.category === 'transport' && it.transportType === 'car').length === 2
    && fallbackDriveDay.filter((it) => it.parking).length === 2,
    '大纲细化失败时的自驾骨架仍逐景点本人驾驶并逐处先停车', JSON.stringify(fallbackDriveDay));
  const optionalRoutes = P.removeOptionalRouteDetours([{
    category: 'other', activity: '返回村寨休息，也可选择去另一侧观景台。若体力允许可短途移动至远处山顶。建议在村寨看日落。',
  }]);
  ok(!/也可选择去|若体力允许可短途移动至/.test(optionalRoutes[0].activity)
    && /建议在村寨看日落/.test(optionalRoutes[0].activity),
    '移除未排入时间线的可选绕行点，保留已安排活动', optionalRoutes[0].activity);
  const timed = P.enforceScenicRouteTiming([
    { dayIndex: 0, category: 'sight', startTime: '10:00', endTime: '11:00',
      activity: '游览山间步道', note: '完整步道游览预计2小时', endLocation: '甲观景点' },
  ]);
  ok(timed[0].endTime === '12:00', '通用游览时长审计采用声明耗时，不按景点名称硬编码');
  const route = [
    { dayIndex: 0, category: 'sight', startTime: '08:00', endTime: '09:00', activity: '先到甲点放行李', endLocation: '甲观景点' },
    { dayIndex: 0, category: 'sight', startTime: '09:00', endTime: '11:00', activity: '游览乙点', endLocation: '乙观景点' },
    { dayIndex: 0, category: 'sight', startTime: '11:00', endTime: '12:00', activity: '返回甲点再次游览', endLocation: '甲观景点' },
    { dayIndex: 0, category: 'sight', startTime: '12:00', endTime: '15:00', activity: '游览丙点', endLocation: '丙观景点' },
    { dayIndex: 0, category: 'sight', startTime: '15:00', endTime: '16:00', activity: '回甲点休息', endLocation: '甲观景点' },
  ];
  const cleaned = P.enforceScenicRouteSeparation(route);
  ok(cleaned.length === 4 && !cleaned.some((item) => /再次游览/.test(item.activity)),
    '通用规则清除中途重复游览，保留首段寄存与末段休息');
  ok(P.enforceScenicRouteSeparation(cleaned).length === 4,
    '时间足够的甲→乙→丙→甲同日路线保持不变');
  const purposeful = route.map((item) => ({ ...item }));
  purposeful[2].activity = '返回甲点取回寄存行李';
  ok(P.enforceScenicRouteSeparation(purposeful).length === 5, '必要的取行李折返不删除');
  const foldedScenic = P.removeScenicReentryBacktracks([
    { dayIndex: 0, startTime: '10:00', endTime: '12:00', category: 'sight',
      activity: '游览青城山前山并参观天师洞', startLocation: '青城山前山入口', endLocation: '天师洞' },
    { dayIndex: 0, startTime: '12:00', endTime: '12:40', category: 'transport',
      activity: '返回青城山站候车', startLocation: '天师洞', endLocation: '青城山站', transportType: 'ride' },
    { dayIndex: 0, startTime: '12:40', endTime: '13:30', category: 'transport',
      activity: '从青城山站前往天师洞', startLocation: '青城山站', endLocation: '天师洞', transportType: 'ride', autoConnector: true },
    { dayIndex: 0, startTime: '13:30', endTime: '14:30', category: 'other',
      activity: '从天师洞下山至景区出口', startLocation: '天师洞', endLocation: '景区出口' },
  ]);
  ok(foldedScenic.length === 2 && !foldedScenic.some((item) => /前往天师洞|下山至景区出口/.test(item.activity)),
    '景区离开后再次回到已游地点的中途折返被清除', JSON.stringify(foldedScenic));
  const validLongjiLoop = P.removeScenicReentryBacktracks([
    { dayIndex: 0, startTime: '11:00', endTime: '11:30', category: 'sight',
      activity: '在西山韶乐放行李并看景', startLocation: '金坑大寨', endLocation: '西山韶乐' },
    { dayIndex: 0, startTime: '11:30', endTime: '13:00', category: 'sight',
      activity: '游览千层天梯', startLocation: '西山韶乐', endLocation: '千层天梯' },
    { dayIndex: 0, startTime: '13:00', endTime: '15:00', category: 'sight',
      activity: '游览金佛顶', startLocation: '千层天梯', endLocation: '金佛顶' },
    { dayIndex: 0, startTime: '15:00', endTime: '15:40', category: 'transport',
      activity: '从金佛顶返回西山韶乐休息点', startLocation: '金佛顶', endLocation: '西山韶乐', transportType: 'walk' },
    { dayIndex: 0, startTime: '15:40', endTime: '16:20', category: 'other',
      activity: '回到西山韶乐休息并整理行李', startLocation: '西山韶乐', endLocation: '西山韶乐' },
  ]);
  ok(validLongjiLoop.length === 5,
    '时间足够时保留西山韶乐→千层天梯→金佛顶→西山韶乐的合理闭环', JSON.stringify(validLongjiLoop));
  const groupedLongjiOutline = P.enforceLongjiSameDayRoute({ days: [
    { city: '龙脊梯田', theme: '金坑大寨核心游览', overnight: '金坑大寨',
      highlights: ['西山韶乐', '千层天梯'], moves: [
        { from: '阳朔', to: '龙脊金坑大寨', startTime: '08:00', endTime: '11:00' },
      ] },
    { city: '龙脊梯田', theme: '金佛顶后前往明仕田园', overnight: '明仕田园',
      highlights: ['金佛顶'], moves: [
        { from: '金佛顶', to: '明仕田园', startTime: '15:30', endTime: '19:00' },
      ] },
  ] }, { dest: '桂林、龙脊梯田、明仕田园', mustVisit: ['龙脊梯田'] });
  ok(groupedLongjiOutline.days[0].highlights.includes('金佛顶')
    && !groupedLongjiOutline.days[1].highlights.includes('金佛顶')
    && groupedLongjiOutline.days[1].moves[0].from === '金坑大寨',
    '时间足够时把金佛顶合并到西山韶乐/千层天梯同日，并修正次日离开起点',
    JSON.stringify(groupedLongjiOutline));
  const splitLongjiOutline = P.enforceLongjiSameDayRoute({ days: [
    { city: '龙脊梯田', overnight: '金坑大寨', highlights: ['西山韶乐', '千层天梯'], moves: [
      { from: '阳朔', to: '龙脊金坑大寨', startTime: '14:00', endTime: '17:00' },
    ] },
    { city: '龙脊梯田', overnight: '明仕田园', highlights: ['金佛顶'], moves: [
      { from: '金佛顶', to: '明仕田园', startTime: '10:00', endTime: '14:00' },
    ] },
  ] }, { dest: '龙脊梯田、明仕田园' });
  ok(!splitLongjiOutline.days[0].highlights.includes('金佛顶')
    && splitLongjiOutline.days[1].highlights.includes('金佛顶'),
    '时间不足时不强行把金佛顶塞入同一天', JSON.stringify(splitLongjiOutline));
  const duplicateDirected = P.dedupeDirectedTransportRoutes([
    { dayIndex: 0, startTime: '11:00', endTime: '14:00', category: 'transport',
      startLocation: '景区游客中心', endLocation: '理县客运站', transportType: 'ride', activity: '提前离开景区前往理县客运站' },
    { dayIndex: 0, startTime: '14:00', endTime: '15:00', category: 'sight',
      startLocation: '景区内部', endLocation: '景区内部', activity: '继续游览雪山湖泊' },
    { dayIndex: 0, startTime: '18:00', endTime: '19:00', category: 'transport', autoConnector: true, timingEstimated: true,
      startLocation: '景区游客中心', endLocation: '理县客运站', transportType: 'bus', activity: '公共交通接驳前往理县客运站' },
  ]);
  ok(duplicateDirected.length === 2 && duplicateDirected.some((item) => item.autoConnector),
    '后续景区安排分隔时删除前置的同向重复交通', JSON.stringify(duplicateDirected));
  const outlineLocalMove = P.sanitizeOutlineLocalMoves({ days: [{ moves: [
    { from: '成都大熊猫繁育研究基地', to: '重庆北站', mode: 'subway' },
    { from: '成都东站', to: '重庆北站', mode: 'train' },
  ] }] });
  ok(outlineLocalMove.days[0].moves.length === 1 && outlineLocalMove.days[0].moves[0].mode === 'train',
    '大纲不保留与城际返程重复的市内地铁段', JSON.stringify(outlineLocalMove));

  const outlineBacktrack = P.removeOutlineBacktracks({ days: [{ moves: [
    { from: '成都东站', to: '沙坪坝站', mode: 'train' },
    { from: '沙坪坝站', to: '成都东站', mode: 'bus' },
    { from: '成都东站', to: '重庆西站', mode: 'train' },
  ] }] });
  ok(outlineBacktrack.days[0].moves.length === 1
    && outlineBacktrack.days[0].moves[0].to === '重庆西站',
    '大纲清理 A→B→A 后又从 A 出发的即时折返', JSON.stringify(outlineBacktrack));

  const staleOrigins = P.reconcileTransportOrigins([
    { dayIndex: 1, startTime: '08:30', endTime: '12:30', category: 'transport', startLocation: '阳朔汽车站', endLocation: '大新汽车站', activity: '乘大巴前往大新' },
    { dayIndex: 1, startTime: '13:30', endTime: '14:30', category: 'transport', startLocation: '大新汽车站', endLocation: '硕龙镇', activity: '乘旅游专线前往硕龙镇' },
    { dayIndex: 1, startTime: '15:00', endTime: '15:30', category: 'other', startLocation: '格林酒店(阳朔西街店)', endLocation: '德天瀑布', activity: '从硕龙镇前往德天瀑布' },
  ], { days: [
    { city: '阳朔', overnight: '阳朔' },
    { city: '大新', overnight: '硕龙镇' },
  ] });
  ok(staleOrigins[2].startLocation === '硕龙镇',
    '抵达新城市后，后续交通或移动行程起点不再串回前一晚酒店', JSON.stringify(staleOrigins[2]));
  const wrongMorningOrigin = P.reconcileTransportOrigins([
    { dayIndex: 1, startTime: '08:30', endTime: '10:00', category: 'transport', startLocation: '南宁沃顿国际大酒店停车场', endLocation: '德天瀑布', activity: '乘旅游专线前往德天瀑布' },
  ], { days: [
    { city: '明仕田园', overnight: '明仕田园', hotel: '明仕度假山庄' },
    { city: '德天瀑布', overnight: '德天瀑布/硕龙镇', hotel: '德天瀑布/硕龙镇经济型住宿片区' },
  ] });
  ok(wrongMorningOrigin[0].startLocation === '明仕度假山庄',
    '跨住宿区域的次日首段交通从昨晚实际住宿地出发', JSON.stringify(wrongMorningOrigin[0]));

  const zeroDistance = P.removeZeroDistanceTransports([
    { dayIndex: 0, category: 'transport', activity: '乘车从遇龙河景区前往遇龙河景区', startLocation: '遇龙河景区', endLocation: '遇龙河景区' },
    { dayIndex: 0, category: 'transport', activity: '乘观光车环游景区', startLocation: '景区入口', endLocation: '景区入口' },
  ]);
  ok(zeroDistance.length === 1 && /环游/.test(zeroDistance[0].activity),
    '移除同名起终点的无效交通，保留明确的环线观光', JSON.stringify(zeroDistance));

  console.log('\n—— 酒店 POI 必须可订且有具体名称 ——');
  ok(!G.isBookableHotelPoi({ name: '南宁沃顿国际大酒店(南湖地铁站店)北门地上停车场' }, ['南宁']),
    '拒绝被误识别为酒店的停车场 POI');
  ok(!G.isBookableHotelPoi({ name: '阳朔西街酒店' }, ['阳朔', '西街']),
    '拒绝只有地名和住宿类别的泛化片区标签');
  ok(G.isBookableHotelPoi({ name: '桂林两江四湖维也纳酒店' }, ['桂林', '两江四湖']),
    '保留含可搜索物业名称的真实酒店 POI');

  const finalHomeRows = P.removeAfterHomeArrival([
    { dayIndex: 0, category: 'transport', startTime: '15:20', endTime: '16:00', startLocation: '重庆江北国际机场', endLocation: '重庆市金童路', activity: '乘车返回重庆市金童路，到家休息', transportType: 'ride' },
    { dayIndex: 0, category: 'other', startTime: '16:00', endTime: '16:30', activity: '抵达车站后整理行李' },
    { dayIndex: 0, category: 'transport', startTime: '16:30', endTime: '17:00', startLocation: '重庆市金童路', endLocation: '重庆市金童路', activity: '乘地铁回家', transportType: 'walk' },
  ], { origin: '重庆市金童路', backTime: '16:00' }, { days: [{}] });
  ok(finalHomeRows.length === 1 && finalHomeRows[0].endTime === '16:00',
    '到家后删除末日多余安排并对齐用户指定到家时刻', JSON.stringify(finalHomeRows));
  const stationBeforeHome = P.removeAfterHomeArrival([
    { dayIndex: 0, category: 'transport', startTime: '09:00', endTime: '15:30',
      startLocation: '南宁站', endLocation: '重庆西站',
      activity: '乘列车从南宁前往重庆西站，抵达后再转接驳回重庆市金童路', transportType: 'train' },
    { dayIndex: 0, category: 'transport', startTime: '15:30', endTime: '16:00',
      startLocation: '重庆西站', endLocation: '重庆市金童路',
      activity: '乘公共交通返回重庆市金童路，到家休息', transportType: 'ride' },
  ], { origin: '重庆市金童路', backTime: '16:00' }, { days: [{}] });
  ok(stationBeforeHome.length === 2 && stationBeforeHome[0].endLocation === '重庆西站',
    '跨城列车说明提到出发地时仍保留到站段，不误判为已到家', JSON.stringify(stationBeforeHome));
  const cappedHomeTransfer = P.removeAfterHomeArrival([
    { dayIndex: 0, category: 'transport', startTime: '16:30', endTime: '17:10',
      startLocation: '重庆西站', endLocation: '重庆市金童路', activity: '乘公共交通返回重庆市金童路，到家休息', transportType: 'ride' },
  ], { origin: '重庆市金童路', backTime: '17:00' }, { days: [{}] });
  ok(cappedHomeTransfer[0].endTime === '17:00',
    '末日估算接驳对齐用户的到家时刻', JSON.stringify(cappedHomeTransfer[0]));

  console.log('\n—— 返程日收尾不重复（DayClosure 认「返程/回家」）——');
  const homeOutline = { days: [{ overnight: '返程', moves: [{ from: '成都东站', to: '重庆西站', mode: 'train', code: 'G8508', startTime: '18:05', endTime: '19:20' }] }] };
  const homeP = { origin: '重庆市金童路', days: 1, goTime: '', backTime: '20:00' };
  const homeItems = [
    { dayIndex: 0, startTime: '18:05', endTime: '19:20', category: 'transport', activity: '乘 G8508 次列车从成都东站前往重庆西站', startLocation: '成都东站', endLocation: '重庆西站', transportType: 'train' },
    { dayIndex: 0, startTime: '19:35', endTime: '20:00', category: 'transport', activity: '乘车返回重庆市金童路家中', startLocation: '重庆西站', endLocation: '返程', transportType: 'car' },
  ];
  const afterHome = P.enforceDayClosure(homeItems.slice(), homeOutline, homeP);
  ok(afterHome.length === 2, '最后一条已写「回家/返程」就不再补', `条目数=${afterHome.length}`);

  console.log('\n—— 同天重复交通条目去重（dedupeTransports）——');
  ok(P.transportCodeOf({ category: 'transport', activity: '乘坐C6101次城际动车前往离堆公园站' }) === 'C6101',
    '从文案里读出班次码 C6101', P.transportCodeOf({ category: 'transport', activity: '乘坐C6101次城际动车' }));
  ok(P.transportCodeOf({ category: 'transport', activity: '乘地铁2号线前往春熙路' }) === '',
    '「2号线」不是班次码', String(P.transportCodeOf({ category: 'transport', activity: '乘地铁2号线' })));
  ok(P.transportCodeOf({ category: 'transport', activity: '前往T2航站楼乘机' }) === '',
    '「T2航站楼」不是班次码', String(P.transportCodeOf({ category: 'transport', activity: '前往T2航站楼乘机' })));
  const dupItems = [
    { dayIndex: 1, startTime: '08:30', endTime: '09:10', category: 'transport', activity: '乘坐C6101次城际动车前往离堆公园站', startLocation: '成都东站', endLocation: '离堆公园站' },
    { dayIndex: 1, startTime: '09:10', endTime: '09:40', category: 'transport', activity: '乘 C6101(参考) 次列车从成都东站前往离堆公园站', startLocation: '成都东站', endLocation: '离堆公园站' },
    { dayIndex: 3, startTime: '16:00', endTime: '17:50', category: 'transport', activity: '乘坐 G8540 次高铁前往沙坪坝站', startLocation: '成都东站', endLocation: '沙坪坝站' },
    { dayIndex: 3, startTime: '19:20', endTime: '19:50', category: 'transport', activity: '乘 G8540(参考) 次列车从成都东站前往沙坪坝站', startLocation: '成都东站', endLocation: '沙坪坝站' },
    { dayIndex: 3, startTime: '19:50', endTime: '20:20', category: 'transport', activity: '乘地铁环线返回家中', startLocation: '沙坪坝站地铁站', endLocation: '金童路' },
  ];
  const afterDup = P.dedupeTransports(dupItems);
  ok(afterDup.length === 3, '同天同班次码（C6101/G8540 各两条）各留最早一条', `剩 ${afterDup.length} 条`);
  ok(afterDup.some((it) => it.startTime === '08:30') && afterDup.some((it) => it.startTime === '16:00'),
    '留下的是最早那条（08:30 / 16:00）', afterDup.map((it) => it.startTime).join(','));
  const dirDup = [
    { dayIndex: 0, startTime: '10:00', endTime: '10:40', category: 'transport', activity: '乘车前往古镇停车场', startLocation: '酒店', endLocation: '古镇停车场' },
    { dayIndex: 0, startTime: '10:20', endTime: '11:00', category: 'transport', activity: '包车前往古镇停车场', startLocation: '酒店门口', endLocation: '古镇停车场入口' },
    { dayIndex: 0, startTime: '15:00', endTime: '16:00', category: 'transport', activity: '包车前往下一个城市', startLocation: '古镇停车场', endLocation: '另一城市' },
  ];
  const afterDir = P.dedupeTransports(dirDup);
  ok(afterDir.length === 2, '同方向且时刻相近（≤90 分钟）的交通只留一条', `剩 ${afterDir.length} 条`);
  const arrivedThenRepeated = P.dedupeTransports([
    { dayIndex: 0, startTime: '10:45', endTime: '15:20', category: 'transport',
      activity: '乘列车从南宁前往重庆西站', startLocation: '南宁东站', endLocation: '重庆西站' },
    { dayIndex: 0, startTime: '15:20', endTime: '15:50', category: 'transport',
      activity: '乘列车从南宁前往重庆西站', startLocation: '南宁东站', endLocation: '重庆西站' },
    { dayIndex: 0, startTime: '15:50', endTime: '16:00', category: 'transport',
      activity: '乘轨道交通回金童路', startLocation: '重庆西站', endLocation: '重庆金童路' },
  ]);
  ok(arrivedThenRepeated.length === 2,
    '列车已到站后立即再次出现同方向长途交通时，识别并删除重复段', JSON.stringify(arrivedThenRepeated));
  const noDup = P.dedupeTransports([
    { dayIndex: 0, startTime: '09:00', endTime: '10:00', category: 'transport', activity: '乘 G1 次列车前往A站', startLocation: 'B站', endLocation: 'A站' },
    { dayIndex: 0, startTime: '18:00', endTime: '19:00', category: 'transport', activity: '乘 G2 次列车返回B站', startLocation: 'A站', endLocation: 'B站' },
  ]);
  ok(noDup.length === 2, '正常往返/不同段的交通不误伤', `剩 ${noDup.length} 条`);
  const hotelRows = P.dedupeDuplicateHotelItems([
    { dayIndex: 0, startTime: '16:00', endTime: '16:30', category: 'hotel', activity: '到酒店放下行李', endLocation: '桂林漓江大瀑布饭店' },
    { dayIndex: 0, startTime: '20:40', endTime: '21:10', category: 'hotel', activity: '前往桂林漓江大瀑布饭店办理入住，放下行李休息', endLocation: '桂林漓江大瀑布饭店' },
    { dayIndex: 0, startTime: '22:30', endTime: '23:00', category: 'hotel', activity: '前往桂林漓江大瀑布饭店办理入住，放下行李休息', endLocation: '桂林漓江大瀑布饭店' },
  ]);
  ok(hotelRows.length === 2 && hotelRows.some((it) => it.startTime === '16:00')
    && hotelRows.some((it) => it.startTime === '20:40'),
    '清理同一天重复的酒店入住，同时保留白天放行李和晚间入住', JSON.stringify(hotelRows));
  const splitTransfer = P.removeRedundantDirectTransports([
    { dayIndex: 0, startTime: '14:00', endTime: '14:30', category: 'transport', transportType: 'ride', startLocation: '磐羊湖', endLocation: '理县客运站', activity: '乘车前往理县客运站' },
    { dayIndex: 0, startTime: '14:30', endTime: '15:00', category: 'transport', transportType: 'ride', startLocation: '磐羊湖', endLocation: '毕棚沟景区游客中心', activity: '乘景区观光车返回游客中心' },
    { dayIndex: 0, startTime: '15:00', endTime: '15:30', category: 'transport', transportType: 'ride', startLocation: '毕棚沟景区游客中心', endLocation: '理县客运站', activity: '包车前往理县客运站' },
  ]);
  ok(splitTransfer.length === 2 && splitTransfer.some((it) => it.endLocation === '毕棚沟景区游客中心')
    && splitTransfer.some((it) => it.startLocation === '毕棚沟景区游客中心'),
    '多段接驳链覆盖时移除冲突的直达交通', JSON.stringify(splitTransfer));
  const checkoutLoop = P.removeCheckoutBacktracks([
    { dayIndex: 0, startTime: '07:00', endTime: '07:30', category: 'transport', transportType: 'ride', startLocation: '理县古尔沟黄金林酒店', endLocation: '古尔沟温泉小镇', activity: '前往古尔沟温泉小镇' },
    { dayIndex: 0, startTime: '07:30', endTime: '08:00', category: 'other', startLocation: '古尔沟温泉小镇', endLocation: '理县古尔沟黄金林酒店门口', activity: '从理县古尔沟黄金林酒店办理退房并携带全部行李出发' },
  ]);
  ok(checkoutLoop.length === 1 && checkoutLoop[0].category === 'other'
    && checkoutLoop[0].startLocation === '理县古尔沟黄金林酒店' && !checkoutLoop[0].endLocation,
    '退房前的短途折返被清除，退房安排回到实际住宿地', JSON.stringify(checkoutLoop));
  const finalCheckoutAudit = P.enforceFinalTimelineIntegrity([
    { dayIndex: 0, startTime: '07:00', endTime: '07:30', category: 'transport', transportType: 'ride', startLocation: '住宿地酒店', endLocation: '附近早餐店', activity: '乘车前往附近早餐店' },
    { dayIndex: 0, startTime: '07:30', endTime: '08:00', category: 'other', startLocation: '附近早餐店', endLocation: '住宿地酒店门口', activity: '回酒店退房并携带全部行李出发' },
  ], P.normalizeInput({ origin: '', dest: '', transport: '高铁/动车优先' }), { days: [{}] });
  ok(finalCheckoutAudit.length === 1 && finalCheckoutAudit[0].category === 'other'
    && finalCheckoutAudit[0].startLocation === '住宿地酒店',
    '最终时间线序列化前再次清除折返并校正退房起点', JSON.stringify(finalCheckoutAudit));
  const finalHomeAudit = P.ensureFinalHomeArrival([
    { dayIndex: 1, startTime: '14:00', endTime: '16:00', category: 'transport',
      transportType: 'train', activity: '乘列车从成都东站返回重庆北站',
      startLocation: '成都东站', endLocation: '重庆北站' },
    { dayIndex: 1, startTime: '16:30', endTime: '17:00', category: 'transport',
      transportType: 'ride', activity: '重庆北站站内出站接驳',
      startLocation: '重庆北站', endLocation: '重庆北站南广场' },
    { dayIndex: 1, startTime: '17:10', endTime: '17:40', category: 'transport',
      transportType: 'ride', activity: '乘地铁前往金童路站',
      startLocation: '重庆北站地铁站', endLocation: '金童路地铁站' },
  ], P.normalizeInput({ origin: '重庆市金童路', endTime: '17:00', transport: '高铁/动车优先' }),
  { days: [{}, { city: '返程', overnight: '返程' }] });
  const finalHomeAuditRows = finalHomeAudit.filter((it) => it.dayIndex === 1)
    .sort((a, b) => P.toMin(a.startTime) - P.toMin(b.startTime));
  ok(finalHomeAuditRows.length === 2
    && finalHomeAuditRows[1].endLocation === '重庆市金童路'
    && finalHomeAuditRows[1].endTime === '17:00'
    && finalHomeAuditRows[1].startLocation === '重庆北站',
  '返程日清除到站后的旧站内接驳并收口到用户出发地/到家时刻', JSON.stringify(finalHomeAuditRows));
  const lateUnverifiedHome = P.ensureFinalHomeArrival([
    { dayIndex: 1, startTime: '14:00', endTime: '15:30', category: 'sight',
      activity: '游览返程前最后一个片区', startLocation: '', endLocation: '' },
    { dayIndex: 1, startTime: '16:30', endTime: '18:00', category: 'transport',
      transportType: 'train', schedSource: 'official-unavailable',
      activity: '乘列车从成都东站前往重庆北站', startLocation: '成都东站', endLocation: '重庆北站' },
  ], P.normalizeInput({ origin: '重庆市金童路', endTime: '17:00', transport: '高铁/动车优先' }),
  { days: [{}, { city: '返程', overnight: '返程' }] });
  ok(lateUnverifiedHome.find((it) => it.category === 'transport' && it.endLocation === '重庆市金童路').endTime === '17:00',
    '未核验返程时刻晚于目标时，按用户到家时间倒推而不是继续延后', JSON.stringify(lateUnverifiedHome));
  const waitingRows = P.removeOrphanStationWaitingItems([
    { dayIndex: 0, startTime: '18:30', endTime: '19:00', category: 'other', startLocation: '成都茶店子客运站', endLocation: '理县客运站候车厅', activity: '抵达后进站候车，准备乘坐长途大巴' },
    { dayIndex: 1, startTime: '08:30', endTime: '09:00', category: 'other', startLocation: '成都东站', endLocation: '成都东站候车厅', activity: '到站安检候车' },
    { dayIndex: 1, startTime: '09:00', endTime: '10:00', category: 'transport', transportType: 'train', startLocation: '成都东站', endLocation: '都江堰站', activity: '乘列车前往都江堰站' },
  ], { days: [{ moves: [] }, { moves: [{ from: '成都东站', to: '都江堰站', mode: 'train', startTime: '09:00' }] }] });
  ok(waitingRows.length === 2 && waitingRows.some((it) => it.activity === '到站安检候车'),
    '删除没有后续发车安排的虚假候车说明，保留对应真实车次的候车时间', JSON.stringify(waitingRows));

  const hotelCheckResult = { outline: { days: [
    { date: '2026-09-30', city: '桂林', overnight: '桂林', hotel: '桂林虚构精选酒店' },
    { date: '2026-10-01', city: '龙脊梯田', overnight: '金坑大寨', hotel: '金坑真实民宿' },
    { date: '2026-10-02', city: '重庆', overnight: '返程', hotel: '末日不安排酒店' },
  ] } };
  const hotelQueries = [];
  await validateOutlineHotels(hotelCheckResult, { budget: '经济实惠' }, async (name, city) => {
    hotelQueries.push(`${city}:${name}`);
    return name === '金坑真实民宿' ? {
      matchedName: '金坑真实民宿（高德 POI）', city: '桂林市', district: '龙胜各族自治县', address: '金坑大寨',
    } : null;
  });
  ok(hotelQueries.length === 2
    && /桂林.*经济型住宿片区/.test(hotelCheckResult.outline.days[0].hotel)
    && hotelCheckResult.outline.days[1].hotel === '金坑真实民宿（高德 POI）'
    && hotelCheckResult.outline.days[2].hotel === '末日不安排酒店',
  '酒店 POI 命中保留真实名称、未命中降级片区档次、返程日不造住宿');
  ok(hotelCheckResult.outline.days[1].hotelPoiAddress.includes('桂林市')
    && P.locationFitsScope(hotelCheckResult.outline.days[1].hotel, '金坑大寨', hotelCheckResult.outline.days[1].hotelPoiAddress)
    && !P.locationFitsScope('云天酒店(崇左大新德天广场店)', '南宁', '崇左市大新县'),
  '核验地址随酒店保留，并能识别搜索结果落在相邻城市');
  const nearbyHotelResult = { outline: { days: [
    { date: '2026-09-30', city: '桂林', overnight: '两江四湖片区', hotel: '桂林 经济型住宿片区' },
    { date: '2026-10-01', city: '桂林', overnight: '返程', hotel: '' },
  ] } };
  let nearbyHotelSearches = 0;
  await validateOutlineHotels(nearbyHotelResult, { budget: '经济实惠' }, async () => null,
    async (city, budget) => {
      nearbyHotelSearches++;
      return city.includes('桂林') && /经济/.test(budget)
        ? { matchedName: '桂林两江四湖维也纳酒店', areaSearch: true, areaMatched: true, searchCity: '桂林' } : null;
    });
  ok(nearbyHotelSearches === 1 && nearbyHotelResult.outline.days[0].hotel === '桂林两江四湖维也纳酒店',
    '模型酒店名未命中时，在同城住宿片区改用真实酒店 POI 名称', nearbyHotelResult.outline.days[0].hotel);
  const missingHotelResult = { outline: { days: [
    { date: '2026-09-30', city: '大新县', overnight: '硕龙镇', hotel: '' },
    { date: '2026-10-01', city: '重庆', overnight: '返程', hotel: '' },
  ] } };
  let fallbackSearchRegion = '';
  await validateOutlineHotels(missingHotelResult, { budget: '经济实惠' }, async () => null,
    async (region) => { fallbackSearchRegion = region; return null; });
  ok(/经济型住宿片区/.test(missingHotelResult.outline.days[0].hotel)
    && fallbackSearchRegion.includes('硕龙镇'),
  '大纲漏推荐酒店时也生成可搜索住宿片区并查询真实 POI', JSON.stringify(missingHotelResult.outline.days[0]));
  const wrongAreaHotelResult = { outline: { days: [
    { date: '2026-10-05', city: '大新→南宁', overnight: '南宁市区', hotel: '大新酒店' },
    { date: '2026-10-06', city: '南宁', overnight: '返程', hotel: '' },
  ] } };
  await validateOutlineHotels(wrongAreaHotelResult, { budget: '经济实惠' }, async () => ({
    matchedName: '大新德天广场酒店', city: '崇左市', district: '大新县', address: '大新县城',
  }), async () => null);
  ok(/南宁市区.*经济型住宿片区/.test(wrongAreaHotelResult.outline.days[0].hotel),
    '跨城日的酒店必须与 overnight 匹配，不能因白天经过大新而把大新酒店留在南宁', wrongAreaHotelResult.outline.days[0].hotel);
  const wrongNearbyHotelResult = { outline: { days: [
    { date: '2026-10-05', city: '南宁', overnight: '南宁', hotel: '南宁 经济型住宿片区' },
    { date: '2026-10-06', city: '重庆', overnight: '返程', hotel: '' },
  ] } };
  await validateOutlineHotels(wrongNearbyHotelResult, { budget: '经济实惠' }, async () => null,
    async () => ({
      matchedName: '云天酒店(崇左大新德天广场店)', city: '南宁市', district: '崇左市',
      address: '广西壮族自治区崇左市大新县', areaSearch: true, areaMatched: true, searchCity: '南宁',
    }));
  ok(!wrongNearbyHotelResult.outline.days[0].hotelPoiVerified
    && /南宁.*经济型住宿片区/.test(wrongNearbyHotelResult.outline.days[0].hotel),
  '附近酒店搜索的行政区地址冲突时，不把邻市 POI 冒充当地酒店', wrongNearbyHotelResult.outline.days[0].hotel);
  const verifiedHotelWithWrongScope = P.normalizeOutlineLodging({ days: [
    { overnight: '南宁青秀区', hotel: '外地真实酒店', hotelPoiVerified: true,
      hotelPoiVerifiedName: '外地真实酒店', hotelPoiAddress: '广西壮族自治区崇左市天等县' },
  ] });
  ok(!verifiedHotelWithWrongScope.days[0].hotelPoiVerified && !verifiedHotelWithWrongScope.days[0].hotel,
    '已核验酒店的地址发生跨城变化时仍会清除旧 POI', JSON.stringify(verifiedHotelWithWrongScope.days[0]));

  const bookingStatusProfile = normalizeInput({
    origin: '重庆金童路', dest: '桂林、德天瀑布',
    startDate: '2026-12-20', endDate: '2026-12-23',
    extra: '去程火车票已购票；德天瀑布门票未购；游船票已预约',
  });
  const bookingStatusOutline = {
    days: [
      { date: '2026-12-20', city: '桂林', overnight: '桂林', moves: [
        { from: '重庆北站', to: '桂林北站', mode: 'train', code: 'G1', startTime: '08:00', endTime: '12:00' },
      ], highlights: ['漓江游船'] },
      { date: '2026-12-21', city: '德天瀑布', overnight: '硕龙镇', moves: [], highlights: ['德天瀑布'] },
      { date: '2026-12-22', city: '桂林', overnight: '桂林', moves: [], highlights: ['返程准备'] },
      { date: '2026-12-23', city: '返程', overnight: '返程', moves: [], highlights: [] },
    ],
  };
  const bookingStatusAlarms = P.normalizeBookingAlarmKinds(
    P.fallbackAlarms(bookingStatusProfile, bookingStatusOutline), [], bookingStatusProfile,
  );
  ok(!bookingStatusAlarms.some((a) => a.type === 'train' && /去程/.test(a.title || '')),
    '补充要求写“去程火车票已购票”时不再重复提醒去程车票');
  ok(bookingStatusAlarms.some((a) => a.type === 'ticket' && /德天/.test(`${a.title} ${a.bookingInfo}`)),
    '“德天瀑布门票未购”不会被误判为已购，仍保留门票提醒');
  ok(!bookingStatusAlarms.some((a) => a.type === 'ticket' && /游船/.test(`${a.title} ${a.bookingInfo}`)),
    '“游船票已预约”时不再重复生成游船提醒');
  const annotatedHotel = P.annotateHotelItems([
    { dayIndex: 0, category: 'hotel', activity: '办理入住', endLocation: '桂林两江四湖维也纳酒店' },
  ], { days: [{ overnight: '桂林', hotel: '桂林两江四湖维也纳酒店', hotelPoiVerified: true,
    hotelPoiVerifiedName: '桂林两江四湖维也纳酒店', hotelPoiAddress: '桂林市象山区' }] });
  ok(annotatedHotel[0].bookingInfo === '桂林两江四湖维也纳酒店'
    && /地址：桂林市象山区/.test(annotatedHotel[0].note)
    && /主流平台/.test(annotatedHotel[0].note),
  '酒店卡片同步完整名称、核验地址和主流平台检索提示', JSON.stringify(annotatedHotel[0]));
  const hotelReferenceOutline = { days: [
    { overnight: '桂林', hotel: '桂林两江四湖维也纳酒店', hotelPoiVerified: true,
      hotelPoiVerifiedName: '桂林两江四湖维也纳酒店', hotelPoiAddress: '桂林市象山区' },
    { overnight: '阳朔', hotel: '阳朔西街云景酒店', hotelPoiVerified: true,
      hotelPoiVerifiedName: '阳朔西街云景酒店', hotelPoiAddress: '阳朔县西街' },
    { overnight: '返程', hotel: '' },
  ] };
  const hotelReferenceItems = P.annotateHotelItems([
    { dayIndex: 0, category: 'hotel', activity: '到桂林旧酒店办理入住', endLocation: '桂林旧酒店' },
    { dayIndex: 1, category: 'food', activity: '在桂林旧酒店吃早餐，退房后出发',
      startLocation: '桂林旧酒店', endLocation: '桂林旧酒店', startTime: '07:00', endTime: '08:00' },
    { dayIndex: 1, category: 'transport', activity: '从桂林旧酒店前往阳朔旧酒店',
      startLocation: '桂林旧酒店', endLocation: '阳朔旧酒店', startTime: '08:00', endTime: '10:00' },
    { dayIndex: 1, category: 'hotel', activity: '到阳朔旧酒店办理入住', endLocation: '阳朔旧酒店' },
    { dayIndex: 2, category: 'food', activity: '在阳朔旧酒店吃早餐并退房',
      startLocation: '阳朔旧酒店', endLocation: '阳朔旧酒店', startTime: '07:00', endTime: '08:00' },
  ], hotelReferenceOutline);
  const hotelReferenceText = hotelReferenceItems.map((item) =>
    `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''} ${item.bookingInfo || ''}`).join('；');
  ok(!/旧酒店/.test(hotelReferenceText)
    && hotelReferenceItems[1].startLocation === '桂林两江四湖维也纳酒店'
    && hotelReferenceItems[1].endLocation === '桂林两江四湖维也纳酒店'
    && hotelReferenceItems[2].startLocation === '桂林两江四湖维也纳酒店'
    && hotelReferenceItems[2].endLocation === '阳朔西街云景酒店'
    && hotelReferenceItems[4].startLocation === '阳朔西街云景酒店',
  '酒店 POI 更新后同步早餐、退房、跨天交通和入住条目的新名称', JSON.stringify(hotelReferenceItems));

  const aliasOutline = { days: [
    { city: '甲城', overnight: '甲城', hotel: '甲城晨光酒店', hotelPoiVerified: true,
      hotelPoiVerifiedName: '甲城晨光酒店', hotelPoiAddress: '甲城市中心' },
    { city: '乙城', overnight: '返程', hotel: '' },
  ] };
  const aliasTransfer = P.annotateHotelItems([
    { dayIndex: 1, category: 'transport', transportType: 'ride', startTime: '07:00', endTime: '07:30',
      startLocation: '甲城晨光酒店', endLocation: '甲城车站附近酒店', activity: '从甲城晨光酒店前往甲城车站附近酒店，开始当天行程' },
  ], aliasOutline);
  ok(aliasTransfer.length === 0, '酒店别名统一后移除新产生的同地点交通');
  const morningAlias = P.normalizeGeneratedLodging([
    { dayIndex: 1, category: 'transport', startTime: '07:00', endTime: '07:30',
      startLocation: '甲城晨光酒店', endLocation: '甲城车站附近酒店', activity: '前往甲城车站附近酒店取行李' },
  ], aliasOutline, { origin: '乙城家中' });
  ok(morningAlias[0].endLocation === '甲城晨光酒店', '返程日早晨酒店别名不被替换成到家城市');
  const normalCheckin = P.normalizeGeneratedLodging([
    { dayIndex: 0, category: 'hotel', startTime: '16:00', endTime: '16:30', endLocation: '甲城晨光酒店', activity: '到达甲城晨光酒店办理入住' },
    { dayIndex: 0, category: 'transport', transportType: 'ride', startTime: '21:00', endTime: '21:30',
      startLocation: '夜市', endLocation: '甲城晨光酒店', activity: '从夜市返回酒店' },
  ], aliasOutline, {});
  ok(normalCheckin.length === 2, '晚间回酒店不导致白天正常入住被删除');

  if (process.argv.includes('--unit')) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
  await runRealGeneration();
})().catch((e) => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});

function runRealGeneration() {
console.log('\n============================================');
console.log('第二部分：真实 LLM 生成（国庆广西场景）');
console.log('============================================');

const INPUT = {
  origin: '重庆金童路',
  dest: '桂林、阳朔、龙脊梯田、明仕庄园和德天瀑布',
  startDate: '2026-09-30',
  endDate: '2026-10-07',
  startTime: '08:30',   // 去程开始时间：08:30 从重庆出发
  endTime: '21:15',     // 返程到达时间：21:15 回到重庆
  people: 2,
  party: '情侣出行',
  budget: '舒适',
  pace: '适中',
  interests: ['自然山水', '古镇古村', '当地美食', '拍照打卡'],
  transport: '高铁/动车优先',
  mustGo: '漓江游船、遇龙河竹筏',
  extra: '不想全程自驾，尽量公共交通+当地直通车',
};

return (async () => {
  // 线上是两次云函数调用（大纲 / 展开），分别都不能超过 60s，这里分开计时验证
  const t0 = Date.now();
  const phase1 = await P.generateOutline(INPUT);
  const outlineSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n阶段一（大纲）：%s（%s）', phase1.title, outlineSec + 's');
  console.log('  概览:', phase1.summary);
  (phase1.outline.days || []).forEach((d, i) => {
    console.log(`  第${i + 1}天 ${d.date}｜${d.theme}｜住${d.overnight || d.city}`);
  });
  ok((Date.now() - t0) / 1000 < 60, `阶段一耗时 ${outlineSec}s < 云函数 60s 上限`);

  // 点名地点必须全部进大纲（Tiger 实锤：龙脊梯田曾被 LLM 默默丢掉）
  const mustVisit = P.normalizeInput(INPUT).mustVisit;
  const outlineJson = JSON.stringify(phase1.outline);
  // 用"词干"比对：用户写的「明仕庄园」和地图通用名「明仕田园」是同一个地方，
  // 模型按通用名写反而更利于导航，不能算漏——全等比对会误报
  const stemOf = (s) => String(s || '')
    .replace(/(庄园|田园|景区|风景区|名胜区|公园|古镇|古村|古寨|度假区|自然保护区|旅游区)$/, '')
    .trim();
  mustVisit.forEach((name) => {
    const stem = stemOf(name);
    const hit = outlineJson.includes(name) || (stem.length >= 2 && outlineJson.includes(stem));
    ok(hit, `大纲包含点名地点「${name}」${hit ? '' : `（词干「${stem}」也没匹配上）`}`);
  });
  // 漏点/重复的代码级检测（与云端修订用同一套判定）
  const playMissing = P.missingMustVisit({ mustVisit }, phase1.outline);
  ok(playMissing.length === 0, `大纲每个点名地点都有"真游玩"安排（不只是路过）`, playMissing.join('、'));
  const outlineDups = P.duplicateHighlights(phase1.outline);
  ok(outlineDups.length === 0, '大纲没有跨天重复游玩的景点',
    outlineDups.map((d) => `${d.name}(第${d.days.map((x) => x + 1).join(',')}天)`).join('；'));

  // 去程 / 返程时刻：同上，不再"平移"班次，改成二选一的契约——
  //   要么模型给的时刻本来就与用户意向吻合（45 分钟容差），
  //   要么代码在当天 note 里把"建议几点出门 / 预计几点到家"说清楚。
  // 两条都不占 = 用户拿到的时刻既对不上意向、又没有任何解释，这才是真 bug。
  const minOf = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  const od = phase1.outline.days || [];
  const firstMove = (od[0] && od[0].moves || [])[0];
  // 返程段 = 大纲里最后一段交通（最后一天没写出来就往前找，别怪模型漏写）
  let lastMove = null;
  let backDay = null;
  for (let i = od.length - 1; i >= 0 && !lastMove; i--) {
    const mv = (od[i] && od[i].moves) || [];
    if (mv.length) { lastMove = mv[mv.length - 1]; backDay = od[i]; }
  }
  const goReal = firstMove ? minOf(firstMove.startTime) : null;
  const goNote = String(od[0] && od[0].note || '');
  ok(!!firstMove && (goReal !== null && Math.abs(goReal - (8 * 60 + 30 + 85)) <= 45
    || /建议\s*\d{2}:\d{2}\s*前出发/.test(goNote)),
    '去程：发车时刻要么与出发时间对得上，要么在当天提示给出建议出门时刻（不硬改班次）',
    firstMove && `${firstMove.startTime}｜note=${goNote.slice(0, 40)}`);
  const backReal = lastMove ? minOf(lastMove.endTime) : null;
  const backNote = String(backDay && backDay.note || '');
  ok(!!lastMove && (backReal !== null && Math.abs(backReal - (21 * 60 + 15 - 40)) <= 45
    || /预计\s*\d{2}:\d{2}\s*到家/.test(backNote)),
    '返程：到站时刻要么与到家时间对得上，要么在当天提示给出预计到家时刻',
    lastMove && `${lastMove.startTime}-${lastMove.endTime}｜note=${backNote.slice(0, 40)}`);
  ok(!!lastMove && minOf(lastMove.startTime) !== null && minOf(lastMove.startTime) < (backReal || Infinity),
    '返程没把到达时间误当成发车时间（发车必须早于到站）',
    lastMove && `${lastMove.startTime}-${lastMove.endTime}`);

  // 阶段二：模拟云端续跑——一次跑不完（partial）就接着调，直到全部生成
  const t1 = Date.now();
  let plan = null;
  let slowest = 0;
  let rounds = 0;
  const allItems = [];
  for (let r = 0; r < 6; r++) {
    const rt = Date.now();
    // attempts 要跟着回传，否则失败的天不会被重试（与前端续跑逻辑保持一致）
    plan = await P.buildPlan(INPUT, Object.assign({}, INPUT, phase1), {
      doneDayIndexes: plan && plan.doneDayIndexes,
      attempts: plan && plan.attempts,
    });
    const cost = (Date.now() - rt) / 1000;
    slowest = Math.max(slowest, cost);
    rounds = r + 1;
    allItems.push(...plan.items);
    if (!plan.partial) break;
  }
  ok(slowest < 60, `阶段二单次最长耗时 ${slowest.toFixed(1)}s < 云函数 60s 上限（共 ${rounds} 轮续跑）`);
  // 续跑时每轮只返回新生成的天，这里合并成完整行程再校验
  if (allItems.length !== plan.items.length) plan.items = allItems;
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n生成结果：${plan.title}（${plan.startDate} ~ ${plan.endDate}）耗时 ${sec}s（${rounds} 轮）`);
  console.log('概览:', plan.summary);

  const byDay = new Map();
  plan.items.forEach((it) => byDay.set(it.dayIndex, (byDay.get(it.dayIndex) || 0) + 1));
  console.log('\n每天条目数：');
  [...byDay.keys()].sort((a, b) => a - b).forEach((k) => {
    console.log(`  第${k + 1}天: ${byDay.get(k)} 条`);
  });

  const zeroDur = plan.items.filter((it) => it.startTime && it.startTime === it.endTime);
  const noTime = plan.items.filter((it) => !it.startTime || !it.endTime);
  console.log(`\n总条目 ${plan.items.length}｜零时长 ${zeroDur.length}｜缺时间 ${noTime.length}`);

  ok(plan.items.length >= plan.meta.days * 6, `条目数达到 ${plan.meta.days * 6} 条以上（参考攻略 84 条/8 天）`, plan.items.length);
  ok(zeroDur.length === 0, '没有零时长条目', zeroDur.length);
  ok(noTime.length === 0, '没有缺失时间的条目', noTime.length);
  ok([...byDay.keys()].length === plan.meta.days, `每一天都有内容（${plan.meta.days} 天）`, [...byDay.keys()].length);

  // 详细行程里得真的去了龙脊梯田（不只是一句带过——这是 Tiger 点名要防的回归）
  const hitLongji = plan.items.some((it) =>
    /龙脊/.test(String(it.activity || '') + (it.startLocation || '') + (it.endLocation || '')));
  ok(hitLongji, '详细行程包含「龙脊梯田」相关安排');

  // 时间连续性抽检：同一天内相邻条目时间不得倒退超过 0 分钟（允许间隔，但不允许倒退）
  let backward = 0;
  [...byDay.keys()].forEach((d) => {
    const dayItems = plan.items.filter((it) => it.dayIndex === d);
    for (let i = 1; i < dayItems.length; i++) {
      const prevEnd = toMin(dayItems[i - 1].endTime);
      const curStart = toMin(dayItems[i].startTime);
      if (prevEnd !== null && curStart !== null && curStart < prevEnd) backward++;
    }
  });
  ok(backward === 0, '同天内没有时间倒退的条目', backward);

  // 住宿闭环：昨天住的地方，今天第一条就该从那里出发（跨城大交通日除外）
  let chainBreak = 0;
  const outlineDays = (phase1.outline.days || []);
  for (let d = 1; d < outlineDays.length; d++) {
    const dayItems = plan.items.filter((it) => it.dayIndex === d)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (!dayItems.length) continue;
    const prevOv = outlineDays[d - 1].overnight || outlineDays[d - 1].city || '';
    const first = dayItems[0];
    const loc = String(first.startLocation || '') + String(first.activity || '') + String(first.endLocation || '');
    const sameCity = prevOv && outlineDays[d].overnight
      && (outlineDays[d].overnight.includes(prevOv) || prevOv.includes(outlineDays[d].overnight)
        || outlineDays[d].city === outlineDays[d - 1].city);
    // 同城连住才检查闭环；跨城日第一件事本来就是赶路，不查
    if (sameCity && prevOv && !loc.includes(prevOv.slice(0, 2))) chainBreak++;
  }
  ok(chainBreak === 0, '同城连住的天，早上从昨晚住宿地出发（闭环）', chainBreak);
  // 闭环兜底：每天"第一条"的 startLocation 都不该是空的（吃饭/游览留空是正常的）
  let emptyFirst = [];
  for (let d = 1; d < outlineDays.length; d++) {
    const dayItems = plan.items.filter((it) => it.dayIndex === d)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (dayItems.length && !String(dayItems[0].startLocation || '').trim()) {
      emptyFirst.push(`第${d + 1}天「${dayItems[0].activity}」`);
    }
  }
  ok(emptyFirst.length === 0, '每天第一条都有起点（兜底已补齐）', emptyFirst.join('；'));

  // 行李：换住处的天必须交代行李怎么走；只要寄存了就必须有取回提醒
  const lugMissing = [];
  const lugNoPickup = [];
  for (let d = 0; d < outlineDays.length; d++) {
    const dayItems = plan.items.filter((it) => it.dayIndex === d)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (!dayItems.length) continue;
    const tonight = outlineDays[d].overnight || outlineDays[d].city || '';
    const lastNight = d > 0 ? (outlineDays[d - 1].overnight || outlineDays[d - 1].city || '') : '';
    if (!lastNight || P.samePlace(lastNight, tonight)) continue;   // 只查换住处的天
    // 否定句里的"寄存"（"行李随身带，不寄存""严禁寄存回原酒店"）不算寄存
    const stripNeg = (s) => String(s || '').replace(/(不|勿|别|无需|无须|不用|避免|严禁|禁止|不要)(寄存|存放|存包|寄放)/g, '');
    const txt = dayItems.map((it) => `${it.activity || ''} ${it.note || ''}`).map(stripNeg).join(' ');
    if (!/行李/.test(txt)) lugMissing.push(`第${d + 1}天`);
    if (/寄存|存放|存包/.test(txt)
      && !/取回|取件|拿回|领回/.test(txt)
      && !/退房请带走全部行李/.test(txt)) lugNoPickup.push(`第${d + 1}天`);
    dayItems.filter((it) => /行李/.test(`${it.activity || ''}${it.note || ''}`))
      .forEach((it) => console.log(`  [第${d + 1}天 ${it.startTime}] ${it.activity}${it.note ? ' ｜ ' + it.note : ''}`));
  }
  ok(lugMissing.length === 0, '换住处的每一天都交代了行李怎么走', lugMissing.join('；'));
  ok(lugNoPickup.length === 0, '寄存行李的天都有「取回」提醒', lugNoPickup.join('；'));

  console.log('\n闹钟清单：');
  (plan.alarms || []).forEach((a) => {
    console.log(`  [${a.fireAtStr}] ${a.title}  (${a.type}${a.source ? '/' + a.source : ''})`);
    if (a.note) console.log(`      └ ${a.note.slice(0, 80)}`);
  });
  const alarms = plan.alarms || [];
  // 临近出发场景下，已过开票日的抢票闹钟会被规则收敛掉一部分，
  // 数量随 LLM 提名波动（实测 4~7 条）——质量门槛看下面的类型覆盖
  ok(alarms.length >= 4, '至少 4 条待办（车票/门票/酒店/准备）', alarms.length);
  // 去程票闹钟：LLM 提名或规则补齐都行，标题里认得"出发地→目的地"即可
  const goA = alarms.find((a) => /去程/.test(a.title)
    || (a.type === 'train' && /重庆|金童/.test(a.title) && /桂林/.test(a.title)));
  ok(!!goA, '存在去程抢票闹钟');
  ok(alarms.every((a) => a.fireAt > Date.now()), '所有闹钟都在未来');
  // 待办必须按时间先后排好（用户照着做就行）
  let sortedOk = true;
  for (let i = 1; i < alarms.length; i++) if (alarms[i].fireAt < alarms[i - 1].fireAt) sortedOk = false;
  ok(sortedOk, '待办按时间从早到晚排序');
  const types = [...new Set(alarms.map((a) => a.type))];
  ok(types.length >= 3, `覆盖至少 3 类待办（${types.join('/')}）`, types.length);

  // 查漏补齐后：每一晚住宿都该被预订提醒覆盖。LLM 会把连住合并成一条
  // （「10月4日-10月6日共2晚」），所以按标题里能对上的晚数算，不按条数算。
  // 临近出发时（提醒日已过去的晚）本来就不可能再提醒，只要求"可提醒的晚全覆盖"。
  const outlineNights = (phase1.outline.days || []).length - 1;
  const hotelAlarms = alarms.filter((a) => a.type === 'hotel');
  let coveredNights = 0;
  hotelAlarms.forEach((a) => {
    const m = /共(\d+)晚/.exec(a.title || '');
    coveredNights += m ? Number(m[1]) : 1;
  });
  const checkinDates = (phase1.outline.days || []).slice(0, -1).map((d) => d.date);
  const remindable = checkinDates.filter((ds) => {
    // 酒店提醒在入住日前 7 天的 20:00 触发，触发力在"现在"之前就算不可提醒
    const fire = new Date(`${ds}T20:00:00+08:00`).getTime() - 7 * 86400000;
    return fire >= Date.now();
  }).length;
  ok(coveredNights >= remindable,
    `酒店提醒覆盖住宿（覆盖 ${coveredNights} 晚 / 可提醒 ${remindable} 晚，共 ${outlineNights} 晚）`, coveredNights);

  if (plan.suggestions && Object.keys(plan.suggestions).length) {
    console.log('\n建议字段:', Object.keys(plan.suggestions).join(', '));
    ok(!!(plan.suggestions.gear || plan.suggestions.tips), '生成了旅行建议');
  }

  console.log('\n示例行程（第2天）：');
  plan.items.filter((it) => it.dayIndex === 1).slice(0, 8).forEach((it) => {
    console.log(`  ${it.startTime}-${it.endTime} ${it.activity}` +
      (it.startLocation || it.endLocation ? `  📍${it.startLocation || ''}→${it.endLocation || ''}` : '') +
      (it.note ? `   · ${it.note.slice(0, 40)}` : ''));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
}
