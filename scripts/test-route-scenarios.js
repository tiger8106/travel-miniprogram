// Real generation regression run for the two routes requested by the product owner.
// Usage: node scripts/test-route-scenarios.js [--route 1|2]
// Requires the local .env.local but never prints its contents.

const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env.local');
const replayPath = process.argv.includes('--replay')
  ? process.argv[process.argv.indexOf('--replay') + 1] : '';
const liveReview = process.argv.includes('--live-review');
const offline = process.argv.includes('--offline') || (!!replayPath && !liveReview);
if (!offline && !fs.existsSync(envPath)) {
  console.error('缺少 .env.local（需配置 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL；AMAP_KEY 用于酒店名称核验）');
  process.exit(1);
}
if (!offline && fs.existsSync(envPath)) fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
  const value = line.trim();
  if (!value || value.startsWith('#')) return;
  const match = value.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (!match) return;
  let parsed = match[2].trim();
  if ((parsed.startsWith('"') && parsed.endsWith('"')) || (parsed.startsWith("'") && parsed.endsWith("'"))) {
    parsed = parsed.slice(1, -1);
  }
  process.env[match[1]] = parsed;
});

const P = require('../cloudfunctions/generatePlan/plan');
const { searchHotelPoi, searchHotelsNearby } = require('../cloudfunctions/generatePlan/geocode');
const { validateOutlineHotels } = require('../cloudfunctions/generatePlan/hotel-validation');
const { lookupSchedules, canLookupSchedules } = require('../cloudfunctions/generatePlan/schedule');
const { executionIssues, reviewExecutionItems, normalizeReviewRows, sameEndpoint } = require('../cloudfunctions/generatePlan/execution-review');

const scenarios = [
  {
    name: '桂林—阳朔—龙脊—明仕—德天',
    input: {
      origin: '重庆金童路',
      dest: '桂林、阳朔、龙脊梯田、明仕田园、德天瀑布',
      startDate: '2026-09-30', endDate: '2026-10-07',
      startTime: '12:00', endTime: '16:00',
      party: '情侣出行', people: 2,
      budget: '经济实惠', pace: '劳逸适中',
      interests: ['自然山水', '当地美食', '拍照打卡'],
      transport: '高铁/动车优先',
      extra: '景点间有高铁/动车尽量坐高铁动车；没有高铁/动车时优先旅游专线或大巴；这些方式没有或不方便时再打车。不要安排用户本人开车。',
    },
    inspectLongji: true,
  },
  {
    name: '成都—都江堰—青城山—毕棚沟',
    input: {
      origin: '重庆市金童路',
      dest: '成都市、都江堰、青城山、毕棚沟',
      startDate: '2026-12-31', endDate: '2027-01-03',
      startTime: '17:00', endTime: '17:00',
      party: '情侣出行', people: 2,
      budget: '经济实惠', pace: '劳逸适中',
      interests: ['自然山水', '当地美食', '拍照打卡'],
      transport: '高铁/动车优先',
      extra: '跨城优先高铁/动车；当地优先公共交通、景区直通车或旅游大巴；公共交通明显不便时可以打车或选择有司机的包车，全程不要安排用户本人开车。毕棚沟冬季留足路途和游览时间，确认返程交通后再安排当天活动。',
    },
  },
];

function offlineDay(date, city, overnight, highlights, moves) {
  return {
    date, city, theme: `${city}路线`, overnight, hotel: '',
    highlights, meals: [], moves, note: '',
  };
}

function offlineMove(from, to, mode, startTime, endTime) {
  return { from, to, mode, code: '', startTime, endTime };
}

function offlineItem(dayIndex, startTime, endTime, category, activity, startLocation, endLocation, transportType) {
  return {
    dayIndex, startTime, endTime, category, activity,
    startLocation: startLocation || '', endLocation: endLocation || '',
    transportType: transportType || '', note: '',
  };
}

/**
 * 离线回归夹具：不调用 LLM/高德，只把两条真实需求路线送进同一套
 * 大纲交通对齐、时间线审计、酒店 POI 归一化和闹钟规则。这样即使网络
 * 暂时不可用，也能重复检查首末日、逐段交通、龙脊路线和票务过滤。
 */
