// 通用的逐日执行复核：知识由模型复核，时间/官方班次/用户边界由代码验收。
// 不包含城市、站点或景区的特例映射。
const llm = require('./llm');
const evidence = require('./route-evidence');
const { solarEventMinute } = require('./solar-time');
const REVIEW_VERSION = 'v4';

function minute(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return match && Number(match[1]) < 24 && Number(match[2]) < 60
    ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function placeKey(value) {
  return String(value || '').replace(/[\s（）()]/g, '').replace(/(?:火车站|高铁站|动车站|站)$/g, '');
}

function sameEndpoint(a, b) {
  return !!placeKey(a) && placeKey(a) === placeKey(b);
}

function positiveInstructions(value) {
  return String(value || '').split(/[。；;，,]/).filter((part) =>
    !/(?:无需|不用|不必|不要|禁止|严禁|没有|未曾|不重复|不安排|不选择|不采用|不寄存)/.test(part)).join('；');
}

function fixedWindow(row, context) {
  return (context.official || []).some((fact) => sameEndpoint(row.startLocation, fact.startLocation)
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

function fitOutdoorDaylight(rows, context) {
  if (context.isFirst || context.isLast || rows.some((row) => fixedWindow(row, context))) return rows;
  let shift = 0;
  rows.filter((row) => row.category === 'sight' && /登山|山峰|前山|后山|徒步|竹筏|漂流/.test(row.activity)
    && !/日落|夕阳|夜游|夜景|灯光|夜场/.test(row.activity)).forEach((row) => {
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
  for (let i = result.length - 1; i >= 0; i--) {
    const row = result[i];
    const start = minute(row.startTime), end = minute(row.endTime);
    if (start === null || end === null || end <= start) return rows;
    const fixed = (context.official || []).some((fact) => sameEndpoint(row.startLocation, fact.startLocation)
      && sameEndpoint(row.endLocation, fact.endLocation));
    if (fixed || (context.solar || []).some((fact) => fact.startTime === row.startTime && fact.endTime === row.endTime)) break;
    let duration = end - start;
    if (i === result.length - 1) duration = Math.max(duration, context.homeAccessMin || 20);
    if (/安检|候车|检票/.test(row.activity || '') && result[i + 1] && result[i + 1].transportType === 'train') {
      duration = Math.max(duration, 40);
    }
    const targetEnd = i === result.length - 1 ? minute(context.backTime) : Math.min(end, nextStart);
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

// 文档解析的 sanitizeItems 会修补时间并删除同点的两个地址，不能用于
// 执行验收，否则重叠被悄悄掩盖、回房位置和官方站点证据丢失。
function normalizeReviewRows(raw, dayIndex, context = {}) {
  let rows = (raw || []).filter((row) => row && String(row.activity || '').trim()).map((row) => {
    const out = { dayIndex };
    ['startTime', 'endTime', 'category', 'activity', 'startLocation', 'endLocation', 'transportType', 'note']
      .forEach((key) => { out[key] = String(row[key] || '').trim(); });
    if (!['sight', 'food', 'hotel', 'transport', 'ticket', 'other'].includes(out.category)) out.category = 'other';
    if (out.category === 'other' && /^(?:游览|参观|观赏|漫步|体验|乘坐.*游船)/.test(out.activity)) out.category = 'sight';
    if (out.startLocation && out.endLocation && !sameEndpoint(out.startLocation, out.endLocation)
      && /^(?:徒步|步行|打车|乘车|包车|乘坐大巴|乘地铁|从.*?乘)/.test(out.activity)
      && !/游览|参观|漂流|观赏|骑行/.test(out.activity)) out.category = 'transport';
    const modeText = `${out.activity}；${out.note}`;
    if (out.category === 'transport' && /(?:乘坐|乘|换乘|搭乘|坐).{0,12}(?:地铁|公交|巴士|大巴|客车|旅游专线|接驳车|观光车|公共交通)/.test(modeText)
      && !/^(?:乘坐|搭乘|计划乘|乘).{0,12}(?:高铁|动车|列车)/.test(out.activity)) out.transportType = 'bus';
    if (out.category === 'transport' && /打车|网约车|出租车|包车/.test(out.activity)
      && !/乘.{0,8}(?:高铁|动车|列车)/.test(out.activity)) out.transportType = 'ride';
    if (out.category === 'transport' && /^(?:步行|徒步)/.test(out.activity)) out.transportType = 'walk';
    if (out.category === 'transport' && out.transportType !== 'walk' && /地铁|轨道交通/.test(modeText)
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
    // 模型可以扩展前后活动，但太阳窗口不能被改成习惯性的“六点半”。
    const fact = (context.solar || []).find((entry) => {
      const event = /日出/.test(entry.activity) ? '日出' : '日落';
      return row.category === 'sight' && row.activity.includes(event);
    });
    if (fact) {
      row.startTime = fact.startTime; row.endTime = fact.endTime;
      row.activity = row.activity.replace(/[（(][^）)]*(?:日出|日落)[^）)]*[）)]/g, '')
        .replace(/(?:日出|日落)(?:约|时间约|时间为)\s*\d{1,2}[:：]\d{2}/g, '太阳时刻以备注为准');
      row.note = [fact.note, row.note.replace(/(?:日出|日落)(?:约|时间约|时间为)\s*\d{1,2}[:：]\d{2}/g, '')]
        .filter(Boolean).join('；').slice(0, 180);
    }
    return row;
  }).sort((a, b) => (minute(a.startTime) ?? 1440) - (minute(b.startTime) ?? 1440));
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
  rows = fitEstimatedReturn(fitOutdoorDaylight(fitEstimatedConnections(rows, context), context), context);
  rows.forEach((row, i) => {
    const previous = rows[i - 1];
    if (row.category === 'hotel' && previous && sameEndpoint(previous.endLocation, row.endLocation)
      && sameEndpoint(row.endLocation, context.hotel) && /返回|回房|回到|休息/.test(row.activity)
      && !/退房|办理入住/.test(row.activity)) {
      // 前一段已到酒店，收尾只是回房，不能再次以车站为起点生成重复接驳。
      row.startLocation = ''; row.transportType = ''; row.activity = '回房休息';
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
    if (row.category === 'sight' && visitScope) row.visitScope = visitScope;
    if (row.category === 'transport' && /离开景区|出景区.*前往|返回.*客运|下山.*客运/.test(row.activity)) visitScope = '';
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
    const state = context.sameHotel ? '连住：大件行李留在房间，携带随身小包出门'
      : context.previousHotel ? '退房时带走全部行李，不留在昨晚酒店' : '携带行李启程';
    if (!rows[0].note.includes(state)) rows[0].note = [state, rows[0].note].filter(Boolean).join('；').slice(0, 220);
  }
  return rows;
}

function executionIssues(rows, context) {
  const issues = [];
  const sorted = rows.slice().sort((a, b) => (minute(a.startTime) ?? 1440) - (minute(b.startTime) ?? 1440));
  if (!sorted.length) return ['没有行程条目'];
  sorted.forEach((row, i) => {
    const start = minute(row.startTime), end = minute(row.endTime);
    if (start === null || end === null || end <= start) issues.push('存在无效或非正时长');
    if (i && start < minute(sorted[i - 1].endTime)) issues.push('时段重叠');
    if (row.category === 'transport' && (row.transportType === 'train' || /^(?:乘坐|搭乘|计划乘|乘).{0,12}(?:高铁|动车|列车)/.test(row.activity || ''))
      && /汽车站|客运站|码头|机场|游客中心/.test(`${row.startLocation || ''} ${row.endLocation || ''}`)) {
      issues.push('铁路使用了非铁路上车/下车点');
    }
    if (row.category === 'transport' && row.transportType === 'train') {
      if (/[\/／]|或|最近|待选/.test(`${row.startLocation || ''} ${row.endLocation || ''}`)) issues.push('铁路站点仍是模糊占位或多个备选');
      const endpoints = [row.startLocation, row.endLocation];
      if (endpoints.some((place) => !/站$/.test(place || '') && !(context.official || []).some((fact) =>
        sameEndpoint(place, fact.startLocation) || sameEndpoint(place, fact.endLocation)))) issues.push('铁路上车/下车点没有明确车站');
      const access = sorted.slice(0, i).reverse().find((entry) => entry.category === 'transport'
        && sameEndpoint(entry.endLocation, row.startLocation));
      if (access && minute(access.endTime) > start - 40) issues.push('铁路进站接驳没有40分钟安检缓冲');
    }
    const activity = String(row.activity || '');
    if (/日落|夕阳|落日/.test(activity) && !/日落之后|错过|不看/.test(activity) && start < 15 * 60) issues.push('上午观看日落');
    if (/日出/.test(activity.replace(/(?:明|次|翌)日出发/g, ''))
      && !/不看|错过/.test(activity) && start > 9 * 60) issues.push('日出安排过晚');
    if (row.category === 'hotel' && /退房/.test(activity) && start > 16 * 60) issues.push('晚上错误退房');
    if (row.category === 'sight' && start >= 19 * 60
      && /登山|山峰|瀑布|溶洞|徒步|竹筏|漂流|景区/.test(activity)
      && !/夜游|夜景|灯光|演出|夜场/.test(activity)) issues.push('日间景区被排到深夜');
    if (row.category === 'sight' && /登山|山峰|前山|后山|徒步|竹筏|漂流/.test(activity)
      && !/日落|夕阳|夜游|夜景|灯光|夜场/.test(activity)) {
      const point = outdoorPoint(row, context);
      const sunset = point && solarEventMinute(context.date, point.lat, point.lon, true);
      if (sunset !== null && sunset !== undefined && end > sunset + 15) issues.push('户外游览超过当地日落，应提前或缩短游线');
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
    if (!sameEndpoint(last.endLocation, context.origin) || (context.backTime && last.endTime !== context.backTime)) issues.push('返程未按指定地点/时间结束');
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
    const atLodging = target ? sameEndpoint(last.endLocation, target)
      : /酒店|民宿|客栈|宾馆|饭店|住宿/.test(last.endLocation || '');
    // 分类只是展示标签；有真实回房动作和正确住宿终点同样构成闭环。
    if (last.category !== 'hotel' && !(atLodging && /休息|回房|返回|回到/.test(last.activity || ''))) {
      issues.push('缺少当晚回住宿地休息');
    }
    if (target && last.category === 'hotel' && !sameEndpoint(last.endLocation, target)) issues.push('当晚收尾住宿地错误');
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
  (context.official || []).forEach((fact) => {
    if (!sorted.some((row) => row.category === 'transport' && sameEndpoint(row.startLocation, fact.startLocation)
      && sameEndpoint(row.endLocation, fact.endLocation) && row.startTime === fact.startTime && row.endTime === fact.endTime
      && String(row.activity || '').includes(fact.code))) issues.push('修改或遗漏了官方班次');
  });
  (context.solar || []).forEach((fact) => {
    const event = /日出/.test(fact.activity || '') ? '日出' : '日落';
    if (!sorted.some((row) => row.category === 'sight' && String(row.activity || '').includes(event)
      && row.startTime === fact.startTime && row.endTime === fact.endTime)) issues.push('未保留太阳光线固定窗口');
  });
  const firstSight = sorted.findIndex((row) => row.category === 'sight' && !/日出/.test(row.activity));
  const lastSight = sorted.reduce((index, row, i) => row.category === 'sight' ? i : index, -1);
  let checkins = 0;
  sorted.forEach((row, i) => {
    const text = positiveInstructions(`${row.activity || ''}；${row.note || ''}`);
    const actualCheckin = /办理入住|入住.*(?:放下|寄存)/.test(positiveInstructions(row.activity || ''));
    if (actualCheckin && ((row.category === 'hotel' && ++checkins > 1)
      || (row.category === 'transport' && checkins > 0))) {
      issues.push('同一天重复办理入住或重复放下大件行李');
    }
    if (context.sameHotel && /办理入住|重新入住|放下(?:大件)?行李/.test(text)) issues.push('连住期间重复入住或放下大件行李');
    if (i > firstSight && firstSight >= 0 && i < lastSight
      && /(?:返回|回到|回).*?(?:酒店|民宿|住宿|客栈)/.test(row.activity || '')
      && !/取回|退房/.test(row.activity || '') && context.scenicRoute && !context.middayRest) issues.push('景区核心游线中途折返住宿地');
    if (context.isLast && /寄存|暂存|寄放/.test(text) && !/取回/.test(text)) issues.push('末日错误寄存行李');
    if (!context.lightLuggage && !context.sameHotel && ['sight', 'transport', 'ticket'].includes(row.category)
      && !(row.category === 'ticket' && !/乘坐|登山|上山|漂流体验|骑行体验/.test(row.activity || ''))
      && !(row.category === 'transport' && sameEndpoint(row.endLocation, context.hotel)
        && /入住|放置|放下|搬运/.test(`${row.activity} ${row.note}`))
      && /竹筏|漂流|骑行|骑.*电动车|登山|登顶|上山|深度.*山|攀登|索道|缆车|雪地徒步|高海拔徒步/.test(row.activity || '')
      && !/山脚|不上山|不登山|不登顶/.test(row.activity || '')) {
      const hasDrop = sorted.slice(0, i).some((entry) => !/退房/.test(entry.activity || '')
        && sameEndpoint(entry.endLocation, context.hotel)
        && (entry.category === 'hotel' || /入住|放下(?:大件)?行李|放置行李/.test(entry.activity || '')));
      const hasStore = sorted.slice(0, i).some((entry) => /寄存|暂存|寄放/.test(positiveInstructions(`${entry.activity}；${entry.note}`)));
      if (!hasDrop && !hasStore) issues.push('携带大件行李安排了不便随身携带的活动');
    }
  });
  sorted.forEach((row, i) => {
    if (row.category !== 'transport' || !row.startLocation || !row.endLocation) return;
    const duplicate = sorted.slice(0, i).findIndex((earlier) => earlier.category === 'transport'
      && sameEndpoint(earlier.startLocation, row.startLocation) && sameEndpoint(earlier.endLocation, row.endLocation));
    if (duplicate >= 0 && !sorted.slice(duplicate + 1, i).some((entry) =>
      sameEndpoint(entry.endLocation, row.startLocation))) issues.push('同方向交通重复执行且没有返回起点');
  });
  issues.push(...evidence.geometryIssues(sorted, context.points || {}));
  let location = context.previousHotel || (context.isFirst ? context.origin : '');
  let lastEnd = null;
  sorted.forEach((row) => {
    const start = row.startLocation;
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
      if ((context.official || []).some((proof) => sameEndpoint(proof.startLocation, row.startLocation)
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
  const key = JSON.stringify([day.date, day.highlights, previous.hotel, day.hotel, routes]);
  const usable = (value) => value && ((value.routeFacts || []).length || value.scenicRoute || value.notes || (value.warnings || []).length);
  if (day.executionEvidence && day.executionEvidence.key === key && usable(day.executionEvidence)) return day.executionEvidence;
  const end = Math.min(deadline, Date.now() + 40000);
  if (end - Date.now() < 5000) return {};
  try {
    const text = await llm.chatWithRetry([
      { role: 'system', content: '你只核查旅行运营知识，不制定时间线。联网查运营方/交通官网，找不到就明确未知，不复制候选的地理假设。只输出JSON。' },
      { role: 'user', content: `核查日期${day.date}，昨晚在${previous.hotel || profile.origin}，今晚在${day.hotel || profile.origin}。景点${JSON.stringify(day.highlights)}。待核查路线${JSON.stringify(routes)}。
独立核对：各铁路段是否真实直达，若不能直达给区域铁路枢纽的换乘链；各交通段通常至少多少分钟；步行段是否过远；景区内部实际入口、观光车、索道上下站及核心游览顺序；游船等级对应的出发码头/方向；冬季开放窗口与末班交通。没有证据不要给班次号或未来售票时刻。公路省道长途/山区不能按高速最高速度算时间。小型城际站不能凭空开往远方城市，市内地铁站不可作为长途高铁枢纽。说明实际可执行的替代路径，但不要编时间线。输出简短JSON：{"routeFacts":[{"from":"候选起点","to":"候选终点","mode":"train|bus|ride|walk|ship","direct":true,"via":[],"minMinutes":0,"sourceUrl":"证据链接，无证据留空"}],"scenicRoute":"核查后的游线和索道/步行/接驳连接，不确定项明确待确认","warnings":["事实矛盾或执行限制"],"sources":["运营方/交通官网链接"]}` },
    ], { deadline: end, enableSearch: true, temperature: 0.1 });
    let parsed;
    try { parsed = llm.parseJSONFromText(text); } catch (_) { parsed = null; }
    if (Array.isArray(parsed)) parsed = { routeFacts: parsed };
    else if (parsed && parsed.from && parsed.to) parsed = { routeFacts: [parsed] };
    if (!parsed || !Array.isArray(parsed.routeFacts)) {
      // 检索报告有时不用约定字段或返回说明文；它仍可作为未核验的知识
      // 提示，但不能伪装成结构化事实，也不因此反复丢掉整轮检索成果。
      const result = { key, routeFacts: [], scenicRoute: '', warnings: [],
        notes: String(text || '').slice(0, 5000), sources: [] };
      if (!result.notes) return {};
      day.executionEvidence = result;
      return result;
    }
    if (!parsed.routeFacts.length && !parsed.scenicRoute && !(parsed.warnings || []).length) {
      console.warn('[generatePlan.review] 运营知识返回空内容，不能视为已核查');
      return {};
    }
    const result = { key, routeFacts: Array.isArray(parsed.routeFacts) ? parsed.routeFacts.filter((fact) =>
      fact && fact.from && fact.to) : [],
    scenicRoute: String(parsed.scenicRoute || '').slice(0, 1600), warnings: (parsed.warnings || []).slice(0, 8),
    sources: (parsed.sources || []).filter((url) => /^https?:\/\//.test(url)).slice(0, 5) };
    day.executionEvidence = result;
    return result;
  } catch (error) {
    console.warn('[generatePlan.review] 独立运营核查暂不可用：%s', error.message);
    return {};
  }
}

async function reviewExecutionItems(profile, outline, items, deadline, options = {}) {
  const days = outline.days || [];
  const indexes = [...new Set(items.map((row) => Number(row.dayIndex || 0)))];
  const results = await Promise.all(indexes.map(async (dayIndex) => {
    const original = items.filter((row) => Number(row.dayIndex || 0) === dayIndex);
    if (original.every((row) => row.executionReview === REVIEW_VERSION)) return original;
    if (deadline - Date.now() < 5000) return original;
    const day = days[dayIndex] || {};
    const previous = days[dayIndex - 1] || {};
    const official = (day.moves || []).filter((move) => move.schedSource === '12306').map((move) => ({
      startLocation: move.from, endLocation: move.to, startTime: move.startTime, endTime: move.endTime, code: move.code,
    }));
    const required = (profile.mustVisit || []).filter((name) =>
      String(day.city || '').replace(/市$/, '') === name.replace(/市$/, '')
      || (day.highlights || []).some((point) => String(point).includes(name) || name.includes(String(point)))
      || dayIndex === days.findIndex((candidate) => String(candidate.overnight || '').includes(name.replace(/市$/, ''))));
    const context = {
      isFirst: dayIndex === 0, isLast: dayIndex === days.length - 1,
      origin: profile.origin, goTime: profile.goTime, backTime: profile.backTime,
      noDrive: String(profile.transport || '').trim() !== '自驾出行', selfDriveAllowed: options.selfDriveAllowed,
      preferRail: /高铁|动车|铁路/.test(profile.transport || '')
        && !/飞机|航班|航空|接受飞行/.test(positiveInstructions(profile.extra)),
      required, scopeCandidates: profile.mustVisit || [], official, city: day.city, date: day.date, hotel: day.hotel, overnight: day.overnight,
      sameHotel: !!day.hotel && sameEndpoint(day.hotel, (days[dayIndex - 1] || {}).hotel),
      previousHotel: previous.hotel,
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
    const regions = [profile.origin, profile.dest, previous.overnight, day.overnight, day.city].filter(Boolean).join(' ');
    // 运营检索与整天重排拆轮，不能把两个约20秒的联网请求挤进一个云函数。
    // 首轮仅缓存独立知识，下一轮重排；未核查的日期不提前标成通过。
    const hadEvidence = !!day.executionEvidence && ((day.executionEvidence.routeFacts || []).length
      || day.executionEvidence.scenicRoute || day.executionEvidence.notes || (day.executionEvidence.warnings || []).length);
    const [operating, freshPoints, topology] = await Promise.all([
      collectOperatingEvidence(profile, day, previous, original, deadline),
      evidence.collectRoutePoints(original, regions, Math.min(deadline - 20000, Date.now() + 5000)),
      evidence.collectRailTopology(original, Math.min(deadline, Date.now() + 12000)),
    ]);
    const points = Object.assign({}, day.executionPoints || {}, freshPoints);
    day.executionPoints = points;
    const roads = await evidence.collectRoadTravelFacts(original, points, Math.min(deadline - 15000, Date.now() + 3500));
    const transits = await evidence.collectUrbanTransitFacts(original, points, Math.min(deadline - 15000, Date.now() + 2000));
    if (!operating.key || !hadEvidence) {
      console.log('[generatePlan.review] 第%d天%s，下一轮执行时间线复核', dayIndex + 1,
        operating.key ? '运营知识已检索' : '运营知识暂未取得');
      return original;
    }
    context.routeFacts = (operating.routeFacts || []).filter((fact) => !topology.concat(roads, transits).some((proof) =>
      sameEndpoint(proof.from, fact.from) && sameEndpoint(proof.to, fact.to) && proof.mode === fact.mode)).concat(topology, roads, transits);
    context.points = points;
    const requirements = {};
    ['origin', 'dest', 'startDate', 'endDate', 'goTime', 'backTime', 'party', 'people', 'budget', 'pace',
      'interests', 'transport', 'mustVisit', 'mustGo', 'extra'].forEach((key) => { requirements[key] = profile[key]; });
    const candidate = Array.isArray(day.executionCandidate) ? day.executionCandidate : original;
    const prompt = `你是旅行执行审计员，逐段复核并重排这一天，返回完整可执行时间线，不要解释。当前条目是未经信任的候选，可能包含错误地理、编造铁路或地铁、错误游船方向。请用联网检索核对运营知识，再重排，不能直接复制这些错误。已核验铁路事实和太阳窗口除外。
用户需求：${JSON.stringify(requirements)}
本日（第${dayIndex + 1}天）：${JSON.stringify({ date: day.date, city: day.city, theme: day.theme,
      hotel: day.hotel, overnight: day.overnight, highlights: day.highlights,
      moves: (day.moves || []).map(({ from, to, mode, startTime, endTime }) => ({ from, to, mode, startTime, endTime })) })}
昨晚住宿：${JSON.stringify({ overnight: previous.overnight, hotel: previous.hotel })}
后续日：${JSON.stringify({ date: (days[dayIndex + 1] || {}).date, city: (days[dayIndex + 1] || {}).city,
      hotel: (days[dayIndex + 1] || {}).hotel, highlights: (days[dayIndex + 1] || {}).highlights })}
当前条目：${JSON.stringify(candidate.map((row) => ({ startTime: row.startTime, endTime: row.endTime,
      category: row.category, activity: String(row.activity || '').slice(0, 160), startLocation: row.startLocation,
      endLocation: row.endLocation, transportType: row.transportType, note: String(row.note || '').slice(0, 80) })))}
已核验、绝对不能修改的铁路事实：${JSON.stringify(official)}
太阳光线固定窗口：${JSON.stringify(facts)}
代码检查：${JSON.stringify(executionIssues(original, context))}
上一轮未通过的验收项：${JSON.stringify(day.executionReviewIssues || [])}
独立运营核查（与候选冲突时，必须重新选真实路径，不只是删去车次）：${JSON.stringify(operating)}
当前12306运行网络核查（只证明连接及耗时下限，不是未来班次；无直达必须换实际区域枢纽）：${JSON.stringify(topology)}
地图公路导航估算（不可缩短为高速直线距离；公交/班车另加候车、停靠及节假日余量）：${JSON.stringify(roads)}
已核查市内公共交通（其他线路号/换乘站不可编造）：${JSON.stringify(transits)}
地图定位证据（直线距离只是下限，不能冒充实际路程）：${JSON.stringify(points)}
当地日落估算（由地图坐标计算，户外山地游线应在此前完成，不替代开放公告）：${JSON.stringify(Object.fromEntries(Object.entries(points).map(([name, point]) => [name, solarEventMinute(day.date, point.lat, point.lon, true)])))}
规则：
1. 首日必须在${profile.goTime || '用户指定时间'}从${profile.origin}启程；不是此时列车发车。返程日必须在${profile.backTime || '用户指定时间'}到${profile.origin}结束。市内去车站至少留交通耗时和40分钟安检缓冲。返家接驳至少${context.homeAccessMin || '实际交通所需'}分钟，不能为凑到家时间随意压缩通勤耗时。
2. 补齐真实游览，抵达/买票不算游玩。先交通后游览，先在酒店放下大件行李再外出；连续住同酒店时大件留房，晚上只是回房，不能重复入住/放行李。换城时带走全部行李；只有当天实际寄存过才写取回行李。寄存必须有明确同地点取回路径，末日绝不安排酒店或景区寄存，携带全部行李只走山脚/城市平缓短线，不能拖箱登山、坐竹筏、漂流或骑行，必要时改为景区门口或山脚核心点的30分钟以上游览。不把大件行李解释为轻便双肩包。早餐午餐晚餐在合理时段，所有景区在开放且光线合理时段游玩，不能早上等待日落。
3. 路线按实际距离和游览时长安排，禁止折返折叠和凭空换城。景区核心点可同日，但步行、接驳、排队和下山时间必须足够；放行李在游线开始前，游线中途不要再回住宿地，沿途用餐后继续前进，最后回住宿地收尾。删除非必要点，不得删用户必去点。不得将A景点贴到B条目上假装已经游览。末日最后一段交通直接以用户到家时间结束，不要提前到家再用整理行李填满时间。
4. 铁路不能到汽车站/码头/游客中心，需实际可检索的铁路枢纽；没有直达应写真实换乘链，到发站只能选一个准确站名，不能“X站/Y站”二选一。小型城际站到远方城市先回区域高铁枢纽再换乘，不要把城际站伪装成长途高铁始发站。联网检索与候选安排冲突时，以运营方和交通官网为准重新选线。非官方班次不得编车次，所有此类交通用估算窗口且note写“班次与时刻待核实”。不能因为未开售/查不到就把真实铁路换成大巴。无铁路的景区段用旅游专线、大巴或司机接送。城市没有地铁时不能编造地铁线路；距离较远不能写成步行十分钟。只有明确选择自驾或点名具体段自驾才可安排本人驾驶。普通市内返家不得写景区接驳。不要在任何备注中编造后续日期车次。
5. 旅游游船的等级、码头、方向须符合运营实际；下船后不要再走船上的景点。住宿只能用本日已有核验酒店的准确名称或明确的住宿片区，不要新造酒店/餐馆。不要改过夜城市。非末日最终回本晚住宿地休息。
输出JSON（完整收尾，优先保留必去游览而非可选夜宵；回房必须写准确酒店名称，不能只填“房间”）：{"items":[{"startTime":"HH:mm","endTime":"HH:mm","category":"transport|hotel|food|sight|ticket|other","activity":"简明活动","startLocation":"准确起点","endLocation":"准确终点","transportType":"train|ship|bus|ride|walk|car或空","note":"简短执行要点"}],"moves":[{"from":"主交通起点","to":"主交通终点","mode":"train|ship|bus|ride|car","code":"仅官方事实可填","startTime":"HH:mm","endTime":"HH:mm","transfer":"接驳方式及预计耗时"}]}`;
    try {
      let text = await llm.chatWithRetry([
        { role: 'system', content: '仅输出合法JSON；按时间与地点依赖逐段审核旅行，不能用改标签冒充解决问题。' },
        { role: 'user', content: prompt },
      ], { deadline, enableSearch: true, temperature: 0.1 });
      let parsed = llm.parseJSONFromText(text);
      if (Array.isArray(parsed)) parsed = { items: parsed };
      if (!parsed || !Array.isArray(parsed.items)) {
        day.executionReviewIssues = ['复核输出缺少完整 items 数组，必须按指定JSON结构输出完整时间线'];
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
      let errors = executionIssues(cleaned, context);
      if (errors.length) { day.executionReviewIssues = errors; day.executionCandidate = cleaned; }
      if (errors.length && deadline - Date.now() >= 25000) {
        text = await llm.chatWithRetry([
          { role: 'system', content: '仅输出完整合法JSON，修复明确的执行验收问题，不要解释。' },
          { role: 'user', content: prompt }, { role: 'assistant', content: text },
          { role: 'user', content: `验收没有通过：${errors.join('；')}。逐项修正后重新输出完整JSON，保留其他合理安排。` },
        ], { deadline, enableSearch: true, temperature: 0.1 });
        const retry = llm.parseJSONFromText(text);
        if (retry && Array.isArray(retry.items)) {
          parsed = retry;
          cleaned = normalizeReviewRows(parsed.items, dayIndex, context);
          errors = executionIssues(cleaned, context);
        }
      }
      if (errors.length) {
        day.executionReviewIssues = errors;
        day.executionCandidate = cleaned;
        console.warn('[generatePlan.review] 第%d天复核未通过验收：%s；末项=%s', dayIndex + 1, errors.join('；'),
          JSON.stringify(cleaned[cleaned.length - 1] || {}));
        return original;
      }
      if (Array.isArray(parsed.moves)) {
        // 大纲移动段来自已验收详情，只保留真实交通；不能让模型另造一份
        // 不连续 moves，或把景区步行/用餐地点混进大交通。
        const moves = cleaned.filter((row) => row.category === 'transport'
          && row.startLocation && row.endLocation && row.transportType !== 'walk').map((move) => {
          const fact = official.find((row) => sameEndpoint(row.startLocation, move.startLocation) && sameEndpoint(row.endLocation, move.endLocation));
          return fact ? Object.assign({}, (day.moves || []).find((row) => sameEndpoint(row.from, move.startLocation) && sameEndpoint(row.to, move.endLocation)))
            : { from: String(move.startLocation), to: String(move.endLocation), mode: String(move.transportType || 'bus'), code: '',
              startTime: move.startTime, endTime: move.endTime, transfer: '',
              timingEstimated: true, scheduleRequired: move.transportType === 'train' };
        });
        if (official.every((fact) => moves.some((move) => sameEndpoint(move.from, fact.startLocation) && sameEndpoint(move.to, fact.endLocation)))) day.moves = moves;
      }
      cleaned.forEach((row) => {
        row.city = day.city || '';
        const fact = official.find((entry) => sameEndpoint(entry.startLocation, row.startLocation) && sameEndpoint(entry.endLocation, row.endLocation)
          && entry.startTime === row.startTime && entry.endTime === row.endTime);
        if (fact) { row.schedSource = '12306'; row.outlineMove = true; }
        const solar = facts.find((entry) => entry.startTime === row.startTime && entry.endTime === row.endTime);
        if (solar) row.timingLocked = true;
        row.executionReview = REVIEW_VERSION;
      });
      delete day.executionReviewIssues;
      delete day.executionCandidate;
      day.executionNetworkFacts = context.routeFacts.filter((fact) => fact.networkOnly);
      day.executionRoadFacts = context.routeFacts.filter((fact) => fact.drivingEstimate);
      day.executionTransitFacts = context.routeFacts.filter((fact) => fact.transitEstimate);
      day.executionPoints = context.points;
      console.log('[generatePlan.review] 第%d天执行复核通过，%d条', dayIndex + 1, cleaned.length);
      return cleaned;
    } catch (error) {
      console.warn('[generatePlan.review] 第%d天复核暂不可用：%s', dayIndex + 1, error.message);
      return original;
    }
  }));
  return results.flat();
}

module.exports = { REVIEW_VERSION, minute, sameEndpoint, fitEstimatedReturn, fitEstimatedConnections, normalizeReviewRows, executionIssues, reviewExecutionItems };
