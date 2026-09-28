// Real generation regression run for the two routes requested by the product owner.
// Usage: node scripts/test-route-scenarios.js [--route 1|2]
// Requires the local .env.local but never prints its contents.

const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env.local');
const offline = process.argv.includes('--offline');
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
      offlineDay('2026-10-01', '阳朔', '阳朔', ['漓江游船', '阳朔自然山水'], [
        offlineMove('桂林磨盘山码头', '阳朔水东门码头', 'ship', '08:30', '12:30'),
      ]),
      offlineDay('2026-10-02', '龙脊梯田', '金坑大寨', ['龙脊梯田', '西山韶乐', '千层天梯', '金佛顶'], [
        offlineMove('阳朔', '龙脊金坑大寨', 'bus', '08:00', '11:00'),
      ]),
      offlineDay('2026-10-03', '明仕田园', '明仕田园', ['明仕田园'], [
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
      offlineItem(1, '08:00', '08:30', 'transport', '从桂林酒店前往桂林磨盘山码头', '桂林酒店', '桂林磨盘山码头', 'ride'),
      offlineItem(1, '08:30', '12:30', 'sight', '乘游船游览漓江精华段，从桂林磨盘山码头到阳朔水东门码头', '桂林磨盘山码头', '阳朔水东门码头', ''),
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
      offlineItem(2, '15:30', '17:30', 'sight', '游览龙脊梯田金佛顶（3号观景台）', '金佛顶', '金佛顶', ''),
      offlineItem(2, '17:30', '18:00', 'transport', '从金佛顶返回西山韶乐休息点', '金佛顶', '西山韶乐', 'walk'),
      offlineItem(2, '18:00', '18:30', 'other', '回到西山韶乐休息并整理行李', '西山韶乐', '西山韶乐', ''),
      offlineItem(2, '18:30', '19:30', 'food', '在西山韶乐住宿点享用晚餐', '西山韶乐', '西山韶乐', ''),
      offlineItem(3, '07:00', '08:00', 'food', '在西山韶乐住宿点吃早餐并收拾行李', '西山韶乐', '西山韶乐', ''),
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
      offlineMove('成都东站', '离堆公园站', 'train', '08:00', '09:00'),
    ]),
    offlineDay('2027-01-02', '毕棚沟', '古尔沟', ['毕棚沟', '自然山水'], [
      offlineMove('都江堰', '毕棚沟游客中心', 'bus', '07:30', '12:00'),
    ]),
    offlineDay('2027-01-03', '返程', '返程', [], [
      offlineMove('古尔沟', '成都东站', 'bus', '07:00', '11:00'),
      offlineMove('成都东站', '重庆西站', 'train', '11:30', '14:30'),
    ]),
  ];
  const items = [
    offlineItem(0, '17:00', '17:40', 'transport', '从重庆市金童路乘网约车前往重庆西站', '重庆市金童路', '重庆西站', 'ride'),
    offlineItem(0, '17:40', '19:00', 'other', '重庆西站安检候车', '重庆西站', '重庆西站', ''),
    offlineItem(0, '19:00', '21:30', 'transport', '乘列车从重庆西站前往成都东站', '重庆西站', '成都东站', 'train'),
    offlineItem(0, '21:30', '22:00', 'hotel', '到成都酒店办理入住', '成都东站', '成都酒店', ''),
    offlineItem(1, '06:50', '07:30', 'food', '在成都酒店吃早餐', '成都酒店', '成都酒店', ''),
    offlineItem(1, '08:00', '09:00', 'transport', '乘动车从成都东站前往离堆公园站', '成都东站', '离堆公园站', 'train'),
    offlineItem(1, '09:00', '12:00', 'sight', '游览都江堰水利工程与南桥', '离堆公园站', '都江堰', ''),
    offlineItem(1, '12:00', '13:00', 'food', '都江堰当地午餐', '都江堰', '都江堰', ''),
    offlineItem(1, '13:00', '13:30', 'hotel', '到都江堰住宿地放行李', '都江堰', '都江堰酒店', ''),
    offlineItem(1, '13:30', '14:15', 'transport', '乘公交前往青城山', '都江堰酒店', '青城山', 'ride'),
    offlineItem(1, '14:15', '17:15', 'sight', '青城山前山游览，按返程时间折返，不登全山', '青城山', '青城山', ''),
    offlineItem(1, '17:15', '18:00', 'transport', '乘公交返回都江堰住宿地', '青城山', '都江堰酒店', 'ride'),
    offlineItem(2, '06:30', '07:30', 'food', '在都江堰住宿地吃早餐并退房', '都江堰酒店', '都江堰酒店', ''),
    offlineItem(2, '07:30', '12:00', 'transport', '乘旅游大巴从都江堰前往毕棚沟游客中心', '都江堰', '毕棚沟游客中心', 'bus'),
    offlineItem(2, '12:00', '16:30', 'sight', '冬季游览毕棚沟景区，预留雪地步行和拍照时间', '毕棚沟游客中心', '毕棚沟', ''),
    offlineItem(2, '16:30', '17:00', 'transport', '乘景区接驳前往古尔沟住宿地', '毕棚沟', '古尔沟酒店', 'ride'),
    offlineItem(2, '17:00', '17:30', 'hotel', '到古尔沟酒店办理入住', '古尔沟酒店', '古尔沟酒店', ''),
    offlineItem(3, '06:00', '07:00', 'food', '在古尔沟吃早餐并退房，携带全部行李出发', '古尔沟酒店', '古尔沟酒店', ''),
    offlineItem(3, '07:00', '11:00', 'transport', '乘旅游大巴从古尔沟前往成都东站', '古尔沟', '成都东站', 'bus'),
    offlineItem(3, '11:00', '11:30', 'other', '成都东站安检候车', '成都东站', '成都东站', ''),
    offlineItem(3, '11:30', '14:30', 'transport', '乘列车从成都东站返回重庆西站', '成都东站', '重庆西站', 'train'),
    offlineItem(3, '14:30', '17:00', 'transport', '乘网约车从重庆西站返回重庆市金童路，到家休息', '重庆西站', '重庆市金童路', 'ride'),
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
    const visited = items.some((item) => ['sight', 'food', 'other'].includes(item.category)
      && !/候车|进站|安检/.test(item.activity || '')
      && toMinutes(item.endTime) > toMinutes(item.startTime)
      && (`${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`.includes(stem)
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
  const noSelfDrive = items.filter((item) => /自驾|开车|驾车|驾驶|驱车|骑(?:行)?(?:电动车|电动摩托车|摩托车)|租(?:赁|用|车)?(?:电动车|电动摩托车|摩托车)/
    .test(`${item.activity || ''} ${item.note || ''}`));
  if (noSelfDrive.length) {
    issues.push(`${noSelfDrive.length} 条行程出现未授权的本人驾驶文案`);
    noSelfDrive.forEach((item) => console.error(`  驾驶文案条目：第${Number(item.dayIndex || 0) + 1}天 ${fmt(item)}`));
  }
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

  const dayReports = (outline.days || []).map((day, dayIndex) => {
    const rows = items.filter((item) => Number(item.dayIndex || 0) === dayIndex);
    const outlineMoves = (day.moves || []).filter((move) => move && move.from && move.to);
    for (let moveIndex = 1; moveIndex < outlineMoves.length; moveIndex++) {
      const previousMove = outlineMoves[moveIndex - 1];
      const currentMove = outlineMoves[moveIndex];
      const hasDetailBridge = rows.some((item) => routeMatches(previousMove.to, item.startLocation)
        && routeMatches(currentMove.from, item.endLocation)
        && item.category !== 'ticket');
      if (!routeMatches(previousMove.to, currentMove.from) && !hasDetailBridge) {
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
    if (P.removeRedundantDirectTransports(sequenceRows).length < sequenceRows.length) {
      issues.push(`第${dayIndex + 1}天仍有被接驳链覆盖的直达交通`);
    }
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
      for (const rows of longjiRowsByDay.values()) {
        const core = rows.filter((item) => item.category === 'sight'
          && (/千层天梯|2号天梯/.test(String(item.activity || '')) || visitsGolden(item)))
          .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
        const westRows = rows.filter((item) => item.category === 'sight'
          && /西山韶乐/.test(String(item.activity || '')))
          .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
        const hasLadder = core.some((item) => /千层天梯|2号天梯/.test(String(item.activity || '')));
        const hasGolden = core.some(visitsGolden);
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
        return visits.some((item) => /西山韶乐/.test(String(item.activity || '')))
          && visits.some((item) => /千层天梯|2号天梯/.test(String(item.activity || '')))
          && visits.some(visitsGolden);
      });
      if (!sameDayCore) {
        issues.push('时间允许时龙脊未将西山韶乐、千层天梯、金佛顶安排在同一天');
      } else {
        const orderedCore = sameDayCore[1].filter((item) => item.category === 'sight'
          && (/西山韶乐|千层天梯|2号天梯|金佛顶/.test(String(item.activity || ''))))
          .sort((a, b) => (toMinutes(a.startTime) ?? 1440) - (toMinutes(b.startTime) ?? 1440));
        const westAt = orderedCore.findIndex((item) => /西山韶乐/.test(String(item.activity || '')));
        const ladderAt = orderedCore.findIndex((item) => /千层天梯|2号天梯/.test(String(item.activity || '')));
        const goldenAt = orderedCore.findIndex(visitsGolden);
        if (!(westAt >= 0 && ladderAt > westAt && goldenAt > ladderAt)) {
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
    }
  }
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
  fixture.outline = P.enforceOutlineTransportPreference(profile, fixture.outline);
  let items = P.enforceMovesAlignment(fixture.items, fixture.outline, undefined, profile);
  items = P.enforceFinalTimelineIntegrity(items, profile, fixture.outline);
  items = P.annotateHotelItems(items, fixture.outline);
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
  let doneDayIndexes = [];
  let attempts = {};
  let final = null;
  const maxRounds = outline.days.length + 2;
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`[${scenario.name}] 细化第 ${round} 轮，已完成 ${doneDayIndexes.length}/${outline.days.length} 天`);
    const heartbeat = setInterval(() => console.log(`[${scenario.name}] 正在细化第 ${round} 轮，已完成 ${doneDayIndexes.length}/${outline.days.length} 天…`), 12000);
    let result;
    try {
      result = await P.buildPlan(input, outlineResult, {
        doneDayIndexes,
        attempts,
        budgetMs: 48 * 1000,
        hardBudgetMs: 62 * 1000,
      });
    } finally {
      clearInterval(heartbeat);
    }
    allItems.push(...result.items);
    doneDayIndexes = result.doneDayIndexes || doneDayIndexes;
    attempts = result.attempts || attempts;
    final = result;
    if (!result.partial) break;
    if (round === maxRounds) throw new Error(`${scenario.name} 超过 ${maxRounds} 轮仍未完成`);
  }

  const inspected = inspectScenario(scenario, outline, allItems);
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
  const alarms = final && final.alarms || [];
  const alarmCounts = alarms.reduce((counts, alarm) => {
    counts[alarm.type || 'other'] = (counts[alarm.type || 'other'] || 0) + 1;
    return counts;
  }, {});
  const alarmIssues = alarms.filter((alarm) => alarm.type === 'ticket'
    && /乘坐|打车|包车|接驳|地铁|公交|前往/.test(`${alarm.title || ''} ${alarm.bookingInfo || ''}`)
    && !/门票|购票|放票|竹筏|游船|漂流|缆车|索道|温泉|演出/.test(`${alarm.title || ''} ${alarm.bookingInfo || ''}`));
  if (alarmIssues.length) issues.push(`${alarmIssues.length} 条普通交通被错误归成门票提醒`);
  alarmIssues.forEach((alarm) => {
    const linked = (allItems || []).find((item) => item.itemId && item.itemId === alarm.linkedItemId);
    console.error(`  错误门票提醒：「${alarm.title}」关联=${linked ? `${linked.category}/${linked.transportType || ''} ${linked.activity}` : '无行程条目'}`);
  });
  const hotelAlarms = alarms.filter((alarm) => alarm.type === 'hotel');
  if (hotelAlarms.some((alarm) => !/酒店住宿/.test(alarm.note || '') || !/越早/.test(alarm.note || ''))) {
    issues.push('酒店提醒没有说明可随时预订并引导到酒店住宿分类');
  }
  const verifiedHotels = (outline.days || []).filter((day) => day.hotelPoiVerified).length;
  const reportDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'travel-route-'));
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({ input, outline, items: allItems, alarms, issues }, null, 2));
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

(async () => {
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