function offlineFixture(scenario) {
  if (scenario.name.startsWith('桂林')) {
    const days = [
      offlineDay('2026-09-30', '桂林', '桂林', ['桂林自然山水', '桂林当地美食'], [
        offlineMove('重庆金童路', '重庆西站', 'ride', '12:00', '12:40'),
        offlineMove('重庆西站', '桂林北站', 'train', '13:30', '17:30'),
      ]),
      offlineDay('2026-10-01', '阳朔', '阳朔', ['漓江四星级游船（磨盘山码头）', '阳朔自然山水'], [
        Object.assign(offlineMove('桂林磨盘山码头', '阳朔水东门码头', 'ship', '08:30', '12:30'), { note: '四星级游船' }),
      ]),
      offlineDay('2026-10-02', '龙脊梯田', '金坑大寨', ['龙脊梯田', '西山韶乐', '千层天梯', '金佛顶日落'], [
        offlineMove('阳朔', '龙脊金坑大寨', 'bus', '08:00', '11:00'),
      ]),
      offlineDay('2026-10-03', '明仕田园', '明仕田园', ['西山韶乐日出', '明仕田园'], [
        offlineMove('西山韶乐', '明仕田园', 'bus', '08:00', '11:00'),
      ]),
      offlineDay('2026-10-04', '明仕田园→德天瀑布', '硕龙镇', ['明仕田园', '自然山水'], [
        offlineMove('明仕田园', '德天瀑布', 'bus', '11:00', '14:00'),
      ]),
      offlineDay('2026-10-05', '德天瀑布', '硕龙镇', ['德天瀑布', '当地美食'], []),
      offlineDay('2026-10-06', '南宁', '南宁', ['南宁当地美食'], [
        offlineMove('德天瀑布', '南宁', 'bus', '08:00', '11:30'),
      ]),
      offlineDay('2026-10-07', '返程', '返程', [], [
        offlineMove('南宁东站', '重庆西站', 'train', '11:30', '15:20'),
      ]),
    ];
    const items = [
      offlineItem(0, '12:00', '12:40', 'transport', '从重庆金童路乘网约车前往重庆西站', '重庆金童路', '重庆西站', 'ride'),
      offlineItem(0, '12:40', '13:30', 'other', '重庆西站安检候车', '重庆西站', '重庆西站', ''),
      offlineItem(0, '13:30', '17:30', 'transport', '乘列车从重庆西站前往桂林北站', '重庆西站', '桂林北站', 'train'),
      offlineItem(0, '17:30', '18:00', 'transport', '乘网约车前往桂林住宿地', '桂林北站', '桂林酒店', 'ride'),
      offlineItem(0, '18:00', '19:00', 'hotel', '到酒店放下行李并休息', '桂林酒店', '桂林酒店', ''),
      offlineItem(0, '19:00', '19:30', 'food', '桂林酒店附近享用晚餐', '桂林酒店', '桂林酒店', ''),
      offlineItem(0, '19:30', '20:30', 'sight', '桂林两江四湖夜景散步', '桂林酒店', '桂林两江四湖', ''),
      offlineItem(0, '20:30', '21:00', 'hotel', '返回桂林酒店休息', '桂林两江四湖', '桂林酒店', ''),
      offlineItem(1, '08:00', '08:30', 'transport', '从桂林酒店前往桂林磨盘山码头', '桂林酒店', '桂林磨盘山码头', 'ride'),
      offlineItem(1, '08:30', '12:30', 'sight', '乘坐漓江四星级游船游览精华段，从桂林磨盘山码头到阳朔水东门码头', '桂林磨盘山码头', '阳朔水东门码头', ''),
      offlineItem(1, '12:30', '13:30', 'food', '阳朔当地特色午餐', '阳朔水东门码头', '阳朔水东门码头', ''),
      offlineItem(1, '13:30', '14:00', 'hotel', '到阳朔酒店放行李', '阳朔水东门码头', '阳朔酒店', ''),
      offlineItem(2, '07:00', '08:00', 'food', '在阳朔吃早餐并收拾行李', '阳朔酒店', '阳朔酒店', ''),
      offlineItem(2, '08:00', '11:00', 'transport', '乘旅游专线或大巴从阳朔前往龙脊金坑大寨', '阳朔', '龙脊金坑大寨', 'bus'),
      offlineItem(2, '11:00', '11:30', 'hotel', '先到西山韶乐住宿点放下行李并休息', '龙脊金坑大寨', '西山韶乐', ''),
      offlineItem(2, '11:30', '12:00', 'food', '在西山韶乐休息点附近简餐', '西山韶乐', '西山韶乐', ''),
      offlineItem(2, '12:00', '13:00', 'sight', '游览西山韶乐（1号观景台）并拍照', '西山韶乐', '西山韶乐', ''),
      offlineItem(2, '13:00', '13:30', 'transport', '沿景区单向步道前往千层天梯', '西山韶乐', '千层天梯', 'walk'),
      offlineItem(2, '13:30', '15:00', 'sight', '游览龙脊梯田千层天梯（2号观景台）', '千层天梯', '千层天梯', ''),
      offlineItem(2, '15:00', '15:30', 'transport', '沿景区游览方向前往金佛顶', '千层天梯', '金佛顶', 'walk'),
      offlineItem(2, '15:30', '17:56', 'sight', '游览龙脊梯田金佛顶（3号观景台）并等候光线', '金佛顶', '金佛顶', ''),
      offlineItem(2, '17:56', '18:46', 'sight', '观赏金佛顶日落', '金佛顶', '金佛顶', ''),
      offlineItem(2, '18:46', '19:46', 'transport', '从金佛顶返回西山韶乐住宿点', '金佛顶', '西山韶乐', 'walk'),
      offlineItem(2, '19:46', '20:30', 'food', '在西山韶乐住宿点享用晚餐', '西山韶乐', '西山韶乐', ''),
      offlineItem(3, '06:00', '06:40', 'sight', '在西山韶乐观赏日出', '西山韶乐', '西山韶乐', ''),
      offlineItem(3, '06:40', '07:20', 'food', '在西山韶乐住宿点吃早餐并收拾行李', '西山韶乐', '西山韶乐', ''),
      offlineItem(3, '08:00', '11:00', 'transport', '乘旅游大巴从西山韶乐住宿片区前往明仕田园', '西山韶乐', '明仕田园', 'bus'),
      offlineItem(3, '11:00', '14:00', 'sight', '游览明仕田园山水与拍照', '明仕田园', '明仕田园', ''),
      offlineItem(3, '14:00', '15:00', 'food', '在明仕田园附近农家菜馆午餐', '明仕田园', '明仕田园', ''),
      offlineItem(3, '15:00', '15:30', 'hotel', '到明仕田园住宿地放下行李', '明仕田园', '明仕田园酒店', ''),
      offlineItem(4, '07:30', '08:00', 'food', '在明仕田园吃早餐', '明仕田园酒店', '明仕田园酒店', ''),
      offlineItem(4, '08:00', '11:00', 'sight', '游览明仕田园山水与拍照点', '明仕田园', '明仕田园', ''),
      offlineItem(4, '11:00', '14:00', 'transport', '乘旅游专线从明仕田园前往德天瀑布', '明仕田园', '德天瀑布', 'bus'),
      offlineItem(4, '14:00', '14:30', 'hotel', '到硕龙镇住宿地放下行李', '德天瀑布', '硕龙镇酒店', ''),
      offlineItem(5, '07:30', '08:00', 'transport', '从硕龙镇住宿地前往德天瀑布', '硕龙镇酒店', '德天瀑布', 'ride'),
      offlineItem(5, '08:00', '12:00', 'sight', '游览德天瀑布跨国瀑布景区并拍照', '德天瀑布', '德天瀑布', ''),
      offlineItem(5, '12:00', '13:00', 'food', '硕龙镇当地午餐', '德天瀑布', '硕龙镇', ''),
      offlineItem(5, '13:00', '13:30', 'hotel', '回硕龙镇酒店休息', '硕龙镇', '硕龙镇酒店', ''),
      offlineItem(6, '06:30', '07:00', 'food', '在硕龙镇吃早餐并收拾行李', '硕龙镇酒店', '硕龙镇酒店', ''),
      offlineItem(6, '07:00', '08:00', 'transport', '从硕龙镇住宿地前往德天瀑布集合点', '硕龙镇酒店', '德天瀑布', 'ride'),
      offlineItem(6, '08:00', '11:30', 'transport', '乘旅游大巴从德天瀑布前往南宁', '德天瀑布', '南宁', 'bus'),
      offlineItem(6, '11:30', '12:30', 'food', '南宁当地午餐', '南宁', '南宁', ''),
      offlineItem(6, '12:30', '13:00', 'hotel', '到南宁住宿地放下行李', '南宁', '南宁酒店', ''),
      offlineItem(7, '07:00', '07:30', 'transport', '从南宁住宿地前往南宁东站', '南宁酒店', '南宁东站', 'ride'),
      offlineItem(7, '07:30', '11:20', 'other', '南宁东站安检候车', '南宁东站', '南宁东站', ''),
      offlineItem(7, '11:30', '15:20', 'transport', '乘列车从南宁东站返回重庆西站', '南宁东站', '重庆西站', 'train'),
      offlineItem(7, '15:20', '16:00', 'transport', '乘网约车从重庆西站返回重庆金童路，到家休息', '重庆西站', '重庆金童路', 'ride'),
    ];
    return { title: scenario.name, summary: '离线路线回归夹具', outline: { days }, items };
  }

  const days = [
    offlineDay('2026-12-31', '成都', '成都', ['成都市区', '当地美食'], [
      offlineMove('重庆西站', '成都东站', 'train', '19:00', '21:30'),
    ]),
    offlineDay('2027-01-01', '都江堰、青城山', '都江堰', ['都江堰', '青城山'], [
      offlineMove('犀浦站', '离堆公园站', 'train', '08:00', '09:00'),
    ]),
    offlineDay('2027-01-02', '毕棚沟', '古尔沟', ['毕棚沟', '自然山水'], [
      offlineMove('都江堰', '毕棚沟游客中心', 'bus', '07:30', '12:00'),
    ]),
    offlineDay('2027-01-03', '返程', '返程', [], [
      offlineMove('古尔沟', '成都东站', 'bus', '07:00', '11:00'),
      offlineMove('成都东站', '重庆西站', 'train', '13:20', '16:20'),
    ]),
  ];
  const items = [
    offlineItem(0, '17:00', '17:40', 'transport', '从重庆市金童路乘网约车前往重庆西站', '重庆市金童路', '重庆西站', 'ride'),
    offlineItem(0, '17:40', '19:00', 'other', '重庆西站安检候车', '重庆西站', '重庆西站', ''),
    offlineItem(0, '19:00', '21:30', 'transport', '乘列车从重庆西站前往成都东站', '重庆西站', '成都东站', 'train'),
    offlineItem(0, '21:30', '22:00', 'food', '抵达成都后在酒店附近简餐', '成都东站', '成都酒店', ''),
    offlineItem(0, '22:00', '22:30', 'hotel', '到成都酒店办理入住', '成都酒店', '成都酒店', ''),
    offlineItem(0, '22:30', '23:00', 'sight', '成都春熙路夜景短线散步', '成都酒店', '成都春熙路', ''),
    offlineItem(0, '23:00', '23:20', 'hotel', '返回成都酒店休息', '成都春熙路', '成都酒店', ''),
    offlineItem(1, '06:00', '06:30', 'food', '在成都酒店吃早餐', '成都酒店', '成都酒店', ''),
    offlineItem(1, '06:30', '07:20', 'transport', '乘公共交通前往犀浦站', '成都酒店', '犀浦站', 'bus'),
    offlineItem(1, '07:20', '08:00', 'other', '进站安检候车', '犀浦站', '犀浦站', ''),
    offlineItem(1, '08:00', '09:00', 'transport', '乘动车从犀浦站前往离堆公园站', '犀浦站', '离堆公园站', 'train'),
    offlineItem(1, '09:00', '12:00', 'sight', '游览都江堰水利工程与南桥', '离堆公园站', '都江堰', ''),
    offlineItem(1, '12:00', '13:00', 'food', '都江堰当地午餐', '都江堰', '都江堰', ''),
    offlineItem(1, '13:00', '13:30', 'hotel', '到都江堰住宿地放行李', '都江堰', '都江堰酒店', ''),
    offlineItem(1, '13:30', '14:15', 'transport', '乘公交前往青城山', '都江堰酒店', '青城山', 'ride'),
    offlineItem(1, '14:15', '17:15', 'sight', '青城山前山游览，按返程时间折返，不登全山', '青城山', '青城山', ''),
    offlineItem(1, '17:15', '18:00', 'transport', '乘公交返回都江堰住宿地', '青城山', '都江堰酒店', 'ride'),
    offlineItem(2, '06:30', '07:30', 'food', '在都江堰住宿地吃早餐并退房', '都江堰酒店', '都江堰酒店', ''),
    offlineItem(2, '07:30', '12:00', 'transport', '乘旅游大巴从都江堰前往毕棚沟游客中心', '都江堰', '毕棚沟游客中心', 'bus'),
    // 固定样例也必须提供真实的行李状态链；不能靠省略“徒步”二字绕过验收。
    offlineItem(2, '12:00', '12:15', 'other', '在游客中心办理行李寄存', '毕棚沟游客中心', '毕棚沟游客中心', ''),
    offlineItem(2, '12:15', '16:00', 'sight', '冬季游览毕棚沟景区，预留雪地步行和拍照时间', '毕棚沟游客中心', '毕棚沟', ''),
    offlineItem(2, '16:00', '16:30', 'transport', '乘观光车返回游客中心，取回寄存行李', '毕棚沟', '毕棚沟游客中心', 'bus'),
    offlineItem(2, '16:30', '17:00', 'transport', '乘网约车前往古尔沟住宿地', '毕棚沟游客中心', '古尔沟酒店', 'ride'),
    offlineItem(2, '17:00', '17:30', 'hotel', '到古尔沟酒店办理入住', '古尔沟酒店', '古尔沟酒店', ''),
    offlineItem(3, '06:00', '07:00', 'food', '在古尔沟吃早餐并退房，携带全部行李出发', '古尔沟酒店', '古尔沟酒店', ''),
    offlineItem(3, '07:00', '11:00', 'transport', '乘旅游大巴从古尔沟前往成都东站', '古尔沟', '成都东站', 'bus'),
    offlineItem(3, '11:00', '13:20', 'other', '成都东站安检候车及站内午餐', '成都东站', '成都东站', ''),
    offlineItem(3, '13:20', '16:20', 'transport', '乘列车从成都东站返回重庆西站', '成都东站', '重庆西站', 'train'),
    offlineItem(3, '16:20', '17:00', 'transport', '乘网约车从重庆西站返回重庆市金童路，到家休息', '重庆西站', '重庆市金童路', 'ride'),
  ];
  return { title: scenario.name, summary: '离线路线回归夹具', outline: { days }, items };
}

