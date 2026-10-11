// cloudfunctions/parseTravelPlan/alarm-infer.js
// ============ 攻略没写抢票时间时，由 AI 反推「待办日历」 ============
//
// 现实问题：绝大多数攻略文档只写"9月30日 重庆北→桂林西 G2249"，压根不写
// "9月16日开票去抢票"。解析出来 alarms 为空 → 闹钟页一片空白，用户以为没这功能。
// 所以：不以闹钟数量为门槛，用完整行程逐项反推一份
// 「什么时候该去抢票 / 预订 / 准备」的待办清单，补进闹钟页。
//
// 时间仍然由代码按国内各平台真实规则兜底校验，AI 只负责提名事项。

const { chatWithRetry, parseJSONFromText } = require('./llm');
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('./cn-time');

const DAY_MS = 86400000;
const INFER_THRESHOLD = 3;   // 仅保留旧接口兼容；完整查漏不再受数量门槛限制。

function asArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function shiftDate(dateStr, days) {
  return tsToDateStr(parseCnTime(`${dateStr}T00:00:00`) + days * DAY_MS);
}

function dateOf(ts) {
  return tsToDateStr(Number(ts) || 0);
}

function textOf(item) {
  return `${item && item.activity || ''} ${item && item.note || ''} ${item && item.bookingInfo || ''} ${item && item.startLocation || ''} ${item && item.endLocation || ''}`;
}

// 攻略如果明确写了“08:30 开票/起售”，优先使用这个时刻；没有明确来源时才用规则基准时刻。
function actionClockOf(text, fallback) {
  const s = String(text || '');
  const patterns = [
    /(?:开票|放票|起售|开售|售票)[^\d]{0,8}([01]?\d|2[0-3])[:：]([0-5]\d)/,
    /([01]?\d|2[0-3])[:：]([0-5]\d)[^。；,，\n]{0,12}(?:开票|放票|起售|开售|售票)/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  }
  return fallback;
}

function ruleAlarm(title, dateStr, timeStr, type, note) {
  const fireAt = parseCnTime(`${dateStr}T${timeStr}:00`);
  if (!fireAt || fireAt <= Date.now()) return null;
  return {
    title: String(title).slice(0, 100),
    note: String(note || '').slice(0, 240),
    fireAt,
    fireAtStr: tsToCnDateTimeStr(fireAt),
    leadMinutes: 5,
    remindAt: fireAt - 5 * 60 * 1000,
    completed: false,
    type,
    source: 'rule',
  };
}

/**
 * 从已经解析出的详细行程做一次确定性查漏。
 * LLM 提名可能只返回部分事项，不能因为数量已经达到阈值就跳过车票/酒店/门票。
 */