const toMinutes = P.toMin;
const fmt = (item) => `${item.startTime || '--:--'}-${item.endTime || '--:--'} ${item.category || ''}`
  + `${item.startLocation || item.endLocation ? ` [${item.startLocation || '—'}→${item.endLocation || '—'}]` : ''} ${item.activity || ''}`;

function inspectScenario(scenario, outline, items) {
  const issues = [];
  const profile = P.normalizeInput(scenario.input);
  const dates = new Set((outline.days || []).map((day) => day.date).filter(Boolean));
  if (dates.size !== profile.days) issues.push(`大纲日期不完整：${dates.size}/${profile.days}`);
  const premature = P.prematureOriginDays(profile, outline);
  if (premature.length) issues.push(`中途提前回到出发地：第 ${premature.map((i) => i + 1).join('、')} 天`);
  const missing = P.missingMustVisit(profile, outline);
  if (missing.length) issues.push(`大纲漏掉目的地：${missing.join('、')}`);
  profile.mustVisit.forEach((place) => {
    const stem = P.placeStem(place);
    const visited = items.some((item) => item.category === 'sight'
      && !/候车|进站|安检/.test(item.activity || '')
      && toMinutes(item.endTime) - toMinutes(item.startTime) >= 30
      && (`${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`.includes(stem)
        || P.placeStem(item.visitScope || '') === stem
        || P.placeStem(item.city || '') === stem
        || (place.endsWith('市') && `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`.includes(place.slice(0, -1)))));
    if (!visited) issues.push(`详细行程没有实际游览目的地：${place}`);
  });
  const misplacedHotels = (outline.days || []).filter((day) => day.hotel
    && !(day.hotelPoiVerified === true && day.hotelPoiVerifiedName === day.hotel && day.hotelPoiAddress)
    && !P.locationFitsScope(day.hotel, day.overnight || day.city, day.hotelPoiAddress));
  if (misplacedHotels.length) issues.push(`${misplacedHotels.length} 家酒店与当晚住宿片区不匹配：${misplacedHotels.map((day) => day.hotel).join('、')}`);
  const missingHotels = (outline.days || []).slice(0, -1).filter((day) => day.overnight && !day.hotel);
  if (missingHotels.length) issues.push(`${missingHotels.length} 个住宿夜没有酒店名称或可搜索片区：${missingHotels.map((day) => day.overnight).join('、')}`);

  const untimed = items.filter((item) => toMinutes(item.startTime) == null || toMinutes(item.endTime) == null);
  if (untimed.length) issues.push(`${untimed.length} 条行程缺少起止时间`);
  items.forEach((item) => {
    if (toMinutes(item.endTime) <= toMinutes(item.startTime)) issues.push(`非正时长条目：${fmt(item)}`);
    if (item.schedSource !== '12306') return;
    const day = (outline.days || [])[Number(item.dayIndex || 0)] || {};
    const matches = (day.moves || []).flatMap((move) => move.sched || []).some((schedule) =>
      String(item.startLocation || '').replace(/站$/, '') === String(schedule.from || '').replace(/站$/, '')
      && String(item.endLocation || '').replace(/站$/, '') === String(schedule.to || '').replace(/站$/, '')
      && item.startTime === schedule.s && item.endTime === schedule.e
      && String(item.activity || '').includes(schedule.code));
    if (!matches) issues.push(`已核验铁路条目的路线/时刻被改坏：${fmt(item)}`);
  });
  const noSelfDrive = items.filter((item) => /自驾|开车|驾车|驾驶|驱车|骑(?:行)?(?:电动摩托车|摩托车)|租(?:赁|用|车)?(?:电动摩托车|摩托车)/
    .test(`${item.activity || ''} ${item.note || ''}`));
  if (noSelfDrive.length) {
    issues.push(`${noSelfDrive.length} 条行程出现未授权的本人驾驶文案`);
    noSelfDrive.forEach((item) => console.error(`  驾驶文案条目：第${Number(item.dayIndex || 0) + 1}天 ${fmt(item)}`));
  }
  const unverifiedRail = items.filter((item) => item.category === 'transport'
    && item.schedSource === 'official-unavailable'
    && (!/待确认|待核验/.test(`${item.activity || ''} ${item.note || ''}`)
      || P.transportCodeOf(item)));
  if (unverifiedRail.length) {
    issues.push(`${unverifiedRail.length} 条未核验铁路段仍有具体车次或没有标明待确认`);
  }
  const homeScenicTransfers = items.filter((item) => /景区接驳/.test(`${item.activity || ''} ${item.note || ''}`)
    && (/重庆西站|重庆北站/.test(`${item.startLocation || ''} ${item.activity || ''}`)
      || P.samePlace(item.endLocation, scenario.input.origin)));
  if (homeScenicTransfers.length) issues.push('重庆西站返回金童路被错误写成景区接驳');
  if (/高铁|动车/.test(profile.transport)) {
    const outlineFlights = (outline.days || []).flatMap((day) => day.moves || [])
      .filter((move) => /plane|航班|飞机/i.test(String(move.mode || '')));
    const detailFlights = items.filter((item) => item.category === 'transport'
      && (/plane/i.test(String(item.transportType || '')) || /乘坐.{0,12}(?:航班|飞机)|登机准备/.test(String(item.activity || ''))));
    if (outlineFlights.length || detailFlights.length) {
      issues.push(`高铁/动车优先路线仍包含 ${outlineFlights.length + detailFlights.length} 段航班安排`);
    }
  }
  const routeRoot = (value) => String(value || '').replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(?:中国|省|市|县|区|镇|乡|村|站|客运站|客运中心|火车站|高铁站|景区|游客中心|停车场)/g, '')
    .match(/[\u4e00-\u9fa5]{2}/)?.[0] || '';
  const routeMatches = (expected, actual) => !!expected && !!actual
    && (P.samePlace(expected, actual) || P.sameTravelArea(expected, actual)
      || String(expected).includes(actual) || String(actual).includes(expected)
      || P.placeStem(expected).includes(P.placeStem(actual))
      || P.placeStem(actual).includes(P.placeStem(expected))
      || (!!routeRoot(expected) && routeRoot(expected) === routeRoot(actual)));
  const routeTextMatches = (expected, item) => {
    const text = `${item.activity || ''} ${item.note || ''}`;
    const stem = P.placeStem(expected);
    const root = routeRoot(expected);
    return !!text && ((stem && text.includes(stem)) || (root && text.includes(root)));
  };
  const moveCoveredByConnectionChain = (move, rows) => {
    const transfers = rows.filter((item) => item.category === 'transport'
      && item.startLocation && item.endLocation)
      .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
    const queue = transfers.filter((item) => routeMatches(move.from, item.startLocation))
      .map((item) => ({ item, hops: 1, visited: new Set([item]) }));
    while (queue.length) {
      const current = queue.shift();
      if (current.hops > 1 && routeMatches(move.to, current.item.endLocation)) return true;
      const currentEnd = toMinutes(current.item.endTime);
      transfers.forEach((next) => {
        if (current.visited.has(next) || !routeMatches(current.item.endLocation, next.startLocation)) return;
        const nextStart = toMinutes(next.startTime);
        if (currentEnd !== null && nextStart !== null && nextStart < currentEnd) return;
        const visited = new Set(current.visited);
        visited.add(next);
        queue.push({ item: next, hops: current.hops + 1, visited });
      });
    }
    return false;
  };

  // 行李提示必须有事实依据：仅写“取回在某地寄存的行李”并不等于之前真的
  // 存过。跨日检查当前日和前一日，覆盖“前一晚酒店寄存、次日取回”的合法例外，
  // 同时拦住最后一天/换城日凭空出现的回头取件安排。
  const hasRealStorage = (item) => {
    const text = `${item && item.activity || ''} ${item && item.note || ''}`;
    const negative = /(?:不|无|无需|不用|禁止|避免|严禁)[^。；;，,]{0,12}(?:寄存|暂存|存放|存包|寄放)/.test(text);
    const pickupOnly = /(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,60}(?:寄存|暂存|存放|寄放|存包)/.test(text)
      && !/(?:寄存|暂存|存放|寄放|存包)[^。；,，;]{0,60}(?:取回|取出|取件|拿回|领回)/.test(text);
    return /行李|箱子|大件/.test(text) && !negative && !pickupOnly
      && /寄存|暂存|存放|存包|寄放/.test(text);
  };
  items.forEach((item) => {
    const text = `${item && item.activity || ''} ${item && item.note || ''}`;
    if (!/(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,80}(?:行李|箱子|大件)/.test(text)) return;
    const di = Number(item.dayIndex || 0);
    const hasNearbyStorage = items.some((candidate) => {
      const candidateDay = Number(candidate.dayIndex || 0);
      return Math.abs(candidateDay - di) <= 1 && hasRealStorage(candidate);
    });
    if (!hasNearbyStorage) issues.push(`第${di + 1}天出现没有寄存依据的取件安排：${fmt(item)}`);
  });

  const dayReports = (outline.days || []).map((day, dayIndex) => {
    const rows = items.filter((item) => Number(item.dayIndex || 0) === dayIndex);
    executionIssues(rows, {
      isFirst: dayIndex === 0, isLast: dayIndex === outline.days.length - 1,
      origin: scenario.input.origin, goTime: scenario.input.startTime, backTime: scenario.input.endTime,
      noDrive: true,
      preferRail: /高铁|动车/.test(profile.transport), date: day.date, points: day.executionPoints || {},
      hotel: day.hotel, overnight: day.overnight,
      previousHotel: (outline.days[dayIndex - 1] || {}).hotel,
      previousMeals: (outline.days[dayIndex - 1] || {}).executionMealNames || [], knownMeals: day.meals || [], repeatMeals: profile.extra,
      visitWindows: (day.executionEvidence || {}).visitWindows || [],
      sailingWindows: (day.executionEvidence || {}).sailingWindows || [],
      sameHotel: !!day.hotel && sameEndpoint(day.hotel, (outline.days[dayIndex - 1] || {}).hotel),
      lightLuggage: P.explicitCarryLuggagePreference(profile),
      routeFacts: ((day.executionEvidence || {}).routeFacts || []).filter((fact) =>
        [...(day.executionNetworkFacts || []), ...(day.executionRoadFacts || [])].every((proof) =>
          !sameEndpoint(proof.from, fact.from) || !sameEndpoint(proof.to, fact.to) || proof.mode !== fact.mode))
        .concat(day.executionNetworkFacts || [], day.executionRoadFacts || []),
      official: (day.moves || []).filter((move) => move.schedSource === '12306').map((move) => ({
        startLocation: move.from, endLocation: move.to, startTime: move.startTime, endTime: move.endTime, code: move.code,
      })),
    }).forEach((issue) => issues.push(`第${dayIndex + 1}天执行问题：${issue}`));
    const outlineMoves = (day.moves || []).filter((move) => move && move.from && move.to);
    for (let moveIndex = 1; moveIndex < outlineMoves.length; moveIndex++) {
      const previousMove = outlineMoves[moveIndex - 1];
      const currentMove = outlineMoves[moveIndex];
      const hasDetailBridge = rows.some((item) => routeMatches(previousMove.to, item.startLocation)
        && routeMatches(currentMove.from, item.endLocation)
        && toMinutes(item.startTime) >= toMinutes(previousMove.endTime)
        && toMinutes(item.endTime) <= toMinutes(currentMove.startTime));
      // 游览/吃饭/步行可以构成真实接驳链，不能只认一条直达 transport。
      const between = rows.filter((item) => item.startLocation && item.endLocation
        && toMinutes(item.startTime) >= toMinutes(previousMove.endTime)
        && toMinutes(item.endTime) <= toMinutes(currentMove.startTime));
      const reached = [previousMove.to];
      between.forEach((item) => {
        if (reached.some((point) => routeMatches(point, item.startLocation))) reached.push(item.endLocation);
      });
      const hasChain = reached.some((point) => routeMatches(point, currentMove.from));
      if (!routeMatches(previousMove.to, currentMove.from) && !hasDetailBridge && !hasChain) {
        issues.push(`第${dayIndex + 1}天大纲交通段不连续：${previousMove.to}→${currentMove.from} 之间缺少接驳`);
      }
      const previousEnd = toMinutes(previousMove.endTime);
      const currentStart = toMinutes(currentMove.startTime);
      if (previousEnd !== null && currentStart !== null && currentStart < previousEnd) {
        issues.push(`第${dayIndex + 1}天大纲交通时段重叠：${previousMove.from}→${previousMove.to} / ${currentMove.from}→${currentMove.to}`);
      }
    }
    const sequenceRows = rows.map((item) => Object.assign({}, item));
    if (P.removeCheckoutBacktracks(sequenceRows).length < sequenceRows.length) {
      issues.push(`第${dayIndex + 1}天仍有退房前短途折返`);
    }
    // 同方向重复在 executionIssues 中按真实终点状态检测。旧的宽泛
    // 地名包含匹配会把景区合法去程/返程误认为冗余并删掉去程。
    if (P.removeOrphanStationWaitingItems(sequenceRows, outline).length < sequenceRows.length) {
      issues.push(`第${dayIndex + 1}天仍有无对应班次的候车说明`);
    }
    const zeroDistance = rows.filter((item) => item.category === 'transport'
      && item.startLocation && item.endLocation
      && P.samePlace(item.startLocation, item.endLocation)
      && !/环线|环游|绕行|往返|环岛|环湖|环山|游览车|观光车|接驳循环/.test(String(item.activity || '')));
    if (zeroDistance.length) {
      issues.push(`第${dayIndex + 1}天仍有起终点相同的无效交通：${zeroDistance.map(fmt).join('；')}`);
    }
    const invalidHotelSelfLoops = rows.filter((item) => item.category === 'hotel'
      && item.startLocation && item.endLocation
      && P.samePlace(item.startLocation, item.endLocation)
      && !/酒店|民宿|客栈|宾馆|青旅|住宿|房间|前台/.test(`${item.startLocation} ${item.endLocation}`)
      && /退房|携带(?:全部)?(?:大件)?行李/.test(String(item.activity || '')));
    if (invalidHotelSelfLoops.length) {
      issues.push(`第${dayIndex + 1}天仍有非住宿地点的酒店自环退房：${invalidHotelSelfLoops.map(fmt).join('；')}`);
    }
    const starts = rows.map((item) => toMinutes(item.startTime));
    if (starts.some((value, i) => i && value < starts[i - 1])) issues.push(`第${dayIndex + 1}天条目仍未按时间排序`);
    for (let i = 1; i < rows.length; i++) {
      const prevEnd = toMinutes(rows[i - 1].endTime);
      const currentStart = toMinutes(rows[i].startTime);
      if (prevEnd != null && currentStart != null && currentStart < prevEnd) {
        issues.push(`第${dayIndex + 1}天时段重叠：${rows[i - 1].activity} / ${rows[i].activity}`);
      }
    }
    const orderedMoves = [];
    const usedRows = new Set();
    (day.moves || []).filter((move) => move && move.from && move.to).forEach((move) => {
      const row = rows.find((item) => !usedRows.has(item)
        && routeMatches(move.from, item.startLocation) && routeMatches(move.to, item.endLocation));
      if (row) { usedRows.add(row); orderedMoves.push({ move, row }); }
    });
    for (let i = 1; i < orderedMoves.length; i++) {
      const previous = orderedMoves[i - 1].row;
      const current = orderedMoves[i].row;
      const previousEnd = toMinutes(previous.endTime);
      const currentStart = toMinutes(current.startTime);
      if (previousEnd !== null && currentStart !== null && currentStart < previousEnd) {
        issues.push(`第${dayIndex + 1}天大纲交通顺序与详细时间线冲突：${orderedMoves[i - 1].move.from}→${orderedMoves[i - 1].move.to} / ${orderedMoves[i].move.from}→${orderedMoves[i].move.to}`);
      }
    }
    return {
      date: day.date || scenario.input.startDate,
      city: day.city || '',
      overnight: day.overnight || '',
      hotel: day.hotel || '',
      count: rows.length,
      moves: (day.moves || []).filter((move) => move && move.from && move.to)
        .map((move) => `${move.from}→${move.to}${move.mode ? ` (${move.mode})` : ''}`),
      rows: rows.map(fmt),
    };
  });
  if (P.dedupeDuplicateHotelItems(items.map((item) => Object.assign({}, item))).length < items.length) {
    issues.push('行程仍有同日重复的酒店入住/收尾条目');
  }

  // 逐段核对大纲里所有明确的移动，而不只检查首末日：跨城巴士或包车如果
  // 在大纲有写、细化却漏掉，会造成“到站后直接游玩/入住”的不可执行空档。
  (outline.days || []).forEach((day, dayIndex) => {
    const rows = items.filter((item) => Number(item.dayIndex || 0) === dayIndex);
    (day.moves || []).filter((move) => move && move.from && move.to).forEach((move) => {
      const represented = rows.some((item) => routeMatches(move.from, item.startLocation)
        && routeMatches(move.to, item.endLocation))
        || rows.some((item) => item.category === 'transport'
          && routeTextMatches(move.from, item) && routeMatches(move.to, item.endLocation))
        || moveCoveredByConnectionChain(move, rows);
      if (!represented) issues.push(`第${dayIndex + 1}天详细计划漏掉大纲交通段 ${move.from}→${move.to}（${move.mode || '交通'}）`);
    });
  });

  const firstDay = items.filter((item) => Number(item.dayIndex || 0) === 0);
  const firstTransfer = firstDay.find((item) => item.category === 'transport'
    && String(item.startLocation || '').includes('金童路'));
  if (!firstTransfer) issues.push('首日缺少从金童路出发的接驳');
  else if (scenario.input.startTime && firstTransfer.startTime !== scenario.input.startTime) {
    issues.push(`首日出发接驳应为 ${scenario.input.startTime}，实际 ${firstTransfer.startTime}`);
  }
  const lastDayIndex = (outline.days || []).length - 1;
  const lastDay = items.filter((item) => Number(item.dayIndex || 0) === lastDayIndex);
  // 末日寄存本身合法；上面的通用执行审计已检查是否在原地点取回。
  // 不能把“取回寄存行李”也识别成新的存包，并一概拒绝末日寄存。
  const finalOutline = (outline.days || [])[lastDayIndex] || {};
  const finalMoves = (finalOutline.moves || []).filter((move) => move && move.from && move.to);
  const returnMove = finalMoves.slice().reverse().find((move) =>
    routeMatches(scenario.input.origin, move.to) && !routeMatches(scenario.input.origin, move.from));
  if (!returnMove) issues.push('大纲末日缺少从最后目的地区域返回出发城市的城际交通段');
  else if (!lastDay.some((item) => item.category === 'transport'
    && routeMatches(returnMove.from, item.startLocation)
    && routeMatches(returnMove.to, item.endLocation))) {
    issues.push(`末日详细行程没有落实大纲返程段 ${returnMove.from}→${returnMove.to}；末日交通：${lastDay.filter((item) => item.category === 'transport').map(fmt).join('；') || '无'}`);
  }
  const hasOutboundRail = (outline.days || []).slice(0, lastDayIndex).some((day) =>
    (day.moves || []).some((move) => routeMatches(scenario.input.origin, move.from)
      && /train|高铁|动车|火车/i.test(String(move.mode || ''))));
  if (/高铁|动车/.test(profile.transport) && hasOutboundRail && returnMove
      && !/train|高铁|动车|火车/i.test(String(returnMove.mode || ''))) {
    issues.push(`已存在去程铁路走廊，返程仍未优先使用铁路：${returnMove.from}→${returnMove.to}（${returnMove.mode || '未注明'}）`);
  }
  const reachesOrigin = lastDay.some((item) => P.samePlace(item.endLocation, scenario.input.origin)
    || String(item.activity || '').includes(scenario.input.origin)
    || String(item.activity || '').includes('回家') || String(item.activity || '').includes('到家'));
  if (!reachesOrigin) issues.push('末日缺少回到出发地/到家的安排');
  const latestEnd = lastDay.map((item) => toMinutes(item.endTime)).filter((value) => value != null)
    .sort((a, b) => b - a)[0];
  const requestedArrival = toMinutes(scenario.input.endTime);
  if (requestedArrival != null && latestEnd !== requestedArrival) {
    issues.push(`末日最后安排应对齐到家时刻 ${scenario.input.endTime}，实际 ${latestEnd == null ? '无时间' : `${String(Math.floor(latestEnd / 60)).padStart(2, '0')}:${String(latestEnd % 60).padStart(2, '0')}`}`);
  }

  // 返程大交通前的活动必须留出进站/安检时间，不能把景点寄存塞在发车前
  // 十几分钟的缝里；这类错误会让“最后一天”看起来有安排，实际却赶不上车。
  const finalIntercity = lastDay.slice().reverse().find((item) => item.category === 'transport'
    && /train|plane|ship|高铁|动车|火车|航班|飞机|游船|大巴|班车|直通车/i
      .test(`${item.transportType || ''} ${item.activity || ''}`));
  if (finalIntercity && toMinutes(finalIntercity.startTime) !== null) {
    const buffer = /plane|航班|飞机/i.test(`${finalIntercity.transportType || ''} ${finalIntercity.activity || ''}`) ? 120 : 45;
    const cutoff = toMinutes(finalIntercity.startTime) - buffer;
    const rushed = lastDay.filter((item) => ['sight', 'other'].includes(String(item.category || ''))
      && !(item.category === 'other' && item.startLocation && item.endLocation
        && P.samePlace(item.startLocation, item.endLocation))
      && toMinutes(item.endTime) !== null && toMinutes(item.endTime) > cutoff
      && toMinutes(item.startTime) < toMinutes(finalIntercity.startTime)
      && !(item.category === 'other' && /候车|安检|检票|进站/.test(item.activity || '')));
    if (rushed.length) issues.push(`末日返程前仍有来不及完成的活动：${rushed.map(fmt).join('；')}`);
  }

  if (scenario.inspectLongji) {
    const longjiDay = (outline.days || []).findIndex((day) => /龙脊/.test(`${day.city || ''} ${day.theme || ''} ${(day.highlights || []).join(' ')}`));
    if (longjiDay < 0) issues.push('没有明确标出龙脊梯田所在日，无法复核景区路线');
    else {
      const longjiRowsByDay = new Map();
      items.filter((item) => Number(item.dayIndex || 0) >= longjiDay).forEach((item) => {
        const day = Number(item.dayIndex || 0);
        if (!longjiRowsByDay.has(day)) longjiRowsByDay.set(day, []);
        longjiRowsByDay.get(day).push(item);
      });
      const visitsGolden = (item) => item.category === 'sight'
        && /金佛顶/.test(String(item.activity || ''))
        && !/(不绕行|不去|不安排|不前往|不考虑|勿前往|不登|岔路口.*不|明天|次日|后一天|储备精力)/.test(String(item.activity || ''));
      // “西山韶乐→千层天梯”是合理路线说明，但不能把“前往千层天梯”
      // 当成已经完成千层天梯游览；必须以独立的实际游览条目判断顺序。
      const visitsLadder = (item) => /千层天梯|2号天梯/.test(String(item.activity || ''))
        && !/金佛顶|3号观景台/.test(String(item.activity || ''))
        && (!/西山韶乐/.test(item.activity || '') || (/千层天梯/.test(item.endLocation || '')
          && toMinutes(item.endTime) - toMinutes(item.startTime) >= 90));
      for (const rows of longjiRowsByDay.values()) {
        const core = rows.filter((item) => item.category === 'sight'
          && (/千层天梯|2号天梯/.test(String(item.activity || '')) || visitsGolden(item)))
          .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
        const westRows = rows.filter((item) => item.category === 'sight'
          && /西山韶乐/.test(String(item.activity || '')))
          .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
        const hasLadder = core.some(visitsLadder);
        const hasGolden = core.some(visitsGolden);
        const goldenRows = rows.filter(visitsGolden);
        const goldenFold = goldenRows.length > 1 && goldenRows.some((item, i) => i && rows.some((between) =>
          toMinutes(between.startTime) >= toMinutes(goldenRows[i - 1].endTime)
          && toMinutes(between.endTime) <= toMinutes(item.startTime)
          && between.category === 'transport' && !/金佛顶/.test(between.endLocation || '')));
        if (goldenFold) {
          issues.push('龙脊同一天重复安排金佛顶，应合并为一段连续游览/日落');
          break;
        }
        const hasMiddleWest = hasLadder && hasGolden && westRows.some((west) => {
          const start = toMinutes(west.startTime);
          return start != null
            && core.some((point) => (toMinutes(point.startTime) ?? 1440) < start)
            && core.some((point) => (toMinutes(point.startTime) ?? 1440) > start);
        });
        if (hasMiddleWest) {
          issues.push('龙脊核心路线之间仍有中途返回西山韶乐的折返');
          break;
        }
      }
      const sameDayCore = [...longjiRowsByDay.entries()].find(([, rows]) => {
        const visits = rows.filter((item) => item.category === 'sight');
        // 住宿处先放行李是用户明确认可的起点，不要求再造一条重复观景活动。
        const westDrop = rows.some((item) => /西山韶乐/.test(`${item.startLocation} ${item.endLocation}`)
          && /入住|放置行李|放下.*行李/.test(item.activity || '')
          && visits.every((visit) => toMinutes(visit.startTime) >= toMinutes(item.endTime)));
        return (visits.some((item) => /西山韶乐/.test(String(item.activity || ''))) || westDrop)
          && visits.some(visitsLadder)
          && visits.some(visitsGolden);
      });
      if (!sameDayCore) {
        issues.push('时间允许时龙脊未将西山韶乐、千层天梯、金佛顶安排在同一天');
      } else {
        const orderedCore = sameDayCore[1].filter((item) => item.category === 'sight'
          && (/西山韶乐|千层天梯|2号天梯|金佛顶/.test(String(item.activity || ''))))
          .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
        let westAt = orderedCore.findIndex((item) => /西山韶乐/.test(String(item.activity || '')));
        if (westAt < 0 && sameDayCore[1].some((item) => /西山韶乐/.test(`${item.startLocation} ${item.endLocation}`)
          && /入住|放置行李|放下.*行李/.test(item.activity || ''))) westAt = 0;
        const ladderAt = orderedCore.findIndex(visitsLadder);
        const goldenAt = orderedCore.findIndex(visitsGolden);
        if (!(westAt >= 0 && ladderAt >= westAt && goldenAt > ladderAt)) {
          issues.push('龙脊核心路线顺序应为西山韶乐→千层天梯→金佛顶');
        }
      }
      const longjiRows = longjiRowsByDay.get(longjiDay) || [];
      const scenicCore = longjiRows.filter((item) => item.category === 'sight'
        && /千层天梯|2号天梯|2号索道|西山韶乐|金佛顶/.test(item.activity || ''))
        .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
      const coreStart = scenicCore.length ? toMinutes(scenicCore[0].startTime) : null;
      const coreEnd = scenicCore.length ? toMinutes(scenicCore[scenicCore.length - 1].endTime) : null;
      const declaredMinutes = scenicCore.reduce((total, item) => {
        const s = toMinutes(item.startTime), e = toMinutes(item.endTime);
        return total + (s !== null && e !== null && e > s ? e - s : 0);
      }, 0);
      if (scenicCore.length >= 2 && coreStart !== null && coreEnd !== null
          && coreEnd - coreStart < declaredMinutes) {
        issues.push('龙脊核心景点的游览时段发生重叠，需调整顺序或删减点位');
      }

      const stayDay = (outline.days || [])[longjiDay] || {};
      const arrivalEnd = (stayDay.moves || [])
        .filter((move) => /龙脊|金坑大寨|田头寨/.test(String(move.to || '')) && toMinutes(move.endTime) !== null)
        .map((move) => toMinutes(move.endTime))
        .sort((a, b) => b - a)[0];
      if (arrivalEnd === undefined || arrivalEnd <= 17 * 60 + 30) {
        const sunsetRows = items.filter((item) => Number(item.dayIndex || 0) === longjiDay
          && item.category === 'sight'
          && /金佛顶/.test(`${item.activity || ''} ${item.note || ''}`)
          && /日落/.test(String(item.activity || '')));
        if (!sunsetRows.length) issues.push('龙脊抵达时间允许时，详细时间线缺少金佛顶日落');
        const sunsetAt = P.longjiSolarMinute((stayDay || {}).date, true);
        const sunsetStart = sunsetRows.map((item) => toMinutes(item.startTime)).filter((x) => x != null)
          .sort((a, b) => a - b)[0];
        if (sunsetAt !== null && sunsetStart !== undefined && Math.abs(sunsetStart - (sunsetAt - 30)) > 35) {
          issues.push(`龙脊金佛顶日落未贴合当地太阳时刻：应约 ${String(Math.floor((sunsetAt - 30) / 60)).padStart(2, '0')}:${String((sunsetAt - 30) % 60).padStart(2, '0')}，实际 ${String(Math.floor(sunsetStart / 60)).padStart(2, '0')}:${String(sunsetStart % 60).padStart(2, '0')}`);
        }
      }
      const nextDay = (outline.days || [])[longjiDay + 1] || {};
      const nextDayText = `${nextDay.city || ''} ${nextDay.theme || ''} ${nextDay.note || ''} ${(nextDay.highlights || []).join(' ')} ${(nextDay.moves || []).map((move) => `${move.from || ''} ${move.to || ''}`).join(' ')}`;
      const nextDeparture = (nextDay.moves || [])
        .filter((move) => /龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.from || ''))
          && !/龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.to || ''))
          && toMinutes(move.startTime) !== null)
        .map((move) => toMinutes(move.startTime))
        .sort((a, b) => a - b)[0];
      if (longjiDay + 1 < (outline.days || []).length
          && /龙脊|金坑大寨|田头寨|千层天梯|西山韶乐|金佛顶/.test(nextDayText)
          && (nextDeparture === undefined || nextDeparture >= 7 * 60)) {
        const sunrise = items.some((item) => Number(item.dayIndex || 0) === longjiDay + 1
          && /西山韶乐/.test(`${item.activity || ''} ${item.note || ''}`)
          && /日出/.test(`${item.activity || ''} ${item.note || ''}`));
        if (!sunrise) issues.push('龙脊次日离开时间允许时，详细时间线缺少西山韶乐日出');
      }
    }
  }
  // 不能因为酒店备注/“等待登船”里提到四星游船，就把普通缓冲条目
  // 当作实际船票或船程来要求起点码头；真正的票务/船程条目才需要核对竹江码头。
  const cruiseRows = items.filter((item) => {
    const text = `${item.activity || ''} ${item.note || ''} ${item.bookingInfo || ''}`;
    return /漓江|四星级游船|四星游船/.test(text)
      && (item.category === 'ticket' || item.transportType === 'ship'
        || /船票|登船|乘坐[^。；，,]{0,20}游船/.test(String(item.activity || '')));
  });
  if (cruiseRows.some((item) => /四星/.test(`${item.activity || ''} ${item.note || ''}`)
      && /磨盘山/.test(`${item.activity || ''} ${item.note || ''} ${item.startLocation || ''} ${item.endLocation || ''}`))) {
    issues.push('四星级漓江游船仍出现磨盘山码头');
  }
  if (cruiseRows.some((item) => /四星/.test(`${item.activity || ''} ${item.note || ''}`)
      && !/竹江码头/.test(`${item.activity || ''} ${item.note || ''} ${item.startLocation || ''} ${item.endLocation || ''}`))) {
    issues.push('四星级漓江游船未明确竹江码头');
  }
  const cruiseArrivals = items.filter((item) => item.transportType === 'ship'
    && /阳朔|龙头山/.test(String(item.endLocation || ''))
    && toMinutes(item.endTime) !== null);
  cruiseArrivals.forEach((cruise) => {
    const endAt = toMinutes(cruise.endTime);
    items.filter((item) => Number(item.dayIndex || 0) === Number(cruise.dayIndex || 0)
      && item.category === 'transport'
      && toMinutes(item.startTime) !== null
      && toMinutes(item.startTime) >= endAt
      && /兴坪|九马画山|黄布倒影|相公山|20元人民币背景/.test(String(item.startLocation || '') + String(item.activity || ''))
      && /阳朔|龙头山|西街/.test(String(item.endLocation || '') + String(item.activity || '')))
      .forEach(() => issues.push('漓江船已抵阳朔后仍生成兴坪沿线→阳朔的重复接驳'));
  });
  items.forEach((item) => {
    const text = `${item.activity || ''} ${item.note || ''}`;
    if (/(?:携带|带走)(?:全部|大件)?行李|(?:全部|大件)?行李[^。；;，,]{0,12}(?:携带|带走)/.test(text)
        && /(?:仅携带|只带)(?:轻便)?(?:随身)?(?:物品|小包)/.test(text)
        && !/(?:寄存|暂存)(?:大件)?行李|(?:大件)?行李(?:留房|留在房间|寄存)/.test(text)) {
      issues.push('行李文案同时写携带大件和仅带小包，存在矛盾');
    }
  });
  const fourStarDays = (outline.days || []).map((day, index) => ({ day, index }))
    .filter(({ day, index }) => {
      const actual = items.filter((row) => Number(row.dayIndex || 0) === index && row.transportType === 'ship');
      if (actual.length) return actual.some((row) => /(?:四星|4\s*星)/.test(row.activity || ''));
      const selected = [day.theme, day.note, ...(day.highlights || [])].filter(Boolean).join(' ');
      return /(?:四星|4\s*星)/.test(selected) && /(?:漓江|游船)/.test(selected);
    })
    .map(({ index }) => index);
  const oldPierOutlineMoves = (outline.days || []).flatMap((day, dayIndex) =>
    (day.moves || []).filter((move) => fourStarDays.includes(dayIndex)
      && /磨盘山/.test(`${move.from || ''} ${move.to || ''} ${move.transfer || ''} ${move.note || ''}`)));
  if (oldPierOutlineMoves.length) issues.push('四星游船大纲前序交通仍指向磨盘山码头');
  const oldPierFeeder = items.filter((item) => fourStarDays.includes(Number(item.dayIndex || 0))
    && /磨盘山/.test(`${item.activity || ''} ${item.note || ''} ${item.startLocation || ''} ${item.endLocation || ''}`));
  if (oldPierFeeder.length) issues.push('四星游船当天前序接驳仍指向磨盘山码头');
  return { issues, dayReports };
}