function backfillRuleAlarms(ctx, existing) {
  const c = ctx || {};
  if (!c.startDate) return [];
  const base = Array.isArray(existing) ? existing : [];
  const out = [];
  // 原文车次证据不能被模型漏提或误写“已购买”抹掉；同一路段靠车次/日期去重。
  const sourceItems = asArray(c.days).flatMap((day) => asArray(day.lines).flatMap((line) => {
    const original = String(line || '');
    const text = original.replace(/^\s*\d{1,2}[:：]\d{2}(?:\s*[-–—~～至]\s*\d{1,2}[:：]\d{2})?\s*(?:左右)?\s*/, '');
    const codes = [...text.matchAll(/\b[GDCKTZ]\d{1,5}\b/gi)].map((match) => match[0]);
    if (!codes.length && !/游船|竹筏|索道|缆车|景区门票|直达大巴/.test(text)) return [];
    if (!codes.length && asArray(c.items).some((item) => Number(item.dayIndex) === Number(day.index)
      && /^(?:乘坐|乘|搭乘|体验|游览|观看)/.test(item.activity || '')
      && (text.match(/游船|竹筏|索道|缆车/g) || []).some((product) => String(item.activity || '').includes(product)))) return [];
    if (!codes.length && /^(?:前往|步行|打车|抵达|到达)/.test(text)
      && !/购票|购买|乘坐|搭乘|体验/.test(text)) return [];
    const times = original.match(/\b\d{1,2}:\d{2}\b/g) || [];
    return [{ dayIndex: day.index, startTime: times[0] || '', endTime: times[1] || '',
      activity: text, category: codes.length ? 'transport' : 'sight', transportType: codes.length ? 'train' : '',
      sourceReservation: true }];
  }));
  const items = sourceItems.concat(asArray(c.items));
  const dayDate = (it) => shiftDate(c.startDate, Number(it && it.dayIndex) || 0);
  const normalized = (s) => String(s || '').replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
  const already = (candidate, text) => {
    const keyText = normalized(text);
    const codes = [...keyText.matchAll(/[gdcktz]\d{1,5}/g)].map((m) => m[0]);
    return base.concat(out).some((a) => {
      if (a.type !== candidate.type || dateOf(a.fireAt) !== dateOf(candidate.fireAt)) return false;
      const oldText = normalized(a.title);
      if (codes.length) return codes.some((code) => new RegExp(`${code}(?!\\d)`).test(oldText));
      const old = oldText.replace(/^(?:准备|预约|预订|抢票)/, '').replace(/\d{4}-\d{2}-\d{2}/g, '');
      const products = /游船|竹筏|漂流|缆车|索道|演出/g;
      const product = (keyText.match(products) || []).join('|');
      const oldProduct = (old.match(products) || []).join('|');
      // 产品相同且地点一致才合并；景区门票与索道不是同一产品。
      const place = normalized(candidate.reservationPlace);
      return old.length >= 4 && (keyText.includes(old) || old.includes(keyText))
        || !!place && product === oldProduct && oldText.includes(place);
    });
  };
  const add = (a, text) => {
    if (a && !already(a, text)) out.push(a);
  };

  items.forEach((it) => {
    const text = textOf(it);
    const date = dayDate(it);
    const isHotel = it.category === 'hotel'
      || /入住|住宿|住在|住进|(?:酒店|民宿|客栈|宾馆).*?(?:睡觉|休息|过夜)/.test(String(it.activity || ''));
    if (isHotel) {
      // 酒店提醒统一在入库前按具名酒店归并，避免每日入住与预订事项重复。
      return;
    }
    if (/已(经)?(购买|预订|预约|订好)|已订|订妥|无需(购买|预约|预订)|不需要(购买|预约|预订)/.test(text)) return;
    const activity = String(it.activity || it.endLocation || it.startLocation || '该事项').slice(0, 70);
    const mode = String(it.transportType || '').toLowerCase();
    const action = String(it.activity || '').replace(/^\s*\d{1,2}[:：]\d{2}(?:\s*[-–—~～至]\s*\d{1,2}[:：]\d{2})?\s*(?:左右)?\s*/, '');
    const transferOnly = /安检|检票|候车|候船|乘船手续|确认.*末班|抵达.*停车场/.test(action)
      || (/^(?:步行|打车|出发|前往|抵达).{0,50}(?:车站|高铁站|火车站|码头|索道游客中心)/.test(action)
        && !/购买|预订|预约|乘坐.*(?:游船|竹筏|索道)/.test(action));
    if (transferOnly) return;
    // “电动车”不是“动车”；地点/备注提到高铁站也不表示本段乘列车。
    const cycling = /电动车|电动自行车|自行车|骑行/.test(action);
    const experience = action.match(/^(?:乘坐|搭乘|乘|体验)([^，。；]{0,24})(?:游船|竹筏|漂流|索道|缆车)/);
    const experienceAction = !!experience && !/网约车|出租车|大巴|公交|直通车|前往|抵达|到达/.test(experience[1]);
    const rail = !cycling && !experienceAction && (mode === 'train'
      || /^(?:乘坐|搭乘|乘|换乘|坐).{0,12}(?:高铁|动车|火车|列车)|\b[GDCKTZ]\d{1,5}\b/i.test(action));
    const plane = !experienceAction && (mode === 'plane' || /(?:乘|搭乘).{0,10}(?:航班|飞机)|购买.*机票/.test(action));
    const longBus = /大巴|直通车|长途|旅游专线/.test(action);
    const bus = !cycling && !/观光车|景区接驳/.test(action) && longBus
      && !/打车|网约车|步行/.test(action);
    if (rail || plane || bus) {
      // 原文已保留车次时，模型遗漏编号的同路段只补信息，不再生成一张泛称票。
      if (rail && !/\b[GDCKTZ]\d{1,5}\b/i.test(action) && sourceItems.some((source) =>
        source.transportType === 'train' && Number(source.dayIndex) === Number(it.dayIndex)
        && [it.startLocation, it.endLocation].filter(Boolean).length === 2
        && [it.startLocation, it.endLocation].every((place) =>
          normalized(source.activity).includes(normalized(place).replace(/站$/, ''))))) return;
      const type = rail ? 'train' : plane ? 'plane' : 'bus';
      const before = rail ? 14 : plane ? 30 : 5;
      const clock = actionClockOf(text, rail ? '09:00' : '10:00');
      const route = [it.startLocation, it.endLocation].filter(Boolean).join('→');
      const explicitBusRoute = bus && activity.match(/(?:乘坐|搭乘|乘)([^→，。；]{2,30})→([^，。；]{2,30}?)(?:的(?:直通车|大巴|班车)|$)/);
      const returnBusStop = bus && (activity.match(/返回([^，。；]{2,20}站)/) || [])[1];
      const candidate = ruleAlarm(
        `准备${date} ${activity}${route && !activity.includes(route) ? `〔${route}〕` : ''}（${plane ? '机票' : '车票'}）`,
        shiftDate(date, -before),
        clock,
        type,
        `根据详细行程自动补齐，按提前 ${before} 天开始关注放票/购票。${rail ? `乘车${date} ${it.startTime || ''}；09:00仅为关注提醒，不代表该站起售时间。` : ''}具体放票时间以官方 App 为准，下单前请核对。`
      );
      if (candidate) Object.assign(candidate, { dayIndex: Number(it.dayIndex) || 0,
        reservationFrom: explicitBusRoute ? explicitBusRoute[1] : it.startLocation || '',
        reservationTo: explicitBusRoute ? explicitBusRoute[2] : returnBusStop || it.endLocation || '',
        usageInfo: `乘车日期：${date}；时间：${it.startTime || '待确认'}${it.endTime ? '–' + it.endTime : ''}；${activity}`.slice(0, 180),
        bookingInfo: `${activity} ${route}`.slice(0, 160) });
      add(candidate, `${activity}${it.startLocation || ''}${it.endLocation || ''}`);
      return;
    }

    // 公交/接驳的买票动作不是景区门票；普通公交通常没有提前预售。
    if (/公交车票|观光车票|接驳车票/.test(action) && !/门票|套票|游船|竹筏/.test(action)) return;
    const ticketLike = it.category === 'ticket'
      || (it.category === 'sight' && /(?:游览|参观|游玩|入园).{0,40}(?:景区|梯田|瀑布|主题公园|博物馆)/.test(String(it.activity || '')))
      || (!cycling && /门票|船票|游船|竹筏|漂流|演出|缆车|索道|温泉|跟拍/.test(action));
    if (ticketLike) {
      const productWords = action.match(/游船|竹筏|漂流|索道|缆车|演出/g) || [];
      const sourceEvidence = asArray(c.days).filter((day) => Number(day.index) === Number(it.dayIndex))
        .flatMap((day) => asArray(day.lines)).filter((line) => productWords.some((word) => String(line).includes(word))).join('；');
      const nextDaySale = (text + '；' + sourceEvidence).match(/(?:每天)?([01]?\d|2[0-3])[:：]([0-5]\d).{0,8}(?:抢|购|预订|预约).{0,8}(?:第二天|次日|翌日).{0,8}票/);
      const clock = nextDaySale ? `${String(Number(nextDaySale[1])).padStart(2, '0')}:${nextDaySale[2]}` : actionClockOf(text, '09:00');
      const candidate = ruleAlarm(
        `预约${date} ${activity}`,
        shiftDate(date, nextDaySale ? -1 : -7),
        clock,
        'ticket',
        nextDaySale ? `攻略注明前一日${clock}购买次日票；请提前向运营方核实最新可售日期和起售时间。`
          : '根据详细行程自动补齐，提前核对门票/预约要求与可售日期，免费且无需预约则不用购票。09:00是建议关注时刻，不代表景区起售时间，具体开放时间以景区公告为准。'
      );
      if (candidate) candidate.reservationPlace = /游船|竹筏|漂流|缆车|索道/.test(action)
        ? String(it.startLocation || it.endLocation || '').replace(/(?:游客中心|观景台|码头)$/, '') : it.endLocation || '';
      if (candidate) Object.assign(candidate, { dayIndex: Number(it.dayIndex) || 0,
        usageInfo: `使用时间：${date} ${it.startTime || '时段待确认'}${it.endTime ? '–' + it.endTime : ''}；${activity}`.slice(0, 180) });
      add(candidate, activity);
      return;
    }

    // 详细攻略里如果明确写了证件、药品、装备、租车等行前准备，也单独落一条待办；
    // 不能只靠一条笼统的“核对订单”提醒，否则用户容易漏掉需要提前办理的事项。
    const prepLike = /^(?:行前|出发前|提前|准备|检查|核对|预订|预约).{0,30}(?:身份证|护照|签证|通行证|驾照|药品|充电宝|装备|宠物|外币|流量卡|保险|值机|选座|租车|包车|接送机)/.test(action);
    if (prepLike) {
      const candidate = ruleAlarm(
        `准备${date} ${activity}`,
        shiftDate(date, -3),
        '20:00',
        'other',
        '根据详细行程自动补齐，出发前检查材料、装备或服务是否已经准备好。'
      );
      add(candidate, activity);
    }
  });

  // 原文的每日目的地补父景区门票核验，防止内部观景点/索道替代入园票。
  const scenicNames = new Set();
  asArray(c.days).forEach((day) => {
    const names = String(day.title || '').match(/[\u4e00-\u9fa5·]{1,18}(?:梯田|瀑布|景区|博物馆|主题公园)/g) || [];
    names.forEach((rawName) => {
      const name = rawName.replace(/^(?:游览|参观|前往|抵达|游玩)/, '');
      const bareName = (value) => normalized(value).replace(/跨国|风景区|景区|游客中心/g, '');
      if (scenicNames.has(name) || base.concat(out).some((alarm) => alarm.type === 'ticket'
        && !/索道|缆车|游船|竹筏|漂流/.test(alarm.title) && bareName(alarm.title).includes(bareName(name)))) return;
      scenicNames.add(name);
      const date = shiftDate(c.startDate, Number(day.index) || 0);
      add(ruleAlarm(`核验${date} ${name}门票/预约`, shiftDate(date, -7), '09:00', 'ticket',
        '景区入园与内部体验分别核验，确认门票有效期及预约要求；免费或无需预约时不用购票，具体以运营方公告为准。'), `${name}门票`);
    });
  });

  // 行程前的通用准备事项也要有一条长期待办，避免上传攻略只有票务没有行前准备。
  const prepareDate = shiftDate(c.startDate, -2);
  const generic = ruleAlarm(
    '核对证件、订单与旅行装备',
    prepareDate,
    '20:00',
    'other',
    '根据详细行程自动补齐：逐项检查车票、门票、酒店订单、身份证、药品和充电设备。'
  );
  add(generic, '证件订单装备');
  return out;
}

/** 合并原文、模型提名和规则兜底：使用日期/产品/实际路段去重，不用四字前缀。 */
function completeReservationAlarms(ctx, existing) {
  const c = ctx || {}, source = asArray(existing);
  const rules = backfillRuleAlarms(c, []);
  const normalize = (value) => String(value || '').replace(/[\s（）()·-]/g, '').replace(/跨国|风景区|景区|游客中心|站/g, '');
  const codeOf = (alarm) => (String(alarm.title || '').match(/\b[GDCKTZ]\d{1,5}\b/i) || [''])[0].toUpperCase();
  const useDate = (alarm) => (String(alarm.usageInfo || alarm.title || '').match(/20\d{2}-\d{2}-\d{2}/) || [])[0]
    || shiftDate(dateOf(alarm.fireAt), alarm.type === 'train' ? 14 : alarm.type === 'ticket' ? 7 : alarm.type === 'bus' ? 5 : 0);
  const gateNames = [...new Set(asArray(c.days).flatMap((day) =>
    String(day.title || '').match(/[\u4e00-\u9fa5·]{1,18}(?:梯田|瀑布|景区|博物馆|主题公园)/g) || []))];
  const product = (alarm) => {
    const text = String(alarm.title || '');
    if (/索道|缆车/.test(text)) return 'cable';
    if (/游船|船票/.test(text)) return 'cruise';
    if (/竹筏|漂流/.test(text)) return 'raft';
    const gate = gateNames.find((name) => normalize(text).includes(normalize(name))
      || normalize(name).replace(/梯田|瀑布|博物馆|主题公园$/, '').length >= 2
        && normalize(text).includes(normalize(name).replace(/梯田|瀑布|博物馆|主题公园$/, '')));
    return gate ? `gate:${normalize(gate)}` : '';
  };
  const groups = new Map();
  const busRules = rules.filter((alarm) => alarm.type === 'bus');
  const endpointMentioned = (text, place) => {
    const full = normalize(String(place || '').replace(/汽车总站|汽车客运站|客运中心|客运站|汽车站|停车场/g, ''));
    const stripped = full.replace(/市|县|入口|出口|广场/g, '');
    return stripped.length >= 2 && normalize(text).includes(stripped);
  };
  // 规则具备逐段日期/时间信息；原文精确提醒仍优先保留实际办理时刻。
  rules.concat(source).forEach((raw) => {
    const alarm = Object.assign({}, raw);
    let date = useDate(alarm);
    let code = codeOf(alarm);
    const kind = alarm.type === 'ticket' ? product(alarm) : '';
    let busMatch = null;
    if (alarm.type === 'bus') {
      const text = `${alarm.title || ''} ${alarm.bookingInfo || ''}`;
      const matches = busRules.filter((rule) => rule.reservationFrom && rule.reservationTo
        && endpointMentioned(text, rule.reservationFrom) && endpointMentioned(text, rule.reservationTo));
      const onDate = matches.filter((rule) => useDate(rule) === date);
      // 唯一原文路段可纠正把购票日当乘车日的模型提名；多日同线路必须按实际日期分开。
      if (onDate.length === 1 || matches.length === 1) busMatch = onDate[0] || matches[0];
      if (busMatch) date = useDate(busMatch);
    }
    if (alarm.source !== 'rule') {
      const actual = rules.filter((rule) => code ? codeOf(rule) === code
        : kind ? product(rule) === kind : false);
      // 办理日和使用日分开：实际日期从唯一原文事项恢复，原文提醒时刻仍保留。
      const dates = [...new Set(actual.map(useDate))];
      if (dates.length === 1) date = dates[0];
    }
    if (alarm.type === 'train' && !code) {
      const match = rules.find((rule) => rule.type === 'train' && useDate(rule) === date
        && asArray(c.items).some((item) => item.transportType === 'train' && item.startLocation && item.endLocation
          && [item.startLocation, item.endLocation].every((place) => normalize(alarm.title).includes(normalize(place)))
          && [item.startLocation, item.endLocation].every((place) => normalize(rule.title).includes(normalize(place)))));
      if (match) { code = codeOf(match); alarm.title += `（${code}）`; }
    }
    // 同类体验每天存在多个实际产品时不贸然合并，避免漏票。
    const experiences = kind && !kind.startsWith('gate:') ? asArray(c.items).filter((item) =>
      Number(item.dayIndex) === Math.round((parseCnTime(date + 'T00:00:00') - parseCnTime(c.startDate + 'T00:00:00')) / DAY_MS)
      && (item.category === 'sight' || item.transportType === 'ship'
        || /^(?:乘坐|搭乘|乘|体验|游览|参观)/.test(item.activity || '')) && !/^(?:前往|步行|打车|抵达|到达)/.test(item.activity || '')
      && product({ title: item.activity }) === kind) : [];
    const identity = busMatch ? `bus:${date}:${normalize(busMatch.reservationFrom)}>${normalize(busMatch.reservationTo)}`
      : code ? `train:${date}:${code}` : kind && (kind.startsWith('gate:') || experiences.length === 1)
      ? `ticket:${date}:${kind}` : `${alarm.type}:${date}:${normalize(alarm.title)}`;
    const previous = groups.get(identity);
    if (!previous) { groups.set(identity, alarm); return; }
    const winner = alarm.source === 'parsed' ? alarm : previous;
    const other = winner === previous ? alarm : previous;
    winner.usageInfo = winner.usageInfo || other.usageInfo;
    winner.bookingInfo = winner.bookingInfo || other.bookingInfo;
    winner.completed = winner.completed === true || other.completed === true;
    winner.note = [winner.note, other.note].filter(Boolean).join('；').slice(0, 500);
    groups.set(identity, winner);
  });
  return [...groups.values()].sort((a, b) => a.fireAt - b.fireAt);
}