async function runOfflineScenario(scenario) {
  console.log(`\n===== 开始离线回归：${scenario.name} =====`);
  const fixture = offlineFixture(scenario);
  const profile = P.normalizeInput(scenario.input);
  const hotelSearch = async () => null;
  const nearbySearch = async (region) => {
    const parts = String(region || '').trim().split(/\s+/).filter(Boolean);
    const area = parts[parts.length - 1] || '目的地';
    return {
      matchedName: `${area}地图 POI 酒店`,
      city: area,
      district: '',
      address: area,
      areaSearch: true,
      areaMatched: true,
      searchCity: area,
    };
  };
  await validateOutlineHotels({ outline: fixture.outline }, scenario.input, hotelSearch, nearbySearch);
  fixture.outline = P.normalizeLijiangCruiseOutline(fixture.outline);
  fixture.outline = P.enforceOutlineTransportPreference(profile, fixture.outline);
  let items = P.normalizeLijiangCruiseItems(fixture.items, fixture.outline);
  items = P.enforceMovesAlignment(items, fixture.outline, undefined, profile);
  // 落库合并不再执行整天重新规划：夹具和真实调用一样先同步酒店名称，
  // 再走幂等合并；旧时间线修补曾把30分钟城市游览裁成20分钟。
  items = P.syncHotelReferences(items, fixture.outline);
  // 离线夹具也走与真实落库相同的景区/返程/行李最终审计，避免测试只覆盖
  // 大纲对齐而漏掉龙脊日落、跨日行李和末日到家边界。
  items = P.auditMergedDetailItems(items, fixture.outline, scenario.input);
  items = P.annotateHotelItems(items, fixture.outline);
  // 与执行复核一样先做语义归一化；不写 accepted 标记绕过验收。
  items = fixture.outline.days.flatMap((day, di) => normalizeReviewRows(items.filter((item) => Number(item.dayIndex || 0) === di), di, {
    isFirst: di === 0, isLast: di === fixture.outline.days.length - 1,
    origin: profile.origin, goTime: profile.goTime, backTime: profile.backTime,
    hotel: day.hotel, overnight: day.overnight, previousHotel: (fixture.outline.days[di - 1] || {}).hotel,
    sameHotel: !!day.hotel && sameEndpoint(day.hotel, (fixture.outline.days[di - 1] || {}).hotel),
  }));
  const inspected = inspectScenario(scenario, fixture.outline, items);
  const issues = inspected.issues.slice();

  const hotelRows = fixture.outline.days.filter((day) => day.hotelPoiVerified === true);
  if (hotelRows.length < fixture.outline.days.length - 1) issues.push('离线酒店夹具仍有未核验的住宿日');
  const hotelNoteRows = items.filter((item) => item.category === 'hotel' && /地图 POI|主流平台/.test(item.note || ''));
  if (!hotelNoteRows.length) issues.push('酒店 POI 地址/可搜索说明没有同步到行程卡片');

  // 票务状态回归：已购去程车票与已预约德天门票不应再次出现提醒，
  // 但酒店提醒仍应保留；“未购”则不能被当成完成态。
  const bookedExtra = scenario.name.startsWith('桂林')
    ? `${scenario.input.extra}；去程火车票已购票；德天瀑布门票已预约`
    : `${scenario.input.extra}；去程火车票已购票；毕棚沟门票未购`;
  const bookedProfile = P.normalizeInput(Object.assign({}, scenario.input, { extra: bookedExtra }));
  const bookedAlarms = P.normalizeBookingAlarmKinds(
    P.buildFallbackAlarms(bookedProfile, fixture.outline), items, bookedProfile,
  );
  const goTrainAlarm = bookedAlarms.find((alarm) => alarm.type === 'train' && /去程/.test(alarm.title || ''));
  if (goTrainAlarm) issues.push('已购去程火车票仍生成提醒');
  if (scenario.name.startsWith('桂林')
      && bookedAlarms.some((alarm) => alarm.type === 'ticket' && /德天/.test(`${alarm.title} ${alarm.bookingInfo}`))) {
    issues.push('已预约德天瀑布门票仍生成提醒');
  }
  if (!bookedAlarms.some((alarm) => alarm.type === 'hotel')) issues.push('已购票状态误删了酒店尽早预订提醒');
  if (!scenario.name.startsWith('桂林')
      && !bookedAlarms.some((alarm) => alarm.type === 'ticket' && /毕棚沟/.test(`${alarm.title} ${alarm.bookingInfo}`))) {
    issues.push('毕棚沟门票未购却没有保留门票提醒');
  }

  inspected.dayReports.forEach((day, index) => {
    console.log(`第${index + 1}天 ${day.date}｜${day.city}｜住${day.overnight || '返程'}｜${day.count}项`);
    if (process.argv.includes('--verbose')) day.rows.forEach((row) => console.log(`  ${row}`));
  });
  console.log(`酒店 POI ${hotelRows.length}/${fixture.outline.days.length - 1} 天；票务提醒 ${bookedAlarms.length} 条`);
  if (issues.length) {
    console.error(`❌ ${scenario.name} 离线回归发现 ${issues.length} 个问题：`);
    issues.forEach((issue) => console.error(`  - ${issue}`));
    return false;
  }
  console.log(`✅ ${scenario.name}：离线逐段顺序、交通偏好、酒店检索信息、票务状态过滤通过`);
  return true;
}