/** 给 LLM 完整逐日摘要，单条文字限长但不截断一天的后续交通。 */
function dayBrief(items, startDate) {
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = it.dayIndex || 0;
    if (!byDay.has(di)) byDay.set(di, []);
    const arr = byDay.get(di);
    // 后半天的返程、索道和演出同样重要，不能只给模型看前六条。
    {
      const hotelInfo = it.category === 'hotel' && it.note ? `（${String(it.note).slice(0, 50)}）` : '';
      arr.push(`${it.startTime || ''}${it.endTime ? '-' + it.endTime : ''} ${String(it.activity || '').slice(0, 100)} ${it.startLocation || ''}→${it.endLocation || ''} ${String(it.bookingInfo || '').slice(0, 100)}${hotelInfo}`);
    }
  });
  const keys = [...byDay.keys()].sort((a, b) => a - b);
  return keys.map((k) => {
    const date = startDate ? shiftDate(startDate, k) : `第${k + 1}天`;
    return `第${k + 1}天 ${date}：${byDay.get(k).join('；')}`;
  }).join('\n');
}

/**
 * 清洗 AI 提名的待办：时间必须解析得出来、不能是过去、不能晚于行程结束后一天
 */
function sanitize(list, endDate) {
  const now = Date.now();
  const tripEndTs = parseCnTime(`${endDate || tsToDateStr(now)}T23:59:00`);
  const out = [];
  const seen = new Set();
  asArray(list).forEach((a) => {
    const title = String((a && a.title) || '').trim();
    if (!title) return;
    const ts = parseCnTime(a.fireAt);
    if (!ts || isNaN(ts) || ts < now || ts > tripEndTs + DAY_MS) return;
    const key = ts + '|' + title.replace(/\s+/g, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      title: title.slice(0, 100),
      note: String(a.note || '').slice(0, 200),
      fireAt: ts,
      fireAtStr: tsToCnDateTimeStr(ts),
      type: ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'].includes(a.type) ? a.type : 'other',
      source: 'ai',
    });
  });
  return out.sort((x, y) => x.fireAt - y.fireAt);
}