async function runScenario(scenario) {
  console.log(`\n===== 开始实测：${scenario.name} =====`);
  const input = scenario.input;
  const outlineResult = await P.generateOutline(input);
  await validateOutlineHotels(outlineResult, input, searchHotelPoi, searchHotelsNearby);
  const outline = outlineResult.outline;
  const segments = P.collectSegments(outline, { origin: input.origin });
  if (segments.length && canLookupSchedules()) {
    const found = await lookupSchedules(segments, 25000);
    const stat = P.applyRealSchedules(outline, found, outlineResult.profile);
    // 班次校正可能改写 overnight 并清空旧酒店，按最终路线再核验一次。
    await validateOutlineHotels({ outline }, input, searchHotelPoi, searchHotelsNearby);
    console.log(`[${scenario.name}] 12306/联网班次校验：${stat ? `${stat.segments} 段命中，${stat.replaced} 段替换` : '无结果'}`);
  }
  const allItems = [];
  const checkpointDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'travel-checkpoint-'));
  console.log(`续跑检查记录：${path.join(checkpointDir, 'result.json')}`);
  let doneDayIndexes = [];
  let attempts = {};
  let final = null;
  const maxRounds = 12;
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`[${scenario.name}] 细化第 ${round} 轮，已完成 ${doneDayIndexes.length}/${outline.days.length} 天`);
    const heartbeat = setInterval(() => console.log(`[${scenario.name}] 正在细化第 ${round} 轮，已完成 ${doneDayIndexes.length}/${outline.days.length} 天…`), 12000);
    let result;
    try {
      result = await P.buildPlan(input, outlineResult, {
        doneDayIndexes,
        attempts,
        reviewItems: allItems.length ? allItems : undefined,
      });
    } finally {
      clearInterval(heartbeat);
    }
    const freshDays = new Set(result.items.map((item) => Number(item.dayIndex || 0)));
    for (let i = allItems.length - 1; i >= 0; i--) {
      if (freshDays.has(Number(allItems[i].dayIndex || 0))) allItems.splice(i, 1);
    }
    allItems.push(...result.items);
    // 和 savePlan 一样每轮落库审计，复核通过的日期保持不变。
    const stored = P.auditMergedDetailItems(allItems, outline, input);
    allItems.splice(0, allItems.length, ...stored);
    doneDayIndexes = result.doneDayIndexes || doneDayIndexes;
    attempts = result.attempts || attempts;
    final = result;
    fs.writeFileSync(path.join(checkpointDir, 'result.json'), JSON.stringify({
      input, outline, items: allItems, attempts, doneDayIndexes,
    }, null, 2));
    if (result.reviewError) throw new Error(result.reviewError);
    if (!result.partial) break;
    if (round === maxRounds) throw new Error(`${scenario.name} 超过 ${maxRounds} 轮仍未完成`);
  }

  // 真实生产流程每一轮都会把“已落库旧天 + 本轮新天”交给同一套合并审计。
  // 测试也要走这一步，否则跨轮生成的同一天补条目会被简单 concat，
  // 误报重复日出/重复交通，且不能代表最终落库结果。
  // 与生产 savePlan 一致，把用户输入传给合并审计；交通偏好、行李例外和
  // 返程接驳都依赖这些字段，测试不能用空 profile 代替。
  const finalItems = P.auditMergedDetailItems(allItems, outline, input);
  const inspected = inspectScenario(scenario, outline, finalItems);
  const issues = inspected.issues;
  const verbose = process.argv.includes('--verbose');
  console.log(`\n--- ${scenario.name} 逐日生成结果（每天检查顺序、缺时、重叠与返程闭环）---`);
  inspected.dayReports.forEach((day, index) => {
    console.log(`\n第${index + 1}天 ${day.date}｜白天：${day.city}｜过夜：${day.overnight || '未注明'}｜住宿：${day.hotel || '未安排'}｜${day.count}项`);
    if (verbose && day.moves.length) console.log(`  大纲交通：${day.moves.join('；')}`);
    if (verbose) day.rows.forEach((row) => console.log(`  ${row}`));
    else {
      const transportRows = day.rows.filter((row) => /\b(?:car|ride|train|plane|bus|walk)\b|高铁|动车|火车|班车|大巴|打车|自驾|开车/.test(row));
      day.rows.slice(0, 1).forEach((row) => console.log(`  起：${row}`));
      if (transportRows.length) console.log(`  交通：${transportRows.join('；')}`);
      day.rows.slice(-1).forEach((row) => { if (day.count > 1) console.log(`  末：${row}`); });
    }
  });
  const profile = P.normalizeInput(input);
  const originalAlarms = final && final.alarms || [];
  let alarms = originalAlarms.concat(P.backfillDetailAlarms(profile, outline, finalItems, originalAlarms));
  alarms = P.linkBookingAlarms(alarms, finalItems);
  alarms = P.normalizeBookingAlarmKinds(alarms, finalItems, profile);
  alarms = P.dedupeBookingAlarmRecords(alarms);
  alarms = P.annotateAlarmUsage(alarms, finalItems, outline);
  const bookingAlarms = alarms.filter((alarm) => ['train', 'plane', 'bus', 'ticket', 'hotel'].includes(alarm.type));
  issues.push(...inspectBookingReminders(profile, finalItems, alarms));
  const missingUsage = bookingAlarms.filter((alarm) => !String(alarm.usageInfo || '').trim());
  if (missingUsage.length) issues.push(`${missingUsage.length} 条分类闹钟缺少实际使用日期/时间信息`);
  const linkedAlarmCounts = new Map();
  bookingAlarms.forEach((alarm) => {
    if (!alarm.linkedItemId) return;
    linkedAlarmCounts.set(String(alarm.linkedItemId), (linkedAlarmCounts.get(String(alarm.linkedItemId)) || 0) + 1);
  });
  const duplicateLinked = [...linkedAlarmCounts.entries()].filter(([, count]) => count > 1);
  if (duplicateLinked.length) issues.push(`${duplicateLinked.length} 个票务/酒店行程条目生成了重复闹钟`);
  const alarmCounts = alarms.reduce((counts, alarm) => {
    counts[alarm.type || 'other'] = (counts[alarm.type || 'other'] || 0) + 1;
    return counts;
  }, {});
  const alarmIssues = alarms.filter((alarm) => alarm.type === 'ticket'
    && /乘坐|打车|包车|接驳|地铁|公交|前往/.test(`${alarm.title || ''} ${alarm.bookingInfo || ''}`)
    && !/门票|购票|放票|竹筏|游船|漂流|缆车|索道|温泉|演出/.test(`${alarm.title || ''} ${alarm.bookingInfo || ''}`));
  if (alarmIssues.length) issues.push(`${alarmIssues.length} 条普通交通被错误归成门票提醒`);
  alarmIssues.forEach((alarm) => {
    const linked = (finalItems || []).find((item) => item.itemId && item.itemId === alarm.linkedItemId);
    console.error(`  错误门票提醒：「${alarm.title}」关联=${linked ? `${linked.category}/${linked.transportType || ''} ${linked.activity}` : '无行程条目'}`);
  });
  const hotelAlarms = alarms.filter((alarm) => alarm.type === 'hotel');
  if (hotelAlarms.some((alarm) => !/酒店住宿|住宿日期/.test(alarm.note || '') || !/越早|尽早/.test(alarm.note || ''))) {
    issues.push('酒店提醒没有说明可随时预订并引导到酒店住宿分类');
  }
  const verifiedHotels = (outline.days || []).filter((day) => day.hotelPoiVerified).length;
  const reportDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'travel-route-'));
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({ input, outline, items: finalItems, alarms, issues }, null, 2));
  console.log(`完整实测记录：${path.join(reportDir, 'result.json')}`);
  console.log(`\n行前/购票提醒数量：${JSON.stringify(alarmCounts)}；酒店提醒 ${hotelAlarms.length} 条；核验酒店 POI ${verifiedHotels} 家；错误门票分类 ${alarmIssues.length} 条`);
  if (issues.length) {
    console.error(`\n❌ ${scenario.name} 检查到 ${issues.length} 个问题：`);
    issues.forEach((issue) => console.error(`  - ${issue}`));
    return false;
  }
  console.log(`\n✅ ${scenario.name}：大纲覆盖、逐日时间、首末日接驳、非自驾约束${scenario.inspectLongji ? '、龙脊线路顺序' : ''}均通过`);
  return true;
}

function inspectBookingReminders(profile, items, alarms) {
  const issues = [];
  const needsBooking = (item, type) => !P.bookingStatusMatches(profile,
    `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`, type)
    && !/(?:已购票|已购买|已预约|无需再购票)/.test(item.note || '');
  items.forEach((item) => {
    if (item.category === 'transport' && item.transportType === 'train' && needsBooking(item, 'train')
      && !alarms.some((alarm) => alarm.type === 'train' && alarm.linkedItemId === item.itemId)) {
      issues.push(`车票提醒漏了具体路段：第${Number(item.dayIndex || 0) + 1}天 ${item.startLocation}→${item.endLocation}`);
    }
    if (item.category !== 'sight' || !needsBooking(item, 'ticket')) return;
    if (/游船|竹筏|漂流|演出|缆车|索道/.test(item.activity || '')
      && !alarms.some((alarm) => alarm.type === 'ticket' && alarm.linkedItemId === item.itemId)) {
      issues.push(`实际体验缺少购票提醒：${item.activity}`);
    }
    const entry = String(item.endLocation || '').replace(/(?:正门|大门|门口|出口|入口).*$/, '').trim();
    const scoped = String(item.visitScope || '').trim();
    const parent = /景区|梯田|瀑布|山|公园|沟|田园|博物馆/.test(scoped) ? scoped
      : /景区|公园|博物馆$/.test(entry) ? entry : '';
    if (/景区|梯田|瀑布|山|公园|沟|田园|博物馆/.test(parent)
      && !P.bookingStatusMatches(profile, `${parent} 门票`, 'ticket')
      && !alarms.some((alarm) => alarm.type === 'ticket'
        && `${alarm.title || ''} ${alarm.bookingInfo || ''}`.includes(parent))) {
      issues.push(`最终景区缺少预约核验提醒：${parent}`);
    }
  });
  alarms.forEach((alarm) => {
    const item = items.find((row) => row.itemId === alarm.linkedItemId);
    if (alarm.type === 'bus' && item && /地铁|公交|观光车|景区.*接驳/.test(`${item.activity} ${item.note}`)) {
      issues.push(`普通市内/景区交通错误生成预购汽车票：${item.activity}`);
    }
    if (!item || alarm.type === 'hotel') return;
    const action = String(item.activity || '');
    const actualBooking = /购买|购票|预约|预订|(?:乘坐|搭乘|体验|观看).{0,16}(?:游船|竹筏|漂流|演出|缆车|索道)/.test(action);
    if (!actualBooking && /候车|候船|取票|安检|检票/.test(action)) issues.push(`候车/候船等办理动作被重复当成新购票：${action}`);
  });
  return [...new Set(issues)];
}