/**
 * 反推待办清单（失败返回空数组，绝不影响主流程）
 * @param {object} ctx { title, startDate, endDate, items }
 */
async function inferAlarms(ctx) {
  const c = ctx || {};
  if (!c.startDate) return [];
  try {
    const brief = dayBrief(c.items, c.startDate);
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;

    const prompt = `请根据完整行程逐项查漏，补齐所有需要提前购票/预订的待办。写了车次、时间、酒店名、票价或出行路线不等于已经买票/预订；只有原文明确已买/已订/已预约才免催订。需要门票的景区即使未写“门票”二字也必须提名，不为免费景点虚构收费。
今天是 ${today}（北京时间）。

【行程】${c.startDate} ~ ${c.endDate}｜${c.title || '我的行程'}
${brief}

请穷举所有需要提前预订、抢购、预约或准备的事项，输出 JSON 数组：
[{"title":"...","fireAt":"YYYY-MM-DD HH:mm","type":"train/plane/bus/ticket/hotel/other","note":"..."}]

# 覆盖类别
去程/返程火车票(train)、机票(plane)、长途汽车票(bus)、行程内每段城际交通、
需预约的景区门票与体验项目(ticket)、证件与装备等行前准备(other)。
酒店由代码按逐晚原文单独归并，勿在本次输出酒店，以免重复。

# 时间推算（按国内各平台可查的实际开放时间）
- 火车票 12306 预售 15 天（含乘车当日）：乘车日减 14 天 = 开票日，取 09:00。
- 机票：提前 30 天起关注，取 10:00。
- 长途汽车票：提前 5 天，取 09:00。
- 酒店：尚未预订时，出发前 7 天 20:00 锁定可免费取消房型；已预订则不要生成重复预订待办，入住信息由系统逐日补齐。
- 景区门票：热门提前 7 天开始盯，取 09:00。
- 行前准备：出发前 2-5 天。

# 要求
1. fireAt 必须是未来时刻，按时间从早到晚排序。同日多段铁路分别提名，标题保留每个车次号、起终站及乘车日期，不合成“火车票”一条。船票、竹筏、索道、景区通票和旅游专线按产品独立分类，不把市内公交当长途订票。建议关注时刻不等于官方起售时刻，须说明。
2. title 保留必要信息但不超过40字，note不超过40字，简述提前天数和官方核对要求，完整输出所有事项，不复制整段行程。
3. 算不准宁可不输出，不要编造模糊日期。只输出数组。`;

    const text = await chatWithRetry([
      { role: 'system', content: '你是行程待办助手，只输出严格 JSON，禁止 markdown 代码块和解释文字。' },
      { role: 'user', content: prompt },
    ], 4000, 25000);
    const list = sanitize(asArray(parseJSONFromText(text)), c.endDate);
    console.log('[parseTravelPlan] AI 反推待办 %d 条', list.length);
    return list;
  } catch (e) {
    console.error('[parseTravelPlan] 待办反推失败（不影响主流程）:', e.message);
    return [];
  }
}

module.exports = { inferAlarms, backfillRuleAlarms, completeReservationAlarms, INFER_THRESHOLD, dayBrief, sanitize };