(async () => {
  if (replayPath) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(replayPath), 'utf8'));
    const scenario = scenarios.find((entry) => entry.input.dest === saved.input.dest);
    if (!scenario) throw new Error('重放文件不属于两条指定测试路线');
    if (process.argv.includes('--evidence-file')) {
      const evidencePath = process.argv[process.argv.indexOf('--evidence-file') + 1];
      const references = JSON.parse(fs.readFileSync(path.resolve(evidencePath), 'utf8'));
      saved.outline.days.forEach((day) => {
        if (references[day.date]) day.operatingReferences = references[day.date];
      });
    }
    let items = liveReview ? saved.items : P.auditMergedDetailItems(saved.items, saved.outline, saved.input);
    let alarms = saved.alarms || [];
    if (liveReview) {
      const hotels = saved.outline.days.map((day) => day.hotel);
      await validateOutlineHotels({ outline: saved.outline }, saved.input, searchHotelPoi, searchHotelsNearby);
      const changed = new Set();
      saved.outline.days.forEach((day, di) => {
        if (day.hotel !== hotels[di]) { changed.add(di); changed.add(di + 1); }
      });
      changed.forEach((di) => {
        const day = saved.outline.days[di];
        if (!day) return;
        delete day.executionCandidate; delete day.executionEvidence;
      });
      items = items.map((row) => {
        if (!changed.has(Number(row.dayIndex || 0))) return row;
        const next = Object.assign({}, row); delete next.executionReview; return next;
      });
    }
    if (liveReview && (process.argv.includes('--recheck-day') || process.argv.includes('--recheck-days'))) {
      const option = process.argv.includes('--recheck-days') ? '--recheck-days' : '--recheck-day';
      const requested = String(process.argv[process.argv.indexOf(option) + 1]).split(',').map((n) => Number(n) - 1);
      if (requested.some((n) => !Number.isInteger(n) || n < 0 || n >= saved.outline.days.length)) throw new Error('无效的复核日期');
      items = items.map((row) => {
        if (!requested.includes(Number(row.dayIndex || 0))) return row;
        const out = Object.assign({}, row); delete out.executionReview; return out;
      });
      requested.forEach((di) => { delete saved.outline.days[di].executionEvidence; });
    }
    const reportDir = liveReview ? fs.mkdtempSync(path.join(require('os').tmpdir(), 'travel-review-')) : '';
    const checkpoint = () => {
      if (!reportDir) return;
      fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({
        input: saved.input, outline: saved.outline, items, alarms,
      }, null, 2));
    };
    if (liveReview) {
      console.log(`复核检查点：${path.join(reportDir, 'result.json')}`);
      let attempts = {};
      try {
        for (let round = 0; round < 12; round++) {
          const result = await P.buildPlan(saved.input, { outline: saved.outline }, { reviewItems: items, attempts });
          const fresh = new Set(result.items.map((row) => Number(row.dayIndex || 0)));
          items = items.filter((row) => !fresh.has(Number(row.dayIndex || 0))).concat(result.items);
          items = P.auditMergedDetailItems(items, saved.outline, saved.input);
          attempts = result.attempts;
          if (!result.partial) alarms = result.alarms || [];
          checkpoint();
          if (result.reviewError) throw new Error(result.reviewError);
          if (!result.partial) break;
          if (round === 11) throw new Error('执行复核超过十二轮仍未完成');
        }
      } finally { checkpoint(); }
    }
    const inspected = inspectScenario(scenario, saved.outline, items);
    const reminders = alarms.filter((alarm) => ['train', 'plane', 'bus', 'ticket', 'hotel'].includes(alarm.type));
    if (liveReview) {
      if (!reminders.length) inspected.issues.push('完整复核后缺少票务/住宿提醒');
      inspected.issues.push(...inspectBookingReminders(P.normalizeInput(saved.input), items, alarms));
      if (reminders.some((alarm) => !alarm.usageInfo)) inspected.issues.push('票务/住宿提醒缺少使用日期或时段摘要');
      const lead = P.normalizeInput(saved.input).leadMinutes;
      if (reminders.some((alarm) => alarm.leadMinutes !== lead
        || alarm.remindAt !== alarm.fireAt - lead * 60000)) inspected.issues.push('提醒未严格使用用户提前量');
    }
    if (liveReview) {
      fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({
        input: saved.input, outline: saved.outline, items, alarms, issues: inspected.issues,
      }, null, 2));
      console.log(`复核记录：${path.join(reportDir, 'result.json')}`);
    }
    inspected.dayReports.forEach((day, index) => {
      console.log(`第${index + 1}天 ${day.date}｜${day.city}｜住${day.overnight || '返程'}`);
      day.rows.forEach((row) => console.log(`  ${row}`));
    });
    inspected.issues.forEach((issue) => console.error(`❌ ${issue}`));
    console.log(`${liveReview ? '真实 LLM 逐日复核' : '真实结果离线重放'}：${inspected.issues.length ? '失败' : '通过'}${liveReview ? '' : '（不代表重新调用 LLM）'}`);
    process.exitCode = inspected.issues.length ? 1 : 0;
    return;
  }
  const requested = process.argv.includes('--route')
    ? Number(process.argv[process.argv.indexOf('--route') + 1]) : 0;
  const selected = requested ? [scenarios[requested - 1]] : scenarios;
  if (selected.some((scenario) => !scenario)) throw new Error('--route 只接受 1 或 2');
  let failed = 0;
  for (const scenario of selected) {
    if (!await (offline ? runOfflineScenario(scenario) : runScenario(scenario))) failed++;
  }
  console.log(`\n${offline ? '离线回归' : '实测'}结束：${selected.length - failed}/${selected.length} 条路线通过`);
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error('路线实测失败：', error.message);
  process.exit(1);
});
