// cloudfunctions/generatePlan/plan.js
// ============ AI 制定攻略：多阶段生成流水线 ============
//
// 为什么要多阶段而不是"一次全吐出来"：
//   一份 7 天的高质量攻略 ≈ 80+ 条行程项（参考用户提供的《国庆七天广西旅游攻略》实解析出 84 条）。
//   单次请求要么超时（云函数 60s 硬上限），要么后几天质量崩塌（LLM 越写越敷衍）。
//   所以拆成：① 先出全局大纲（保证整体路线合理、不绕路、住宿连得上）
//            ② 再按天并行展开细节（每天一个小请求，质量稳定、总耗时可控）
//            ③ 闹钟用「LLM 提名 + 代码按规则算时间」，不让 LLM 瞎编抢票时刻
//            ④ 建议单独一个请求（失败了也不影响主流程）
//
// 本文件是纯逻辑：只在内存里生成数据，不碰数据库（写库在 index.js）。
// 本地可以直接 require 跑测试（见 scripts/test-generate.js）。

// 走 llm.chatWithRetry（而不是解构出来的局部引用）是为了让测试能替换成假实现，
// 这样"某天失败 → 重试 → 耗尽放弃"这条链路可以脱离真实 LLM 确定性验证。
const llm = require('./llm');
const { parseJSONFromText, asArray, SYS_PROMPT } = require('./llm');
const { sanitizeItems, META_PAT, META_HARD, parseDurationMin } = require('./normalize');
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('./cn-time');
const { cacheKeyOf: scheduleKeyOf, sameStation } = require('./schedule');
const { reviewExecutionItems, executionIssues, invalidateRepeatedMeals, invalidateUnsafeAcceptedDays, syncAcceptedMoves, REVIEW_VERSION } = require('./execution-review');
const { solarEventMinute } = require('./solar-time');

const MAX_DAYS = 12;
const DAY_MS = 86400000;

// ============================================================
// 0. 输入处理（确定性，不交给 LLM）
// ============================================================

/** "2026-09-30" 是否合法 */
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(parseCnTime(`${s}T00:00:00`));
}

/** 两个日期相差天数（含首尾）：9-30 ~ 10-07 → 8 */
function dayDiff(start, end) {
  return Math.round((parseCnTime(`${end}T00:00:00`) - parseCnTime(`${start}T00:00:00`)) / DAY_MS) + 1;
}

/** 北京时间日期加减天数 → "YYYY-MM-DD" */
function shiftDate(dateStr, days) {
  return tsToDateStr(parseCnTime(`${dateStr}T00:00:00`) + days * DAY_MS);
}

/**
 * 用太阳高度角估算景区日出/日落（北京时间分钟数）。
 *
 * 这不是路线映射，也不替代景区当天公告；它只给“日出/日落”一个稳定的
 * 时间锚点，避免模型把 16:30 当成 10 月龙脊日落。调用方仍会检查抵达、
 * 离开和前后条目的余量，不足时宁可不硬塞观景段。
 */
// 龙脊所在纬度/经度只用于太阳时刻估算，任何路线/站点选择仍由大纲和模型决定。
const LONGJI_SOLAR = { latitude: 25.8, longitude: 110.2 };

function longjiSolarMinute(dateStr, sunset) {
  return solarEventMinute(dateStr, LONGJI_SOLAR.latitude, LONGJI_SOLAR.longitude, sunset);
}

/** 星期几（北京时间） */
function weekdayOf(dateStr) {
  const d = new Date(parseCnTime(`${dateStr}T00:00:00`) + 8 * 3600 * 1000);
  return '日一二三四五六'[d.getUTCDay()];
}

/** 出行日期是不是法定长假（国庆 / 春节 / 五一）—— 决定要不要加抢票 / 错峰提醒 */
function isHolidayRange(start, end) {
  const md = [];
  for (let i = 0; i <= dayDiff(start, end); i++) md.push(shiftDate(start, i).slice(5));
  const inNation = md.some((d) => d >= '10-01' && d <= '10-07');
  const inLabor = md.some((d) => d >= '05-01' && d <= '05-05');
  const inSpring = md.some((d) => d >= '01-20' && d <= '02-15');
  return inNation || inLabor || inSpring;
}

// 省级地名：用户写"广西（桂林、阳朔）"时，"广西"只是范围提示，不算必到点
// （北京/上海/天津/重庆/香港/澳门本身是城市级目的地，不在此列）
const PROVINCE_NAMES = new Set([
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西',
  '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西',
  '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆',
]);

/**
 * 目的地清单解析："广西（桂林、龙脊梯田、阳朔、明仕田园和德天瀑布）"
 *   → destList:  ['广西','桂林','龙脊梯田','阳朔','明仕田园','德天瀑布']（进 prompt）
 *   → mustVisit: 去掉省份后的清单（大纲必须逐个覆盖，漏了代码会发起修订）
 * "和"也当分隔符（用户习惯连写）；但像"颐和园"这种切成单字碎片的保留原词，不误伤。
 */
function parseDestList(dest) {
  const cleaned = String(dest || '').replace(/[（）()【】[\]]/g, '、');
  const raw = cleaned.split(/[、，,；;\/|\s]+/).map((s) => s.trim()).filter(Boolean);
  const list = [];
  raw.forEach((tok) => {
    if (tok.includes('和')) {
      const parts = tok.split('和').map((x) => x.trim());
      if (parts.every((x) => x.length >= 2)) { list.push(...parts); return; }
    }
    list.push(tok);
  });
  const uniq = [...new Set(list)];
  return {
    destList: uniq,
    mustVisit: uniq.filter((t) =>
      t.length >= 2 && !t.endsWith('省') && !PROVINCE_NAMES.has(t)),
  };
}

function normalizeInput(input) {
  const i = input || {};
  const startDate = validDate(i.startDate) ? i.startDate : tsToDateStr(Date.now());
  let endDate = validDate(i.endDate) ? i.endDate : startDate;
  let days = dayDiff(startDate, endDate);
  if (days <= 0) { endDate = startDate; days = 1; }
  if (days > MAX_DAYS) { days = MAX_DAYS; }
  const end = days > 1 ? shiftDate(startDate, days - 1) : endDate;

  const party = String(i.party || '朋友同行');
  const peopleNum = parseInt(i.people, 10) || 2;
  const budget = String(i.budget || '舒适');
  const pace = String(i.pace || '适中');
  const interests = Array.isArray(i.interests) ? i.interests.slice(0, 8) : [];
  const transport = String(i.transport || '高铁/动车优先');
  // 分钟级的去/返程时刻：用户指定后，首末两天的大交通必须落在这个时刻上。
  // ⚠️ 语义（2026-09-25 二次修正）：
  //   goTime   = **离开出发地（家门口/酒店）的时刻**——第一天第 1 条就是
  //              「goTime 从出发地出发前往车站」的接驳，大交通在其后发车
  //              （applyTripEdgeTimes 按 goTime+接驳/安检预留推算发车时刻）
  //   backTime = **回到出发地（到家）的时刻**——大交通到站 = backTime-40 分钟
  //              （市内返家接驳），到家那条由细化/DayClosure 兜底生成
  const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()) ? String(s).trim() : '';
  const dest = String(i.dest || i.destCity || '').trim();
  const { destList, mustVisit } = parseDestList(dest);
  const explicitMustGo = String(i.extra || '').split(/[；;。\n]/).map((clause) => {
    const match = /(?:一定要去|必须去|必去(?:景点)?|务必安排|重点去|希望去|想去)\s*[:：]?\s*(.+)/.exec(clause);
    return match ? match[1].split(/[，,](?=不|优先|交通|预算|已|未|要求|不要)/)[0].trim() : '';
  }).filter(Boolean);
  const mustGo = [String(i.mustGo || '').trim(), ...explicitMustGo].filter(Boolean).join('、');
  // “补充要求”里的必去字段不是装饰文本：规划页的占位示例是“漓江游船、遇龙河竹筏”。
  // 将其中明确列出的点并入硬性覆盖清单，后续漏点检查和一次性修订才不会只检查目的地字段。
  const mustGoList = parseDestList(mustGo
    .replace(/^(?:一定要去|必须去|必去|重点去|重点安排|希望去|想去)\s*[:：]?\s*/, '')).mustVisit;

  return {
    origin: String(i.origin || i.fromCity || '').trim(),
    dest,
    destList,      // 目的地清单（含省份提示词），进 prompt 让 LLM 逐个安排
    mustVisit: [...new Set(mustVisit.concat(mustGoList))], // 目的地与“必去”点都必须触发覆盖检查
    startDate,
    endDate: end,
    days,
    party, peopleNum, budget, pace, interests, transport,
    leadMinutes: Math.max(1, Math.min(60, Math.round(Number(i.leadMinutes) || 5))),
    goTime: validTime(i.startTime || i.goTime),
    backTime: validTime(i.endTime || i.backTime),
    mustGo,
    extra: String(i.extra || '').trim(),
    // 兼容旧版只有“补充要求”的表单，也接收后续页面可能单独保存的
    // 票务状态。状态只影响车票/门票类提醒，酒店仍然按“尽早预订”处理。
    bookingStatus: String(i.bookingStatus || i.ticketStatus || '').trim(),
    bookedTickets: String(i.bookedTickets || i.purchasedTickets || '').trim(),
    holiday: isHolidayRange(startDate, end),
  };
}

const BOOKING_DONE_RE = /(?:已\s*(?:购票|买票|订票|购买|预订|预约|订好|购)|已经\s*(?:购票|买票|购买|预订|预约|订好)|票已\s*(?:购|买)|已完成\s*(?:购票|预订|预约)|无需\s*(?:再\s*)?(?:购票|买票|购买|预订|预约)|不需要\s*(?:再\s*)?(?:购票|买票|购买|预订|预约))/;
const BOOKING_PENDING_RE = /(?:未\s*(?:购票|买票|订票|购买|预订|预约)|尚未|还没(?:有)?|待(?:购票|买票|预订|预约)|需要\s*(?:再\s*)?(?:购票|买票|购买|预订|预约))/;

function compactBookingText(value) {
  return String(value || '').replace(/[\s\u3000→⇒＞>：:，,。；;（）()\[\]【】/\\-]/g, '').toLowerCase();
}

function bookingKindOf(value) {
  const text = String(value || '');
  if (/(?:火车票|高铁票|动车票|火车|高铁|动车|列车|车次|12306|铁路)/i.test(text)) return 'train';
  if (/(?:机票|航班|飞机票|飞机|航空)/i.test(text)) return 'plane';
  if (/(?:汽车票|大巴票|客运票|旅游专线|直通车)/i.test(text)) return 'bus';
  if (/(?:门票|景区|景点|演出|剧场|游船|船票|竹筏|漂流|缆车|索道|温泉|博物馆|预约|体验)/i.test(text)) return 'ticket';
  return '';
}

function bookingCoreTerms(value) {
  const text = String(value || '')
    .replace(/(?:立即查看并(?:预约|购买)|预计(?:开放预约\/购票|开售)|开抢|开始盯|关注|查询|预约|购票|购买|预订|票|火车|高铁|动车|列车|车次|机票|航班|飞机|汽车|大巴|船票|门票|景区|景点|演出|游船|竹筏|漂流|缆车|索道|温泉|票)/gi, ' ');
  return [...text.matchAll(/[\u4e00-\u9fa5]{2,}/g)].map((match) => match[0])
    .filter((term) => term.length >= 2 && !/^(?:已经|已购|未购|尚未|需要|不要|不需要|全程|所有|全部)$/.test(term));
}

/**
 * 判断用户是否已经明确完成某一类购票/预约。
 * 只在“已购票/已预约”等完成态成立时返回 true；“未购票/还没买”不能被
 * 误判成完成。若用户写了具体景点/路线，则要求状态句与目标有名称或票种交集，
 * 避免“火车票已购，景区门票未购”把两类提醒一起删掉。
 */
function bookingStatusMatches(p, targetText, type) {
  const source = [p && p.extra, p && p.mustGo, p && p.bookingStatus, p && p.bookedTickets]
    .filter(Boolean).join('；');
  if (!source || !BOOKING_DONE_RE.test(source)) return false;
  const target = String(targetText || '');
  const targetKind = type || bookingKindOf(target);
  const targetCompact = compactBookingText(target);
  const targetTerms = bookingCoreTerms(target);
  const clauses = source.split(/[。；;，,\n]+/).map((part) => part.trim()).filter(Boolean);
  return clauses.some((clause) => {
    if (!BOOKING_DONE_RE.test(clause) || BOOKING_PENDING_RE.test(clause)) return false;
    const clauseKind = bookingKindOf(clause);
    if (targetKind && clauseKind && targetKind !== clauseKind) return false;
    const clauseCompact = compactBookingText(clause);
    const nameHit = targetTerms.some((term) => clauseCompact.includes(compactBookingText(term)));
    const kindHit = !targetKind || !clauseKind || targetKind === clauseKind;
    if (nameHit && kindHit) return true;
    const clauseTerms = bookingCoreTerms(clause);
    const clauseHasSpecificName = clauseTerms.some((term) =>
      !/^(?:已购|已买|已订|已预订|已预约|已购买|无需|不需要|购票|买票|预订|预约|去程|返程|往返|来回|行程)$/.test(term));
    const subtypeHit = [
      /游船|船票|竹筏|漂流/.test(clause) && /游船|船票|竹筏|漂流/.test(target),
      /门票|景区|景点/.test(clause) && /门票|景区|景点/.test(target),
      /演出|剧场/.test(clause) && /演出|剧场/.test(target),
      /缆车|索道/.test(clause) && /缆车|索道/.test(target),
    ].some(Boolean);
    if (subtypeHit && kindHit) return true;
    // “火车票已购票”“所有门票都已预约”这类没有写具体路线/景点的句子，
    // 视为对应票种的全局完成态；“已购票”则视为所有票务均已完成。
    const global = /(?:所有|全部|全程|各类|各种|已购票|已买票|(?:票|车票|门票|船票)都(?:已|已经)|(?:票|车票|门票|船票)均(?:已|已经))/.test(clause);
    const genericTicket = /门票/.test(clause)
      && !/演出|游船|船票|竹筏|漂流|缆车|索道|温泉/.test(clause);
    const genericByType = clauseKind && clauseKind === targetKind && !clauseHasSpecificName
      && (/火车票|高铁票|动车票|机票|汽车票|大巴票/.test(clause)
        || (targetKind === 'ticket' && genericTicket));
    if ((global || genericByType) && kindHit
      && (!targetCompact || targetTerms.length === 0 || clauseKind === targetKind || !clauseKind)) return true;
    // 目标本身只有“去程/返程/车票”这类票种描述时，具体状态句无需再次写路线。
    return targetTerms.length === 0 && kindHit && (clauseKind === targetKind || (!clauseKind && targetKind === 'ticket'));
  });
}

// “自驾出行”是用户本人驾驶的全程偏好；包车/打车属于有司机的 fallback，不能
// 从旧的“自驾/包车”混合选项或补充要求里推断成全程自驾。
function drivingAllowed(p) {
  return String(p && p.transport || '').trim() === '自驾出行';
}

function normalizeRoutePlace(value) {
  return String(value || '').toLowerCase().replace(/[\s,，、。；;：:（）()\[\]【】]/g, '')
    .replace(/中国|省|市|自治州|地区|盟|县|区|镇|乡|街道|站|景区|停车场|跨国|国际|核心|主景区|风景名胜区/g, '');
}

function hasPositiveSelfDrive(text) {
  const s = String(text || '');
  return /自驾|开车|驾车|驾驶|驱车/.test(s)
    && !/(?:不|无需|禁止|不要|别|没|未|不会|没有|避免|不需要|不想|拒绝)[^。；;，,\n]{0,14}(?:自驾|开车|驾车|驾驶|驱车)/.test(s);
}

/** 补充要求明确写出的单段自驾，只作用于能和该段起终点/当天地点对应上的条目。 */
function explicitSelfDriveSegment(p, item) {
  if (drivingAllowed(p)) return true;
  const clauses = String(p && p.extra || '').split(/[。；;，,\n]/).map((x) => x.trim()).filter(Boolean);
  const it = item || {};
  const places = [it.startLocation, it.endLocation, it.city]
    .map(normalizeRoutePlace).filter((x) => x.length >= 2);
  return clauses.some((clause) => {
    if (!hasPositiveSelfDrive(clause)) return false;
    const normalized = normalizeRoutePlace(clause);
    const hits = [...new Set(places.filter((place) => normalized.includes(place)))];
    if (hits.length >= 2) return true;
    // 景区/城市内一段路线可能只在补充要求里写一个地点名（如“龍脊景区内自驾”）。
    // 如果句子已写出 A 到 B 的具体路段，只命中其中一个地点不能把自驾权限
    // 扩展到相邻路线（例如“只在成都到都江堰这一段自驾，其余不自驾”）。
    const namesAnotherRoute = /(?:从|由).{1,18}(?:到|至|前往)|.{1,18}(?:到|至).{1,18}(?:自驾|开车|驾车|驾驶|驱车)/.test(clause);
    return hits.length === 1 && !namesAnotherRoute
      && /(?:在|景区内|园区内|市内|当地|周边|该段|这段|路段).{0,16}(?:自驾|开车|驾车|驾驶|驱车)|(?:自驾|开车|驾车|驾驶|驱车).{0,16}(?:景区内|园区内|市内|当地|周边|该段|这段|路段)/.test(clause);
  });
}

function taxiAllowed(p) {
  const text = `${p && p.transport || ''} ${p && p.extra || ''}`;
  return !/(?:不|无需|禁止|不要|避免|不需要|不想|拒绝)(?:考虑|使用|安排|选择)?(?:打车|网约车|出租车|出租|巡游车|包车)/.test(text);
}

function taxiPreferred(p) {
  const text = `${p && p.transport || ''} ${p && p.extra || ''}`;
  return /(?:打车|网约车|出租车|出租|巡游车)(?:出行)?优先|优先(?:打车|网约车|出租车)|主要(?:打车|网约车|出租车)/.test(text);
}

function defaultTransferMode(p) {
  return drivingAllowed(p) || taxiPreferred(p) ? 'car' : 'ride';
}

function transferText(from, to, mode) {
  if (mode === 'car') return `打车从${from}前往${to}`;
  if (mode === 'walk') return `步行从${from}前往${to}`;
  return `乘公共交通或景区接驳从${from}前往${to}`;
}

// 回到用户填写的出发地时，不要把普通市内接驳写成景区接驳。
// 景区内部仍可使用 transferText 的“景区接驳”，这里只处理返家边界。
function homeTransferText(from, to, mode) {
  if (mode === 'car') return `打车从${from}返回${to}`;
  if (mode === 'walk') return `步行从${from}返回${to}`;
  return `乘公交、地铁或网约车从${from}返回${to}`;
}

/**
 * 非本人驾驶行程不能把模型的否定性说明原样展示给用户，也不能残留
 * “开车/自驾”这类会被误解成用户需要自己驾驶的文案。先删除否定句，
 * 再把剩余的驾驶动词转换成中性交通表述；显式点名某一段自驾的要求
 * 由调用方在 enforceTransportPreference 中保留。
 */
function sanitizeUnauthorizedDriveText(value, field) {
  let text = String(value || '');
  if (!text) return text;
  const drive = '(?:自驾出行|自驾|开车|驾车|驾驶|驱车)';
  const negative = new RegExp(
    `(?:不|不要|禁止|无需|不应|不得|避免|未选择|未选|没有选择|不需要|不考虑|不安排)[^。；;，,\\n]{0,24}${drive}[^。；;，,\\n]*`,
    'g'
  );
  text = text.replace(negative, '');
  if (field === 'activity') {
    // “自驾从 A 前往 B”去掉驾驶方式后仍保留地点链；其它活动改成中性前往。
    text = text.replace(new RegExp(`${drive}\\s*从`, 'g'), '从');
    text = text.replace(new RegExp(`${drive}(?=\\s*(?:前往|去|到))`, 'g'), '');
    text = text.replace(new RegExp(drive, 'g'), '前往');
    text = text.replace(/前往前往/g, '前往');
  } else {
    text = text.replace(new RegExp(drive, 'g'), '公共交通或司机接送');
  }
  return text
    .replace(/([，,；;：:]\\s*){2,}/g, '；')
    .replace(/^\\s*[，,；;。]\\s*/, '')
    .replace(/\\s{2,}/g, ' ')
    .trim();
}

/** 只在全程自驾或补充要求点名的路段保留本人驾驶；打车/包车仍是司机接送。 */
function enforceTransportPreference(items, p) {
  const railFirst = /高铁|动车/.test(String(p && p.transport || '')) && !drivingAllowed(p);
  const rows = asArray(items).map((it) => {
    if (!it) return it;
    const mode = String(it.transportType || '').toLowerCase();
    const activity = String(it.activity || '');
    if (railFirst && it.category === 'transport'
        && (/plane/.test(mode) || /(?:乘坐|搭乘|乘).{0,12}(?:航班|飞机)|登机准备/.test(activity))) {
      console.warn('[generatePlan] 用户优先高铁/动车，删除细化模型额外生成的航班条目：%s', activity.slice(0, 50));
      return null;
    }
    const selfDrive = explicitSelfDriveSegment(p, it);
    if (!drivingAllowed(p) && !selfDrive) {
      // 电动车/自行车是阳朔等景区常见的当地游玩方式，不等同于用户
      // 选择“自驾出行”；只拦截电动摩托车/摩托车，避免把合法的骑行游览
      // 误改成公共交通，也便于行李规则识别“轻装骑行、下午取回行李”。
      it.note = String(it.note || '').replace(/[^。；;]*(?:租赁|租用|租|骑行|驾驶|驾车|自驾)[^。；;]*(?:电动摩托车|摩托车)[^。；;]*[。；;]?/g,
        '此段使用步行、公共交通或景区接驳。');
    }
    const from = String(it.startLocation || '').trim();
    const to = String(it.endLocation || '').trim();
    const isOwnDriveText = /自驾|开车|驾车|驾驶|驱车/.test(activity);
    const isChauffeured = /打车|网约车|出租车|巡游车|包车/.test(activity);
    const selfOperatedMotor = /(?:租赁|租用|租|骑行|骑|驾驶|开)(?:两辆|一辆|电动)?(?:电动摩托车|摩托车)|(?:电动摩托车|摩托车)(?:租赁|租用|租车|骑行)/.test(activity);
    const motorRentalStop = (value) => String(value || '')
      .replace(/电动摩托车租赁点|电动车租赁点|摩托车租赁点|摩托车租车点/g, '公共交通接驳点');

    if (!drivingAllowed(p) && !selfDrive && selfOperatedMotor) {
      if (it.category === 'transport') {
        it.startLocation = motorRentalStop(from);
        it.endLocation = motorRentalStop(to);
        it.startLon = it.startLat = it.endLon = it.endLat = '';
        it.transportType = taxiAllowed(p) ? 'ride' : 'bus';
        it.activity = `${taxiAllowed(p) ? '乘公共交通或有司机接送的车辆' : '乘公共交通或景区接驳'}从${it.startLocation || '当前位置'}前往${it.endLocation || '目的地'}`;
        return it;
      }
      if (/租赁|租用|租车/.test(activity)) return null;
      it.activity = activity.replace(/(?:骑行|骑|驾驶|开)(?:两辆|一辆|电动)?(?:电动摩托车|摩托车)[^，。；;]*/g,
        '改乘公共交通、景区接驳或有司机接送方式前往景区');
      it.startLocation = motorRentalStop(from);
      it.endLocation = motorRentalStop(to);
    }

    if (drivingAllowed(p) && it.category === 'transport') {
      it.transportType = 'car';
      it.activity = from && to ? `自行驾驶从${from}前往${to}` : activity.replace(/(?:乘坐)?(?:高铁|动车|火车|列车|飞机|航班|大巴|班车)/g, '自行驾驶前往');
      it.note = String(it.note || '').replace(/(?:车次|航班号|参考班次)[^。；;]*/g, '').trim();
      delete it.schedSource;
      delete it.scheduleRequired;
      delete it.sched;
      return it;
    }

    if (selfDrive && it.category === 'transport') {
      it.transportType = 'car';
      if (from && to) it.activity = `自行驾驶从${from}前往${to}`;
      return it;
    }

    if (it.category === 'transport' && isChauffeured && !taxiAllowed(p)) {
      it.transportType = 'ride';
      it.activity = from && to ? transferText(from, to, 'ride') : activity.replace(/打车|网约车|出租车|巡游车|包车/g, '乘公共交通');
      return it;
    }

    if (it.category === 'transport' && (isOwnDriveText || (mode === 'car' && !isChauffeured))) {
      // 用户没有说自己驾驶时，模型生成的“开车”路线降级为有司机接送；
      // 未写交通方式的 car 条目则回到公共交通，避免 car 被误解为用户自驾。
      if (isOwnDriveText) {
        it.transportType = 'car';
        it.activity = transferText(from || '当前位置', to || '目的地', 'car');
      } else {
        it.transportType = 'ride';
        it.activity = from && to ? transferText(from, to, 'ride') : activity;
      }
      it.note = String(it.note || '').replace(/(?:预计)?(?:车费|费用)[^。；;]*/g, '').trim();
      return it;
    }

    if (it.category !== 'transport' && isOwnDriveText && !selfDrive) {
      it.activity = activity.replace(/(?:自驾|开车|驾车|驾驶|驱车)(?:前往|去|到|游览)?/g, '前往');
      if (mode === 'car') it.transportType = 'ride';
    }
    return it;
  }).filter(Boolean).map((it) => {
    // 这一层放在所有早退分支之后，覆盖模型生成的 note 以及被前面分支
    // 重写过的 activity，避免最终序列化时又残留未经授权的驾驶文案。
    if (!drivingAllowed(p) && !explicitSelfDriveSegment(p, it)) {
      it.activity = sanitizeUnauthorizedDriveText(it.activity, 'activity');
      it.note = sanitizeUnauthorizedDriveText(it.note, 'note');
    }
    return it;
  });
  const out = [];
  rows.forEach((it) => {
    const from = String(it && it.startLocation || '').trim();
    const to = String(it && it.endLocation || '').trim();
    const activity = String(it && it.activity || '');
    const movesToDestination = explicitSelfDriveSegment(p, it) && it && it.category !== 'transport' && from && to
      && !samePlace(from, to) && (String(it.transportType || '').toLowerCase() === 'car'
        || /前往|驶往|开车|自驾|驾车|驱车/.test(activity));
    if (!movesToDestination) { out.push(it); return; }

    const start = toMin(it.startTime);
    const end = toMin(it.endTime);
    if (start === null || end === null || end <= start + 10) { out.push(it); return; }
    const driveDuration = Math.min(180, Math.max(15, Math.floor((end - start) / 4)));
    const driveEnd = Math.min(start + driveDuration, 23 * 60 + 49);
    const oldEnd = end;
    out.push({
      dayIndex: Number(it.dayIndex || 0),
      startTime: fmtMin(start),
      endTime: fmtMin(driveEnd),
      activity: `自行驾驶从${from}前往${to}`,
      category: 'transport',
      startLocation: from,
      endLocation: to,
      transportType: 'car',
      note: '',
    });
    it.startTime = fmtMin(Math.min(driveEnd + 10, 23 * 60 + 49));
    it.endTime = fmtMin(Math.min(oldEnd + driveDuration + 10, 23 * 60 + 59));
    it.startLocation = '';
    it.transportType = '';
    if (it.category === 'hotel') it.activity = `在${to}办理入住、放下行李休息`;
    else {
      it.activity = activity.replace(/(?:自驾|开车|驾车|驾驶|驱车)/g, '')
        .replace(/从[^，。；;]{1,30}前往[^，。；;]{1,30}[，,，]?/, '')
        .replace(/^前往[^，。；;]{1,30}[，,，]?/, '').trim();
      if (!it.activity) it.activity = `抵达${to}后开始安排`;
    }
    out.push(it);
  });
  return out;
}

/** 自驾到达后单独占出停车时间，保证停车在入住、游览、用餐等安排之前。 */
function ensureSelfDriveParking(items, p) {
  const source = asArray(items);
  const out = [];
  source.forEach((it, index) => {
    out.push(it);
    if (!it || String(it.transportType || '').toLowerCase() !== 'car'
      || !/自行驾驶|自驾/.test(String(it.activity || ''))
      || it.category !== 'transport') return;
    const to = String(it.endLocation || '').trim();
    if (!to || (p && p.origin && samePlace(to, p.origin)) || /回家|到家|出发地/.test(to)) return;
    const day = Number(it.dayIndex || 0);
    const next = source.slice(index + 1).find((x) => Number(x.dayIndex || 0) === day);
    if (next && /停车|停好车/.test(`${next.activity || ''} ${next.note || ''}`)) return;
    const arrival = toMin(it.endTime);
    out.push({
      dayIndex: day,
      startTime: arrival == null ? '' : fmtMin(arrival),
      endTime: arrival == null ? '' : fmtMin(Math.min(arrival + 10, 23 * 60 + 59)),
      activity: `抵达${to}后先停好车、确认停妥，再开始后续安排`,
      category: 'other',
      startLocation: to,
      endLocation: to,
      transportType: '',
      parking: true,
      note: '停车后再办理入住、游览或用餐。',
    });
  });
  return out;
}

// ============================================================
// 0.1 地点范围校验（确定性，防止模型把上一份攻略的酒店地址带进来）
// ============================================================

const LODGING_WORD_RE = /酒店|民宿|客栈|宾馆|青旅|住宿|度假村|招待所/;
const ADMIN_SUFFIX_RE = /(省|自治区|自治州|地区|盟|市|自治县|县|区|旗|镇|乡)$/;
const HOTEL_PLACEHOLDER_RE = /^(?:同上|同前|上一家(?:酒店)?|原酒店|酒店|住宿地)$/;

/** 从地址里提取带行政后缀的词根，例如「石家庄市」「桥西区」。 */
function adminRootsOf(value) {
  const s = String(value || '').replace(/[（(][^）)]*[）)]/g, '');
  const re = /([\u4e00-\u9fa5]{2,8}?)(省|自治区|自治州|地区|盟|市|自治县|县|区|旗|镇|乡)/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const root = String(m[1] || '').trim();
    const suffix = String(m[2] || '');
    if (root.length >= 2 && !out.some((x) => x.root === root && x.suffix === suffix)) {
      out.push({ root, suffix });
    }
  }
  return out;
}

/** 把城市/住宿地拆成可比较的词根，既支持「成都市」也支持「古尔沟」。 */
function scopeWordsOf(value) {
  const out = [];
  const add = (word) => {
    const w = String(word || '').replace(/[\s,，、;；/|]+/g, '').trim();
    if (w.length >= 2 && !out.includes(w)) out.push(w);
    const bare = w.replace(ADMIN_SUFFIX_RE, '');
    if (bare.length >= 2 && !out.includes(bare)) out.push(bare);
  };
  // 酒店 POI 经常把片区写在括号中（「新悦酒店(阳朔西街店)」）；保留括号内的
  // 地名，跨日衔接才能识别它属于阳朔，而不是把品牌名「新悦」当成所在城市。
  String(value || '').split(/[\s,，、;；/|()（）]+/).forEach(add);
  adminRootsOf(value).forEach((x) => add(x.root));
  return out;
}

/**
 * 判断地点是否至少和当天范围相容。
 * 没有明确省/市/县后缀的短 POI 无法仅靠字符串证明归属，保留给高德校验；
 * 一旦地点带了完整行政区，却与当天城市完全冲突，就不能继续把它当住宿地。
 */
function locationFitsScope(location, scope, address) {
  const place = String(location || '').replace(/[\s,，、·]/g, '');
  const addressText = String(address || '').replace(/[\s,，、·]/g, '');
  const words = scopeWordsOf(scope);
  if (!place || !words.length) return true;
  if (addressText) {
    const addressMatches = words.some((w) => addressText.includes(w) || w.includes(addressText));
    const addressCities = adminRootsOf(addressText).filter((x) => ['市', '自治州', '地区', '盟'].includes(x.suffix));
    // A city-scoped search can still return a POI from a neighboring city.
    // Explicit address evidence takes precedence over the query's searchCity.
    if (addressCities.length && !addressMatches) return false;
    if (addressMatches) return true;
  }
  if (words.some((w) => place.includes(w) || w.includes(place))) return true;
  const roots = adminRootsOf(`${location || ''} ${addressText}`);
  if (!roots.length) return true;
  return roots.some((x) => words.some((w) => w.includes(x.root) || x.root.includes(w)));
}

/** 两个地点是否属于同一片区，允许「城市」和「城市某酒店」这种粒度差异。 */
function sameTravelArea(a, b) {
  if (samePlace(a, b)) return true;
  // “桂林酒店”和“阳朔酒店”都会拆出一个“酒店”词，不能因为住宿类别
  // 相同就判成同片区；“地图 POI/住宿地/片区”也只是生成占位词，不提供
  // 地理证据。保留真实城市、区县、景区等词再做包含匹配。
  const genericAreaWord = /^(?:酒店|民宿|客栈|宾馆|青旅|住宿|住宿地|度假村|招待所|地图|poi|片区|市区|县城|周边|附近)$/i;
  const ax = scopeWordsOf(a).filter((word) => !genericAreaWord.test(word));
  const bx = scopeWordsOf(b).filter((word) => !genericAreaWord.test(word));
  const areaRoot = (word) => String(word || '')
    .replace(/(?:高铁|动车|火车|铁路|客运|汽车)?站$/, '')
    .replace(/(?:游客服务中心|游客中心|景区大门|景区入口|景区出口|入口|出口|前山|后山|观景台|码头)$/, '');
  const rootedA = ax.map(areaRoot).filter((word) => word.length >= 2);
  const rootedB = bx.map(areaRoot).filter((word) => word.length >= 2);
  if (rootedA.some((x) => rootedB.some((y) => x === y
      || (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y))))) {
    return true;
  }
  // 大纲常用“阳朔酒店/龙脊住宿地”这种泛称，细化结果则会落成
  // “新悦酒店(阳朔西街店)”等真实 POI。前者的地名词根不一定会被
  // scopeWordsOf 从“阳朔酒店”里单独拆出来，导致明明是同一住宿片区却
  // 被误判为断链，继而重复补一段从“阳朔酒店”出发的交通。
  const lodgingArea = (value) => {
    const text = String(value || '').replace(/[\s,，、·]/g, '');
    if (!LODGING_WORD_RE.test(text)) return '';
    const match = text.match(/^([\u4e00-\u9fa5]{2,6})(?:市|县|区|镇)?(?:酒店|民宿|客栈|宾馆|青旅|住宿|度假村|招待所)/);
    return match ? match[1].replace(/(?:市|县|区|镇)$/, '') : '';
  };
  const lodgingA = lodgingArea(a);
  const lodgingB = lodgingArea(b);
  if (lodgingA && String(b || '').includes(lodgingA)) return true;
  if (lodgingB && String(a || '').includes(lodgingB)) return true;
  if (LODGING_WORD_RE.test(String(a || '')) || LODGING_WORD_RE.test(String(b || ''))) {
    const prefix = (v) => (String(v || '').match(/^[\u4e00-\u9fa5]{2,4}/) || [''])[0].slice(0, 2);
    const pa = prefix(a);
    const pb = prefix(b);
    if (pa && pb && pa === pb) return true;
  }
  return false;
}

function dayScope(day) {
  const d = day || {};
  // city 是白天游览范围，overnight 才是酒店必须落入的片区。
  return String(d.overnight || d.city || '').trim();
}

/** 大纲里的酒店是模型推荐，不允许带入与当天路线冲突的完整外地地址。 */
function safeHotelOf(day) {
  const hotel = String((day && day.hotel) || '').trim();
  if (HOTEL_PLACEHOLDER_RE.test(hotel)) return '';
  const verified = day && day.hotelPoiVerified === true
    && String(day.hotelPoiVerifiedName || '').trim() === hotel
    && String(day.hotelPoiAddress || '').trim();
  return hotel && (verified || locationFitsScope(hotel, dayScope(day), day && day.hotelPoiAddress)) ? hotel : '';
}

function normalizeOutlineLodging(outline) {
  asArray(outline && outline.days).forEach((day, di) => {
    const hotel = String((day && day.hotel) || '').trim();
    if (hotel && HOTEL_PLACEHOLDER_RE.test(hotel)) {
      console.warn('[generatePlan] 第%d天住宿使用占位词，改用可搜索住宿片区：%s', di + 1, hotel);
      day.hotel = '';
      day.hotelPoiVerified = false;
      day.hotelPoiVerifiedName = '';
      day.hotelPoiAddress = '';
      day.hotelPoiSource = '';
      day.hotelSearchHint = '';
      day.hotelRecommendationReason = '';
      return;
    }
    if (hotel && day.hotelPoiVerified === true
      && String(day.hotelPoiVerifiedName || '').trim() === hotel
      && String(day.hotelPoiAddress || '').trim()
      && (day.hotelPoiOvernight === dayScope(day)
        || locationFitsScope(hotel, dayScope(day), day.hotelPoiAddress))) return;
    if (!hotel || locationFitsScope(hotel, dayScope(day), day && day.hotelPoiAddress)) return;
    console.warn('[generatePlan] 第%d天推荐住宿与当天范围冲突，忽略错误酒店地址：%s', di + 1, hotel.slice(0, 80));
    day.hotel = '';
    day.hotelPoiVerified = false;
    day.hotelPoiVerifiedName = '';
    day.hotelPoiAddress = '';
    day.hotelPoiSource = '';
    day.hotelSearchHint = '';
    day.hotelRecommendationReason = '';
  });
  return outline;
}

/** 住宿 POI 被路线校正清掉后，至少保留一个可在主流平台搜索的片区范围。 */
function ensureOutlineHotelFallbacks(outline, p) {
  const budget = String(p && (p.budget || p.budgetLevel) || '');
  const grade = /经济/.test(budget) ? '经济型' : /品质/.test(budget) ? '品质型' : '舒适型';
  asArray(outline && outline.days).forEach((day, index, days) => {
    if (index === days.length - 1 || !day || String(day.hotel || '').trim()) return;
    const place = String(day.overnight || day.city || '').trim();
    if (!place) return;
    day.hotel = `${place} ${grade}住宿片区`;
    day.hotelPoiVerified = false;
    day.hotelPoiVerifiedName = '';
    day.hotelPoiAddress = '';
    day.hotelPoiSource = '';
    day.hotelSearchHint = day.hotel;
    day.hotelRecommendationReason = `暂未保留到可核验的具体物业，先提供${place}的${grade}住宿片区；请在携程、去哪儿、美团或高德搜索后核对真实酒店。`;
  });
  return outline;
}

/** 路线串含有中转城市时，避免把中转城市的景点误排到最终落脚日。 */
function normalizeRouteDayFocus(outline, p) {
  asArray(outline && outline.days).forEach((day) => {
    if (!day) return;
    const routeParts = String(day.city || '').split(/(?:->|→|⇒|＞|>|—|–)/)
      .map((part) => part.trim()).filter(Boolean);
    if (routeParts.length < 2) return;
    const target = String(day.overnight || routeParts[routeParts.length - 1] || '').trim();
    const staleParts = routeParts.slice(0, -1);
    const mustKeep = new Set(asArray(p && p.mustVisit).map((name) => placeStem(name)));
    const highlights = asArray(day.highlights).filter((highlight) => {
      const text = String(highlight || '').trim();
      if (!text) return false;
      if ([...mustKeep].some((name) => name && (text.includes(name) || name.includes(placeStem(text))))) return true;
      return !staleParts.some((part) => {
        const stem = placeStem(part);
        return stem.length >= 2 && (text.includes(stem) || stem.includes(placeStem(text)));
      });
    });
    if (highlights.length) day.highlights = highlights;
    else if (target) day.highlights = [`${target}周边风光`, '当地特色美食', '沿途拍照打卡'];
  });
  return outline;
}

/** Keep each day's listed movement legs in the same order as their times. */
function alignOutlineMoveTimes(outline) {
  asArray(outline && outline.days).forEach((day) => {
    const moves = asArray(day && day.moves).filter((move) => move && move.from && move.to);
    for (let index = 1; index < moves.length; index++) {
      const previous = moves[index - 1];
      const current = moves[index];
      const previousEnd = toMin(previous.endTime);
      const currentStart = toMin(current.startTime);
      if (previousEnd === null || currentStart === null) continue;
      const exactStation = sameStation(previous.to, current.from);
      const currentMode = String(current.mode || '').toLowerCase();
      const transferBuffer = /train|高铁|动车|火车/.test(currentMode) ? 45
        : /ship|游船|轮渡/.test(currentMode) ? 30
          : /bus|coach|shuttle|大巴|专线/.test(currentMode) ? (exactStation ? 15 : 45)
            : exactStation ? 10 : 45;
      const earliestStart = previousEnd + transferBuffer;
      if (currentStart >= earliestStart) continue;

      const previousOfficial = previous.schedSource === '12306';
      const currentOfficial = current.schedSource === '12306';
      const durationOf = (move) => {
        const start = toMin(move.startTime);
        const end = toMin(move.endTime);
        const existing = start !== null && end !== null && end > start ? end - start : 0;
        const fromText = parseDurationMin(String(move.transfer || '')) || 0;
        const mode = String(move.mode || '').toLowerCase();
        const estimate = fromText || (/ship|游船/.test(mode) ? 180
          : /bus|coach|shuttle|大巴|专线/.test(mode) ? 180
            : /car|drive|taxi|ride|charter|包车|打车/.test(mode) ? 120 : 60);
        return Math.max(existing, estimate);
      };
      if (currentOfficial && !previousOfficial) {
        const duration = durationOf(previous);
        const end = currentStart - transferBuffer;
        const start = end - duration;
        if (start >= 5 * 60) {
          previous.startTime = fmtMin(start);
          previous.endTime = fmtMin(end);
          previous.timingEstimated = true;
          previous.transfer = [previous.transfer, '为衔接后续已核实班次提前出发；时段为估算'].filter(Boolean).join('；');
          continue;
        }
      } else if (!currentOfficial) {
        const duration = durationOf(current);
        current.startTime = fmtMin(Math.min(earliestStart, 23 * 60 + 30));
        current.endTime = fmtMin(Math.min(toMin(current.startTime) + duration, 23 * 60 + 59));
        current.timingEstimated = true;
        current.transfer = [current.transfer, '已按前序交通顺延，具体运营时刻请出发前核实'].filter(Boolean).join('；');
        continue;
      }

      day.note = [String(day.note || '').trim(), `第${index + 1}段交通与相邻班次时序冲突，请核实衔接`]
        .filter(Boolean).join('；');
      console.warn('[generatePlan] 当天第%d段交通无法在不改动已核实班次的情况下顺序衔接：%s→%s',
        index + 1, current.from, current.to);
    }
  });
  return outline;
}

/**
 * 确保同一天的大交通在地点上首尾相接。
 *
 * 大纲里的 mv 通常只有城际段，模型容易把“到某铁路站”直接接到“从另一个
 * 景区/车站出发”的下一段，详细计划就会出现凭空跳转。这里不猜具体城市，
 * 只在两段的终点/起点无法判定为同一片区、且时间中确实留有空档时，补一条
 * 可核实的公共交通/大巴接驳。标记为 autoConnector，官方班次回写改变站名后
 * 会先删除旧连接再按新站名重建，避免保留旧方向。
 */
function ensureOutlineMoveContinuity(outline, p) {
  asArray(outline && outline.days).forEach((day) => {
    const baseMoves = asArray(day && day.moves)
      .filter((move) => move && move.from && move.to && !move.autoConnector);
    if (baseMoves.length < 2) {
      if (day) day.moves = baseMoves;
      return;
    }
    const rebuilt = [];
    for (let index = 0; index < baseMoves.length; index++) {
      const current = baseMoves[index];
      if (index) {
        const previous = baseMoves[index - 1];
        const connected = sameStation(previous.to, current.from)
          || sameTravelArea(previous.to, current.from);
        const previousEnd = toMin(previous.endTime);
        const currentStart = toMin(current.startTime);
        if (!connected && previousEnd !== null && currentStart !== null
            && currentStart - previousEnd >= 30) {
          const mode = drivingAllowed(p) ? 'car' : 'bus';
          const preferredDuration = /train|高铁|动车|火车/.test(String(current.mode || '').toLowerCase())
            ? 45 : /ship|游船|轮渡/.test(String(current.mode || '').toLowerCase()) ? 30 : 90;
          // 中间空档还包含游览、用餐，接驳应靠近下一班车，而不是
          // 一抵达景区就立即离开。不能让自动连接段吃掉整个游览窗口。
          const end = currentStart - 30;
          const start = Math.max(previousEnd + 10, end - preferredDuration);
          if (end > start) {
            rebuilt.push({
              from: String(previous.to).trim(),
              to: String(current.from).trim(),
              mode,
              code: '',
              startTime: fmtMin(start),
              endTime: fmtMin(end),
              transfer: drivingAllowed(p)
                ? '抵达后停车再继续后续行程'
                : '公共交通/旅游专线接驳，具体班次与耗时请按当天情况核实',
              autoConnector: true,
              timingEstimated: true,
            });
            console.warn('[generatePlan] 第%d天补齐交通接续：%s→%s，再%s→%s',
              asArray(outline.days).indexOf(day) + 1, previous.to, current.from,
              current.from, current.to);
          }
        } else if (!connected && (currentStart === null || previousEnd === null)) {
          // 模型常不给两段大交通写时刻，不能因为没有分钟数就把中间
          // “下车站→下一段上车点”的地点链省略；保留一个无时刻的待核实
          // 接驳，详细阶段会按当天实际班次补时间。
          rebuilt.push({
            from: String(previous.to).trim(),
            to: String(current.from).trim(),
            mode: drivingAllowed(p) ? 'car' : 'bus',
            code: '',
            startTime: '',
            endTime: '',
            transfer: drivingAllowed(p)
              ? '抵达后停车再继续后续行程'
              : '公共交通/旅游专线接驳，具体班次与耗时请按当天情况核实',
            autoConnector: true,
            timingEstimated: true,
          });
          console.warn('[generatePlan] 第%d天补齐无时刻交通接续：%s→%s，再%s→%s',
            asArray(outline.days).indexOf(day) + 1, previous.to, current.from,
            current.from, current.to);
        } else if (!connected && currentStart !== null && previousEnd !== null
            && currentStart - previousEnd < 30) {
          day.note = [String(day.note || '').trim(),
            `第${index + 1}段交通前需核实 ${previous.to}→${current.from} 的短途接驳`]
            .filter(Boolean).join('；');
        }
      }
      rebuilt.push(current);
    }
    day.moves = rebuilt;
  });
  return outline;
}

/** 清掉修订模型误把市内接驳写进大纲大交通的条目。 */
/**
 * 白天游览片区与当晚住宿片区不同且大纲漏写离场交通时，补一段跨区移动。
 * 这类漏项在模型失败/续跑时很常见：大纲写了“下午返回另一城市”，但 moves
 * 只剩上午的景区段，详细页最后只能伪造一条“直接去酒店入住”。这里仅依据
 * city、overnight 和已有 moves 判断，不绑定具体城市；时间明确写了下午时给
 * 一个待核实的估算窗口，详细阶段仍会按相邻游览和真实班次再次调整。
 */
function ensureOvernightMoveContinuity(outline, p) {
  const days = asArray(outline && outline.days);
  days.forEach((day, index) => {
    if (!day || index >= days.length - 1) return;
    const overnight = String(day.overnight || '').trim();
    if (!overnight || /返程|回家|到家/.test(overnight)) return;
    const moves = asArray(day.moves).filter((move) => move && move.from && move.to);
    const dayArea = String(day.city || '').trim()
      || String(moves[moves.length - 1] && moves[moves.length - 1].to || '').trim();
    if (!dayArea || sameTravelArea(dayArea, overnight)) return;
    const alreadyArrives = moves.some((move) => sameTravelArea(move.to, overnight)
      && !sameTravelArea(move.from, overnight));
    if (alreadyArrives) return;
    const from = String((moves[moves.length - 1] && moves[moves.length - 1].to) || dayArea).trim();
    if (!from || sameTravelArea(from, overnight)) return;
    const note = `${day.note || ''} ${day.theme || ''} ${asArray(day.highlights).join(' ')}`;
    let startTime = '';
    let endTime = '';
    if (/下午|傍晚|晚上|晚间/.test(note)) {
      startTime = '15:00';
      endTime = '18:00';
    }
    const mode = drivingAllowed(p) ? 'car' : 'bus';
    day.moves.push({
      from,
      to: overnight,
      mode,
      code: '',
      startTime,
      endTime,
      transfer: drivingAllowed(p)
        ? '抵达后停车，再办理入住；具体道路与耗时请按当天核实'
        : '旅游专线/大巴或其他公共交通，具体班次与耗时请按当天核实',
      timingEstimated: !!startTime,
      overnightAccess: true,
    });
    console.warn('[generatePlan] 第%d天补齐白天片区→当晚住宿地交通：%s→%s',
      index + 1, from, overnight);
  });
  return outline;
}

function sanitizeOutlineLocalMoves(outline) {
  const days = asArray(outline && outline.days);
  const localMode = (move) => /subway|metro|地铁|公交|步行|walk|tram|轻轨/.test(
    `${move && move.mode || ''} ${move && move.code || ''}`.toLowerCase());
  days.forEach((day, dayIndex) => {
    const moves = asArray(day && day.moves);
    if (moves.length < 2) return;
    const kept = moves.filter((move) => {
      // 大纲只描述段与段之间的主交通；同一车站到自身是模型把“未查到
      // 站点/改查大巴”的说明误写成交通，保留它会让细化阶段凭空插入一段
      // 行程，也会破坏返程铁路前后的地点链。
      if (move && move.from && move.to && sameStation(move.from, move.to)) {
        console.warn('[generatePlan] 第%d天移除起终点相同的大纲交通段：%s→%s',
          dayIndex + 1, move.from, move.to);
        return false;
      }
      if (!localMode(move) || !move || !move.to) return true;
      const hasIntercityTwin = moves.some((other) => other !== move && other && other.to
        && sameTravelArea(other.to, move.to)
        && !localMode(other)
        && (sameTravelArea(other.from, move.from) === false
          || /train|plane|bus|ship|car|高铁|动车|火车|列车|大巴|航班|飞机/.test(
            `${other.mode || ''} ${other.code || ''}`.toLowerCase())));
      if (hasIntercityTwin) {
        console.warn('[generatePlan] 第%d天移除误写入大纲的市内接驳段：%s→%s',
          dayIndex + 1, move.from, move.to);
        return false;
      }
      return true;
    });
    day.moves = kept;
  });
  return outline;
}

/**
 * 收口大纲里的自动接驳链。
 *
 * 返程铁路已经确定后，修订模型有时会把“景区/景区站→某个无关车站”的
 * autoConnector 链插到返程铁路前，再额外生成一段 railReturnAccess。这样
 * 详细计划就会先离开景区去错误车站，再从另一个车站回头。这里不认识任何
 * 城市或车站，只把紧挨着 railReturnAccess、且完全由自动估算生成的链折叠
 * 到接驳起点；明确的用户/模型城际段仍然保留。
 */
function normalizeGeneratedOutlineMoveChains(outline) {
  asArray(outline && outline.days).forEach((day, dayIndex) => {
    let moves = asArray(day && day.moves).filter((move) => move && move.from && move.to).slice();
    if (!moves.length) {
      if (day) day.moves = moves;
      return;
    }

    // 先删掉同一站点的伪交通，避免它阻断后面的自动链回溯。
    moves = moves.filter((move) => {
      if (sameStation(move.from, move.to)) {
        console.warn('[generatePlan] 第%d天清理同站伪交通：%s→%s',
          dayIndex + 1, move.from, move.to);
        return false;
      }
      return true;
    });

    moves.forEach((access) => {
      if (!access || access.railReturnAccess !== true) return;
      let from = String(access.from || '').trim();
      const remove = new Set();
      let cursor = moves.indexOf(access) - 1;
      let collapsed = false;
      while (cursor >= 0 && from) {
        const previous = moves[cursor];
        const generated = previous && (previous.autoConnector === true
          || previous.timingEstimated === true);
        if (!generated || !sameTravelArea(previous.to, from)) break;
        remove.add(previous);
        from = String(previous.from || '').trim();
        collapsed = true;
        cursor -= 1;
      }
      if (collapsed && from && !sameTravelArea(from, access.to)) {
        console.warn('[generatePlan] 第%d天折叠返程前自动接驳链：%s→%s 改为 %s→%s',
          dayIndex + 1, access.from, access.to, from, access.to);
        access.from = from;
        moves = moves.filter((move) => !remove.has(move));
      }
    });
    day.moves = moves;
  });
  return outline;
}

/** 清掉大纲中 A→B→A 后又从 A 出发的即时折返段。大纲只描述主交通，
 * 这种结构通常是修订模型把“市内接驳/备选路线”误写成了第二段城际交通。 */
function removeOutlineBacktracks(outline) {
  const days = asArray(outline && outline.days);
  const same = (a, b) => sameTravelArea(a, b) || samePlace(a, b);
  days.forEach((day, dayIndex) => {
    let moves = asArray(day && day.moves).slice();
    let changed = true;
    while (changed && moves.length >= 3) {
      changed = false;
      for (let i = 0; i <= moves.length - 3; i++) {
        const a = moves[i], b = moves[i + 1], c = moves[i + 2];
        if (!a || !b || !c || !a.from || !a.to || !b.from || !b.to || !c.from) continue;
        const immediateLoop = same(a.to, b.from) && same(b.to, c.from) && same(a.from, c.from)
          && !same(a.from, a.to) && !same(c.from, c.to);
        if (!immediateLoop) continue;
        // 有官方核验的真实铁路段不随意删除；无核验的修订占位/反向接驳才清。
        if (a.schedSource === '12306' && b.schedSource === '12306') continue;
        moves.splice(i, 2);
        changed = true;
        console.warn('[generatePlan] 第%d天清理大纲即时折返：%s→%s→%s',
          dayIndex + 1, a.from, a.to, b.to);
        break;
      }
    }
    day.moves = moves;
  });
  return outline;
}

/**
 * 细化条目也要保持地点链连续。
 *
 * LLM 常把“理县→汶川站”的一段写出来，下一条却直接从“成都东站”开始，
 * 中间漏掉汶川→成都的接驳。只要前一条终点、后一条起点都明确，且时间上
 * 留有至少 30 分钟，就补一条通用的公共交通/司机接送接驳；同片区、已相连
 * 或没有可用时间时不猜路线。这样既补断链，也不会把景区内部没有导航字段
 * 的普通游览强行拆成交通。
 */
function ensureItemLocationContinuity(items, p) {
  const rows = asArray(items);
  if (!rows.length) return rows;
  const byDay = new Map();
  rows.forEach((item) => {
    const day = Number(item && item.dayIndex || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  });
  const out = [];
  const meaningful = (value) => {
    const text = String(value || '').trim();
    return text && !/^(?:—|-|无|未知|附近|周边|当前位置)$/.test(text);
  };
  const rowEnd = (item) => meaningful(item && item.endLocation)
    ? String(item.endLocation).trim()
    : meaningful(item && item.startLocation) && item.category === 'transport'
      ? String(item.startLocation).trim() : '';
  const rowStart = (item) => meaningful(item && item.startLocation)
    ? String(item.startLocation).trim() : '';
  const isRealConnector = (item) => item && item.autoConnector === true;
  const durationOf = (item) => Math.max(30, Math.min(180,
    parseDurationMin(`${item && item.note || ''} ${item && item.activity || ''}`)
      || (/train|plane|ship|bus/.test(String(item && item.transportType || '').toLowerCase()) ? 90 : 60)));
  const sortedDays = [...byDay.keys()].sort((a, b) => a - b);
  sortedDays.forEach((day) => {
    const list = byDay.get(day).slice().sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    const rebuilt = [];
    let previous = null;
    list.forEach((current) => {
      const previousPlace = rowEnd(previous);
      const currentPlace = rowStart(current);
      const previousEnd = toMin(previous && previous.endTime);
      const currentStart = toMin(current && current.startTime);
      const gap = previousEnd !== null && currentStart !== null ? currentStart - previousEnd : null;
      const needsConnector = previous && previousPlace && currentPlace
        && !sameTravelArea(previousPlace, currentPlace)
        && gap !== null && gap >= 30
        && !isRealConnector(previous) && !isRealConnector(current)
        && !/候车|安检|检票|进站/.test(String(current.activity || ''));
      if (needsConnector) {
        const mode = drivingAllowed(p) ? 'car' : defaultTransferMode(p);
        const start = previousEnd + 10;
        const end = Math.min(currentStart - 10, start + 90);
        if (end > start) {
          const connector = {
            dayIndex: day,
            startTime: fmtMin(start),
            endTime: fmtMin(end),
            activity: transferText(previousPlace, currentPlace, mode),
            category: 'transport',
            startLocation: previousPlace,
            endLocation: currentPlace,
            transportType: mode,
            autoConnector: true,
            timingEstimated: true,
            note: '前后地点断链兜底接驳；具体班次与耗时请按当天情况核实。',
          };
          rebuilt.push(connector);
          console.warn('[generatePlan] 第%d天细化地点断链，补齐接驳：%s→%s',
            day + 1, previousPlace, currentPlace);
        }
      }
      rebuilt.push(current);
      if (rowEnd(current)) previous = current;
    });
    out.push(...rebuilt);
  });
  return out;
}

/**
 * 删除没有可达起点的孤立交通。
 *
 * 模型偶尔在“抵达酒店”之后直接补一条“从另一片区返回酒店”的交通，或者
 * 在没有任何前置接驳时从旧车站开启下一条地铁。这样的条目即使时间不重叠，
 * 也会把用户带进不存在的地点。硬核验铁路/船/飞机和大纲锁定交通保留，普通
 * 接驳只有在当前地点可达时才保留；这条规则不绑定任何城市名称。
 */
function removeOrphanTransportRows(items, outline) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const drop = new Set();
  const isHardMove = (item) => item && (item.outlineMove === true
    || item.schedSource === '12306'
    || /train|plane|ship|高铁|动车|火车|列车|飞机|航班|游船|轮渡/.test(
      `${item.transportType || ''} ${item.activity || ''}`));
  const isLodging = (value) => LODGING_WORD_RE.test(String(value || ''));
  const reachable = (from, to, currentIsLodging) => {
    if (!from || !to) return true;
    if (samePlace(from, to) || sameStation(from, to)) return true;
    // 酒店是“当前人在哪里”的精确锚点。不能把同一城市的另一个片区
    // 自动当成已到达，否则会复现“入住锦江→凭空从青羊区出发”的错序。
    if (currentIsLodging && LODGING_WORD_RE.test(String(to || ''))
        && sameTravelArea(from, to)) return true;
    if (currentIsLodging) return false;
    return sameTravelArea(from, to);
  };
  const byDay = new Map();
  rows.forEach((item) => {
    const di = Number(item && item.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(item);
  });
  byDay.forEach((list, di) => {
    const sorted = list.slice().sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    let current = '';
    let currentIsLodging = false;
    let droppedOrphan = false;
    sorted.forEach((item, index) => {
      if (!item || drop.has(item)) return;
      const start = String(item.startLocation || '').trim();
      const end = String(item.endLocation || '').trim();
      const movement = item.category === 'transport' && start && end;
      if (movement && current && !reachable(current, start, currentIsLodging)
          && !isHardMove(item) && item.autoConnector !== true) {
        // 连续出现的第二条孤立交通也不能因为它曾经是“早先到过的车站”
        // 就放行；当前地点仍是上一条有效记录的终点。
        drop.add(item);
        droppedOrphan = true;
        console.warn('[generatePlan] 第%d天删除无可达起点的孤立交通：%s→%s',
          di + 1, start, end);
        return;
      }
      if (movement) {
        current = end;
        currentIsLodging = isLodging(end);
        droppedOrphan = false;
        return;
      }
      // 非交通条目的起终点是景点/餐厅闭环时，也要更新当前位置；若它没有
      // 起点但有终点，视为抵达该地点，给下一条交通一个可用锚点。
      if (end && (!current || !currentIsLodging || reachable(current, start, currentIsLodging))) {
        current = end;
        currentIsLodging = item.category === 'hotel' || isLodging(end);
      } else if (!current && start) {
        current = start;
        currentIsLodging = isLodging(start);
      }
      // 第一条普通交通允许由当天大纲/首日出发地隐式开始，不能因为没有
      // 前一条详细记录而误删；变量保留只用于说明审计状态。
      if (index === 0 || droppedOrphan) droppedOrphan = false;
    });
  });
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/**
 * 清理“今晚酒店提前出现”的未来状态。
 *
 * LLM 有时会在当天早晨先写“退房并前往今晚酒店”，随后又从这家今晚酒店
 * 返回旧景区；这不是普通的酒店名称校正，而是把尚未发生的跨城移动提前了。
 * 只要大纲或详细交通已经给出“从外部区域抵达今晚住宿片区”的时间锚点，锚点
 * 之前的住宿终点/住宿起点都不能引用今晚酒店：退房留在昨晚住宿地，后续交通
 * 从昨晚住宿地接续。规则只比较地点范围和时间，不写死任何城市或酒店名称。
 */
function normalizePrematureDestinationRows(items, outline) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const byDay = new Map();
  rows.forEach((item) => {
    const di = Number(item && item.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(item);
  });
  const drop = new Set();
  days.forEach((day, di) => {
    const target = safeHotelOf(day) || String(day && (day.overnight || day.city) || '').trim();
    const dayRows = (byDay.get(di) || []).slice().sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    if (!target || !dayRows.length) return;

    // 优先采用大纲移动段的出发时刻。详细阶段可能把同一段交通拆成多段，
    // 但最终抵达目标片区的第一段仍然是“未来住宿地”的时间边界。
    const plannedArrivalStarts = asArray(day.moves)
      .filter((move) => move && move.from && move.to
        && toMin(move.startTime) !== null
        && sameTravelArea(move.to, target)
        && !sameTravelArea(move.from, target))
      .map((move) => toMin(move.startTime));
    const detailedArrivalStarts = dayRows
      .filter((item) => item && item.category === 'transport'
        && item.startLocation && item.endLocation
        && toMin(item.startTime) !== null
        && sameTravelArea(item.endLocation, target)
        && !sameTravelArea(item.startLocation, target)
        // 不能把“夜市→酒店”“景点→酒店”这种当天回房间的短接驳当成
        // 跨城抵达锚点；无大纲时只采纳铁路、长途汽车/专线或明显长于
        // 90 分钟的跨区交通。
        && (/train|plane|ship|bus|高铁|动车|火车|航班|飞机|大巴|班车|旅游专线|城际|跨城|长途/i
          .test(`${item.transportType || ''} ${item.activity || ''}`)
          || (toMin(item.endTime) !== null && toMin(item.endTime) - toMin(item.startTime) >= 90))
        && !/退房|整理行李|携带(?:全部|大件)?行李/.test(String(item.activity || '')))
      .map((item) => toMin(item.startTime));
    const arrivalStart = [...plannedArrivalStarts, ...detailedArrivalStarts]
      .filter((value) => value !== null)
      .sort((a, b) => a - b)[0];
    if (arrivalStart === undefined) return;

    const previousDay = di > 0 ? days[di - 1] || {} : {};
    const previousBase = di > 0
      ? (safeHotelOf(previousDay) || String(previousDay.overnight || previousDay.city || '').trim())
      : '';
    const textOf = (item) => `${item && item.activity || ''} ${item && item.note || ''}`;
    const replaceStart = (item, oldStart, nextStart) => {
      if (!oldStart || !nextStart) return;
      item.startLocation = nextStart;
      item.startLon = '';
      item.startLat = '';
      if (String(item.activity || '').includes(oldStart)) {
        item.activity = String(item.activity).split(oldStart).join(nextStart);
      }
    };
    dayRows.forEach((item) => {
      if (drop.has(item)) return;
      const start = toMin(item && item.startTime);
      if (start === null || start >= arrivalStart) return;
      const startLocation = String(item && item.startLocation || '').trim();
      const endLocation = String(item && item.endLocation || '').trim();
      const startsAtTarget = !!startLocation && sameTravelArea(startLocation, target);
      const endsAtTarget = !!endLocation && sameTravelArea(endLocation, target);
      if (!startsAtTarget && !endsAtTarget) return;

      const text = textOf(item);
      const luggageDeparture = /退房|整理行李|收拾行李|携带(?:全部|大件)?行李|行李随身/.test(text);
      if (endsAtTarget && !startsAtTarget) {
        if (previousBase && luggageDeparture) {
          // 保留真实的退房动作，但不能让退房条目把人“送到”尚未抵达的
          // 今晚酒店；后续大交通应继续从昨晚住宿地出发。
          item.endLocation = previousBase;
          item.endLon = '';
          item.endLat = '';
          item.activity = '退房并整理行李，携带全部大件行李出发';
          console.warn('[generatePlan] 第%d天清理提前出现的今晚酒店终点：%s → %s',
            di + 1, endLocation.slice(0, 40), previousBase.slice(0, 40));
        } else {
          drop.add(item);
          console.warn('[generatePlan] 第%d天删除抵达大交通前的未来住宿安排：%s',
            di + 1, text.slice(0, 80));
        }
        return;
      }
      if (startsAtTarget && !endsAtTarget && previousBase) {
        // 例如“从今晚南宁酒店步行到德天景区出口”：起点应回到昨晚住宿地，
        // 但目的地和时长仍可保留，避免为了清洗文案而丢掉真实的离开安排。
        replaceStart(item, startLocation, previousBase);
        console.warn('[generatePlan] 第%d天清理提前出现的今晚酒店起点：%s → %s',
          di + 1, startLocation.slice(0, 40), previousBase.slice(0, 40));
      } else if (startsAtTarget && endsAtTarget) {
        // 目标酒店自环且发生在真正抵达之前，只能是模型提前安排的入住/放行李。
        drop.add(item);
      }
    });
  });
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/** 细化结果再次校正住宿条目，防止错误酒店被闭环兜底和下一天继承。 */
function normalizeGeneratedLodging(items, outline, p) {
  const days = asArray(outline && outline.days);
  let out = normalizePrematureDestinationRows(items, outline);
  const removed = new Set();
  // 丢掉模型偶尔放在早晨的「直接去今晚酒店入住」假转移：如果同一天后面
  // 已有交通段真正到达同一家酒店，这条早晨入住会让人先跳到晚上住宿地、再折返。
  days.forEach((day, di) => {
    const target = safeHotelOf(day) || String(day && (day.overnight || day.city) || '').trim();
    if (!target) return;
    const rows = out.filter((it) => Number(it.dayIndex || 0) === di);
    rows.forEach((it) => {
      if (String(it.category || '') !== 'hotel' || !sameTravelArea(it.endLocation, target)) return;
      const text = String(it.activity || '');
      if (!/(?:前往|到达|抵达).{0,50}(?:酒店|民宿|客栈|办理入住|入住|放行李)|办理入住.{0,30}(?:酒店|民宿|客栈)/.test(text)) return;
      const start = toMin(it.startTime);
      if (start == null) return;
      const hasLaterArrival = rows.some((other) => other !== it
        && (toMin(other.startTime) == null || toMin(other.startTime) > start)
        && sameTravelArea(other.endLocation, target)
        && other.category === 'transport' && other.startLocation
        && !sameTravelArea(other.startLocation, target)
        && !/返回|回到|回酒店|回客栈|回民宿/.test(String(other.activity || '')));
      const destinationArea = String(day.overnight || day.city || '').trim();
      const laterOutlineArrival = asArray(day.moves).some((move) => {
        const moveStart = toMin(move && move.startTime);
        const moveEnd = toMin(move && move.endTime);
        return sameTravelArea(move && move.to, destinationArea)
          && ((moveStart !== null && moveStart > start) || (moveEnd !== null && moveEnd > start));
      });
      if (hasLaterArrival || laterOutlineArrival) {
        removed.add(it);
        console.warn('[generatePlan] 第%d天移除提前出现的酒店入住条目，晚些时候已有抵达安排：%s', di + 1, target.slice(0, 40));
      }
    });
  });
  if (removed.size) out = out.filter((it) => !removed.has(it));
  out.forEach((it) => {
    if (!it) return;
    const di = Number(it.dayIndex || 0);
    const day = days[di] || {};
    const scope = dayScope(day);
    const hotel = safeHotelOf(day);
    const target = hotel || String(day.overnight || day.city || '').trim();
    const prevDay = di > 0 ? (days[di - 1] || {}) : null;
    const startScope = prevDay ? dayScope(prevDay) : String((p && p.origin) || '').trim() || scope;
    const startTarget = prevDay
      ? (safeHotelOf(prevDay) || String(prevDay.overnight || prevDay.city || '').trim())
      : String((p && p.origin) || '').trim();
    const start = String(it.startLocation || '').trim();
    const end = String(it.endLocation || '').trim();
    const activity = String(it.activity || '');
    // Morning hotel aliases belong to the previous night, including on the
    // return day. A generic hotel must never be replaced with the home city.
    if (prevDay && end && LODGING_WORD_RE.test(end)
        && (toMin(it.startTime) ?? 1440) < 11 * 60
        && !/办理入住|入住|放下?行李/.test(activity)
        && sameTravelArea(end, startScope)) {
      it.endLocation = startTarget;
      if (end !== startTarget) it.activity = activity.split(end).join(startTarget);
      it.endLon = it.endLat = '';
      return;
    }
    // 模型偶尔会把“晚餐后入住”错误生成成 hotel 自环：起点和终点都写成
    // 餐厅/景点，却套用了“退房、携带全部行李”的旧酒店话术。这个条目既不
    // 能表示离店，也会让下一天继承错误地点。当前日有明确住宿目标时，收敛
    // 为一次真实的“前往今晚住宿地并入住”，保留酒店类别供住宿页和提醒使用。
    const suspiciousHotelSelfLoop = String(it.category || '') === 'hotel'
      && di < days.length - 1
      && !!target
      && !/返程|回家|家中/.test(target)
      && !!start && !!end && samePlace(start, end)
      && !LODGING_WORD_RE.test(start)
      && /退房|携带(?:全部)?(?:大件)?行李/.test(activity);
    if (suspiciousHotelSelfLoop) {
      const oldStart = start;
      // 如果当天后面已经有一次真正到酒店的入住/回房，前面的同地点
      // “退房”只是模型把退房话术贴错了。删除这条伪入住，保留后面的
      // 真实酒店收尾，避免在景点/县城里制造一条住宿自环。
      const laterRealHotel = out.some((other) => other !== it
        && Number(other.dayIndex || 0) === di
        && String(other.category || '') === 'hotel'
        && (toMin(other.startTime) === null || toMin(other.startTime) > (toMin(it.startTime) ?? -1))
        && sameTravelArea(other.endLocation, target)
        && /办理入住|入住|返回|回到|洗漱|休息/.test(String(other.activity || '')));
      if (laterRealHotel) {
        removed.add(it);
        console.warn('[generatePlan] 第%d天删除后续真实入住前的错误酒店自环退房：%s→%s',
          di + 1, oldStart.slice(0, 40), end.slice(0, 40));
        return;
      }
      it.endLocation = target;
      it.activity = `从${oldStart}前往${target}办理入住，放下大件行李并休息`;
      it.transportType = defaultTransferMode(p);
      it.note = String(it.note || '')
        .replace(/今晚不回这家酒店，?退房请带走全部行李（行李随人走）/g, '')
        .replace(/离开前记得取回[^；。]*/g, '')
        .replace(/[；;]\s*[；;]/g, '；')
        .replace(/^[；;]|[；;]$/g, '')
        .trim();
      console.warn('[generatePlan] 第%d天修正非住宿地点的酒店自环退房条目：%s→%s',
        di + 1, oldStart.slice(0, 40), target.slice(0, 40));
      return;
    }
    // 退房并前往下一站属于离店/交通，不能被当成当晚入住再把终点改成今晚酒店。
    if (String(it.category || '') === 'hotel' && /退房/.test(activity)
        && !/回酒店|回民宿|回客栈/.test(activity)) {
      if (/前往|乘车|乘坐|步行|打车|出发|赶往|前往/.test(activity)) {
        it.category = 'transport';
        if (!it.transportType) it.transportType = defaultTransferMode(p);
        return;
      } else if (!/早餐|早饭|早餐店/.test(activity)) {
        it.category = 'other';
        return;
      }
    }
    // 「在昨晚的酒店吃早餐、退房」不是入住目标酒店，也不是跨城交通。
    // 归回餐饮/杂项并把地点留在出发酒店，防止错误终点触发伪造的城市跳转。
    if (/早餐|早饭|早餐店/.test(activity)
        && /退房|收拾行李|整理行李/.test(activity)
        && !/前往|到达|抵达|入住|办理入住|放行李/.test(activity)) {
      // 模型有时把这条写成 food，有时写成 hotel；两者都表示“在昨晚酒店
      // 吃早餐并离店”，终点必须留在 startLocation，不能被下面的住宿范围
      // 校验改成当天晚上的酒店。
      if (String(it.category || '') === 'hotel') it.category = 'food';
      if (start) it.endLocation = start;
      it.transportType = '';
      it.endLon = '';
      it.endLat = '';
      return;
    }
    const badStart = !!start && LODGING_WORD_RE.test(start)
      && adminRootsOf(start).length > 0
      && !locationFitsScope(start, startScope);
    if (badStart && startTarget) {
      it.startLocation = startTarget;
      it.startLon = '';
      it.startLat = '';
      if (activity.includes(start)) it.activity = activity.split(start).join(startTarget);
      console.warn('[generatePlan] 第%d天住宿起点已校正：%s → %s', di + 1, start.slice(0, 80), startTarget);
    }
    // 出发点包含「酒店/住宿」并不表示终点也是住宿：例如“从古尔沟酒店
    // 包车去毕棚沟”，不能因此把景区终点覆盖成当晚酒店。
    const lodgingArrival = String(it.category || '') === 'hotel'
      || LODGING_WORD_RE.test(end)
      || (LODGING_WORD_RE.test(activity)
        && /入住|办理入住|放行李|到达.{0,20}(酒店|民宿|客栈|住宿)|抵达.{0,20}(酒店|民宿|客栈|住宿)/.test(activity));
    if (!lodgingArrival) return;
    const currentEnd = String(it.endLocation || '').trim();
    const targetMatchesEnd = !!target && sameTravelArea(currentEnd, target);
    if (String(it.category || '') === 'hotel' && targetMatchesEnd) {
      const startMinute = toMin(it.startTime);
      const alreadyArrived = out.some((other) => other !== it
        && Number(other.dayIndex || 0) === di
        && other.category === 'transport'
        && (startMinute == null || toMin(other.startTime) == null || toMin(other.startTime) < startMinute)
        && sameTravelArea(other.endLocation, target));
      if (alreadyArrived && it.startLocation && !sameTravelArea(it.startLocation, target)) {
        it.startLocation = '';
        it.startLon = '';
        it.startLat = '';
        if (/前往|抵达|到达/.test(String(it.activity || ''))) {
          it.activity = `在${target}办理入住，放下行李休息`;
        }
      }
    }
    const badEnd = !currentEnd || !locationFitsScope(currentEnd, scope);
    const lodgingEndItem = String(it.category || '') === 'hotel' || LODGING_WORD_RE.test(currentEnd);
    const badNamedEnd = String(it.category || '') === 'hotel' && !!hotel && !!currentEnd
      && (!LODGING_WORD_RE.test(currentEnd) || !samePlace(currentEnd, hotel));
    const badActivity = LODGING_WORD_RE.test(String(it.activity || ''))
      && adminRootsOf(String(it.activity || '')).length > 0
      && !locationFitsScope(String(it.activity || ''), scope)
      && !badStart && lodgingEndItem;
    if (badEnd || badNamedEnd || badActivity) {
      const old = currentEnd;
      if (target) it.endLocation = target;
      it.endLon = '';
      it.endLat = '';
      if (target && (old || badActivity)
        && /入住|办理入住|放行李|回到|回酒店|回民宿|住宿|步行至/.test(activity)) {
        it.activity = `前往${target || '当晚住宿地'}办理入住，放下行李休息`;
      }
      console.warn('[generatePlan] 第%d天住宿条目终点已校正：%s → %s', di + 1, old || '(空)', target || '(空)');
    }
  });

  // 住宿纠偏后再审一次“抵达新片区后的旧酒店起点”。行李规则有时会把
  // 这类条目保留下来（例如新城晚餐前仍写着上一晚酒店），但用户已经
  // 完成了跨城抵达，后续活动应从今晚住宿地/当前片区接续。
  days.forEach((day, di) => {
    if (di <= 0) return;
    const previousDay = days[di - 1] || {};
    const previousBase = String(previousDay.hotel || previousDay.overnight || previousDay.city || '').trim();
    const currentBase = safeHotelOf(day) || String(day.overnight || day.city || '').trim();
    if (!previousBase || !currentBase || samePlace(previousBase, currentBase)) return;
    const dayRows = out.filter((item) => Number(item && item.dayIndex || 0) === di)
      .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    let reachedCurrentBase = false;
    dayRows.forEach((item) => {
      if (reachedCurrentBase && !item.outlineMove
          && sameTravelArea(item.startLocation, previousBase)
          && !/取回|取件|拿回|领回|寄存|行李/.test(`${item.activity || ''} ${item.note || ''}`)) {
        const oldStart = String(item.startLocation || '').trim();
        item.startLocation = currentBase;
        item.startLon = '';
        item.startLat = '';
        if (oldStart && String(item.activity || '').includes(oldStart)) {
          item.activity = String(item.activity).split(oldStart).join(currentBase);
        }
        console.warn('[generatePlan] 第%d天抵达新住宿片区后纠正旧酒店起点：%s → %s',
          di + 1, oldStart.slice(0, 40), currentBase.slice(0, 40));
      }
      if (['hotel', 'transport'].includes(String(item.category || ''))
          && item.endLocation
          && sameTravelArea(item.endLocation, currentBase)
          && !sameTravelArea(item.startLocation, currentBase)) {
        reachedCurrentBase = true;
      }
    });
  });
  return out;
}

/** 给用户画像一句话摘要（喂给 LLM） */
function profileText(p) {
  const bits = [
    `${p.origin || '?'}出发 → ${p.dest || '?'}`,
    `${p.days}天（${p.startDate} 至 ${p.endDate}）`,
  ];
  // 去/返程时刻精确到分钟。语义（2026-09-25 二次修正）：
  //   goTime = **离开出发地（家门口/酒店）的时刻**——第一天行程第 1 条就是
  //            「goTime 从出发地出发，前往车站/机场」的接驳，大交通在其之后发车；
  //   backTime = **回到出发地的时刻**（到家），不是发车也不是到站。
  if (p.goTime) bits.push(`去程 ${p.goTime} 从${p.origin || '出发地'}启程（离开家/酒店的时刻）`);
  if (p.backTime) bits.push(`返程 ${p.backTime} 回到${p.origin || '出发地'}（到家时刻）`);
  bits.push(`${p.party} ${p.peopleNum}人`);
  bits.push(`预算${p.budget}`);
  bits.push(`节奏${p.pace}`);
  bits.push(p.transport);
  if (p.destList && p.destList.length > 1) bits.push('目的地清单：' + p.destList.join('、'));
  if (p.interests.length) bits.push('偏好：' + p.interests.join('、'));
  if (p.mustGo) bits.push('必去：' + p.mustGo);
  if (p.extra) bits.push('特殊要求：' + p.extra);
  if (p.bookingStatus || p.bookedTickets) {
    bits.push('票务状态：' + [p.bookingStatus, p.bookedTickets].filter(Boolean).join('；'));
  }
  if (p.holiday) bits.push('⚠️ 出行日期落在法定长假，必须考虑抢票/错峰');
  return bits.join('；');
}

// ============================================================
// ① 大纲
// ============================================================

/**
 * 大纲体检：到站后还要长途打车的段（通用判定，不涉及任何具体城市/车站）。
 * 只告警——改站交给模型的复核请求，代码不写死车站知识（写死了换个城市就失效）。
 */
function warnDetourTransfers(outline) {
  const detours = detourTransfers(outline);
  if (detours.length) {
    console.warn('[generatePlan] 到站后仍需长途打车的段 %d 处：%s',
      detours.length,
      detours.map((x) => `第${x.dayIndex + 1}天 ${x.move.from}→${x.move.to}（${x.move.transfer}）`).join('；'));
  }
  return outline;
}

async function genOutline(p) {
  // 交通偏好的硬约束：用户选了「高铁/动车优先」就全程不许飞（长距离也一样），
  // 改走近目的地的高铁站 + 短途接驳；选了自驾出行则全程由用户本人驾驶。
  const railFirst = /高铁|动车/.test(p.transport);
  const driveFirst = drivingAllowed(p);
  const planeFirst = /飞机/.test(p.transport);
  const longjiRouteRule = /龙脊|金坑大寨/.test(`${p.dest} ${p.mustGo || ''} ${(p.mustVisit || []).join(' ')}`)
    ? '龙脊金坑大寨路线约束：千层天梯（2号）与西山韶乐（1号）按实际入口和游览方向安排，不能在两条核心路线之间来回折返；只要抵达后到固定离开交通前有足够时间，金佛顶（3号）必须优先与它们安排在同一天，并把接驳、步行、放行李、拍照和游览时长算足。合理示例是先到西山韶乐放行李/休息，再去千层天梯，之后单向前往金佛顶，最后回西山韶乐收尾；禁止西山→千层→西山→金佛顶→西山这种中途折返。只有时间确实不足或会冲突时，才删掉后到的短停或拆到次日，不要无理由拆开三处。'
    : '';
  const lijiangCruiseRule = /漓江|四星级游船|四星游船|磨盘山|竹江码头/.test(
    `${p.dest} ${p.mustGo || ''} ${(p.mustVisit || []).join(' ')}`)
    ? '漓江船型与码头必须匹配：四星级/四星游船从竹江码头出发，不能把四星级游船写成从磨盘山码头出发；若安排磨盘山码头，船型不要标四星级。把码头、船型、购票提醒和当天交通保持一致。'
    : '';
  const localDriveRule = drivingAllowed(p)
    ? '用户已选「自驾出行」：全程每一段城际、市内、景区间移动都由用户本人开车，禁止安排高铁/动车、飞机、大巴或其他替代交通；每次抵达酒店、景区、餐馆等目的地，必须先单独安排停车，再入住、游览或用餐。'
    : taxiAllowed(p)
      ? '未选「自驾出行」：不得默认安排用户本人开车/租车，只有补充要求明确点名的具体路段才可自驾。优先高铁/动车、铁路、公交、景区接驳、旅游专线或大巴；这些没有或明显不方便时，才可安排打车、网约车或有司机包车，并明确这是司机接送。'
      : '用户明确不使用打车/包车；优先高铁/动车、铁路、步行、公交、景区接驳、旅游专线或大巴。未选「自驾出行」时不得默认安排本人开车，只有补充要求明确点名的路段才可自驾。';
  const modeRule = railFirst
    ? `**用户已选「高铁/动车优先」：全程禁止安排飞机（含长距离路段）**。优先高铁；两地之间没有合适的高铁时，可以走动车或城际列车，仍然不许排航班。实在没有铁路直达，就走到离目的地最近的铁路站，再衔接旅游专线/大巴。${localDriveRule}`
    : driveFirst
      ? '**用户已选「自驾出行」：全程每个交通路段都安排用户本人驾驶自己的车**（按路况给出驾驶时长，抵达每个目的地先停车）；不要安排高铁/动车、飞机、包车或大巴。'
      : planeFirst
        ? '**用户已选「飞机优先」：单程超过 6 小时的跨城段优先飞机**，但同城/近郊仍走地面交通。'
        : `优先铁路和旅游专线/大巴；${localDriveRule}`;

  // 用短键名：一份 8 天大纲能省 30%+ 的输出 token。虽然不再设 max_tokens，
  // 但云函数只有 60s，输出越短写得越快，留出余量给"漏点修订"那一次请求。
  const prompt = `为以下旅行需求制定逐日路线大纲。

【需求】${profileText(p)}
${p.holiday ? '【重要】含法定节假日：首末两天通常是往返大交通日，热门项目要预留抢票/预约窗口。' : ''}

# 输出格式（严格 JSON，短键名）
{"t":"行程标题","s":"一句话路线概览","nt":[{"d":"MM-DD","c":"住宿城市"}],"ds":[
{"d":"YYYY-MM-DD","city":"城市","t":"当天主题短语","mv":[{"f":"出发站","to":"到达站","m":"train/plane/car/bus/ship","c":"车次/航班号","s":"HH:mm","e":"HH:mm","st":"到站后到当天首个目的地的接驳方式与耗时"}],"hl":["必玩1","必玩2","必玩3"],"ml":["餐1","餐2"],"ov":"当晚住宿城市或片区","h":"推荐酒店","n":"关键提示（30字内）"}]}

# 硬性要求
${longjiRouteRule ? `0.7 **龙脊线路专门约束**：${longjiRouteRule}` : ''}
${lijiangCruiseRule ? `0.8 **漓江游船专门约束**：${lijiangCruiseRule}` : ''}
0. **城市串联原则（最重要）**：把出发地和所有目的地按「总路程最短 + 换乘最少 + 单程耗时最短」串成一条线。
   - 交通方式判定：${modeRule}
   - 走法要单向推进，禁止来回折返（例：重庆→桂林→阳朔→南宁→重庆，不要 重庆→南宁→桂林→重庆 这种回头路）。
   - 相邻城市间移动尽量控制在 3 小时内；需要更久的，安排在整天里并给出具体班次与运行时长。
   - 同一城市的景点连片玩完再换下一城，避免同城反复往返。
0.1 **按真实地理方位聚类，绝不南北来回跑**：先按实际地理位置把目的地分组（例：龙脊梯田在桂林北面约 2.5 小时车程，阳朔/兴坪在桂林南面，明仕田园/德天瀑布在桂西南崇左），**同一方位的景点连片玩完再去下一方位**。一般规律：先去离主基地最远的一端玩（如先去北面的龙脊），回到主基地后再顺着返程方向一路玩过去（南面的阳朔→更南的崇左/德天），让整条线只有"前进"没有"回头"。
0.2 **住宿闭环（铁律）**：每一天的 ov（当晚住宿地）就是**第二天早上出发的地方**，两天之间不许断链。同一片区的多天写**同一个 ov**（同一家酒店连住，如"桂林市区（两江四湖片区）"连住两晚），一个基地辐射周边景点，别天天换酒店搬行李。禁止出现"昨晚住 A，第二天一早却从 B 出发"的安排。
   **反过来：相邻两天核心游玩片区相距超过约 1 小时车程时，必须换基地**——今晚 ov 要写到离明天景点最近的片区（例：今天玩成都市区、明天一早进毕棚沟，今晚就住理县/古尔沟，绝不允许住成都市、来回通勤 4 小时）；"同一 ov 连住"只适用于同一片区的多天，全称行程只用一家酒店是不允许的。
   0.2.1 **行李随人走（铁律，为游客的方便着想）**：通常只要当晚不回昨晚那家酒店（ov 与前一天不同），大件行李就随身走；但如果**当天上午仍在昨晚住宿片区游玩、下午/傍晚才离开去下一城**，可以把大件行李临时寄存在昨晚酒店前台，轻装完成竹筏、骑行等活动，离开原片区前必须返回取回，再去乘车。补充要求若明确说行李方便随身携带/不用寄存，则按用户要求全程随身，不强行安排寄存。除此以外，禁止把行李寄存在 A 酒店而人去 B 住。换住处的常规走法：退房带走行李 → 抵达新住宿地后**先到酒店放行李/寄存前台，再轻装出门玩**；若当天先去景区，行李随身带到景区，用游客中心的寄存处/存包柜，并在当天提示里写明"离开时取回行李"。
0.3 **一个基地管一片**：同一片景点（如阳朔的西街/遇龙河/十里画廊/兴坪）住在同一个基地辐射游览，不要每天换酒店搬行李；能当天往返的远景点就当天往返。
0.4 **交通+游览二合一的段优先这样串**：游船/观光列车这类"坐上去本身就是游览"的交通（如漓江游船桂林→阳朔），直接作为当天的转移方式（mv 的 m 填 ship，同时写进 hl），下船即开始玩，**不要"游完再原路坐车回来、再重新坐车过去"**。
0.5 **目的地全覆盖（铁律）**：目的地清单里的每一个地点都必须作为**游玩目的地**安排（成为某天的 city / 当天主题 / 必玩点），绝不能只当成过路走廊。哪怕它恰好在两站之间（例：都江堰在成都与毕棚沟之间），也要安排半天到一天**真正进去游玩**，禁止只写"途经都江堰""车览都江堰"。用户点名要去的地方，没有"顺路看一眼"这个说法。
0.6 **同一个景点只玩一次**：每个具体景点（hl 里的名字）在整个行程**只出现在一天**，禁止跨天重复游玩；也禁止"玩完 A 过两天又回头玩 A"。相邻目的地按地理顺序串成一条线，一趟走完。
1. ds 恰好 ${p.days} 天，日期从 ${p.startDate} 连续到 ${p.endDate}，每天一个元素，顺序递增。
2. 路线顺路：相邻两天不来回折返；同一城市连片玩完再换城。
3. 第一天从（或抵达）目的地${p.origin ? `（出发地 ${p.origin}）` : ''}，最后一天返回${p.origin || '出发地'}。${driveFirst ? '自驾出行全程自己开车，首日从出发地开出、末日开回出发地；不要安排公共交通。' : ''}
3.1 ${p.goTime ? driveFirst
    ? `**去程开始时间已由用户指定**：${p.goTime} 是离开${p.origin || '出发地'}并开始自驾的时刻，首段 mv.s 原样填 ${p.goTime}；不要另加去车站、候车或安检。`
    : `**去程开始时间已由用户指定**：${p.goTime} 是用户**离开${p.origin || '出发地'}（家门口）的时刻**，不是发车时刻！第一天的大交通发车时刻 = ${p.goTime} + 市内接驳约 40 分钟 + 安检候车（高铁提前 45 分 / 飞机提前 2 小时），把推算出的发车/起飞时刻写进 mv.s（e 按实际运行时长推算）。`
    : '去程请给出一个具体、合理的启程/发车时刻（s/e 都要精确到分钟）。'}
3.2 ${p.backTime ? driveFirst
    ? `**返程到家时间已由用户指定**：${p.backTime} 是自驾回到${p.origin || '出发地'}的到家时刻，最后一段 mv.e 必须原样填 ${p.backTime}，合理倒推启程时间。`
    : `**返程到家时间已由用户指定**：${p.backTime} 是用户**回到${p.origin || '出发地'}（到家）的时刻**，不是发车也不是到站！最后一天的大交通 mv.e = ${p.backTime} 减去市内返家接驳约 40 分钟（到站时刻），s 按实际运行时长往前倒推。`
    : '返程请给出合理的发车/起飞/启程时刻与到达时刻（精确到分钟）。'}
4. mv 只写城际大交通：**s = 发车/起飞时刻，e = 到达时刻**；火车给参考车次走向（如 G2249），飞机给航线；市内交通不写。
   4.1 **大交通到发站选「下车后接驳最短」的站（铁律）**：同一目的地常有多个车站/码头/机场，选站标准是"**下车（机）后到当天最终景点或今晚住宿地的接驳距离最短**"，不是"车次最多、站名最大、和城市同名就选它"。
   判断顺序：① 先定当天最终要去的景点在哪个片区、今晚住哪；② 倒推哪个车站离它最近、有轨道交通或能步行直达；③ 同城/都市圈内的市域铁路、城际线、机场快线优先——班次密、票价低、不堵车，比"坐到远站再打车折回来"又快又省。
   **禁止舍近求远**：如果某个站下车后还要长距离打车折返才能到当天目的地，就是选错了站，必须换成更近的站（哪怕车次少一点）。
   4.2 **每段 mv 都要给 st（到站/下机后到当天首个目的地的接驳方式与耗时，如"地铁30分钟""步行8分钟""打车20分钟"）**：st 是你自己检验选站是否合格的尺子。
   判据：**st 里写"打车/网约车 ≥25 分钟"就说明这个站选在了反方向**（下车还得花钱绕回目的地），必须重选更近的站，或改成"同城轨道交通/市域铁路 + 短驳"的组合，把 st 变成步行或地铁；轨交/步行 1 小时以内都算合格（大城市坐地铁 40 分钟到酒店很正常，不算绕路）。确实没有更近的站才保留，并在当天 n 里说明原因。
   4.3 **铁路班次只作路线占位，最终由程序按日期查询 12306 官方结果**：不要凭记忆把车次号和时刻写成事实；如果暂时无法判断，车次可以留空，不能生造"G9999"。铁路运行时长仍要符合两地实际距离，站点必须是真实铁路站；最终显示给用户的车次与时刻以程序核对到的 12306 候选为准。航班同样只写合理的路线占位，最终以航司实际为准。
5. hl 每天 3-4 个**具体景点/片区名称**，别写"逛逛市区"这种废话；城市漫游日也要点名具体街区/景点，兼顾${p.pace}节奏和用户兴趣「${p.interests.join('、') || '当地特色'}」。在路线和时长允许时，每天至少落实一个用户偏好，不要只在摘要里复述兴趣。同一景区内先按官方游览线路或地图的单向步行顺序排点，不能为了凑景点在观景台之间来回折返；把景区接驳、排队、上下山和步行时间算进当天安排，复杂山地/徒步线路要留足半日或一整日，不把短暂拍照时间当成完整游览时间。缺少可靠线路信息时，缩小当天景点数量并明确选择一条完整线路，不猜测多个观景点之间的捷径。补充要求「${p.extra || '无'}」必须落实到对应日期与路段；若客观时间不够，减少景点数量并明确取舍。
   5.1 **地名用地图搜得到的通用叫法**：写"象鼻山"就别写成"象鼻山公园"（外省真有同名公园，导航会导过去），不要自造"XX景区大门""XX游客中心"这类后缀，也不要带括号补注。
6. ${p.mustGo ? `用户必去：${p.mustGo}，必须排进合适的一天。` : ''}${p.extra ? `特殊要求：${p.extra}` : ''}
6.1 ${p.mustVisit && p.mustVisit.length ? `**用户点名的目的地一个都不许漏**：${p.mustVisit.join('、')} —— 每一个都必须在大纲里占到实实在在的行程（成为某天的城市、当天主题或必玩点之一）。觉得不顺路的，安排当天往返或顺路串联，宁可调整路线也绝不许默默丢掉任何一个。` : ''}
7. ${/^经济/.test(p.budget) ? '住性价比档，餐饮接地气；' : /^品质/.test(p.budget) ? '住高品质酒店/度假村，餐饮选口碑正餐；' : '住舒适型酒店，餐饮兼顾特色与性价比；'}推荐写类型/片区+代表菜，不要编造具体门牌地址。
   7.1 **每晚推荐一家可核验的住宿**：优先写高德 POI 中能搜到、名称完整的真实酒店/民宿，不要编造店名、分店后缀、门牌和价格；没有把握时只写「片区+住宿档次」，不要把虚构名字伪装成具体酒店。同一片区连住多晚用同一家。最后一天（返程日）h 留空。用户可在酒店提醒分类里逐项核对并选择预订，酒店没有统一放票时间，越早确认越好。
   7.2 **ml 一日三餐都要点名**：写具体店名或"片区/景区+代表菜"（例："午餐：陈麻婆豆腐（青羊店）""晚餐：南桥附近尤兔头"），不要只写"午餐""晚餐"；没有把握的店名就写"片区+招牌菜"（如"晚餐：古尔沟片区藏式汤锅"）。
   7.4 **全程体验要差异化（铁律）**：同一类餐饮（如火锅、烧烤、米粉、小吃）全程**最多安排 2 次**，同一类游览体验（如古镇老街、博物馆、夜市、山岳徒步、主题乐园）也**最多 2 次**。多天行程时每天换花样：逛了老街就换个公园/展馆，吃了火锅就换家常菜/地方菜，让用户每天有新鲜感，而不是换了个地方重复同一种玩法。
   7.3 **市内/短途交通按预算选型**：预算以用户填写的「${p.budget}」为准。经济实惠→ 3km 内步行、地铁/公交/景区接驳优先，打车只留给公共交通到不了或明显不便的路段；舒适适中→ 轨道交通优先，赶时间或携带行李且公共交通不便时打车/包车；品质优选→ 可增加打车/包车。除用户选择「自驾出行」或补充要求点名路段外，不安排用户本人开车。选定的基调写进当天 n 提示。
8. ov 写住宿城市或片区（最后一天写"返程"）；h 每晚一家；nt 长度 = ${p.days - 1} 晚。
9. 所有文本简体中文，n 字段控制在 30 字以内。只输出 JSON 对象。`;

  // 大纲是单独一次云函数调用（60s 上限），留 8s 给返回，单次最多等 52s
  // 注意：不传 max_tokens —— 天数多的时候大纲本来就长，封顶会把后面几天从中间掐断
  const outlineDeadline = Date.now() + 52 * 1000;
  const text = await llm.chatWithRetry([
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: prompt },
  ], { deadline: outlineDeadline });

  // 去程开始 / 返程到达时刻由代码兜底对齐（LLM 自己常常不照办）
  const outline = normalizeOutlineLodging(
    applyTripEdgeTimes(p, enforceOutlineTransportPreference(p, normalizeOutlineJson(parseJSONFromText(text), p)))
  );
  if (!outline.days.length) throw new Error('大纲没有生成任何一天');
  ensureOutlineHighlightCoverage(outline, p);
  enforceLongjiSameDayRoute(outline, p);
  ensureLongjiSunriseSunset(outline);
  ensureOvernightMoveContinuity(outline, p);
  normalizeLijiangCruiseOutline(outline);
  normalizeGeneratedOutlineMoveChains(outline);

  // 点名地点兜底：LLM 偶尔会"自作主张"丢掉它认为不顺路的点
  // （用户点名"桂林、龙脊梯田、阳朔…"，结果整份大纲没有龙脊梯田——实锤踩过）。
  // 生成后对照清单逐个查，漏了且时间还够就发一次修订请求补回来。
  // 同一条修订链路也管"跨天重复游玩"（毕棚沟被排了两天——实锤踩过），
  // 以及"到站后还得长途打车"（站选在反方向、舍近求远——实测踩过）。
  // 这三类都用同一套通用判据，代码里不写任何具体城市/车站的知识。
  const missing = missingMustVisit(p, outline);
  const dups = duplicateHighlights(outline);
  const detours = detourTransfers(outline);
  const earlyReturns = prematureOriginDays(p, outline);
  if (missing.length || dups.length || detours.length || earlyReturns.length) {
    if (missing.length) console.warn('[generatePlan] 大纲漏掉用户点名地点: %s', missing.join('、'));
    if (dups.length) console.warn('[generatePlan] 大纲跨天重复游玩: %s',
      dups.map((d) => `${d.name}(第${d.days.map((x) => x + 1).join(',')}天)`).join('、'));
    if (detours.length) console.warn('[generatePlan] 大纲有到站后仍需长途打车的段: %s',
      detours.map((x) => `第${x.dayIndex + 1}天 ${x.move.from}→${x.move.to}（${x.move.transfer}）`).join('；'));
    if (earlyReturns.length) console.warn('[generatePlan] 大纲提前回到出发地: 第%s天',
      earlyReturns.map((x) => x + 1).join('、'));
    // 修订现在只吐"改动的那几天"，几百 token 就够，12s 足够跑完
    if (outlineDeadline - Date.now() > 12 * 1000) {
      const repaired = await repairOutline(p, outline, missing, dups, detours, earlyReturns, outlineDeadline);
      if (repaired) {
        ensureOutlineHighlightCoverage(repaired, p);
        enforceLongjiSameDayRoute(repaired, p);
        ensureLongjiSunriseSunset(repaired);
        // 修订补丁可能重新带回磨盘山码头；必须在交通连续性审计前统一
        // 四星游船的竹江码头，否则会被误补成“磨盘山→竹江”接驳。
        normalizeLijiangCruiseOutline(repaired);
        normalizeGeneratedOutlineMoveChains(repaired);
        const stillMissing = missingMustVisit(p, repaired);
        const stillDups = duplicateHighlights(repaired);
        const stillDetours = detourTransfers(repaired);
        const stillEarlyReturns = prematureOriginDays(p, repaired);
        // 绕路段只要求"不恶化"：这条体检是概率性的（模型自报耗时不准），
        // 不能因为它没改善就把"漏点补齐/去重"这些确定性修复一起否掉
        const okDetour = stillDetours.length <= detours.length;
        if (!stillMissing.length && stillDups.length < Math.max(1, dups.length) && okDetour && !stillEarlyReturns.length) {
          console.log('[generatePlan] 修订成功（剩余：漏点 %d，重复 %d，绕路段 %d，提前返程 %d）',
            stillMissing.length, stillDups.length, stillDetours.length, stillEarlyReturns.length);
          sanitizeOutlineLocalMoves(repaired);
          return warnDetourTransfers(normalizeOutlineLodging(repaired));
        }
        console.warn('[generatePlan] 修订后仍有问题（漏 %d，重复 %d，绕路段 %d，提前返程 %d）',
          stillMissing.length, stillDups.length, stillDetours.length, stillEarlyReturns.length);
        if (stillEarlyReturns.length) {
          deferPrematureReturn(p, repaired, stillEarlyReturns);
          sanitizeOutlineLocalMoves(repaired);
          normalizeGeneratedOutlineMoveChains(repaired);
          return warnDetourTransfers(normalizeOutlineLodging(repaired));
        }
        // 原大纲仍有提前返程时，即使其他问题让模型补丁不能整体采纳，也先兜住路线闭环。
        if (earlyReturns.length) {
          deferPrematureReturn(p, outline, earlyReturns);
          sanitizeOutlineLocalMoves(outline);
          normalizeGeneratedOutlineMoveChains(outline);
          return warnDetourTransfers(normalizeOutlineLodging(outline));
        }
        sanitizeOutlineLocalMoves(outline);
        normalizeGeneratedOutlineMoveChains(outline);
        return warnDetourTransfers(normalizeOutlineLodging(outline));
      }
    } else {
      console.warn('[generatePlan] 剩余时间不足，跳过修订，保留原大纲');
    }
  }
  const remainingEarlyReturns = prematureOriginDays(p, outline);
  if (remainingEarlyReturns.length) deferPrematureReturn(p, outline, remainingEarlyReturns);
  sanitizeOutlineLocalMoves(outline);
  normalizeGeneratedOutlineMoveChains(outline);
  return warnDetourTransfers(normalizeOutlineLodging(outline));
}

// ---- 时刻工具（分钟制，用于把大交通对齐到用户指定的去/返程时刻）----
function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function fmtMin(v) {
  const t = ((v % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * 把首末两天的大交通对齐到用户指定的时刻（确定性兜底，不靠提示词）
 *
 * 为什么不写在 prompt 里就算了：LLM 看见"去程 08:30 出发"，照样按它认为合理的
 * 14:44 写（提示词加再多硬约束也只是提高概率，还会让输出变啰嗦、更慢）。
 * 与其跟模型较劲，不如生成完用代码把整段班次**整体平移**——运行时长保持不变，
 * 只挪时刻。这样"去程开始时间 / 返程到达时间"是 100% 生效的硬保证。
 *
 * @param {object} p 归一化输入（goTime = 去程开始，backTime = 返程到达）
 * @param {object} outline 归一化后的大纲（会被就地修改）
 */
/**
 * 清洗之后再兜一次「每天第一条的起点」
 *
 * 为什么不在 genDayItems 里做完就算了：sanitizeItems 的"假导航清除"（Pass 3）
 * 会把"起点=终点"的条目成对清掉（如「在酒店吃早餐」被填成 酒店→酒店），
 * 恰好每天第一条经常就是这种"没移动"的条目 —— 前面补的起点被清了个干净。
 * 所以放到 sanitize 之后再做一次，才是真的闭环。
 */
function enforceDayStartLocation(items, outline, p) {
  const days = asArray(outline && outline.days);
  if (!days.length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const ordered = (list) => list.slice().sort((a, b) => {
    const av = toMin(a.startTime);
    const bv = toMin(b.startTime);
    return (av == null ? 24 * 60 : av) - (bv == null ? 24 * 60 : bv);
  });
  const lastKnownOf = (list, day) => {
    // 次日首条起点以大纲的过夜地为准：景点/餐厅的短 POI 常没有行政区，
    // 若先扫描条目终点，会把“昨晚住酒店、晚餐在奎星楼”误判成次日从
    // 奎星楼出发，随后又补一段奎星楼→酒店的无意义折返。
    const lodging = safeHotelOf(day) || String((day && day.overnight) || '').trim();
    if (lodging) return lodging;
    const scope = dayScope(day);
    for (const it of ordered(list).reverse()) {
      const end = String(it.endLocation || '').trim();
      if (end && locationFitsScope(end, scope)) return end;
      const start = String(it.startLocation || '').trim();
      if (start && locationFitsScope(start, scope)) return start;
    }
    return safeHotelOf(day) || String((day && (day.overnight || day.city)) || '').trim();
  };

  const out = items.slice();
  const drop = new Set();
  days.forEach((day, di) => {
    if (di <= 0) return;                       // 第一天本来就是从出发地启程
    const list = byDay.get(di) || [];
    if (!list.length) return;
    const prevDay = days[di - 1] || {};
    const prevList = byDay.get(di - 1) || [];
    const prevLocation = lastKnownOf(prevList, prevDay);
    if (!prevLocation) return;
    const sorted = ordered(list);
    // 模型偶尔把“前一天夜游结束在 A、但实际住宿在 B”写成次日清晨
    // A→C→B，再从 B 出发。既然上一晚住宿已明确是 B，这段只是折返
    // 补链，不应占用第二天早晨；删除到达 B 前的纯市内接驳即可。
    const reconnectIndex = sorted.findIndex((it, index) => index > 0
      && sameTravelArea(it.endLocation, prevLocation)
      && sorted.slice(0, index).every((row) => row.category === 'transport'
        && !/列车|高铁|动车|火车|航班|飞机|大巴|班车|游船|轮渡/.test(
          `${row.transportType || ''} ${row.activity || ''}`)));
    const afterReconnect = reconnectIndex >= 0 ? sorted[reconnectIndex + 1] : null;
    if (reconnectIndex >= 1 && afterReconnect
        && sameTravelArea(afterReconnect.startLocation, prevLocation)
        && (afterReconnect.category !== 'transport'
          || !/列车|高铁|动车|火车|航班|飞机|大巴|班车/.test(
            `${afterReconnect.transportType || ''} ${afterReconnect.activity || ''}`))) {
      sorted.slice(0, reconnectIndex + 1).forEach((row) => drop.add(row));
      console.warn('[generatePlan] 第%d天删除住宿地前的跨日折返接驳：%s',
        di + 1, sorted.slice(0, reconnectIndex + 1).map((row) => row.activity).join(' → ').slice(0, 100));
    }
    const first = sorted.find((row) => !drop.has(row));
    if (!first) return;
    const firstStart = String(first.startLocation || '').trim();
    if (!firstStart) {
      first.startLocation = prevLocation;
      return;
    }
    const prevScope = dayScope(prevDay);
    const firstRoots = adminRootsOf(firstStart);
    const scopeRoots = adminRootsOf(prevScope);
    const bothInPreviousOvernight = prevScope && firstRoots.length && scopeRoots.length
      && firstRoots.some((root) => scopeRoots.some((scopeRoot) =>
        root.root === scopeRoot.root || root.root.includes(scopeRoot.root) || scopeRoot.root.includes(root.root)));
    if (sameTravelArea(firstStart, prevLocation) || bothInPreviousOvernight) return;

    // 早餐被模型错误挂在了当天第一个景区上，但后面已有从昨晚住宿片区前往该景区的
    // 明确交通时，不要再插一条“酒店→景区→早餐回城→再次去景区”的折返接驳。
    // 将早餐地点归到昨晚住宿片区，保留后面那条真实交通作为当天唯一进景区的路线。
    const firstEnd = toMin(first.endTime);
    const laterRoute = list.find((it) => it !== first && it.category === 'transport'
      && toMin(it.startTime) != null && (firstEnd == null || toMin(it.startTime) >= firstEnd)
      && sameTravelArea(it.startLocation, prevLocation)
      && sameTravelArea(it.endLocation, firstStart));
    const firstText = `${first.activity || ''} ${first.note || ''}`;
    const previousText = `${prevDay.city || ''} ${prevDay.overnight || ''} ${prevLocation}`;
    const previousWords = scopeWordsOf(previousText);
    const mealBelongsBeforeTrip = first.category === 'food'
      && /早餐|早饭/.test(firstText)
      && previousWords.some((word) => word.length >= 2 && firstText.includes(word));
    if (laterRoute && mealBelongsBeforeTrip) {
      first.startLocation = '';
      first.endLocation = prevLocation;
      first.endLon = '';
      first.endLat = '';
      return;
    }

    // 起点不一致时补一条真实的跨日接驳，保留模型原本的第一站，
    // 比直接覆盖第一站更安全：有些行程确实需要先从住宿地去车站/景区。
    const firstMin = toMin(first.startTime);
    if (firstMin == null) {
      first.startLocation = prevLocation;
      return;
    }
    const end = firstMin;
    const start = Math.max(0, end - 30);
    out.push({
      dayIndex: di,
      startTime: fmtMin(start),
      endTime: fmtMin(end),
      activity: `从${prevLocation}前往${firstStart}，开始当天行程`,
      category: 'transport',
      startLocation: prevLocation,
      endLocation: firstStart,
      transportType: p ? defaultTransferMode(p) : 'ride',
      note: '跨日位置接驳（根据前一天收尾位置补齐）',
    });
    console.warn('[generatePlan] 第%d天首条起点与前一晚位置不一致，补一条 %s→%s 接驳',
      di + 1, prevLocation.slice(0, 20), firstStart.slice(0, 20));
  });
  return drop.size ? out.filter((item) => !drop.has(item)) : out;
}

/** A stale hotel origin must not reappear after the day has already reached another city. */
function reconcileTransportOrigins(items, outline) {
  const days = asArray(outline && outline.days);
  const byDay = new Map();
  asArray(items).forEach((item) => {
    const index = Number(item && item.dayIndex || 0);
    if (!byDay.has(index)) byDay.set(index, []);
    byDay.get(index).push(item);
  });
  byDay.forEach((rows, dayIndex) => {
    const previousNight = String((days[dayIndex - 1] && (days[dayIndex - 1].overnight || days[dayIndex - 1].city)) || '').trim();
    if (!previousNight) return;
    const sorted = rows.slice().sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    const previousDay = days[dayIndex - 1] || {};
    const previousHotel = safeHotelOf(previousDay) || previousNight;
    const firstMoveIndex = sorted.findIndex((item) => item.category === 'transport'
      || item.transportType || (item.startLocation && item.endLocation
        && /前往|乘车|乘坐|打车|包车|步行|乘船|坐船|接驳/.test(String(item.activity || ''))));
    const firstMove = firstMoveIndex >= 0 ? sorted[firstMoveIndex] : null;
    // 次日首段交通必须从昨晚住宿区域开始，避免酒店起点和实际位置断链。
    const firstMoveStartsAtPreviousNight = firstMove
      && (sameTravelArea(firstMove.startLocation, previousHotel)
        || sameTravelArea(firstMove.startLocation, previousNight));
    // 如果当天已经先游览/抵达了这个交通起点（例如先从金坑到金佛顶，
    // 再从金佛顶乘车离开），不能把它误改回昨晚酒店，否则会丢掉景区内
    // 的真实顺序并造成“酒店→景区/景区→酒店”的绕路。
    const reachedWithinDay = firstMove && firstMoveIndex > 0
      && sorted.slice(0, firstMoveIndex).some((item) => item.endLocation
        && sameTravelArea(item.endLocation, firstMove.startLocation));
    if (firstMove && firstMove.schedSource !== '12306'
        && !/train|plane|ship/.test(String(firstMove.transportType || ''))
        && LODGING_WORD_RE.test(String(firstMove.startLocation || ''))
        && firstMove.startLocation && !firstMoveStartsAtPreviousNight && !reachedWithinDay) {
      const oldStart = String(firstMove.startLocation || '').trim();
      firstMove.startLocation = previousHotel;
      firstMove.startLon = '';
      firstMove.startLat = '';
      if (firstMove.activity && oldStart && String(firstMove.activity).includes(oldStart)) {
        firstMove.activity = String(firstMove.activity).split(oldStart).join(previousHotel);
      }
      console.warn('[generatePlan] 第%d天首段交通起点误用了今晚酒店，改回昨晚住宿地：%s → %s',
        dayIndex + 1, oldStart.slice(0, 32), previousHotel.slice(0, 32));
    }
    const priorMoves = [];
    sorted.forEach((item) => {
      const outlineRoute = asArray(days[dayIndex] && days[dayIndex].moves).some((move) =>
        samePlace(move.from, item.startLocation) && samePlace(move.to, item.endLocation));
      if (item.schedSource === '12306' || outlineRoute
          || /train|plane|ship/.test(String(item.transportType || ''))) { priorMoves.push(item); return; }
      const activity = String(item.activity || '');
      const movementRow = item.category === 'transport' || item.transportType
        || (item.startLocation && item.endLocation
          && /前往|乘车|乘坐|打车|包车|步行|乘船|坐船|抵达|出发|接驳|开车|自驾|驾驶|驾车/.test(activity));
      if (!movementRow) return;
      const start = String(item.startLocation || '').trim();
      const previousMove = priorMoves[priorMoves.length - 1];
      const reachedAnotherArea = previousMove && previousMove.endLocation
        && !sameTravelArea(previousMove.startLocation, previousMove.endLocation);
      if (reachedAnotherArea && LODGING_WORD_RE.test(start) && sameTravelArea(start, previousNight)
          && !sameTravelArea(start, previousMove.endLocation)) {
        const oldStart = start;
        item.startLocation = String(previousMove.endLocation).trim();
        if (item.activity && oldStart && String(item.activity).includes(oldStart)) {
          item.activity = String(item.activity).split(oldStart).join(item.startLocation);
        }
        item.startLon = '';
        item.startLat = '';
        console.warn('[generatePlan] 第%d天交通起点已接续前一段抵达地：%s → %s',
          dayIndex + 1, oldStart.slice(0, 32), item.startLocation.slice(0, 32));
      }
      priorMoves.push(item);
    });
  });
  return items;
}

/** Remove generated vehicle legs whose origin and destination are the same named place. */
function removeZeroDistanceTransports(items) {
  const loopLike = /环线|环游|绕行|往返|环岛|环湖|环山|游览车|观光车|接驳循环/;
  const stationVicinity = (value) => String(value || '')
    .replace(/(?:周边|附近|站内|站旁|站前|门口|餐饮店|餐馆|饭店|美食街|候车点|上车点)/g, '')
    .trim();
  const sameStationVicinity = (a, b) => {
    const left = stationVicinity(a);
    const right = stationVicinity(b);
    if (!left || !right) return false;
    const hasVicinity = left !== String(a || '').trim() || right !== String(b || '').trim();
    return hasVicinity && sameStation(left, right);
  };
  return asArray(items).filter((item) => {
    if (!item || item.category !== 'transport') return true;
    const start = String(item.startLocation || '').trim();
    const end = String(item.endLocation || '').trim();
    if (!start || !end || (!samePlace(start, end) && !sameStationVicinity(start, end))
        || loopLike.test(String(item.activity || ''))) return true;
    console.warn('[generatePlan] 移除起终点相同的无效交通条目：%s', String(item.activity || '').slice(0, 64));
    return false;
  });
}

/** Drop generated activities that continue after the traveler has reached home on the final day. */
function removeAfterHomeArrival(items, p, outline) {
  const rows = asArray(items);
  const lastDay = asArray(outline && outline.days).length - 1;
  const origin = String(p && p.origin || '').trim();
  const arrivalWords = /到家|回家|返家|返回家中|抵达家中/;
  if (lastDay < 0 || !origin) return rows;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 不能仅因一段跨城车次的说明里提到了“重庆金童路”就判定已经到家；
  // 只有终点字段命中出发地，或活动明确使用“返回/抵达/回到+出发地”
  // 的到达语义，才允许截断后续条目。
  const explicitHomeActivity = (activity) => arrivalWords.test(activity)
    || new RegExp(`(?:抵达|到达|返回|回到|回)[^。；;，,]{0,16}${escapedOrigin}`).test(activity);
  const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === lastDay);
  const arrivals = dayRows.filter((item) => {
    const end = String(item && item.endLocation || '').trim();
    const activity = String(item && item.activity || '');
    const genericHomeEnd = !end || /^(返程|回家|家中|家)$/.test(end);
    const isArrival = matchesOriginPlace(end, origin)
      || (genericHomeEnd && explicitHomeActivity(activity));
    return isArrival && (item.category === 'transport' || item.transportType || arrivalWords.test(activity));
  }).map((item) => ({ item, end: toMin(item.endTime) }))
    .filter((row) => row.end !== null)
    .sort((a, b) => a.end - b.end);
  if (!arrivals.length) return rows;
  const requested = toMin(p && p.backTime);
  const arrival = arrivals.find((row) => requested !== null && row.end === requested) || arrivals[arrivals.length - 1];
  if (requested !== null && arrival.item.schedSource !== '12306' && arrival.end !== requested) {
    const start = toMin(arrival.item.startTime);
    if (start !== null && start >= requested) arrival.item.startTime = fmtMin(Math.max(0, requested - 30));
    arrival.item.endTime = fmtMin(requested);
    arrival.end = requested;
  }
  const remove = new Set();
  dayRows.forEach((item) => {
    if (item === arrival.item) return;
    const start = toMin(item && item.startTime);
    const end = toMin(item && item.endTime);
    if (start !== null && start >= arrival.end) {
      remove.add(item);
      return;
    }
    // A non-transport activity can overlap the final home transfer; cap it at arrival.
    // A second transport after getting home is always stale and is dropped above.
    if (start !== null && start < arrival.end && end !== null && end > arrival.end
        && !isTransportItem(item)) item.endTime = fmtMin(arrival.end);
  });
  if (remove.size) console.warn('[generatePlan] 移除到家后的末日行程 %d 条（到家 %s）', remove.size, fmtMin(arrival.end));
  return rows.filter((item) => !remove.has(item));
}

/**
 * 已确认大交通对齐兜底（确定性，不靠模型自觉）
 *
 * 实测踩过：大纲里"成都东→重庆西 G8528 15:00-17:00"被细化模型写到早上 09:00，
 * 还在 activity 里自圆其说"实际行程将提前完成都江堰，此处为倒叙 bridge…此处特别
 * 规划时间线以符合'上游规定'的约束"——用户看到的是"标的去重庆西，实际先玩都江堰"，
 * 外加一整段内心戏。这里按车次码把大交通硬拽回既定的时刻和起终点：
 *   · 全天没提这段大交通 → 补一条干净的交通条目（时刻/起终点取大纲）
 *   · 同一车次码出现多条 → 留一条，其余丢弃（同一天不可能坐两次同一班车）
 *   · 条目时刻漂移超 60 分钟 → 拽回大纲时刻（15:00 的车不许排在 09:00）
 *   · 起终点强制对齐大纲车站（导航 chip 直接吃这两个字段，错一个字导去对面省）
 *   · activity 还带着独白或串了别的地名 → 重写成干净版
 */
/** 真班次码（G8515/CA4123 这类）；"包车/租车""顺风车"是写法不是码 */
function isRealCode(code) {
  const c = String(code || '').trim();
  return !!c && /^[A-Za-z]{0,2}\d{2,}/.test(c) && !/包车|租车|顺风|大巴|直通|专线|索道/.test(c);
}

/** 大纲 move → 干净的交通条目文案（补条目与骨架兜底共用） */
function moveActivityText(m, p) {
  const mode = String(m.mode || '').toLowerCase();
  const code = String(m.code || '').trim();
  if (/car|drive|自驾/.test(mode) && drivingAllowed(p)) return `自行驾驶从${m.from}前往${m.to}`;
  if (/plane|航班|飞机/.test(mode)) return code ? `乘 ${code} 航班从${m.from}前往${m.to}` : `乘飞机从${m.from}前往${m.to}`;
  if (/train|高铁|动车|火车/.test(mode)) return m.scheduleRequired
    ? `计划乘高铁/动车从${m.from}前往${m.to}（班次待确认）`
    : code ? `乘 ${code} 次列车从${m.from}前往${m.to}` : `乘火车从${m.from}前往${m.to}`;
  if (/ship|游船/.test(mode)) return code ? `乘 ${code} 从${m.from}前往${m.to}` : `乘船从${m.from}前往${m.to}`;
  if (/bus|coach|shuttle|tour.?line|直通车|旅游专线|大巴|班车/.test(mode)) return `乘旅游专线或大巴从${m.from}前往${m.to}`;
  if (/taxi|ride|charter|car|drive|包车|打车|网约车/.test(mode)) return `乘有司机接送的车辆从${m.from}前往${m.to}`;
  return isRealCode(code) ? `乘 ${code} 从${m.from}前往${m.to}` : `乘公共交通或司机接送从${m.from}前往${m.to}`;
}

/** 班次类大交通（火车/飞机/游船或真车次码）：按码/路段对齐；接驳类只做宽松匹配防重复补 */
function isScheduledMove(m) {
  const mode = String(m.mode || '').toLowerCase();
  return /train|plane|ship|船|轮渡|渡船/.test(mode) || isRealCode(m.code);
}

/**
 * @param {number[]} [activeDays] 续跑时本轮真正产出条目的天。
 *   不传 = 全量处理（首轮/单次生成）。
 *   ⚠️ 续跑必须传：本轮 items 只包含这一轮新生成的天，而本函数原本按整个大纲
 *      循环，会把之前轮次已生成好的天再补一遍大交通（实测第 1 天凭空多出
 *      "接驳 + 高铁 + 回酒店"3 条），每轮都往库里合并 → 行程里一堆重复条目。
 */
function enforceMovesAlignment(items, outline, activeDays, p) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const active = new Set(asArray(activeDays).map(Number));
  const railLike = (m) => /train|plane|高铁|动车|火车|航班|飞机|ship|游船|bus|coach|shuttle|tour.?line|taxi|ride|charter|car|drive|walk|metro|subway|大巴|班车|旅游专线|打车|包车|公交|地铁|步行/
    .test(`${m.mode || ''}${m.code || ''}`.toLowerCase());
  const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moveActivity = (move) => moveActivityText(move, p);
  const transportTypeOf = (m) => {
    const mode = String(m.mode || '').toLowerCase();
    if (/plane|航班|飞机/.test(mode)) return 'plane';
    if (/ship|游船|轮渡|渡船/.test(mode)) return 'ship';
    if (/train|高铁|动车|火车/.test(mode)) return 'train';
    if (/bus|coach|shuttle|tour.?line|直通车|旅游专线|大巴|班车/.test(mode)) return 'bus';
    if (/car|drive|自驾/.test(mode)) return drivingAllowed(p) ? 'car' : 'ride';
    if (/taxi|ride|charter|包车|打车|网约车/.test(mode)) return 'ride';
    if (/walk|步行/.test(mode)) return 'walk';
    return '';
  };
  const cityRootOf = (value) => {
    const clean = String(value || '').replace(/[（(][^）)]*[）)]/g, '').replace(/(?:省|市|县|区|镇|站|客运站|火车站|高铁站)/g, '');
    return (clean.match(/[\u4e00-\u9fa5]{2}/) || [''])[0];
  };
  const sameArea = (a, b) => sameTravelArea(a, b)
    || (!!cityRootOf(a) && cityRootOf(a) === cityRootOf(b));
  const guessMoveTimes = (move, existing) => {
    const start = toMin(move.startTime);
    const end = toMin(move.endTime);
    if (start !== null && end !== null && end > start) return { start, end, estimated: false };
    const mode = String(move.mode || '').toLowerCase();
    const duration = Math.max(15, Math.min(300,
      parseDurationMin(move.transfer || '') || (/bus|coach|shuttle|大巴|专线/.test(mode) ? 180
        : /car|charter|taxi|包车|打车/.test(mode) ? 90 : /walk|步行/.test(mode) ? 30 : 60)));
    const rows = existing.filter((it) => it && it.category === 'transport');
    const targetArrivals = rows.map((it) => ({
      item: it,
      time: toMin(it.startTime),
    })).filter((row) => row.time !== null && sameArea(row.item.endLocation, move.to))
      .sort((a, b) => a.time - b.time);
    const targetDepartures = rows.map((it) => ({
      item: it,
      time: toMin(it.startTime),
    })).filter((row) => row.time !== null && sameArea(row.item.startLocation, move.to))
      .sort((a, b) => a.time - b.time);
    const originArrivals = rows.map((it) => ({
      item: it,
      time: toMin(it.endTime),
    })).filter((row) => row.time !== null && sameArea(row.item.endLocation, move.from))
      .sort((a, b) => b.time - a.time);
    const originDepartures = rows.map((it) => ({
      item: it,
      time: toMin(it.endTime),
    })).filter((row) => row.time !== null && sameArea(row.item.startLocation, move.from))
      .sort((a, b) => b.time - a.time);
    const originVisits = existing.filter((it) => it && it.category === 'sight'
      && (samePlace(it.startLocation, move.from) || samePlace(it.endLocation, move.from)
        || String(it.activity || '').includes(placeStem(move.from))))
      .map((it) => toMin(it.endTime)).filter((time) => time !== null);
    let s = start;
    let e = end;
    // 无时刻移动首先接在“抵达本段起点”的实际条目之后。若先拿
    // 目的地的其它发车时间倒推，容易把“游玩后离开”排到当天开场，
    // 形成先离开景区、后又抵达景区的倒序。
    if (s === null && e === null && originVisits.length) {
      s = Math.max(...originVisits) + 15;
      e = s + duration;
    } else if (s === null && e === null && originArrivals.length) {
      s = originArrivals[0].time + 15;
      e = s + duration;
    } else if (s === null && e === null && targetDepartures.length) {
      e = targetDepartures[0].time;
      s = e - duration;
    } else if (s === null && originDepartures.length) {
      s = originDepartures[0].time;
      e = s + duration;
    } else if (e === null && targetArrivals.length) {
      e = targetArrivals[0].time;
      s = e - duration;
    } else if (s === null && e === null) {
      const timed = existing.map((it) => toMin(it.startTime)).filter((x) => x !== null).sort((a, b) => a - b);
      e = timed.length ? timed[0] : 8 * 60;
      s = e - duration;
    } else if (s === null) s = e - duration;
    else if (e === null) e = s + duration;
    s = Math.max(0, Math.min(s, 23 * 60 + 30));
    e = Math.max(s + 15, Math.min(e, 23 * 60 + 59));
    return { start: s, end: e, estimated: true };
  };

  const out = items.slice();
  days.forEach((day, di) => {
    if (active.size && !active.has(di)) return;   // 本轮没产出这一天的条目 → 不碰它
    // moves 是大纲对真实地点移动的完整清单，不能只处理有车次号的火车/飞机。
    // 没有 code 的旅游专线、大巴、包车、接驳同样必须落进行程，否则会出现
    // 火车到站后直接开始景点/酒店、跨城路段消失的空档。
    const moves = asArray(day && day.moves).filter((m) => m && m.from && m.to
      && (String(m.code || '').trim() || railLike(m) || String(m.mode || '').trim()));
    if (!moves.length) return;
    moves.forEach((m) => {
      const code = String(m.code || '').trim();
      // 包车/自驾/大巴（没有真车次码）不参与"按码去重"：实测同一天两段不同方向的
      // 包车（都江堰→古尔沟、古尔沟→毕棚沟）都写了"包车"二字，被当成同一班车删掉一条
      const scheduled = isScheduledMove(m);
      const codeRe = scheduled && code ? new RegExp(escapeRe(code)) : null;
      const fStem = placeStem(m.from);
      const tStem = placeStem(m.to);
      const inDay = out.filter((it) => Number(it.dayIndex || 0) === di);
      const boatMove = /ship|船|轮渡|渡船/.test(`${m.mode || ''} ${m.type || ''}`.toLowerCase());
      const boatActivityCovers = (it) => {
        const activity = String(it.activity || '');
        if (!boatMove || !/船|游船|竹筏|漂流/.test(activity)) return false;
        if (samePlace(it.startLocation, m.from) && samePlace(it.endLocation, m.to)) return true;
        // 游船/竹筏往往被细化模型归到 sight，而不是 transport。这里既要
        // 允许这种“体验型交通”参与去重，也要兼容活动文案只写码头全名+
        // 目的地城市的情况（例如“磨盘山码头→阳朔龙头山码头”）。
        const compact = activity.replace(/[\s\u3000]/g, '');
        const fromTokens = [fStem, cityRootOf(m.from)].filter((x, i, a) => x && a.indexOf(x) === i);
        const toTokens = [tStem, cityRootOf(m.to)].filter((x, i, a) => x && a.indexOf(x) === i);
        const fromHit = fromTokens.some((token) => token.length >= 2 && compact.includes(token));
        const toHit = toTokens.some((token) => token.length >= 2 && compact.includes(token));
        // 体验型游览常把起点只写成“漓江游船/竹筏”，但终点字段已经
        // 是大纲目的地；这种条目仍然完整覆盖大纲船段，不能再补一条
        // 同一班船造成“先游览、后重复乘船”的假折返。
        const endpointTo = samePlace(it.endLocation, m.to) || toHit;
        const endpointFrom = samePlace(it.startLocation, m.from) || fromHit;
        return (endpointFrom && endpointTo) || (it.category === 'sight' && endpointTo);
      };
      const matched = scheduled
        ? inDay.filter((it) => {
            const experienceMove = boatActivityCovers(it);
            if (it.category !== 'transport' && !experienceMove) return false;
            const itemCode = transportCodeOf(it);
            const exactRoute = (samePlace(it.startLocation, m.from) && samePlace(it.endLocation, m.to))
              || (fStem.length >= 2 && tStem.length >= 2
                && String(it.activity || '').includes(fStem) && String(it.activity || '').includes(tStem));
            const routeWithoutConflictingCode = exactRoute && (!itemCode || !code || itemCode === code);
            const railText = /train|plane|ship|高铁|动车|火车|列车|航班|飞机|游船/.test(
              `${it.transportType || ''} ${it.activity || ''}`);
            return experienceMove
              || (codeRe && isRealCode(code) && railText
                ? codeRe.test(`${it.activity || ''} ${it.note || ''}`) : false)
              || routeWithoutConflictingCode
              || (!code && boatActivityCovers(it));
          })
        : [];

      // 包车/自驾/大巴段没有车次码可对：只要当天已有"同方向"的交通条目
      // （终点或起点地名对得上），就视为模型已安排，绝不重复补 ——
      // 实测踩过：细化写了"乘车沿 G317 前往理县县城"，兜底又补一条
      // "乘包车/租车 从都江堰景区前往理县县城"，一天两段重复的车。
      if (!scheduled) {
        const previousNight = String((days[di - 1] && (days[di - 1].overnight || days[di - 1].city)) || '').trim();
        const arrivedAtDestination = previousNight && inDay.some((it) => it.category === 'transport'
          && sameTravelArea(it.startLocation, previousNight)
          && sameTravelArea(it.endLocation, m.to)
          && (toMin(m.startTime) == null || toMin(it.endTime) == null || toMin(it.endTime) <= toMin(m.startTime)));
        if (arrivedAtDestination) {
          console.log('[generatePlan] 第%d天交通段 %s→%s 已由前一晚住宿地直达该目的地的安排覆盖', di + 1, m.from, m.to);
          return;
        }
        const activity = (it) => String(it.activity || '');
        const toStem = placeStem(m.to);
        const fromStem = placeStem(m.from);
        const normalizedArea = (value) => normalizeRoutePlace(value)
          .replace(/住宿片区|住宿地|住宿区|酒店|民宿|客栈|附近|周边|游客中心|景区|停车场/g, '');
        const sameRouteArea = (a, b) => sameTravelArea(a, b)
          || (!!cityRootOf(a) && cityRootOf(a) === cityRootOf(b))
          || (!!normalizedArea(a) && !!normalizedArea(b)
            && (normalizedArea(a).includes(normalizedArea(b)) || normalizedArea(b).includes(normalizedArea(a))));
        const genericOrigin = /住宿地|住宿区|酒店|民宿|客栈|住处|当前位置/.test(String(m.from || ''));
        const originAreas = [
          days[di - 1] && (days[di - 1].overnight || days[di - 1].city),
          day && (day.hotel || day.overnight || day.city),
        ].filter(Boolean);
        const transportRows = inDay.filter((it) => it.category === 'transport'
          && String(it.startLocation || '').trim() && String(it.endLocation || '').trim());
        // 细化模型有时会把“德天瀑布→南宁东站”拆成“硕龙镇集散中心→南宁东站”，
        // 起点粒度虽然不同，但前一晚住宿→集散中心的接驳已经把人送到这段车的
        // 实际上车点。仅比较大纲起点会误判为“全天未安排”，再补一条重叠的
        // 直达大巴。这里要求：
        //   1) 已有交通条目抵达同一目的地；
        //   2) 它的实际起点能从前一晚住宿/当天起点通过连续接驳到达；
        //   3) 时段与大纲段相邻或有交集。
        // 这样能覆盖“景区/集散中心/客运站”名称粒度差异，又不会把另一条无关
        // 的同终点交通误当成大纲段。
        const destinationCoverage = (() => {
          const expectedStart = toMin(m.startTime);
          const expectedEnd = toMin(m.endTime);
          // 这里比“同一行政区”更严格：硕龙镇和明仕田园都在大新县，
          // 但它们是两个需要实际换乘的目的地，不能因为行政区相同就把
          // 明仕酒店→明仕景区误当成硕龙镇→明仕田园已经完成。地点带
          // 行政前缀时再用末尾片区词（如“大新县硕龙镇”→“硕龙”）
          // 补一个通用的同点判断。
          const moveOriginMatches = (a, b) => {
            if (samePlace(a, b)) return true;
            const left = normalizeRoutePlace(a);
            const right = normalizeRoutePlace(b);
            if (!left || !right) return false;
            if (left.slice(0, 2) === right.slice(0, 2)) return true;
            const leftTail = left.slice(-2);
            const rightTail = right.slice(-2);
            return leftTail.length === 2 && leftTail === rightTail
              && !/酒店|民宿|客栈|宾馆|车站|码头|景区/.test(`${leftTail}${rightTail}`);
          };
          const contextOrigins = [
            days[di - 1] && (days[di - 1].overnight || days[di - 1].city),
            day && day.overnight,
            day && day.city,
          ].map((x) => String(x || '').trim()).filter(Boolean);
          // 当前日的 overnight/city 只能作为“这段大交通本来就从当前
          // 住宿地出发”的上下文。若大纲明确写的是上一住宿地→下一站，
          // 不能拿当前目的地的一条酒店→景区接驳冒充已经完成了前半段，
          // 否则跨城日会丢掉真实的前置交通。
          const originMatchesMove = (origin) => moveOriginMatches(origin, m.from)
            || /住宿地|住宿区|酒店|民宿|客栈|住处|当前位置/.test(String(m.from || ''));
          const matchedOrigins = contextOrigins.filter(originMatchesMove);
          if (matchedOrigins.length) contextOrigins.splice(0, contextOrigins.length, ...matchedOrigins);
          if (!contextOrigins.length) return null;
          const reachableFromContext = (target, excluded) => {
            const queue = contextOrigins.map((place) => ({ place, end: null }));
            const visited = new Set();
            while (queue.length) {
              const current = queue.shift();
              const key = normalizeRoutePlace(current.place);
              if (!key || visited.has(key)) continue;
              visited.add(key);
              if (moveOriginMatches(current.place, target)) return true;
              transportRows.forEach((row) => {
                if (row === excluded || !moveOriginMatches(row.startLocation, current.place)) return;
                const rowStart = toMin(row.startTime);
                const rowEnd = toMin(row.endTime);
                if (current.end !== null && rowStart !== null && rowStart < current.end - 15) return;
                queue.push({ place: row.endLocation, end: rowEnd });
              });
            }
            return false;
          };
          return transportRows.find((row) => {
            if (!sameRouteArea(row.endLocation, m.to)) return false;
            const rowStart = toMin(row.startTime);
            const rowEnd = toMin(row.endTime);
            const timeFits = expectedStart === null || expectedEnd === null
              || rowStart === null || rowEnd === null
              || (rowEnd >= expectedStart - 30 && rowStart <= expectedEnd + 30);
            return timeFits && reachableFromContext(row.startLocation, row);
          }) || null;
        })();
        if (destinationCoverage) {
          console.log('[generatePlan] 第%d天交通段 %s→%s 已由前置接驳衔接至同一目的地，不重复补直达段',
            di + 1, m.from, m.to);
          return;
        }
        const beginsAtMoveOrigin = (item) => sameRouteArea(item.startLocation, m.from)
          || (genericOrigin && originAreas.some((area) => sameRouteArea(item.startLocation, area)));
        const sourceRows = transportRows.filter(beginsAtMoveOrigin)
          .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
        const lodgingStarts = sourceRows.filter((item) => /住宿|酒店|宾馆|民宿|客栈|住处/.test(String(item.startLocation || '')));
        const chainStarts = genericOrigin && lodgingStarts.length ? lodgingStarts
          : genericOrigin ? sourceRows.slice(0, 1) : sourceRows;
        const chainCoversMove = () => {
          const queue = chainStarts.map((item) => ({ place: item.endLocation, hops: 1 }));
          const visited = new Set();
          while (queue.length) {
            const current = queue.shift();
            const place = String(current.place || '').trim();
            if (!place || visited.has(place)) continue;
            if (current.hops > 1 && sameRouteArea(place, m.to)) return true;
            visited.add(place);
            transportRows.filter((item) => sameRouteArea(item.startLocation, place))
              .forEach((item) => {
                if (!visited.has(String(item.endLocation || '').trim())) queue.push({ place: item.endLocation, hops: current.hops + 1 });
              });
          }
          return false;
        };
        if (chainCoversMove()) {
          console.log('[generatePlan] 第%d天移动段 %s→%s 已由连续接驳覆盖，不重复补整段', di + 1, m.from, m.to);
          return;
        }
        // 跨日住宿地经常被大纲写成“古尔沟”，而细化模型会从真实酒店名
        // （例如“理县塔斯基藏家客栈”）直接出发。若这条交通已经抵达大纲
        // 目的地，必须把它归一到大纲移动段，而不是因为起点粒度不同再补一
        // 条“古尔沟→毕棚沟”的重复包车。保留真实酒店信息到 note，结构化
        // 起点使用大纲地点，便于后续顺序审计和跨页联动。
        const previousOvernight = String((days[di - 1] && (days[di - 1].overnight || days[di - 1].city)) || '').trim();
        const lodgingBridge = previousOvernight && sameRouteArea(previousOvernight, m.from)
          ? transportRows.filter((item) => sameRouteArea(item.endLocation, m.to)
            && (LODGING_WORD_RE.test(String(item.startLocation || ''))
              || sameRouteArea(item.startLocation, previousOvernight)))
              .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0]
          : null;
        if (lodgingBridge) {
          const actualOrigin = String(lodgingBridge.startLocation || '').trim();
          lodgingBridge.startLocation = String(m.from).trim();
          lodgingBridge.endLocation = String(m.to).trim();
          lodgingBridge.startLon = lodgingBridge.startLat = '';
          lodgingBridge.endLon = lodgingBridge.endLat = '';
          lodgingBridge.category = 'transport';
          lodgingBridge.outlineMove = true;
          lodgingBridge.activity = moveActivity(m);
          lodgingBridge.transportType = transportTypeOf(m) || lodgingBridge.transportType;
          lodgingBridge.note = [lodgingBridge.note,
            actualOrigin && actualOrigin !== String(m.from).trim() ? `实际从${actualOrigin}出发` : '']
            .filter(Boolean).join('；');
          console.log('[generatePlan] 第%d天住宿地交通 %s→%s 已按大纲移动段对齐（实际起点：%s）',
            di + 1, m.from, m.to, actualOrigin || m.from);
          return;
        }
        // 还有一种常见的可执行拆分：到站后先去附近寄存行李，再从片区内
        // 的另一上车点继续前往下一目的地。中间的寄存/步行条目不一定属于
        // transport，但它们把“大纲起点”连续衔接到了当前交通条目的实际
        // 起点；应标记当前交通覆盖整段大纲移动，同时保留中间条目的真实地点。
        const bridgedMove = transportRows
          .filter((item) => sameRouteArea(item.endLocation, m.to))
          .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))
          .find((item) => {
            const itemStart = toMin(item.startTime);
            return inDay.some((bridge) => bridge !== item
              && String(bridge.endLocation || '').trim()
              && sameRouteArea(bridge.endLocation, item.startLocation)
              && (sameRouteArea(bridge.startLocation, m.from)
                || samePlace(bridge.startLocation, m.from))
              && (toMin(bridge.endTime) === null || itemStart === null
                || toMin(bridge.endTime) <= itemStart));
          });
        if (bridgedMove) {
          const actualOrigin = String(bridgedMove.startLocation || '').trim();
          const bridge = inDay.filter((item) => item !== bridgedMove
            && sameRouteArea(item.endLocation, actualOrigin)
            && (sameRouteArea(item.startLocation, m.from) || samePlace(item.startLocation, m.from)))
            .sort((a, b) => (toMin(b.endTime) ?? 0) - (toMin(a.endTime) ?? 0))[0];
          bridgedMove.startLocation = String(m.from).trim();
          bridgedMove.endLocation = String(m.to).trim();
          bridgedMove.startLon = bridgedMove.startLat = '';
          bridgedMove.endLon = bridgedMove.endLat = '';
          bridgedMove.category = 'transport';
          bridgedMove.outlineMove = true;
          bridgedMove.activity = moveActivity(m);
          bridgedMove.transportType = transportTypeOf(m) || bridgedMove.transportType;
          bridgedMove.note = [bridgedMove.note,
            bridge && bridge.endLocation && bridge.endLocation !== actualOrigin
              ? `实际先从${m.from}前往${bridge.endLocation}，再在片区内换乘`
              : actualOrigin && actualOrigin !== String(m.from).trim() ? `实际从${actualOrigin}出发` : '']
            .filter(Boolean).join('；');
          console.log('[generatePlan] 第%d天中间接驳 %s→%s 已并入大纲移动段（实际换乘点：%s）',
            di + 1, m.from, m.to, actualOrigin || m.from);
          return;
        }
        const loose = inDay.filter((it) => it.category === 'transport'
          && ((sameRouteArea(it.startLocation, m.from) && sameRouteArea(it.endLocation, m.to))
            || (toStem.length >= 2 && fromStem.length >= 2
              && /前往|乘车|乘坐|打车|包车|大巴|班车|专线|抵达|出发|接驳/.test(activity(it))
              && activity(it).includes(toStem) && activity(it).includes(fromStem))));
        if (loose.length) {
          const matchedMove = loose.sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
          const routeMismatch = !sameRouteArea(matchedMove.startLocation, m.from)
            || !sameRouteArea(matchedMove.endLocation, m.to);
          const actualOrigin = String(matchedMove.startLocation || '').trim();
          const actualDestination = String(matchedMove.endLocation || '').trim();
          // 大纲中的非铁路交通段也可能带有明确的出发/到达时段。
          // 不能只把它标记为 outlineMove，否则模型若把这段放到当天末尾，
          // 后续审计仍会保留错误的晚间顺序。先按大纲的结构化地点和时段
          // 对齐，再把模型生成的真实上下车点保留在备注里供用户核实。
          if (routeMismatch || actualOrigin !== String(m.from).trim()
            || actualDestination !== String(m.to).trim()) {
            matchedMove.startLocation = String(m.from).trim();
            matchedMove.endLocation = String(m.to).trim();
            matchedMove.startLon = matchedMove.startLat = '';
            matchedMove.endLon = matchedMove.endLat = '';
            matchedMove.activity = moveActivity(m);
            const actualNote = [
              actualOrigin && actualOrigin !== String(m.from).trim() ? `实际从${actualOrigin}出发` : '',
              actualDestination && actualDestination !== String(m.to).trim() ? `实际到${actualDestination}` : ''
            ].filter(Boolean).join('，');
            matchedMove.note = [matchedMove.note, actualNote].filter(Boolean).join('；');
            console.warn('[generatePlan] 第%d天交通文案命中但地点字段串线，按大纲校正：%s→%s（%s）',
              di + 1, m.from, m.to, actualNote || '地点一致');
          }
          matchedMove.category = 'transport';
          matchedMove.outlineMove = true;
          if (!matchedMove.transportType) matchedMove.transportType = transportTypeOf(m);
          const hasExplicitMoveTiming = toMin(m.startTime) !== null && toMin(m.endTime) !== null;
          if ((m.timingEstimated || hasExplicitMoveTiming) && hasExplicitMoveTiming) {
            matchedMove.startTime = m.startTime;
            matchedMove.endTime = m.endTime;
            const timingNote = '龙脊班车时段为路线估算，请出发前核实运营时间';
            const moveTimingNote = /龙脊/.test(`${m.from} ${m.to}`)
              ? timingNote : '交通时段按相邻路段顺序估算，请出发前核实';
            matchedMove.note = String(matchedMove.note || '').includes(moveTimingNote)
              ? matchedMove.note : [matchedMove.note, moveTimingNote].filter(Boolean).join('；');
          }
          console.log('[generatePlan] 第%d天包车段 %s→%s 已由细化安排（宽松匹配），不补', di + 1, m.from, m.to);
          return;
        }
      }

      if (!matched.length) {
        // 大纲有这段大交通、模型全程没提 → 补一条
        const timing = guessMoveTimes(m, inDay);
        out.push({
          dayIndex: di,
          startTime: timing.start != null ? fmtMin(timing.start) : '',
          endTime: timing.end != null ? fmtMin(timing.end) : '',
          activity: moveActivity(m),
          category: 'transport',
          startLocation: String(m.from || '').trim(),
          endLocation: String(m.to || '').trim(),
          transportType: transportTypeOf(m),
          scheduleRequired: !!m.scheduleRequired,
          outlineMove: true,
          note: timing.estimated ? '行程时段按路线与前后安排估算；请根据当天班次核实。' : '',
        });
        console.warn('[generatePlan] 第%d天大纲大交通 %s 全天未安排，补一条', di + 1, `${m.from}→${m.to} ${code}`);
        return;
      }

      // 同一车次多条：留时刻最接近大纲的那条，其余丢弃
      const wantS = toMin(m.startTime);
      const driftOf = (it) => {
        const v = toMin(it.startTime);
        return wantS != null && v != null ? Math.abs(v - wantS) : 24 * 60;
      };
      matched.sort((a, b) => driftOf(a) - driftOf(b));
      matched.slice(1).forEach((extra) => {
        const idx = out.indexOf(extra);
        if (idx >= 0) out.splice(idx, 1);
        console.warn('[generatePlan] 第%d天车次 %s 出现多条，丢弃一条', di + 1, code || `${m.from}→${m.to}`);
      });
      const it = matched[0];
      it.outlineMove = true;
      const experienceMove = boatMove && it.category !== 'transport'
        && /船|游船|竹筏|漂流/.test(String(it.activity || ''));

      // 起终点强制对齐大纲车站
      it.startLocation = String(m.from || '').trim();
      it.endLocation = String(m.to || '').trim();
      if (!experienceMove) it.category = 'transport';
      if (!experienceMove) it.transportType = transportTypeOf(m) || it.transportType;
      if (m.scheduleRequired) it.scheduleRequired = true;

      // 时刻漂移超 60 分钟 → 拽回大纲时刻（中间天模型按真实班次微调的半小时内不动）
      const drift = driftOf(it);
      // 12306 没查到当天候选时，applyRealSchedules 会把大纲的精确时刻清空。
      // 此时不能把 null 交给 fmtMin（会被当成 00:00），否则第一天的顺序会被
      // 凭空改乱；保留模型给出的占位时刻，并由 stripUnverifiedSchedules 标注待核实。
      if (drift > 60 && wantS != null) {
        it.startTime = fmtMin(wantS);
        const wantE = toMin(m.endTime);
        if (wantE != null) it.endTime = fmtMin(wantE);
        console.warn('[generatePlan] 第%d天大交通 %s 时刻漂移 %d 分钟，拽回 %s',
          di + 1, code || `${m.from}→${m.to}`, drift, it.startTime);
      }

      // activity 带独白 / 车次码或目的地被写丢 → 重写成干净版
      const act = String(it.activity || '');
      const contaminated = META_HARD.some((re) => re.test(act)) || META_PAT.some((re) => re.test(act));
      const wrongDest = (code && !act.includes(code)) || (tStem && !act.includes(tStem));
      if (!experienceMove && (contaminated || wrongDest)) it.activity = moveActivity(m);
    });
  });
  return out;
}

/** 从交通条目文案里读班次码（G8540/CA4123 这类）；"T2航站楼""2号线"不算 */
function transportCodeOf(it) {
  if (String(it.category || '') !== 'transport') return '';
  const m = /\b([A-Za-z]{1,2}\d{2,4})\b(?!\s*(?:号线|航站楼|号航站楼|站台))/
    .exec(`${it.activity || ''}${it.note || ''}`);
  return m ? m[1].toUpperCase() : '';
}

/**
 * 12306 没有返回可用候选时，清掉细化模型可能重新编出的车次号。
 * 时间字段保留为当天行程的占位安排，并在 note 明确这是估算，避免把“空缺”
 * 误显示成“已核对”。一旦官方查询成功，enforceRealSchedule 会在这里之前完成
 * 车次、站点和时刻的精确回写，不会进入本兜底。
 */
function stripUnverifiedSchedules(items, outline) {
  const days = asArray(outline && outline.days);
  const out = asArray(items).slice();
  const append = (it, text) => {
    const old = String(it.note || '').trim();
    if (!old.includes(text)) it.note = old ? `${old}；${text}` : text;
  };
  days.forEach((day, di) => {
    const pending = asArray(day && day.moves).filter((m) => m && m.scheduleRequired);
    if (!pending.length) return;
    out.forEach((it) => {
      if (Number(it.dayIndex || 0) !== di || String(it.category || '') !== 'transport') return;
      const mode = `${it.transportType || ''}${it.activity || ''}`;
      if (!/train|高铁|动车|火车|列车/.test(mode)) return;
      const matched = pending.find((m) =>
        (it.startLocation && it.endLocation
          && sameStation(it.startLocation, m.from) && sameStation(it.endLocation, m.to))
        || pending.length === 1);
      if (!matched) return;
      it.schedSource = 'official-unavailable';
      const from = String(matched.from || it.startLocation || '').trim();
      const to = String(matched.to || it.endLocation || '').trim();
      // 未开售、接口故障和无铁路连接是不同状态。没有查询结果只
      // 能撤销具体班次，不能据此发明一条长途大巴、改变交通偏好。
      matched.code = '';
      matched.timingEstimated = true;
      it.transportType = 'train';
      it.scheduleRequired = true;
      it.timingEstimated = true;
      it.activity = `计划乘高铁/动车从${from}前往${to}（班次待确认）`;
      it.startLocation = from;
      it.endLocation = to;
      // 同时清掉旧备注中的模型车次，避免标题待确认、备注仍像已购。
      it.note = String(it.note || '').replace(/\b[GDCKTZ]\d{1,5}\b/gi, '').trim();
      append(it, '尚未核验到当日班次，时段为估算；开售后核对车站、车次及发到时间');
    });
  });
  return out;
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 同一天重复交通条目清理（兜底，通用判定不认地名）。
 *
 * 实测踩过：模型写了"乘坐C6101次城际动车前往X站"（没提出发站，
 * enforceMovesAlignment 匹配不上）→ 又留/补一条"乘 C6101(参考) 次列车从
 * Y东站前往X站"，用户看到同一趟车排了两遍；更离谱的一条还排在
 * 到站之后。规则：
 *   · 同一天出现同一个班次码 → 只留最早一条（同一天不可能坐两次同一班车）；
 *   · 同一天同方向（起点、终点词干都相同）且发车时刻相近（≤90 分钟）
 *     的两条 → 视为同一段路，留最早一条。
 */
function dedupeTransports(items) {
  if (!asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const drop = new Set();
  byDay.forEach((list) => {
    const trans = list.filter((it) => String(it.category || '') === 'transport')
      .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
    // ① 同班次码只留最早
    const seenCode = new Map();
    trans.forEach((it) => {
      const code = transportCodeOf(it);
      if (!code) return;
      if (seenCode.has(code)) drop.add(it);
      else seenCode.set(code, it);
    });
    // ② 同方向且时刻相近只留最早（词干互相包含算同地："酒店"⊂"酒店门口"）
    const sameSpot = (a, b) => a === b
      || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b));
    for (let i = 0; i < trans.length; i++) {
      if (drop.has(trans[i])) continue;
      const fs = placeStem(trans[i].startLocation);
      const ts = placeStem(trans[i].endLocation);
      if (fs.length < 2 || ts.length < 2) continue;
      for (let j = i + 1; j < trans.length; j++) {
        if (drop.has(trans[j])) continue;
        if (!sameSpot(placeStem(trans[j].startLocation), fs)
          || !sameSpot(placeStem(trans[j].endLocation), ts)) continue;
        const firstStart = toMin(trans[i].startTime);
        const firstEnd = toMin(trans[i].endTime);
        const nextStart = toMin(trans[j].startTime);
        const gap = firstStart !== null && nextStart !== null ? nextStart - firstStart : null;
        const startsBeforePreviousTripFinishes = firstEnd !== null && nextStart !== null
          && nextStart >= (firstStart === null ? 0 : firstStart) && nextStart <= firstEnd + 15;
        if ((gap !== null && gap >= 0 && gap <= 90) || startsBeforePreviousTripFinishes) drop.add(trans[j]);
      }
    }
  });
  if (!drop.size) return items;
  console.warn('[generatePlan] 清理同天重复交通条目 %d 条', drop.size);
  return items.filter((it) => !drop.has(it));
}

/** Keep onboard-meal suggestions inside the train row so they do not become a false stop after arrival. */
function mergeOnboardMealsIntoTrain(items) {
  const rows = asArray(items);
  const drop = new Set();
  rows.forEach((meal) => {
    if (!meal || meal.category !== 'food'
      || !/(?:车上|列车上|火车上|餐车|乘车途中|途中).{0,24}(?:用餐|吃饭|晚餐|午餐|早餐|简餐)|(?:用餐|吃饭|晚餐|午餐|早餐).{0,16}(?:车上|列车上|火车上|餐车)/.test(`${meal.activity || ''} ${meal.note || ''}`)) return;
    const day = Number(meal.dayIndex || 0);
    const mealStart = toMin(meal.startTime);
    const trains = rows.filter((item) => item && item !== meal && Number(item.dayIndex || 0) === day
      && item.category === 'transport'
      && /train|高铁|动车|火车|列车/.test(`${item.transportType || ''} ${item.activity || ''}`));
    if (!trains.length) return;
    trains.sort((a, b) => {
      const endA = toMin(a.endTime);
      const endB = toMin(b.endTime);
      const driftA = mealStart == null || endA == null ? Number.MAX_SAFE_INTEGER : Math.abs(mealStart - endA);
      const driftB = mealStart == null || endB == null ? Number.MAX_SAFE_INTEGER : Math.abs(mealStart - endB);
      return driftA - driftB;
    });
    const train = trains[0];
    const suggestion = String(meal.activity || meal.note || '').trim();
    const note = String(train.note || '').trim();
    if (suggestion && !note.includes(suggestion)) {
      train.note = [note, `车上用餐提示：${suggestion}`].filter(Boolean).join('；');
    }
    drop.add(meal);
  });
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/** Prefer an explicit multi-hop transfer chain over a conflicting direct shortcut. */
function removeRedundantDirectTransports(items) {
  const rows = asArray(items);
  const drop = new Set();
  const byDay = new Map();
  rows.forEach((item) => {
    if (!item || item.category !== 'transport' || !item.startLocation || !item.endLocation) return;
    const day = Number(item.dayIndex || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  });
  const sameArea = (a, b) => sameTravelArea(a, b) || samePlace(a, b);
  const isMovementRow = (item) => item && item.startLocation && item.endLocation
    && (item.category === 'transport'
      || /前往|返回|回到|取回|取件|拿回|乘坐|乘车|打车|包车|接驳|步行|出发/.test(
        `${item.activity || ''} ${item.note || ''}`));
  const chainCoversDirect = (direct, movementRows) => {
    const directStart = toMin(direct && direct.startTime);
    const directEnd = toMin(direct && direct.endTime);
    if (!direct || directStart === null || directEnd === null || directEnd <= directStart) return false;
    // 只有已经完成一条至少两跳、且最终到达同一终点的链路，才覆盖粗粒度
    // 直达段；这样不会把真正的备选路线误删。other 类的“返回酒店取行李”
    // 也要参与链路判断，否则会漏掉最常见的轻装换乘场景。
    const prior = movementRows.filter((item) => item !== direct
      && isMovementRow(item)
      && (toMin(item.endTime) ?? 1440) <= directStart
      && sameArea(item.startLocation, direct.startLocation));
    const queue = prior.map((item) => ({ item, hops: 1, visited: new Set([item]) }));
    while (queue.length) {
      const current = queue.shift();
      if (current.hops >= 2 && sameArea(current.item.endLocation, direct.endLocation)) return true;
      if (current.hops >= 4) continue;
      const currentEnd = toMin(current.item.endTime);
      movementRows.forEach((next) => {
        if (current.visited.has(next) || next === direct || !isMovementRow(next)
            || !sameArea(current.item.endLocation, next.startLocation)) return;
        const nextStart = toMin(next.startTime);
        const nextEnd = toMin(next.endTime);
        if ((nextEnd ?? 1440) > directStart) return;
        if (currentEnd !== null && nextStart !== null && nextStart < currentEnd) return;
        const visited = new Set(current.visited);
        visited.add(next);
        queue.push({ item: next, hops: current.hops + 1, visited });
      });
    }
    return false;
  };
  byDay.forEach((list) => {
    const dayAllRows = rows.filter((item) => Number(item && item.dayIndex || 0) === Number(list[0] && list[0].dayIndex || 0));
    const sorted = list.slice().sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    sorted.forEach((direct) => {
      if (direct.schedSource === '12306') return;
      // 大纲直达段也可能只是粗粒度骨架。如果详细结果已经给出“景区→
      // 原住宿地取行李→下一城市”的完整多跳链，保留两者会制造两条同时
      // 发生的路线；官方核验车次仍由上面的 12306 保护条件保留。
      if (chainCoversDirect(direct, dayAllRows)) {
        drop.add(direct);
        console.warn('[generatePlan] 已有多跳接驳覆盖直达交通，清理重复段：%s→%s',
          direct.startLocation, direct.endLocation);
        return;
      }
      // 该条已由大纲交通段对齐，不能再被后续的“多段接驳覆盖直达”
      // 误删；否则大纲有写的中间码头/班车会在最终清洗中消失。
      if (direct.outlineMove === true) return;
      // 酒店→酒店是换住宿地的真实转场，即使两家酒店都在同一片区，
      // 后续“酒店→景区→酒店”的活动链也不能反向证明这段转场多余。
      if (LODGING_WORD_RE.test(String(direct.startLocation || ''))
        && LODGING_WORD_RE.test(String(direct.endLocation || ''))) return;
      // 游船/大交通抵达后先到酒店放行李或办理入住，再去下一处游玩，
      // 这段“到酒店”本身就是用户需要的落脚点；后续从同片区去景点
      // 不能把它误判成被接驳链覆盖的直达交通。
      if (LODGING_WORD_RE.test(String(direct.endLocation || ''))
        || /入住|放行李|寄存行李|寄存大件/.test(String(direct.activity || ''))) return;
      const directStart = toMin(direct.startTime);
      const directEnd = toMin(direct.endTime);
      if (directStart === null || directEnd === null || directEnd <= directStart) return;
      // 一条较早的交通已经把人送到直达段的终点，后面又从旧起点
      // “直达”同一终点，通常是大纲段与细化接驳重复叠加。只有在中间
      // 没有从前一终点返回旧起点的接驳时才删除，保留真正的往返安排。
      const priorArrival = sorted.find((item) => item !== direct
        && item.category === 'transport'
        && (toMin(item.endTime) ?? 1440) <= directStart
        && sameArea(item.endLocation, direct.endLocation)
        && sameArea(item.startLocation, direct.startLocation));
      if (priorArrival) {
        // 同方向交通被景点/用餐隔开时，前一段通常是模型误放的“提前离场”，
        // 后一段才是游玩结束后的真实离开；不能机械地把后段删掉。
        const hasActivityBetween = dayAllRows.some((item) => item !== direct && item !== priorArrival
          && ['sight', 'food', 'other'].includes(String(item.category || ''))
          && !/候车|安检|检票|取票|行李|办理入住|退房/.test(String(item.activity || ''))
          && (toMin(item.startTime) ?? 1440) >= (toMin(priorArrival.endTime) ?? 1440)
          && (toMin(item.endTime) ?? 1440) <= directStart);
        if (hasActivityBetween) {
          drop.add(priorArrival);
          console.warn('[generatePlan] 同方向交通被景区安排分隔，删除前置重复段：%s→%s',
            priorArrival.startLocation, priorArrival.endLocation);
          return;
        }
        const returnedToOrigin = sorted.some((item) => item !== direct && item !== priorArrival
          && item.category === 'transport'
          && (toMin(item.startTime) ?? 1440) >= (toMin(priorArrival.endTime) ?? 1440)
          && (toMin(item.endTime) ?? 1440) <= directStart
          && sameArea(item.startLocation, priorArrival.endLocation)
          && sameArea(item.endLocation, direct.startLocation));
        if (!returnedToOrigin) {
          drop.add(direct);
          return;
        }
      }
      const queue = sorted.filter((item) => item !== direct
        && sameArea(item.startLocation, direct.startLocation)
        && !sameArea(item.endLocation, direct.endLocation)
        && (toMin(item.startTime) ?? 1440) >= directStart
        && (toMin(item.startTime) ?? 1440) <= directEnd + 90)
        .map((item) => ({ item, hops: 1, visited: new Set([item]) }));
      while (queue.length) {
        const current = queue.shift();
        if (current.hops > 1 && sameArea(current.item.endLocation, direct.endLocation)) {
          drop.add(direct);
          break;
        }
        const currentEnd = toMin(current.item.endTime);
        sorted.forEach((next) => {
          if (current.visited.has(next) || !sameArea(current.item.endLocation, next.startLocation)) return;
          const nextStart = toMin(next.startTime);
          if (currentEnd !== null && nextStart !== null && nextStart < currentEnd) return;
          const visited = new Set(current.visited);
          visited.add(next);
          queue.push({ item: next, hops: current.hops + 1, visited });
        });
      }
    });
  });
  if (drop.size) console.warn('[generatePlan] 多段接驳已覆盖错误直达交通，清理 %d 条', drop.size);
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/** Repair a transfer chain when a direct leg was placed before its feeder. */
function enforceTransportChainOrder(items) {
  const rows = asArray(items);
  const out = rows.slice();
  const byDay = new Map();
  out.forEach((row) => {
    const day = Number(row && row.dayIndex || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  });
  const durationOf = (row, fallback) => {
    const s = toMin(row && row.startTime), e = toMin(row && row.endTime);
    return s !== null && e !== null && e > s ? e - s : fallback;
  };
  const sameArea = (a, b) => sameTravelArea(a, b) || samePlace(a, b);
  byDay.forEach((dayRows) => {
    const transports = dayRows.filter((row) => row && row.category === 'transport'
      && row.startLocation && row.endLocation && row.schedSource !== '12306');
    transports.forEach((direct) => {
      const directStart = toMin(direct.startTime);
      if (directStart === null) return;
      const feeder = transports.find((row) => row !== direct
        && sameArea(row.endLocation, direct.startLocation)
        && toMin(row.endTime) !== null
        && toMin(row.endTime) > directStart);
      if (!feeder) return;
      const anchor = dayRows.filter((row) => row !== direct && row !== feeder
        && row.category === 'transport' && row.endLocation
        && (row.schedSource === '12306' || /train|plane|ship|列车|高铁|动车|飞机|航班|游船/.test(
          `${row.transportType || ''} ${row.activity || ''}`))
        && sameArea(row.endLocation, feeder.startLocation)
        && toMin(row.endTime) !== null && toMin(row.endTime) <= directStart)
        .sort((a, b) => toMin(b.endTime) - toMin(a.endTime))[0];
      if (!anchor) return;
      const feederDuration = durationOf(feeder, 30);
      const directDuration = durationOf(direct, 60);
      let cursor = Math.max(toMin(anchor.endTime) + 10, directStart);
      // 取票/检票/候车等准备项若原来落在直达段之后，移到上车前，
      // 不让“先出发、再取票”继续污染顺序。
      const prep = dayRows.filter((row) => row !== direct && row !== feeder
        && /取票|检票|候车|上车|进站/.test(String(row.activity || ''))
        && sameArea(row.startLocation, direct.startLocation)
        && toMin(row.startTime) !== null && toMin(row.startTime) >= directStart)
        .sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
      feeder.startTime = fmtMin(cursor);
      feeder.endTime = fmtMin(Math.min(1439, cursor + feederDuration));
      cursor = toMin(feeder.endTime);
      prep.forEach((row) => {
        const duration = durationOf(row, 20);
        row.startTime = fmtMin(cursor);
        row.endTime = fmtMin(Math.min(1439, cursor + duration));
        cursor = toMin(row.endTime);
      });
      direct.startTime = fmtMin(cursor);
      direct.endTime = fmtMin(Math.min(1439, cursor + directDuration));
      direct.timingEstimated = true;
      direct.note = [direct.note, '已按前序接驳、取票/候车顺序重排，具体运营时刻请核实'].filter(Boolean).join('；');
      console.warn('[generatePlan] 交通接驳顺序纠正：先%s→%s，再%s→%s',
        feeder.startLocation, feeder.endLocation, direct.startLocation, direct.endLocation);
    });
  });
  return out;
}

/** Remove a short out-and-back detour inserted immediately before hotel checkout. */
function removeCheckoutBacktracks(items) {
  const rows = asArray(items).slice();
  const days = new Map();
  rows.forEach((item) => {
    const day = Number(item && item.dayIndex || 0);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(item);
  });
  const drop = new Set();
  days.forEach((list) => {
    const sorted = list.slice().sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    for (let i = 0; i < sorted.length - 1; i++) {
      const first = sorted[i];
      const checkout = sorted[i + 1];
      if (first.category !== 'transport' || !first.startLocation || !first.endLocation
          || !/退房|携带全部行李|携带行李/.test(String(checkout && checkout.activity || ''))) continue;
      if (!/car|ride|walk|metro|subway|打车|网约|步行|地铁|公交/i.test(String(first.transportType || ''))
          || /train|plane|bus|ship|列车|航班|大巴|班车/.test(`${first.transportType || ''} ${first.activity || ''}`)) continue;
      const firstEnd = toMin(first.endTime);
      const nextStart = toMin(checkout.startTime);
      const closeInTime = firstEnd === null || nextStart === null || nextStart - firstEnd <= 45;
      const goesOutAndBack = sameTravelArea(first.endLocation, checkout.startLocation)
        && sameTravelArea(first.startLocation, checkout.endLocation);
      if (!closeInTime || !goesOutAndBack) continue;
      drop.add(first);
      const base = String(first.startLocation).trim();
      checkout.activity = String(checkout.activity || '')
        .split(String(checkout.startLocation || '')).join(base)
        .split(String(checkout.endLocation || '')).join(base);
      checkout.startLocation = base;
      checkout.endLocation = '';
      checkout.transportType = '';
      console.warn('[generatePlan] 第%d天退房前出现短途往返，移除多余的出发后折返交通：%s→%s',
        Number(first.dayIndex || 0) + 1, first.startLocation, first.endLocation);
    }
  });
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/** A station-waiting note is valid only when a matching departure is still ahead. */
function removeOrphanStationWaitingItems(items, outline) {
  const rows = asArray(items);
  const days = asArray(outline && outline.days);
  const waiting = /候车|候车厅|等车|候机|候船|进站安检.{0,8}候车/;
  const transport = /train|bus|plane|ship|高铁|动车|火车|列车|大巴|班车|航班|轮渡/;
  const removed = new Set();
  rows.forEach((item) => {
    if (!item || item.category === 'transport' || !waiting.test(String(item.activity || ''))) return;
    const dayIndex = Number(item.dayIndex || 0);
    // 候车/候机条目常把“从酒店到车站”写成 start=住宿地、end=车站；
    // 站点核对必须优先用终点，否则会把明明对应后续班车的候车说明误删。
    const stationEnd = String(item.endLocation || '').trim();
    const place = /站|客运|机场|码头|港口|候车/.test(stationEnd)
      ? stationEnd : String(item.startLocation || item.endLocation || '').trim();
    if (!place) return;
    const itemEnd = toMin(item.endTime);
    const laterItemDeparture = rows.some((next) => next !== item
      && Number(next.dayIndex || 0) === dayIndex && next.category === 'transport'
      && transport.test(`${next.transportType || ''} ${next.activity || ''}`)
      && sameTravelArea(place, next.startLocation)
      && (itemEnd === null || toMin(next.startTime) === null || toMin(next.startTime) >= itemEnd));
    const laterOutlineDeparture = asArray(days[dayIndex] && days[dayIndex].moves).some((move) =>
      transport.test(`${move && move.mode || ''} ${move && move.code || ''}`)
      && sameTravelArea(place, move && move.from)
      && (itemEnd === null || toMin(move.startTime) === null || toMin(move.startTime) >= itemEnd));
    if (!laterItemDeparture && !laterOutlineDeparture) removed.add(item);
  });
  if (removed.size) console.warn('[generatePlan] 删除没有后续车次/班车对应的候车说明 %d 条', removed.size);
  return removed.size ? rows.filter((item) => !removed.has(item)) : rows;
}

/** Remove duplicated same-day hotel check-in/return rows created by closure repair. */
function dedupeDuplicateHotelItems(items) {
  const rows = asArray(items);
  const drop = new Set();
  const byDay = new Map();
  rows.forEach((item) => {
    if (!item || item.category !== 'hotel') return;
    const day = Number(item.dayIndex || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  });
  const normalizeText = (value) => String(value || '').toLowerCase()
    .replace(/[\s\u3000，,。；;：:（）()【】\[\]]/g, '');
  byDay.forEach((hotels) => {
    const sorted = hotels.slice().sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    for (let i = 0; i < sorted.length; i++) {
      const kept = sorted[i];
      if (drop.has(kept)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const candidate = sorted[j];
        if (drop.has(candidate)) continue;
        const sameText = normalizeText(kept.activity) === normalizeText(candidate.activity);
        const samePlace = kept.endLocation && candidate.endLocation
          && (sameTravelArea(kept.endLocation, candidate.endLocation)
            || normalizeRoutePlace(kept.endLocation) === normalizeRoutePlace(candidate.endLocation));
        if (!sameText && !samePlace) continue;
        const aStart = toMin(kept.startTime);
        const aEnd = toMin(kept.endTime);
        const bStart = toMin(candidate.startTime);
        const bEnd = toMin(candidate.endTime);
        const sameWindow = aStart !== null && aEnd !== null && bStart !== null && bEnd !== null
          && Math.max(aStart, bStart) < Math.min(aEnd, bEnd)
          && (sameText || Math.max(aStart, bStart) === Math.min(aStart, bStart))
          && Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
            >= Math.min(aEnd - aStart, bEnd - bStart) * 0.8;
        const exactDuplicate = sameText && aStart !== null && aEnd !== null
          && aStart === bStart && aEnd === bEnd;
        const untimedDuplicate = sameText && (aStart === null || bStart === null);
        if ((sameText && samePlace) || sameWindow || exactDuplicate || untimedDuplicate) drop.add(candidate);
      }
    }
  });
  if (drop.size) console.warn('[generatePlan] 清理同天重复酒店条目 %d 条', drop.size);
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/**
 * 收尾闭环兜底：当天最后一条必须"回到今晚住宿地"（返程日除外）
 *
 * 实测踩过：某天模型把大交通时刻冲突写成一段自我论证的独白，收拾残局时
 * 只写到"17:35 到站"就结束了——晚上和回酒店凭空消失，第二天也从别处开始，
 * 两天之间断链。提示词第 14 条写了"最后 1 条必须是回住宿地休息"，但模型
 * 一旦前面跑偏就顾不上；这里用代码补最后一条 hotel，不指望 LLM 自觉。
 */
function enforceDayClosure(items, outline, p) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const out = items.slice();
  byDay.forEach((list, di) => {
    if (!list.length || di < 0 || di >= days.length) return;
    const today = days[di] || {};
    const tonight = String(today.overnight || today.city || '').trim();
    // 最后一天 ov 应写"返程"；就算模型写漏了，最后一天也绝不能补"回酒店"
    if (!tonight || /返程|回家/.test(tonight) || di === days.length - 1) {
      // 返程日兜底：大交通到站后必须还有一条"回出发地（家）"的接驳，
      // 到站不算到家——用户填的 origin 是具体地址（如"重庆市金童路"）
      const origin = String((p && p.origin) || '').trim();
      if (!origin) return;
      const sorted = list.slice().sort((a, b) =>
        (toMin(a.startTime) == null ? 24 * 60 : toMin(a.startTime))
        - (toMin(b.startTime) == null ? 24 * 60 : toMin(b.startTime)));
      const last = sorted[sorted.length - 1];
      if (!last) return;
      // "返程/家中/回家"也算到家：模型常把最后一条的 endLocation 写成「返程」，
      // 认不出就会再补一条"从返程返回XX家"，末尾凭空多一段
      const backHome = samePlace(last.endLocation || '', origin)
        || String(last.endLocation || '').includes(origin)
        || /^(返程|回家|家中|家)$|回家|到家/.test(String(last.endLocation || ''))
        || String(last.activity || '').includes(origin)
        || /回家|到家/.test(String(last.activity || ''));
      const backTarget = toMin(p && p.backTime);
      if (backHome) {
        if (drivingAllowed(p)) {
          if (backTarget !== null && last.category === 'transport' && String(last.transportType || '') === 'car') {
            last.endTime = fmtMin(backTarget);
            const from = String(last.startLocation || '').trim()
              || sorted.slice(0, -1).reverse().map((it) => String(it.endLocation || it.startLocation || '').trim())
                .find((value) => value && !samePlace(value, origin))
              || String(today.city || '').trim() || '当前地点';
            last.startLocation = from;
            last.activity = `自行驾驶从${from}返回${origin}`;
          }
          return;
        }
        if (backTarget !== null && /抵达|到达|回到|返回|回家|到家/.test(String(last.activity || ''))
            && (String(last.activity || '').includes(origin) || samePlace(last.endLocation || '', origin))) {
          const previousMove = sorted.slice(0, -1).reverse().find((it) =>
            it.category === 'transport' && /列车|高铁|动车|火车|航班|飞机|大巴|班车/.test(String(it.activity || '')));
          const arrival = toMin(previousMove && previousMove.endTime);
          const idealStart = Math.max(0, backTarget - 40);
          const start = arrival !== null && arrival > idealStart ? arrival : idealStart;
          const missedTarget = arrival !== null && arrival > idealStart;
          const from = String(previousMove && previousMove.endLocation || last.startLocation || '').trim();
          if (from && !samePlace(from, origin)) {
            last.startTime = fmtMin(start);
            last.endTime = fmtMin(missedTarget ? Math.min(start + 40, 23 * 60 + 59) : backTarget);
            last.startLocation = from;
            last.endLocation = origin;
            last.category = 'transport';
            last.transportType = defaultTransferMode(p);
            last.activity = `${homeTransferText(from, origin, defaultTransferMode(p))}，到家休息`;
            if (missedTarget) {
              const actualHome = fmtMin(Math.min(1439, arrival + 40));
              const msg = `按返程班次 ${fmtMin(arrival)} 到站，预计 ${actualHome} 到家；晚于计划 ${p.backTime}`;
              today.note = String(today.note || '').includes(msg) ? today.note : [today.note, msg].filter(Boolean).join('；');
            }
          }
        }
        return;
      }
      // "从哪出发回家"的兜底链：最后一条的终点 → 当天最后一个已知位置 → 当天所在城市。
      // 实测坑：末日最后一条常是「步行返回酒店休息」这种连地名都没写的条目，
      // 旧代码只取 last 的起终点，`if (!from) return` 直接放弃 → 末日收在酒店，没回家。
      const pickReturnFrom = () => {
        for (let i = sorted.length - 1; i >= 0; i--) {
          const p = String(sorted[i].endLocation || sorted[i].startLocation || '').trim();
          if (p && !/^(返程|回家|家中|家)$/.test(p)) return p;
        }
        const c = String(today.city || '').trim();
        if (c && !/返程|回家/.test(c)) return c;
        const ov = String(tonight || '').trim();
        if (ov && !/返程|回家/.test(ov)) return ov;
        return '';
      };
      const lastMove = sorted.slice().reverse().find((it) => it.category === 'transport'
        && /列车|高铁|动车|火车|航班|飞机|大巴|班车/.test(String(it.activity || '')));
      const arrival = toMin(lastMove && lastMove.endTime);
      // 末日前一晚住宿/寄行李的地点会落在前面的条目里；返程大交通之后，
      // 回家接驳必须从列车/航班实际到达站出发，不能误拿出发城市的旧地点。
      const from = String(lastMove && lastMove.endLocation || '').trim() || pickReturnFrom();
      if (!from) return;
      const endMin = toMin(last.endTime);
      const idealStart = backTarget !== null ? Math.max(0, backTarget - 40) : null;
      const missedTarget = arrival !== null && idealStart !== null && arrival > idealStart;
      const st = missedTarget ? arrival
        : idealStart !== null ? idealStart
          : (endMin != null ? endMin : 19 * 60) + 10;
      // 末日当天压根没有跨城大交通 = 模型把返程整段漏了，此时"40 分钟到家"是假的
      // （人还在目的地城市）。判据只看当天有没有城际交通条目，不认任何具体地名。
      const intercity = sorted.some((it) => it.category === 'transport'
        && /高铁|动车|火车|城际|列车|航班|飞机|自行驾驶|自驾/.test(`${it.activity || ''}${it.transportType || ''}`));
      const dur = drivingAllowed(p) ? 180 : intercity ? 40 : 180;
      out.push({
        dayIndex: di,
        startTime: fmtMin(Math.min(st, 23 * 60 + 30)),
        endTime: fmtMin(Math.min(missedTarget ? st + dur : backTarget !== null ? backTarget : st + dur, 23 * 60 + 59)),
        activity: drivingAllowed(p)
          ? `自行驾驶从${from}返回${origin}，到家休息`
          : intercity
            ? `${homeTransferText(from, origin, defaultTransferMode(p))}，到家休息`
            : `${homeTransferText(from, origin, defaultTransferMode(p))}，到家休息（返程大交通班次请另行查询）`,
        category: 'transport',
        startLocation: from,
        endLocation: origin,
        transportType: defaultTransferMode(p),
        note: missedTarget ? `返程班次 ${fmtMin(arrival)} 到站，预计 ${fmtMin(Math.min(1439, arrival + dur))} 到家，晚于计划 ${p.backTime}` : '',
      });
      console.warn('[generatePlan] 返程日最后一条只到「%s」，补一条回家接驳', from.slice(0, 16));
      return;
    }
    const sorted = list.slice().sort((a, b) =>
      (toMin(a.startTime) == null ? 24 * 60 : toMin(a.startTime))
      - (toMin(b.startTime) == null ? 24 * 60 : toMin(b.startTime)));
    const last = sorted[sorted.length - 1];
    // 已经收在住宿地：hotel 条目，或终点/描述明确是酒店民宿类。
    // 注意别用 samePlace(终点, ov) 判——"眉山站"包含"眉山"会被误判成已到家，
    // 人明明还拎着行李站在火车站。描述类只认"回/到/入住 + 住宿词"的动宾搭配，
    // "去酒店附近的夜市"这种不算。
    const lodgingWord = LODGING_WORD_RE;
    const atLodging = lodgingWord.test(String(last.endLocation || ''))
      || /(回|回到|抵达|入住|办理入住)[^。，；]{0,8}(酒店|民宿|客栈|宾馆|青旅|住宿)/
        .test(String(last.activity || ''));
    const scope = dayScope(today);
    // 原始字段仍然来自 String(today.hotel || '')，但必须经过范围校验，
    // 才能阻断“石家庄酒店”这类模型串入的外地地址。
    const hotel = safeHotelOf(today); // String(today.hotel || '')
    const destName = hotel || tonight;
    if (last.category === 'hotel') {
      // 推荐酒店经过范围校验后才可用于闭环；即使模型写了一个同城简称，
      // 也统一回写成同一条大纲酒店，避免第二天从另一个“酒店”起步。
      const endText = String(last.endLocation || '').trim();
      const hotelMismatch = hotel && endText
        && (!lodgingWord.test(endText) || !samePlace(endText, hotel));
      if (destName && (!String(last.endLocation || '').trim()
        || !locationFitsScope(last.endLocation, scope)
        || hotelMismatch
        || (hotel && !sameTravelArea(last.endLocation, hotel)))) {
        const oldEnd = String(last.endLocation || '').trim();
        last.endLocation = destName;
        last.endLon = '';
        last.endLat = '';
        if (oldEnd && /入住|办理入住|放行李|回到|回酒店|回民宿|住宿/.test(String(last.activity || ''))) {
          last.activity = `前往${destName}办理入住，放下行李休息`;
        }
      }
      return;
    }
    if (atLodging && locationFitsScope(last.endLocation, scope)) {
      return;
    }
    const from = String(last.endLocation || last.startLocation || '').trim();
    const endMin = toMin(last.endTime);
    const st = (endMin != null ? endMin : 21 * 60) + 10;
    // 不用 samePlace 判断要不要导航：'眉山站'包含'眉山'会被判成同地，
    // 人明明还拎着行李在火车站，却连"从哪去酒店"的导航都不给了
    const moved = !!from && from !== tonight;
    if (moved && drivingAllowed(p)) {
      const driveEnd = Math.min(st + 30, 23 * 60 + 59);
      const hotelStart = Math.min(driveEnd + 10, 23 * 60 + 59);
      out.push({
        dayIndex: di,
        startTime: fmtMin(Math.min(st, 23 * 60 + 30)),
        endTime: fmtMin(driveEnd),
        activity: `自行驾驶从${from}前往${destName}`,
        category: 'transport',
        startLocation: from,
        endLocation: destName,
        transportType: 'car',
        note: '',
      });
      out.push({
        dayIndex: di,
        startTime: fmtMin(hotelStart),
        endTime: fmtMin(Math.min(hotelStart + 30, 23 * 60 + 59)),
        activity: `在${destName}办理入住、放下行李休息`,
        category: 'hotel',
        startLocation: '',
        endLocation: destName,
        transportType: '',
        note: hotel ? `今晚住${tonight}` : '',
      });
      console.warn('[generatePlan] 自驾抵达住宿地前补停车安排');
      return;
    }
    out.push({
      dayIndex: di,
      startTime: fmtMin(Math.min(st, 23 * 60 + 30)),
      endTime: fmtMin(Math.min(st + 30, 23 * 60 + 59)),
      activity: moved
        ? `前往${destName}办理入住，放下行李休息`
        : `回${destName}休息`,
      category: 'hotel',
      startLocation: moved ? from : '',
      endLocation: destName,
      transportType: moved ? defaultTransferMode(p) : '',
      note: hotel ? `今晚住${tonight}` : '',
    });
    console.warn('[generatePlan] 第%d天没有收在住宿地（最后一条：%s…），补一条回酒店',
      di + 1, String(last.activity || '').slice(0, 20));
  });
  return out;
}

/**
 * 跨区住宿日的最终到达审计：跨区交通开始后，不能继续保留旧片区的晚餐、
 * 夜游或“前往同上酒店”文案。若已有大纲交通，按它重排旧酒店条目；若详情
 * 阶段漏了这段，则补一条公共交通/旅游专线并把入住接到抵达之后。
 */
function enforceOvernightArrivalItems(items, outline, p) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const drop = new Set();
  days.forEach((day, di) => {
    if (!day || di >= days.length - 1) return;
    const overnight = String(day.overnight || '').trim();
    if (!overnight || /返程|回家|到家/.test(overnight)) return;
    const accessMove = asArray(day.moves).find((move) => move && move.overnightAccess)
      || asArray(day.moves).find((move) => move && move.from && move.to
        && sameTravelArea(move.to, overnight) && !sameTravelArea(move.from, overnight));
    if (!accessMove) return;
    const list = rows.filter((item) => Number(item && item.dayIndex || 0) === di)
      .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    if (!list.length) return;
    const sameAccessRoute = (item) => item && item.category === 'transport'
      && sameTravelArea(item.startLocation, accessMove.from)
      && sameTravelArea(item.endLocation, accessMove.to);
    let access = list.find((item) => item.outlineMove === true && sameAccessRoute(item));
    if (!access) access = list.find(sameAccessRoute);
    if (!access) {
      const start = toMin(accessMove.startTime);
      const end = toMin(accessMove.endTime);
      access = {
        dayIndex: di,
        startTime: start === null ? '' : fmtMin(start),
        endTime: end === null ? '' : fmtMin(end),
        activity: drivingAllowed(p)
          ? `自行驾驶从${accessMove.from}前往${accessMove.to}`
          : `乘旅游专线或大巴从${accessMove.from}前往${accessMove.to}`,
        category: 'transport',
        startLocation: String(accessMove.from || '').trim(),
        endLocation: String(accessMove.to || '').trim(),
        transportType: drivingAllowed(p) ? 'car' : 'bus',
        outlineMove: true,
        timingEstimated: true,
        note: '跨区抵达住宿片区，具体班次与耗时请按当天核实。',
      };
      rows.push(access);
    }
    const accessStart = toMin(access.startTime);
    const accessEnd = toMin(access.endTime);
    const target = safeHotelOf(day) || overnight;
    const atTarget = (item) => {
      const text = `${item && item.activity || ''} ${item && item.note || ''}`;
      const locationAtTarget = (value) => {
        const location = String(value || '').trim();
        if (!location || /早餐|午餐|晚餐|餐厅|饭店|米粉|农家乐|菜馆|美食/.test(location)
            && !LODGING_WORD_RE.test(location)) return false;
        return sameTravelArea(location, overnight);
      };
      const targetHit = sameTravelArea(item && item.startLocation, overnight)
        || locationAtTarget(item && item.endLocation)
        || (/(抵达|到达|前往|返回|入住)/.test(text) && sameTravelArea(text, overnight));
      if (targetHit) return true;
      // 旧片区晚餐常把“南宁老友粉/某某餐厅”写进 endLocation，不能只因
      // 文字带目标城市就保留；反过来，龙脊/瀑布/田园等景区内部餐饮若有
      // 明确景区语义，应继续保留在跨区抵达后的游览链里。
      if (item && item.category === 'food'
          && !/景区|景点|观景|梯田|大寨|天梯|西山|金佛|瀑布|田园|竹筏|漂流|古镇|码头|山水/.test(text)) {
        return false;
      }
      // 景区内部的观景台/餐厅/短接驳可能不含“当晚住宿地”词根，不能因为
      // 人已经从旧片区跨区离开，就把整段景区游览误删。只清理那些仍然
      // 明确落在跨区交通起点（旧住宿/旧景区）里的残留活动。
      const originHit = [item && item.startLocation, item && item.endLocation]
        .filter(Boolean).some((value) => sameTravelArea(value, accessMove.from));
      if (!originHit) return true;
      return false;
    };
    list.concat(access).forEach((item) => {
      if (!item || item === access || drop.has(item)) return;
      const start = toMin(item.startTime);
      if (accessStart === null || start === null || start < accessStart) return;
      if (!atTarget(item)) drop.add(item);
    });
    const hotels = list.filter((item) => !drop.has(item) && item.category === 'hotel'
      && (sameTravelArea(item.endLocation, overnight) || /办理入住|入住|放下行李/.test(String(item.activity || ''))));
    let hotel = hotels.sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
    const hotelStart = accessEnd === null ? null : Math.min(23 * 60 + 20, accessEnd + 10);
    if (!hotel) {
      hotel = {
        dayIndex: di,
        startTime: hotelStart === null ? '' : fmtMin(hotelStart),
        endTime: hotelStart === null ? '' : fmtMin(Math.min(hotelStart + 30, 23 * 60 + 59)),
        activity: `前往${target}办理入住，放下行李休息`,
        category: 'hotel',
        startLocation: String(access.endLocation || overnight).trim(),
        endLocation: target,
        transportType: defaultTransferMode(p),
        note: `当日已从${accessMove.from}前往${overnight}，不返回旧住宿地。`,
      };
      rows.push(hotel);
    } else {
      hotel.startLocation = String(access.endLocation || overnight).trim();
      hotel.endLocation = target;
      if (hotelStart !== null) {
        hotel.startTime = fmtMin(hotelStart);
        hotel.endTime = fmtMin(Math.min(hotelStart + 30, 23 * 60 + 59));
      }
      hotel.activity = `前往${target}办理入住，放下行李休息`;
      hotel.transportType = defaultTransferMode(p);
      hotel.note = [String(hotel.note || '').replace(/同上/g, '').trim(),
        `当日已从${accessMove.from}前往${overnight}，不返回旧住宿地。`].filter(Boolean).join('；');
    }
  });
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/**
 * 确保跨城抵达后真的有入住落点。
 *
 * 细化模型有时已经写出“高铁到桂林北”，但因为把“酒店”漏在了大纲文字里，
 * 详细页会直接结束当天；第二天却又从上一晚酒店开始，用户看不到中间的入住。
 * 只在非末日、当天已有交通/活动落到 overnight 片区且没有对应 hotel 条目时
 * 补一条入住，不猜具体酒店名称，名称优先使用已核验的 outline hotel。
 */
function ensureOvernightHotelItems(items, outline, p) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const dropInvalidHotels = new Set();
  const isHardTimedRow = (item) => item && (
    item.schedSource === '12306'
      || item.scheduleRequired === true
  );
  days.forEach((day, di) => {
    if (!day || di >= days.length - 1) return;
    const overnight = String(day.overnight || day.city || '').trim();
    if (!overnight) return;
    const target = safeHotelOf(day) || overnight;
    const list = rows.filter((item) => Number(item && item.dayIndex || 0) === di)
      .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    if (!list.length) return;
    const hotelRows = list.filter((item) => item && item.category === 'hotel'
      && (sameTravelArea(item.endLocation, overnight)
        || sameTravelArea(item.endLocation, target)
        || sameTravelArea(item.startLocation, overnight)
        || sameTravelArea(item.startLocation, target)
        || /办理入住|入住|放下行李/.test(String(item.activity || ''))));
    if (hotelRows.length) {
      // 已有入住条目也要做顺序校正：模型常把“抵达后简餐”排在入住前，
      // 但入住时刻却仍沿用原始抵达时刻，造成 21:30-22:00 用餐与
      // 21:40-22:10 入住重叠。保持入住时长，只把它顺延到前序活动结束后。
      hotelRows.forEach((hotel) => {
        const hotelStart = toMin(hotel.startTime);
        const hotelEnd = toMin(hotel.endTime);
        if (hotelStart === null || hotelEnd === null) return;
        // 模型在“抵达已到当天最后一分钟”时偶尔会留下 23:59-23:59
        // 的伪入住。它既不能让用户完成入住，也会在前端显示异常条目。
        // 先给酒店保留一个最小但真实的 15 分钟窗口；若前一段是普通
        // 接驳则收短 10 分钟让出空间。已核验/必须保持的班次不能篡改，
        // 此时删除无法执行的伪入住也比保留零时长记录更符合实际。
        if (hotelEnd <= hotelStart) {
          const latestPrior = list
            .filter((item) => item !== hotel && (toMin(item.startTime) ?? 1440) < 1440
              && (toMin(item.endTime) ?? toMin(item.startTime) ?? -1) >= hotelStart)
            .sort((a, b) => (toMin(b.endTime) ?? toMin(b.startTime) ?? -1)
              - (toMin(a.endTime) ?? toMin(a.startTime) ?? -1))[0];
          const slotStart = 23 * 60 + 44;
          const slotEnd = 23 * 60 + 59;
          if (latestPrior && isHardTimedRow(latestPrior)) {
            dropInvalidHotels.add(hotel);
            console.warn('[generatePlan] 第%d天没有可执行的酒店入住窗口，删除零时长酒店条目：%s',
              di + 1, hotel.endLocation || hotel.activity || '酒店');
            return;
          }
          if (latestPrior) {
            const priorStart = toMin(latestPrior.startTime);
            if (priorStart === null || priorStart >= slotStart - 10) {
              dropInvalidHotels.add(hotel);
              console.warn('[generatePlan] 第%d天前序活动占满收尾时间，删除零时长酒店条目：%s',
                di + 1, hotel.endLocation || hotel.activity || '酒店');
              return;
            }
            latestPrior.endTime = fmtMin(slotStart - 10);
            latestPrior.timingEstimated = true;
            latestPrior.note = [latestPrior.note, '为酒店办理入住预留收尾时间'].filter(Boolean).join('；');
          }
          hotel.startTime = fmtMin(slotStart);
          hotel.endTime = fmtMin(slotEnd);
          hotel.timingEstimated = true;
          hotel.note = [hotel.note, '已补足最小入住时间窗口'].filter(Boolean).join('；');
          console.warn('[generatePlan] 第%d天修复零时长酒店入住：%s-%s',
            di + 1, hotel.startTime, hotel.endTime);
          return;
        }
        const priorEnd = list.filter((item) => item !== hotel
          && (toMin(item.startTime) ?? 1440) < hotelStart)
          .map((item) => toMin(item.endTime))
          .filter((value) => value !== null)
          .sort((a, b) => b - a)[0];
        if (priorEnd === undefined || priorEnd < hotelStart) return;
        const duration = Math.max(15, hotelEnd - hotelStart);
        const start = Math.min(1430, priorEnd + 10);
        hotel.startTime = fmtMin(start);
        hotel.endTime = fmtMin(Math.min(1439, start + duration));
        hotel.timingEstimated = true;
        console.warn('[generatePlan] 第%d天入住与前序活动重叠，顺延至%s', di + 1, hotel.startTime);
      });
      return;
    }
    const arrivalRows = list.filter((item) => item && item.category === 'transport'
      && item.endLocation && sameTravelArea(item.endLocation, overnight)
      && (!item.startLocation || !sameTravelArea(item.startLocation, overnight)));
    if (!arrivalRows.length) return;
    const arrival = arrivalRows[arrivalRows.length - 1];
    const arrivalIndex = list.indexOf(arrival);
    // 如果抵达后还有已经落在当晚片区的晚餐/活动，入住应接在当天最后一段
    // 本地活动之后；否则直接接在城际抵达后，避免把入住插到晚餐前。
    const tail = list.slice(arrivalIndex + 1).filter((item) =>
      sameTravelArea(item.startLocation, overnight) || sameTravelArea(item.endLocation, overnight));
    const anchor = tail.length ? tail[tail.length - 1] : arrival;
    const anchorEnd = toMin(anchor.endTime);
    if (anchorEnd === null) return;
    const start = Math.min(1430, anchorEnd + 10);
    const end = Math.min(1439, start + 30);
    if (end <= start) return;
    rows.push({
      dayIndex: di,
      startTime: fmtMin(start),
      endTime: fmtMin(end),
      activity: `前往${target}办理入住，放下行李休息`,
      category: 'hotel',
      startLocation: String(anchor.endLocation || overnight).trim(),
      endLocation: target,
      transportType: defaultTransferMode(p),
      note: `已从外部交通抵达${overnight}，入住后不再返回旧住宿地。`,
      timingEstimated: true,
    });
    console.warn('[generatePlan] 第%d天抵达住宿片区后缺少入住条目，已补齐：%s', di + 1, target);
  });
  return rows.filter((item) => !dropInvalidHotels.has(item)).sort((a, b) => {
    const dayDiff = Number(a && a.dayIndex || 0) - Number(b && b.dayIndex || 0);
    if (dayDiff) return dayDiff;
    return (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440);
  });
}

/**
 * 第一天出发接驳兜底：必须有「从出发地（家门口）→ 车站/机场」这一条
 *
 * 实测踩过：用户填"出发地 重庆市金童路、出发时间 15:30"，生成的行程第 1 条
 * 直接是"15:30 乘高铁"——从金童路去重庆西站的接驳凭空消失。
 * prompt 规则 7 已要求第 1 条就是接驳，但模型偶尔仍直接从大交通写起；
 * 这里确定性补：第 0 天若没有任何"从出发地出发"的条目，就在大交通之前
 * 插一条打车接驳（时刻按 goTime 与安检预留推算）。
 */
function enforceOriginAccess(items, p, outline, activeDays) {
  const origin = String((p && p.origin) || '').trim();
  if (!origin || !asArray(items).length) return items;
  // 续跑轮次：本轮没有第 1 天的条目就不碰（否则会重复补接驳，见 MovesAlignment 注释）
  const active = new Set(asArray(activeDays).map(Number));
  if (active.size && !active.has(0)) return items;
  const goMin = toMin(p && p.goTime);
  const days = asArray(outline && outline.days);
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const list = byDay.get(0) || [];
  if (!list.length) return items;

  // 已经有"从出发地出发"的条目（模型写了接驳）→ 不重复插
  const fromOrigin = (it) => samePlace(it.startLocation || '', origin)
    && String(it.category || '') === 'transport';
  if (list.some(fromOrigin)) return items;

  // 首段大交通：transportType 与 activity 双重识别
  const isBigMove = (it) => /train|plane/.test(String(it.transportType || ''))
    || /乘[^，。;；]*(列车|航班)|飞机|高铁|动车/.test(String(it.activity || ''));
  const sorted = list.slice().sort((a, b) =>
    String(a.startTime || '').localeCompare(String(b.startTime || '')));
  const big = sorted.find(isBigMove);
  if (!big) return items;

  const plane = String(big.transportType || '') === 'plane'
    || /航班|飞机/.test(String(big.activity || ''));
  const station = String(big.startLocation
    || (days[0] && asArray(days[0].moves)[0] && asArray(days[0].moves)[0].from) || '').trim();
  if (!station) return items;

  const checkIn = plane ? 120 : 45;   // 到站需提前：安检候车
  const drive = 40;                   // 市内门到门
  const trainS = toMin(big.startTime);
  const s = goMin != null ? goMin : (trainS != null ? trainS - checkIn - drive : null);
  if (s == null) return items;
  let e = trainS != null ? trainS - checkIn : s + drive;
  if (e <= s + 15) e = s + drive;     // 时间紧也保底给一段完整的接驳
  const st = Math.min(s, 23 * 60 + 50);
  const en = Math.max(Math.min(e, 23 * 60 + 59), st + 15);
  const mode = defaultTransferMode(p);
  items.push({
    dayIndex: 0,
    startTime: fmtMin(st),
    endTime: fmtMin(en),
    activity: `${transferText(origin, station, mode)}，准备乘车`,
    category: 'transport',
    startLocation: origin,
    endLocation: station,
    transportType: mode,
    note: '出发接驳（按用户填写的出发时间生成）',
  });
  console.warn('[generatePlan] 第一天没有从「%s」出发的接驳，补一条去「%s」', origin, station);
  return items;
}

/** 首末日按已确认的大交通截断无效活动，避免晚到后继续夜游或返程后还在玩。 */
function enforceTripEdgeOrder(items, p, outline, activeDays) {
  const days = asArray(outline && outline.days);
  if (!days.length) return items;
  const active = new Set(asArray(activeDays).map(Number));
  const out = [];
  const bigMove = (m) => /train|plane|高铁|动车|火车|航班|飞机|ship|游船/.test(
    `${m && m.mode || ''}${m && m.code || ''}`.toLowerCase());
  const isMainTransit = (it, day) => {
    if (!it || it.category !== 'transport') return false;
    if (/乘[^，。;；]*(列车|航班|高铁|动车|火车|飞机|大巴|班车)|乘火车|返回|到家/.test(String(it.activity || ''))) return true;
    const code = transportCodeOf(it);
    return asArray(day && day.moves).filter(bigMove).some((move) => {
      const sameRoute = it.startLocation && it.endLocation
        && sameStation(it.startLocation, move.from) && sameStation(it.endLocation, move.to);
      const sameCode = code && String(move.code || '').toUpperCase() === code;
      const sameStart = toMin(it.startTime) !== null && toMin(move.startTime) !== null
        && Math.abs(toMin(it.startTime) - toMin(move.startTime)) <= 5;
      return sameRoute || sameCode || (sameStart && /列车|航班|高铁|动车|火车|飞机|大巴|班车/.test(String(it.activity || '')));
    });
  };
  const isHomeReturn = (it) => {
    const origin = String(p && p.origin || '').trim();
    const end = String(it && it.endLocation || '').trim();
    return !!origin && (sameStation(end, origin) || String(it && it.activity || '').includes(origin)
      || /回家|到家/.test(String(it && it.activity || '')));
  };
  const minOf = (it, key) => toMin(it && it[key]);

  for (let di = 0; di < days.length; di++) {
    const list = asArray(items).filter((it) => Number(it.dayIndex || 0) === di);
    if (active.size && !active.has(di)) { out.push(...list); continue; }
    if (!list.length) continue;
    if (di === 0) {
      const move = asArray(days[0].moves).find(bigMove);
      const arrive = toMin(move && move.endTime);
      const go = toMin(p && p.goTime);
      const kept = list.filter((it) => {
        const start = minOf(it, 'startTime');
        if (go !== null && start !== null && start < go
            && !samePlace(it.startLocation || '', p.origin || '')) return false;
        if (arrive !== null && start !== null && start < arrive
            && !isMainTransit(it, days[0])
            && !samePlace(it.startLocation || '', p.origin || '')
            && !samePlace(it.endLocation || '', move && move.from || '')) return false;
        // 迟到首日只保留必要晚餐/入住；不安排抵达后的夜游、第二轮转场或跨午夜活动。
        if (arrive !== null && arrive >= 21 * 60 && start !== null && start >= arrive) {
          const localAfterLateArrival = !isMainTransit(it, days[0])
            && !/车上|列车上|返家|到家/.test(String(it.activity || ''));
          const lodgingAccess = /酒店|住宿|入住|放行李/.test(String(it.activity || ''));
          if (localAfterLateArrival && !lodgingAccess && (it.category === 'sight' || it.category === 'transport'
              || start >= 22 * 60 + 30)) return false;
        }
        return true;
      });
      out.push(...kept);
      continue;
    }
    if (di === days.length - 1) {
      const moves = asArray(days[di].moves).filter(bigMove);
      const move = moves[moves.length - 1];
      const depart = toMin(move && move.startTime);
      const kept = list.filter((it) => {
        const start = minOf(it, 'startTime');
        if (it.category === 'hotel' && (depart === null || start === null || start >= depart)) return false;
        if (depart !== null && start !== null && start >= depart && !isMainTransit(it, days[di])
            && !isHomeReturn(it) && !/车上|列车上/.test(String(it.activity || ''))) return false;
        return true;
      });
      out.push(...kept);
      continue;
    }
    out.push(...list);
  }
  return out;
}

/**
 * 返程日发车前的最后一段准备必须完整：先离开住宿地到车站，再进站候车，
 * 最后才乘城际交通。模型偶尔会把“博物馆寄存行李/游览”塞到 09:13 的高铁
 * 前面，却没有从博物馆回车站的时间，结果既看不成展又赶不上车。
 *
 * 规则保持通用：只有在活动结束时间已经压到发车前的安全缓冲内时才移除；
 * 午餐、早餐或时间充足的上午游览仍可保留。被移除的寄存文案也不能继续在
 * 后续车票备注里要求取回不存在的行李。
 */
function enforceReturnDeparturePreparation(items, p, outline) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const lastDay = days.length - 1;
  if (lastDay < 0 || !rows.length) return rows;

  const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === lastDay)
    .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
  if (!dayRows.length) return rows;
  const day = days[lastDay] || {};
  const bigMove = (move) => /train|plane|ship|高铁|动车|火车|航班|飞机|游船|轮渡|大巴|班车|直通车/
    .test(`${move && move.mode || ''} ${move && move.code || ''}`.toLowerCase());
  const textOf = (item) => `${item && item.activity || ''} ${item && item.note || ''}`;
  const outlineReturn = asArray(day.moves).slice().reverse().find((move) => bigMove(move));
  const isIntercity = (item) => item && item.category === 'transport'
    && /train|plane|ship|高铁|动车|火车|列车|航班|飞机|游船|轮渡|大巴|班车|直通车/
      .test(`${item.transportType || ''} ${item.activity || ''} ${item.code || ''}`.toLowerCase());
  const anchor = dayRows.slice().reverse().find((item) => {
    if (!isIntercity(item)) return false;
    if (!outlineReturn) return true;
    const sameRoute = sameStation(item.startLocation, outlineReturn.from)
      && sameStation(item.endLocation, outlineReturn.to);
    const sameCode = outlineReturn.code && transportCodeOf(item)
      && String(outlineReturn.code).toUpperCase() === transportCodeOf(item);
    return sameRoute || sameCode || item.outlineMove === true;
  });
  if (!anchor) return rows;
  const departure = toMin(anchor.startTime);
  if (departure === null) return rows;

  const anchorText = `${anchor.transportType || ''} ${anchor.activity || ''}`.toLowerCase();
  const buffer = /plane|航班|飞机/.test(anchorText) ? 120
    : /ship|游船|轮渡/.test(anchorText) ? 50
      : /train|高铁|动车|火车|列车/.test(anchorText) ? 45 : 30;
  const safeCutoff = Math.max(0, departure - buffer);
  const station = String(anchor.startLocation || '').trim();
  const isAnchorRoute = (item) => item === anchor
    || (item && item.category === 'transport' && outlineReturn
      && sameStation(item.startLocation, outlineReturn.from)
      && sameStation(item.endLocation, outlineReturn.to));
  const isLocalActivity = (item) => item && ['sight', 'other'].includes(String(item.category || ''));
  const isStorage = (item) => /行李/.test(textOf(item))
    && /寄存|暂存|存放|存包|寄放/.test(textOf(item))
    && !/(不|无|免|无需|不用|禁止|避免)(?:[^；。]{0,4})(?:寄存|暂存|存放|存包|寄放)/.test(textOf(item));
  const sameEndpoint = (a, b) => !!a && !!b && (sameStation(a, b)
    || normalizeRoutePlace(a) === normalizeRoutePlace(b));
  const drop = new Set();

  // 景点/展馆/寄存条目如果已经挤到安全缓冲内，直接删掉该活动；它不是
  // 返程日的必需交通事实。非主交通也不能在这一时段把人送到非车站地点。
  dayRows.forEach((item) => {
    if (item === anchor || isAnchorRoute(item)) return;
    const start = toMin(item.startTime);
    const end = toMin(item.endTime);
    // 发车后的回家接驳属于返程闭环，不能被“发车前安全缓冲”规则当成
    // 来不及的站前活动删掉。
    if (start !== null && start >= departure) return;
    const tight = (end !== null && end > safeCutoff)
      || (end === null && start !== null && start >= safeCutoff);
    if (isLocalActivity(item) && tight) drop.add(item);
    if (item.category === 'transport' && tight && station
        && !sameEndpoint(item.endLocation, station)) drop.add(item);
  });

  // “去博物馆→博物馆寄存”通常是同一段错误安排，前一条接驳也要一起移除，
  // 否则删了寄存条目后还会留下“从酒店赶到已取消的博物馆”的断链。
  let changed = true;
  while (changed) {
    changed = false;
    dayRows.forEach((item, index) => {
      if (drop.has(item) || item.category !== 'transport' || isAnchorRoute(item)) return;
      const next = dayRows.slice(index + 1).find((candidate) => !drop.has(candidate)
        && candidate !== anchor && toMin(candidate.startTime) !== null);
      if (!next || !drop.has(next)) return;
      const nextPlace = String(next.startLocation || next.endLocation || '').trim();
      const nearNext = nextPlace && (sameEndpoint(item.endLocation, nextPlace)
        || normalizeRoutePlace(String(item.activity || '')).includes(normalizeRoutePlace(nextPlace)));
      if (nearNext || (toMin(item.endTime) !== null && toMin(item.endTime) > safeCutoff)) {
        drop.add(item);
        changed = true;
      }
    });
  }

  const keptDay = dayRows.filter((item) => !drop.has(item));
  const anchorIndex = keptDay.indexOf(anchor);
  if (anchorIndex < 0) return rows.filter((item) => !dayRows.includes(item)).concat(keptDay);

  // 取消错误的“取回寄存”提示。若返程前确实有车站/机场寄存，则该条不会被
  // 删除，保留模型原文和后续取件提醒。
  const hasKeptStorage = keptDay.slice(0, anchorIndex).some((item, index, before) => {
    if (!isStorage(item)) return false;
    const storagePlace = String(item.endLocation || item.startLocation || '').trim();
    if (sameEndpoint(storagePlace, station) || /车站|机场|码头|候车/.test(textOf(item))) return true;
    // 景区/游客中心寄存后，下一段通常先回到山门、游客中心或车站，
    // 不一定会单独生成“取回行李”条目。只要后续已有同片区离开交通，
    // 保留取回提示，不能被返程安全清理误删。
    return !!storagePlace && keptDay.slice(index + 1, anchorIndex).some((next) =>
      (next.category === 'transport' || /取回|取出|取件|拿回|领回/.test(textOf(next)))
      && (sameTravelArea(next.startLocation, storagePlace)
        || sameTravelArea(next.endLocation, storagePlace)));
  });
  if (!hasKeptStorage) {
    const stripPickup = (value) => String(value || '')
      .replace(/离开前(?:先)?返回[^。；;，,]{0,80}(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,30}行李/g, '')
      .replace(/(?:离开前记得|记得|务必|请先)?(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,50}(?:寄存|暂存|存放|寄放|存包)?的?(?:全部|大件)?行李/g, '')
      .replace(/[；;]\s*[；;]/g, '；').replace(/^[；;]|[；;]$/g, '').trim();
    keptDay.forEach((item) => {
      if (item === anchor || /取回|取出|取件|拿回|领回/.test(textOf(item))) {
        item.activity = stripPickup(item.activity);
        item.note = stripPickup(item.note);
      }
    });
  }

  // 重新检查发车前最后一个有效地点；若没有到车站的接驳，则补一段普通
  // 市内交通。这里刻意不用“景区接驳”，返程站点接驳只能是公交/地铁/网约车。
  const beforeAnchor = keptDay.slice(0, keptDay.indexOf(anchor));
  const reachesStation = beforeAnchor.some((item) => item.category === 'transport'
    && station && sameEndpoint(item.endLocation, station));
  if (!reachesStation && station) {
    const previous = beforeAnchor.slice().reverse().find((item) =>
      String(item.endLocation || item.startLocation || '').trim());
    const from = String(previous && (previous.endLocation || previous.startLocation)
      || safeHotelOf(day) || day.overnight || day.city || '').trim();
    if (from && !sameEndpoint(from, station)) {
      const previousEnd = toMin(previous && previous.endTime);
      const end = Math.max(0, departure - 10);
      const start = previousEnd !== null && previousEnd < end
        ? previousEnd : Math.max(0, end - 40);
      if (end - start >= 15) {
        const mode = defaultTransferMode(p);
        const activity = mode === 'car'
          ? `打车从${from}前往${station}`
          : mode === 'walk'
            ? `步行从${from}前往${station}`
            : `乘公交、地铁或网约车从${from}前往${station}`;
        keptDay.splice(keptDay.indexOf(anchor), 0, {
          dayIndex: lastDay,
          startTime: fmtMin(start),
          endTime: fmtMin(end),
          activity,
          category: 'transport',
          startLocation: from,
          endLocation: station,
          transportType: mode,
          note: '返程进站接驳，预留安检和候车时间',
          autoConnector: true,
        });
      }
    }
  }
  return rows.filter((item) => !dayRows.includes(item)).concat(keptDay);
}

/**
 * 把有明确时刻的城际大交通当作当天不可移动的时间锚点。
 *
 * fixDayTimeOverlaps 只能保证条目不重叠，不能阻止模型把“阳朔→南宁”的
 * 候车、骑行、回酒店取行李顺延到列车之后，形成“先到南宁、再回阳朔”的
 * 假路线。这里按大纲中的 train/plane/ship 段做一次通用的前后边界审计：
 * 车前为进站留出 45 分钟，车后必须先从到达枢纽接上下一段，旧出发地的
 * 活动和重复到站交通直接移除；不依赖具体城市或景点名称。
 */
function enforceScheduledMoveTimeline(items, outline, activeDays) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const active = new Set(asArray(activeDays).map(Number));
  const moveTransportText = (move) => `${move && move.mode || ''} ${move && move.code || ''}`.toLowerCase();
  const surfaceMove = (move) => /bus|coach|shuttle|ride|taxi|car|charter|大巴|客运|专线|班车|网约车|出租车|包车|打车/.test(
    moveTransportText(move));
  const scheduledMove = (move) => move && move.from && move.to
    && toMin(move.startTime) !== null && toMin(move.endTime) !== null
    && (/train|plane|ship|高铁|动车|火车|航班|飞机|游船|轮渡|渡船/.test(moveTransportText(move))
      || (surfaceMove(move) && !move.timingEstimated))
    && !move.autoConnector
    && !/metro|subway|地铁|轻轨/.test(moveTransportText(move));
  const scheduledItem = (item) => item && item.category === 'transport'
    && /train|plane|ship|bus|coach|shuttle|ride|taxi|car|charter|高铁|动车|火车|列车|航班|飞机|游船|轮渡|渡船|大巴|客运|专线|班车|网约车|出租车|包车|打车/.test(
      `${item.transportType || ''} ${item.activity || ''} ${item.note || ''}`.toLowerCase());
  const textOf = (item) => `${item && item.activity || ''} ${item && item.note || ''} `
    + `${item && item.startLocation || ''} ${item && item.endLocation || ''}`;
  const mention = (text, place) => {
    const value = String(text || '');
    if (!place) return false;
    if (sameTravelArea(value, place)) return true;
    return scopeWordsOf(place).some((token) => token.length >= 2 && value.includes(token));
  };
  const sameRoute = (item, move) => {
    const code = transportCodeOf(item);
    const exact = item.startLocation && item.endLocation
      && sameStation(item.startLocation, move.from)
      && sameStation(item.endLocation, move.to);
    const byCode = code && move.code && String(code).toUpperCase() === String(move.code).toUpperCase();
    return exact || byCode || (item.outlineMove === true
      && Math.abs((toMin(item.startTime) || 0) - (toMin(move.startTime) || 0)) <= 10);
  };
  const sortDay = (dayIndex) => rows
    .filter((item) => Number(item && item.dayIndex || 0) === dayIndex)
    .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
  const drop = new Set();

  days.forEach((day, dayIndex) => {
    if (active.size && !active.has(dayIndex)) return;
    asArray(day && day.moves).filter(scheduledMove).forEach((move) => {
      const dayRows = sortDay(dayIndex);
      const anchors = dayRows.filter((item) => !drop.has(item) && scheduledItem(item) && sameRoute(item, move));
      if (!anchors.length) return;
      const anchor = anchors.slice().sort((a, b) =>
        Math.abs((toMin(a.startTime) || 0) - (toMin(move.startTime) || 0))
        - Math.abs((toMin(b.startTime) || 0) - (toMin(move.startTime) || 0)))[0];
      const depart = toMin(anchor.startTime);
      const arrive = toMin(anchor.endTime);
      if (depart === null || arrive === null || arrive <= depart) return;
      const from = String(move.from || anchor.startLocation || '').trim();
      const to = String(move.to || anchor.endLocation || '').trim();
      const moveText = `${move.mode || ''} ${anchor.transportType || ''} ${anchor.activity || ''}`;
      const buffer = /plane|航班|飞机/.test(moveText) ? 90
        : /bus|coach|shuttle|ride|taxi|car|charter|大巴|客运|专线|班车|网约车|出租车|包车|打车/i.test(moveText)
          ? 30 : 45;
      const cutoff = Math.max(0, depart - buffer);
      const isWaiting = (item) => item !== anchor
        && /候车|安检|检票|进站|准备乘|站内等待|等待列车|等待发车/.test(textOf(item))
        && (mention(textOf(item), from) || (move.code && textOf(item).includes(String(move.code))));
      const startsAtDestination = (item) => {
        // 有明确起点时只认起点，不能因为“十里画廊→南宁东”的终点写了
        // 南宁，就把它误当成“从南宁东出发”的后续接驳。
        if (item.startLocation) {
          return sameTravelArea(item.startLocation, to) || sameStation(item.startLocation, to);
        }
        return mention(textOf(item), to);
      };
      const endsAtDestination = (item) => sameTravelArea(item.endLocation, to)
        || sameStation(item.endLocation, to)
        || (item.endLocation && mention(item.endLocation, to));
      const startsAtOrigin = (item) => sameTravelArea(item.startLocation, from)
        || sameStation(item.startLocation, from)
        || mention(textOf(item), from);
      const onboard = (item) => /车上|列车上|航班上|飞机上|船上|船舱|车厢|大巴上|途中/.test(textOf(item));

      // 同一大纲段只保留一条真正的城际交通；候车条目后面单独前移。
      anchors.slice(1).forEach((item) => drop.add(item));

      // 车前安全窗口内只允许进站接驳/候车；旧城市的景点、骑行和用餐
      // 没有足够时间完成就删除，避免后续重叠修复把列车推迟。
      dayRows.forEach((item) => {
        if (item === anchor || drop.has(item)) return;
        const start = toMin(item.startTime);
        const end = toMin(item.endTime);
        if (start === null && end === null) return;
        if (isWaiting(item)) {
          if (start === null || start > cutoff || (end !== null && end > depart)) {
            const duration = Math.min(45, Math.max(15, end !== null && start !== null ? end - start : 30));
            item.endTime = fmtMin(Math.max(0, depart - 5));
            item.startTime = fmtMin(Math.max(0, Math.min(cutoff, depart - 5 - duration)));
            item.timingEstimated = true;
          }
          return;
        }
        if (start !== null && start < depart && end !== null && end > cutoff) {
          const stationAccess = item.category === 'transport'
            && (sameTravelArea(item.endLocation, from) || sameStation(item.endLocation, from)
              || /站|机场|码头|车站/.test(String(item.endLocation || '')));
          if (stationAccess && end <= depart) {
            const duration = Math.max(15, end - start);
            item.endTime = fmtMin(cutoff);
            item.startTime = fmtMin(Math.max(0, cutoff - duration));
            item.timingEstimated = true;
          } else if (['sight', 'food', 'other', 'hotel'].includes(String(item.category || ''))
              || startsAtOrigin(item)) {
            drop.add(item);
          }
        }
      });

      // 车后先接“到达枢纽→下一站”的交通；在这条链开始前，任何仍从旧
      // 出发地出发、或再次抵达同一到站枢纽的条目都是回折/重复安排。
      let postChain = false;
      dayRows.slice().sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))
        .forEach((item) => {
          if (drop.has(item) || item === anchor) return;
          const start = toMin(item.startTime);
          const end = toMin(item.endTime);
          if (start === null || start < depart) return;
          if (isWaiting(item) || onboard(item)) return;
          if (!postChain) {
            const destinationTransfer = startsAtDestination(item) && !startsAtOrigin(item);
            const destinationArrival = (destinationTransfer
              || (item.category !== 'transport' && endsAtDestination(item)))
              && !startsAtOrigin(item)
              && ['transport', 'hotel', 'sight', 'food', 'other'].includes(String(item.category || ''));
            if (destinationArrival) {
              postChain = true;
              // 模型常把前面被删除的旧城活动时长顺延到这条接驳之后；
              // 没有明确等待理由时，接驳应在抵达后尽快开始。
              if (start > arrive + 60) {
                const duration = end !== null && end > start ? end - start : 30;
                item.startTime = fmtMin(Math.min(1439, arrive + 10));
                item.endTime = fmtMin(Math.min(1439, arrive + 10 + duration));
                item.timingEstimated = true;
              }
              return;
            }
            // 已经直接“到达目的地”再补一条同向前往该目的地的交通，
            // 例如十里画廊→南宁东发生在阳朔→南宁的列车之后。
            if (endsAtDestination(item) || startsAtOrigin(item)
                || ['sight', 'food', 'other', 'hotel'].includes(String(item.category || ''))) {
              drop.add(item);
            }
          }
        });
      if (drop.size) {
        console.warn('[generatePlan] 第%d天以城际交通 %s→%s 为时间锚点，清理前后错序条目',
          dayIndex + 1, from, to);
      }
    });
  });
  return rows.filter((item) => !drop.has(item));
}

/**
 * 删除细化模型自行添加、且不在当日大纲交通链上的跨城段。
 *
 * 详细模型有时会把“到达换乘枢纽”的备选路线也写进正式时间线，例如
 * 已确定阳朔→大新的当天，又额外生成阳朔→南宁、南宁→阳朔和一段无关列车。
 * 后续地点断链修复会把这条错误路线补成完整回折，所以必须在跨城层先收口。
 * 只约束跨片区交通；同片区步行、公交、酒店接驳仍由其它规则处理。
 */
function removeUnplannedIntercityRows(items, outline) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const drop = new Set();
  const generic = /^(?:酒店|民宿|客栈|宾馆|住宿|住宿地|片区|市区|县城|周边|附近|返程|家中|家)$/;
  const areaTokens = (value) => {
    const raw = String(value || '').replace(/[\s，,、；;（）()]/g, '');
    const stripped = raw
      .replace(/(?:高铁|动车|火车|铁路|汽车|客运)?站$/g, '')
      .replace(/(?:游客服务中心|游客中心|景区大门|景区入口|景区出口|入口|出口|码头|机场)$/g, '')
      .replace(/[东南西北]$/, '');
    return [...new Set([stripped, ...scopeWordsOf(stripped), ...scopeWordsOf(raw)])]
      .map((word) => String(word || '').trim())
      .filter((word) => word.length >= 2 && !generic.test(word));
  };
  const routeFits = (expected, actual) => {
    const e = String(expected || '').trim();
    const a = String(actual || '').trim();
    if (!e || !a) return false;
    return samePlace(e, a) || sameStation(e, a) || sameTravelArea(e, a)
      || areaTokens(e).some((left) => areaTokens(a).some((right) =>
        left === right || (left.length >= 2 && right.includes(left))
          || (right.length >= 2 && left.includes(right))));
  };
  const isMovement = (item) => item && (item.category === 'transport' || item.transportType
    || (item.startLocation && item.endLocation
      && /前往|返回|回到|乘车|乘坐|坐车|打车|包车|专线|大巴|班车|接驳|出发|抵达|到达/.test(
        `${item.activity || ''} ${item.note || ''}`)));
  const isStrongIntercity = (item) => {
    const text = `${item && item.transportType || ''} ${item && item.activity || ''} ${item && item.note || ''}`.toLowerCase();
    if (/train|plane|ship|bus|coach|高铁|动车|火车|列车|航班|飞机|游船|轮渡|大巴|旅游专线|直通车|长途班车|跨城班车|城际|长途|跨城/.test(text)) return true;
    // 站点之间的“公共交通/接驳”常是模型拼出的替代跨城方案；但酒店到
    // 车站的步行、地铁、打车接驳属于本地交通，不能在这里删除。
    return item && item.category === 'transport'
      && /站|机场|码头/.test(`${item.startLocation || ''} ${item.endLocation || ''}`)
      && !/步行|地铁|公交|打车|网约车|出租车|接驳|walk|metro|subway|taxi|ride/.test(text);
  };
  const isLocalMode = (item) => /步行|地铁|公交|打车|网约车|出租车|接驳|walk|metro|subway|taxi|ride|car/i.test(
    `${item && item.transportType || ''} ${item && item.activity || ''} ${item && item.note || ''}`);
  const byDay = new Map();
  rows.forEach((item) => {
    const dayIndex = Number(item && item.dayIndex || 0);
    if (!byDay.has(dayIndex)) byDay.set(dayIndex, []);
    byDay.get(dayIndex).push(item);
  });

  byDay.forEach((dayRows, dayIndex) => {
    const day = days[dayIndex] || {};
    const moves = asArray(day.moves).filter((move) => move && move.from && move.to);
    if (!moves.length) return;
    const allowedScopes = [day.city, day.overnight, day.hotel, ...asArray(day.highlights),
      days[dayIndex - 1] && (days[dayIndex - 1].overnight || days[dayIndex - 1].city),
      ...moves.flatMap((move) => [move.from, move.to])].filter(Boolean);
    const declaredHighlights = asArray(day.highlights).map((highlight) => String(highlight || '').trim())
      .filter(Boolean);
    const isDeclaredSight = (item) => {
      if (!item || item.category !== 'sight' || !declaredHighlights.length) return false;
      const text = `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`;
      return declaredHighlights.some((highlight) => {
        const normalized = normalizeRoutePlace(highlight);
        const stem = placeStem(highlight);
        return text.includes(highlight)
          || (stem.length >= 2 && text.includes(stem))
          || (normalized.length >= 2 && normalizeRoutePlace(text).includes(normalized));
      });
    };
    const representsMove = (item) => moves.some((move) =>
      routeFits(move.from, item.startLocation) && routeFits(move.to, item.endLocation));
    const scopeAllowed = (location) => allowedScopes.some((scope) => routeFits(scope, location));
    const sameAllowedScope = (left, right) => allowedScopes.some((scope) =>
      routeFits(scope, left) && routeFits(scope, right));
    const badTokens = new Set();

    dayRows.forEach((item) => {
      const genericStart = /^(?:返程|回家|家中|家)$/.test(String(item && item.startLocation || '').trim());
      const genericEnd = /^(?:返程|回家|家中|家)$/.test(String(item && item.endLocation || '').trim());
      const representsCurrentMove = moves.some((move) =>
        routeFits(move.from, item && item.startLocation) && routeFits(move.to, item && item.endLocation));
      // “酒店→返程”“返程→某城市”是模型把返程占位词当成真实地点后
      // 拼出来的假接驳。真正的返程段必须命中大纲中的 from/to（通常是
      // 住宿地→车站、车站→出发地），不能因为“返程”被列为 overnight
      // 就把这类占位路线误判成合法链路。
      if (isMovement(item) && item.startLocation && item.endLocation
          && (genericStart || genericEnd) && !representsCurrentMove) {
        drop.add(item);
        [item.startLocation, item.endLocation].forEach((location) => {
          if (location && !scopeAllowed(location)) areaTokens(location).forEach((token) => badTokens.add(token));
        });
        console.warn('[generatePlan] 第%d天删除返程占位地点造成的无效接驳：%s→%s',
          dayIndex + 1, item.startLocation, item.endLocation);
        return;
      }
      if (!isMovement(item) || !item.startLocation || !item.endLocation
          || sameTravelArea(item.startLocation, item.endLocation)
          || sameAllowedScope(item.startLocation, item.endLocation)
          || representsMove(item)
          || (!/^(?:返程|回家|家中|家)$/.test(`${item.startLocation || ''}`.trim())
            && !/^(?:返程|回家|家中|家)$/.test(`${item.endLocation || ''}`.trim())
            && !isStrongIntercity(item) && isLocalMode(item))
          || (!isStrongIntercity(item)
            && !/^(?:返程|回家|家中|家)$/.test(String(item.endLocation || '').trim()))) return;
      const startAllowed = scopeAllowed(item.startLocation);
      const endAllowed = scopeAllowed(item.endLocation);
      if (startAllowed && endAllowed) return;
      drop.add(item);
      [item.startLocation, item.endLocation].forEach((location) => {
        if (!scopeAllowed(location)) areaTokens(location).forEach((token) => badTokens.add(token));
      });
      console.warn('[generatePlan] 第%d天删除不在大纲交通链上的跨城段：%s→%s',
        dayIndex + 1, item.startLocation, item.endLocation);
    });

    // 错误跨城段旁边常带一条“到某站候车/在某站吃饭”。只有它明确提到
    // 被删除的外部片区且自身不属于大纲交通链时才删除，避免误伤正常餐饮。
    if (!badTokens.size) return;
    dayRows.forEach((item) => {
      if (!item || drop.has(item) || representsMove(item)) return;
      const text = `${item.activity || ''} ${item.note || ''} ${item.startLocation || ''} ${item.endLocation || ''}`;
      if (!badTokensHasText(badTokens, text)) return;
      const category = String(item.category || '');
      // 景点本身已经被当天大纲明确列为必玩点时，即使它的起终点
      // 被模型写得不够精确，也不能因为旁边一条错误跨城交通带有同名
      // 地点就把实际游览项一起删掉；后续时间/地点审计会继续校正它。
      if (isDeclaredSight(item)) return;
      if (category === 'hotel' && scopeAllowed(item.endLocation || item.startLocation)) return;
      drop.add(item);
      console.warn('[generatePlan] 第%d天删除跨城错段附带的地点条目：%s',
        dayIndex + 1, String(item.activity || '').slice(0, 80));
    });
  });
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

function badTokensHasText(tokens, text) {
  const value = String(text || '').replace(/[\s，,、；;（）()]/g, '');
  return [...tokens].some((token) => token && value.includes(token));
}

/**
 * 最终时间线审计：前面的清洗可能在对齐大交通后又补出一段接驳，必须把
 * “跨日首点、首末日边界、交通偏好、停车、同日时序”再作为一个整体检查一次。
 * 这些函数都是确定性的，不重新生成内容；发现问题只修位置/时间/必要接驳。
 */
function enforceFinalTimelineIntegrity(items, p, outline, activeDays) {
  let out = normalizeGeneratedLodging(asArray(items), outline, p);
  out = reconcileTransportOrigins(out, outline);
  // 最早的清洗之后可能又发生了住宿地纠偏，先补回被擦掉的大纲移动段，
  // 让后续的首末日边界和时间修复都基于完整路线工作。
  out = enforceMovesAlignment(out, outline, activeDays, p);
  out = enforceScheduledMoveTimeline(out, outline, activeDays);
  out = enforceTransportChainOrder(out);
  out = enforceDayStartLocation(out, outline, p);
  out = enforceTripEdgeOrder(out, p, outline, activeDays);
  out = enforceTransportPreference(out, p);
  out = ensureSelfDriveParking(out, p);
  out = fixDayTimeOverlaps(out);
  out = removeAfterHomeArrival(out, p, outline);
  out = ensureItemLocationContinuity(out, p);
  out = fixDayTimeOverlaps(out);

  // 以上步骤可能补出闭环、接驳或入住条目，必须在返回前做一次最终收口。
  // 这些清洗保持通用规则，不依赖具体城市或景点名称。
  out = removeZeroDistanceTransports(out);
  out = removeCheckoutBacktracks(out);
  out = removeRedundantDirectTransports(out);
  out = enforceTransportChainOrder(out);
  out = removeOrphanStationWaitingItems(out, outline);
  out = dedupeDuplicateHotelItems(out);
  // 住宿/返程修复可能改写了交通起终点，再对照大纲做最后一次移动覆盖审计。
  out = enforceMovesAlignment(out, outline, activeDays, p);
  out = enforceScheduledMoveTimeline(out, outline, activeDays);
  out = enforceTransportChainOrder(out);
  out = fixDayTimeOverlaps(out);
  out = enforceScenicRouteSeparation(out, outline);
  out = removeScenicReentryBacktracks(out);
  out = enforceTransportPreference(out, p);
  out = ensureSelfDriveParking(out, p);
  out = fixDayTimeOverlaps(out);
  out = removeAfterHomeArrival(out, p, outline);
  out = ensureItemLocationContinuity(out, p);
  out = fixDayTimeOverlaps(out);
  out = removeZeroDistanceTransports(out);
  // A final alignment can insert a missing transfer after the first cleanup
  // pass, so repeat route-cleanup at the actual serialization boundary.
  out = removeCheckoutBacktracks(out);
  out = removeRedundantDirectTransports(out);
  out = enforceTransportChainOrder(out);
  out = removeOrphanStationWaitingItems(out, outline);
  out = removeZeroDistanceTransports(out);
  out = dedupeDuplicateHotelItems(out);
  out = ensureItemLocationContinuity(out, p);
  out = fixDayTimeOverlaps(out);
  out = removeScenicReentryBacktracks(out);
  out = dedupeDirectedTransportRoutes(out);
  out = ensureFinalHomeArrival(out, p, outline);
  out = removeUnplannedIntercityRows(out, outline);
  out = fixDayTimeOverlaps(out);

  const overlapCount = out.filter((item, index) => {
    if (index === 0 || Number(item.dayIndex || 0) !== Number(out[index - 1].dayIndex || 0)) return false;
    const previousEnd = toMin(out[index - 1].endTime);
    const currentStart = toMin(item.startTime);
    return previousEnd !== null && currentStart !== null && currentStart < previousEnd;
  }).length;
  if (overlapCount) console.warn('[generatePlan] 最终时间线仍有 %d 处重叠，保留交通事实等待人工核实', overlapCount);
  return out;
}

/**
 * 每天早餐兜底：第 2 天起，若 10:00 前没有任何餐饮条目，补一条"早餐+收拾退房"。
 * （第一天从家里出发，早餐在家吃，不补；出发太早赶早班车的也不硬塞。）
 */
function enforceMorningRoutine(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  byDay.forEach((list, di) => {
    if (di <= 0 || di >= days.length || !list.length) return;
    const hasBreakfast = list.some((it) =>
      it.category === 'food' && toMin(it.startTime) != null && toMin(it.startTime) < 10 * 60);
    if (hasBreakfast) return;
    const hasAnyFood = list.some((it) => it.category === 'food');
    const sorted = list.slice().sort((a, b) =>
      String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const first = sorted[0];
    const fs = toMin(first.startTime);
    if (fs == null || fs < 7 * 60 + 35) return;   // 赶早班车没空吃，别硬塞
    const prevOv = String((days[di - 1] && (days[di - 1].overnight || days[di - 1].city)) || '').trim();
    // 只在上午补早餐。实测踩过：返程日细化失败只剩 17:40 的高铁，
    // 兜底把"早餐"补在 17:00 —— 第一条都在中午以后了，该补的是午餐。
    if (fs <= 11 * 60 + 30) {
      const s = Math.max(7 * 60, fs - 40);
      const e = fs - 5;
      if (e <= s + 10) return;
      items.push({
        dayIndex: di,
        startTime: fmtMin(s),
        endTime: fmtMin(e),
        activity: prevOv ? `在${prevOv}吃早餐，收拾行李退房` : '吃早餐，收拾行李退房',
        category: 'food',
        startLocation: '',
        endLocation: '',
        transportType: '',
        note: '',
      });
      console.warn('[generatePlan] 第%d天 10 点前没有吃饭安排，补一条早餐', di + 1);
      return;
    }
    if (hasAnyFood || fs >= 15 * 60) return;      // 已有饭吃 / 下午才开始的不硬塞
    const s = Math.min(Math.max(fs - 50, 11 * 60 + 30), 13 * 60 + 30);
    items.push({
      dayIndex: di,
      startTime: fmtMin(s),
      endTime: fmtMin(s + 50),
      activity: prevOv ? `在${prevOv}附近吃午餐，收拾行李退房` : '吃午餐，收拾行李退房',
      category: 'food',
      startLocation: '',
      endLocation: '',
      transportType: '',
      note: '',
    });
    console.warn('[generatePlan] 第%d天第一条已是 %s，补午餐而不是早餐', di + 1, first.startTime);
  });
  return items;
}

/**
 * 晚间安排兜底：非末日当天若 20:30 前就结束了（典型：第一天傍晚就到目的地、
 * 行李一放就没事干），补晚餐/夜逛。必须跑在 enforceDayClosure 之前——
 * 插完由 closure 收尾"回酒店"，闭环不断。
 */
function enforceEveningPlan(items, outline, p) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  byDay.forEach((list, di) => {
    if (di < 0 || di >= days.length - 1 || !list.length) return;
    const today = days[di] || {};
    const tonight = String(today.overnight || today.city || '').trim();
    if (!tonight || /返程|回家/.test(tonight)) return;
    const city = String(today.city || tonight).trim() || tonight;
    const sorted = list.slice().sort((a, b) =>
      String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const last = sorted[sorted.length - 1];
    const endMin = toMin(last.endTime);
    // 15:00 前就结束的整天也别补"晚餐/夜游"——那是细化失败的残天（只落了大交通
    // +接驳），补出来就是"12:30 夜游散步"这种鬼东西，残天交给骨架重建
    if (endMin == null || endMin >= 20 * 60 + 30 || endMin < 15 * 60) return;

    if (last.category === 'hotel') {
      // 人已经回酒店但天还没黑透 → 补一条"再出门夜逛"（closure 随后补回酒店）
      const s = endMin + 30;
      if (s + 40 > 22 * 60 + 30) return;
      items.push({
        dayIndex: di,
        startTime: fmtMin(s),
        endTime: fmtMin(Math.min(s + 90, 22 * 60 + 30)),
        activity: `晚上出门到${city}市区逛逛，感受当地夜生活`,
        category: 'sight',
        startLocation: tonight,
        endLocation: city,
        transportType: p ? defaultTransferMode(p) : 'ride',
        note: '时间充裕，按兴趣选夜市/江边/商圈',
      });
      console.warn('[generatePlan] 第%d天 %s 就收尾了，补一条夜逛', di + 1, last.endTime);
      return;
    }
    // 人还在外面 → 补晚餐；时间够再补夜逛
    const s = endMin + 15;
    const dinnerEnd = Math.min(s + 75, 20 * 60 + 30);
    if (dinnerEnd > s + 30) {
      items.push({
        dayIndex: di,
        startTime: fmtMin(s),
        endTime: fmtMin(dinnerEnd),
        activity: `在${city}吃晚餐，尝当地特色菜`,
        category: 'food',
        startLocation: '',
        endLocation: city,
        transportType: '',
        note: '',
      });
    }
    const ns = dinnerEnd + 20;
    if (ns + 40 <= 22 * 60) {
      items.push({
        dayIndex: di,
        startTime: fmtMin(ns),
        endTime: fmtMin(Math.min(ns + 60, 22 * 60)),
        activity: `饭后到${city}市区夜游散步`,
        category: 'sight',
        startLocation: '',
        endLocation: city,
        transportType: 'walk',
        note: '',
      });
    }
    console.warn('[generatePlan] 第%d天 %s 就结束了，补晚餐/夜逛', di + 1, last.endTime);
  });
  return items;
}

/** 两个住宿地名是不是同一个地方（去掉括号补注与行政后缀再比，允许互相包含） */
function samePlace(a, b) {
  const norm = (s) => String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')   // 去掉"（两江四湖片区）"这类补注
    .replace(/[\s，,、·]/g, '')
    .replace(/(市区|市|县|区|镇)+$/, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 行李逻辑兜底
 *
 * 提示词里已经写了规矩，但 LLM 常偷懒（整天不提行李）或写反（换住处仍把行李
 * 留在上一家酒店）。这里做确定性修补，只往 note 里追加提醒，不动 activity 和时间线：
 *   ① 换住处却写了"把行李寄存在酒店前台" → 纠正为"退房带走全部行李"；
 *   ② 换住处但整天没提行李 → 早上第一条补一句；
 *   ③ 任何"寄存行李"之后没人提醒取回 → 在离开那一条补"取回行李"。
 */
function explicitCarryLuggagePreference(p) {
  const text = String(p && p.extra || '').trim();
  if (!text) return false;
  // 只有补充要求明确说“随身携带方便/不需要寄存”才跳过临时寄存建议；
  // “行李不方便随身带”不能被误判成例外。
  if (/不方便|不便|不能|不想|不希望|避免/.test(text) && /随身|携带|寄存/.test(text)) return false;
  return /(?:行李|箱子|大件).{0,16}(?:随身携带|随身带|携带方便|方便携带|不用寄存|不需要寄存|无需寄存)|(?:随身携带|随身带|携带方便|方便携带|不用寄存|不需要寄存|无需寄存).{0,16}(?:行李|箱子|大件)/.test(text);
}

function enforceLuggageRules(items, outline, p) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;

  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const drop = new Set();

  const TIP_PICKUP = '离开前记得取回寄存的行李';

  byDay.forEach((list, di) => {
    if (!list.length) return;
    const today = days[di] || {};
    const prevDay = di > 0 ? days[di - 1] : null;
    const tonight = String(today.overnight || today.city || '');
    const lastNight = prevDay ? String(prevDay.overnight || prevDay.city || '') : '';
    const changedBase = !!lastNight && !samePlace(lastNight, tonight);
    // 行政区相同不等于回到了昨晚酒店：县城客运站、机场、码头和景区
    // 可能与住宿地共享同一个“县/市”词根，不能因此把“景区→客运站”
    // 当成回酒店取行李。只有地点本身等同于旧住宿地、明确是住宿 POI，
    // 或活动文字明确写了回酒店/取件，才算完成旧住宿地回收。
    const isOldLodgingLocation = (value) => {
      const text = String(value || '').trim();
      if (!text) return false;
      // 行政区名称可能包含在“某某汽车站/高铁站”里；不能先用
      // samePlace 判断就把交通节点认成昨晚酒店，否则会伪造“回酒店取行李”。
      const isLodging = /酒店|民宿|客栈|宾馆|青旅|住宿|房间|前台/.test(text);
      if (/车站|客运|汽车|机场|码头|景区|游客中心|停车场/.test(text) && !isLodging) return false;
      if (samePlace(text, lastNight)) return true;
      return sameTravelArea(text, lastNight)
        && isLodging
        && !/车站|客运|汽车|机场|码头|景区|游客中心|停车场/.test(text);
    };
    const explicitlyReturnsToOldLodging = (it) => {
      // 备注里的“游玩结束后返回旧酒店取回”可能只是模型对寄存方案的
      // 推测，且结构化起终点已经显示人要去客运站；只有活动正文或真实
      // 起终点明确回住宿地，才把它当成可执行的取件闭环。
      const text = String(it && it.activity || '');
      if (/回酒店|回民宿|回客栈|回住宿地|回房间|返回酒店|返回民宿|返回客栈/.test(text)) return true;
      return /取回|取件|拿回|领回/.test(text)
        && (text.includes(lastNight) || /昨晚住宿|昨晚酒店|原酒店|旧酒店/.test(text));
    };
    const explicitCarry = explicitCarryLuggagePreference(p);
    const TIP_TAKE = /返程|回家|返回/.test(tonight)
      ? '今天返程，退房请带走全部行李（行李随人走）'
      : '今晚不回这家酒店，退房请带走全部行李（行李随人走）';

    const textOf = (it) => `${it.activity || ''} ${it.note || ''}`;
    const hasLuggage = (it) => /行李|箱子|大件/.test(textOf(it));
    // 否定句里的"寄存"不是寄存："行李随身带，不寄存""严禁寄存回原酒店"
    // ——先把否定短语剥掉再匹配，否则会莫名其妙冒出一条"记得取回行李"
    const stripNegation = (s) => String(s || '')
      // "不可寄存回原酒店""不能寄存"这类中间夹了个能愿动词的否定，也要认——
      // 只写 `不` 时 "不可寄存" 会漏（不+可+寄存 不相邻），于是被当成真寄存，
      // 凭空冒出一条"记得取回行李"（国庆广西冒烟踩到）
      .replace(/(不可|不能|不得|不该|不宜|切记不要|不要|不|勿|别|无需|无须|不用|避免|严禁|禁止)(寄存|暂存|存放|存包|寄放)/g, '');
    const isGeneratedTempStoreNote = (value) => /早上离开[^；。]*?前将大件行李临时寄存在[^；。]*?，轻装游玩；下午离开前返回取回/.test(String(value || ''));
    const isGeneratedTempPlan = (value) => /早上离开[^；。]*?前将(?:大件行李临时寄存在[^；。]*?|携带全部大件行李)[^；。]*，轻装游玩；下午离开前返回取回/.test(String(value || ''));
    const hasStorageActionInActivity = (it) => /寄存|暂存|存放|寄放|存包/.test(stripNegation(String(it && it.activity || '')))
      && hasLuggage(it)
      && !/(?:之前|先前|此前|如需|如有|若未|若有|如果|可能)[^；。]{0,24}(?:寄存|暂存|存放|寄放|存包)/.test(String(it && it.activity || ''));
    const hasRoomHoldAction = (it) => hasLuggage(it)
      && /(?:留房|留在|留存|放在|放置)(?:酒店|民宿|客栈|房间|前台)?/.test(stripNegation(String(it && it.activity || '')));
    // 只把"真的把行李存下了"当成寄存：activity 里写了寄存动作，或备注里明确写了"寄存行李"。
    // 「码头有行李寄存柜」这种顺口一提不算——否则会莫名其妙冒出一条"记得取回行李"。
    const invalidStores = new Set();
    const isPickup = (it) => {
      const text = textOf(it);
      const explicitPickup = /取回|取件|拿回|领回|取寄存|取暂存/.test(text);
      const returnForLuggage = /(?:返回|回到|前往)[^。；;，,]{0,50}(?:取|拿|领)(?:回|出|件)?(?:寄存|暂存|存放|寄放)?的?(?:全部|大件)?行李/.test(text);
      // “下午离开前返回取回”是自动追加在临时寄存提示里的计划说明，
      // 不是已经发生的取件动作；否则最后一天清洗时会把整条提示拆坏。
      const generatedTempPlan = isGeneratedTempPlan(it && it.note);
      return !generatedTempPlan && (explicitPickup || returnForLuggage)
        && (hasLuggage(it) || /寄存|暂存|存放|存包/.test(text));
    };
    const pickupOnlyStorageText = (value) => {
      const text = stripNegation(value);
      // “取回寄存的大件行李”是在描述取件，不代表这条记录本身完成了
      // 寄存；只有“先寄存……再取回”才算真实存放动作。
      return /(?:取回|取件|拿回|领回|取寄存|取暂存|取存放)[^；。]*?(?:寄存|暂存|存放|寄放|存包)?/.test(text)
        && !/(?:寄存|暂存|存放|寄放|存包)[^；。]*?(?:取回|取件|拿回|领回)/.test(text);
    };
    const isStore = (it) => !invalidStores.has(it)
      && !isGeneratedTempPlan(it && it.note)
      && !pickupOnlyStorageText(textOf(it))
      && !/(?:之前|先前|此前|如需|如有|若未|若有|如果|可能)[^；。]{0,24}(?:寄存|暂存|存放|寄放|存包)/.test(textOf(it))
      && (hasStorageActionInActivity(it)
        || hasRoomHoldAction(it)
        || (/(?:寄存|暂存)(大件)?行李|存放(大件)?行李|行李(?:寄存|暂存)/.test(stripNegation(String(it.note || '')))
          && !isGeneratedTempStoreNote(it.note)));
    const appendNote = (it, tip) => {
      if (!it) return false;
      const cur = String(it.note || '');
      if (cur.includes(tip)) return false;
      it.note = cur ? `${cur.replace(/[；;]\s*$/, '')}；${tip}` : tip;
      return true;
    };

    const storageText = (it) => `${it && it.activity || ''} ${it && it.note || ''}`;
    const hasHotelStorageWord = (it) => /酒店|民宿|客栈|宾馆|青旅|房间|前台/.test(storageText(it));
    const locationText = (it) => [it && it.startLocation, it && it.endLocation, storageText(it)]
      .filter(Boolean).join(' ');
    const storageAt = (it, place, implicitOldHotelStore) => !!place && isStore(it)
      // 抵达新酒店后的存放不是旧酒店寄存，即使备注提到旧城市也不算。
      && !(changedBase && today.hotel && it.endLocation === today.hotel
        && it.endLocation !== (prevDay && prevDay.hotel))
      && (isOldLodgingLocation(it && it.startLocation)
        || isOldLodgingLocation(it && it.endLocation)
        // 只有调用方已经确认这条“无地点字段”的酒店寄存发生在离开旧住宿地
        // 之前，才允许用上下文推断归属。不能把当天抵达新酒店后的存放动作
        // 误认成旧酒店寄存。
        || (!!implicitOldHotelStore && hasHotelStorageWord(it))
        || (sameTravelArea(locationText(it), place) && hasHotelStorageWord(it)));
    const rewriteHotelStorageAsCarry = (it) => {
      if (!it) return;
      const oldActivity = String(it.activity || '').trim();
      // 早餐/景点条目有时只是被自动追加了“临时寄存”备注，不能因为
      // 备注里出现了“酒店”就把整条活动改成一条新的退房交通。
      // 只有住宿条目或活动本身以退房动作开头时，才替换为完整的携行李动作；
      // 其它活动保留原内容，仅把寄存动作改成随身携带。
      if (it.category === 'hotel' || /^(?:办理)?退房(?:[，,、 ]|$)/.test(oldActivity)) {
        it.activity = '退房，携带全部大件行李前往下一站';
      } else if (it.category === 'transport' && it.endLocation) {
        it.activity = `携带全部大件行李从${it.startLocation || lastNight}前往${it.endLocation}`;
      } else if (oldActivity) {
        const checkoutIndex = oldActivity.search(/退房/);
        const hasCheckoutStorage = checkoutIndex >= 0
          && /行李/.test(oldActivity.slice(checkoutIndex))
          && /寄存|暂存|存放|寄放|存包/.test(stripNegation(oldActivity.slice(checkoutIndex)));
        if (hasCheckoutStorage) {
          const prefix = oldActivity.slice(0, checkoutIndex)
            .replace(/[。；;，,]\s*$/, '')
            .trim();
          const target = String(it.endLocation || '').trim() || '下一站';
          it.activity = `${prefix ? `${prefix}。` : ''}退房并整理行李，携带全部大件行李前往${target}`;
        } else {
          it.activity = oldActivity.replace(/寄存|暂存|存放|寄放|存包/g, '携带');
        }
      }
      // 旧酒店寄存被判定为无效时，连同模型附带的“返回取件”理由一起清掉。
      // 这里只处理已经确定不应寄存的旧酒店条目，避免留下一个看似需要折返的动作。
      it.activity = String(it.activity || '')
        .replace(/[（(][^）)]*(?:因需)?(?:返回取件|取回寄存|取回暂存)[^）)]*[）)]/g, '')
        .replace(/(?:因需)?返回取件[^，。；;]*/g, '')
        .trim();
      // 不能只追加“带走”，正文里仍留着“寄存在旧酒店”会让用户继续误解；
      // 仅移除存放动作的局部文字，保留其它交通/景点说明。
      it.note = String(it.note || '')
        .replace(/寄存|暂存|存放|寄放|存包/g, '随身携带')
        .replace(/酒店前台|酒店房间|房间|前台/g, '')
        .replace(/[；;]\s*[；;]/g, '；')
        .replace(/^[；;]|[；;]$/g, '')
        .trim();
      // 住宿归一化有时会把“昨晚酒店寄存”这一条的 endLocation 改成今晚
      // 的酒店，造成“人还在成都却已经从古尔沟出发”的地点断链。纠正为
      // 昨晚实际住宿地，后续连续性审计才能从正确地点接到车站。
      if (it.category === 'hotel' && changedBase
          && sameTravelArea(it.endLocation, tonight)
          && !sameTravelArea(it.endLocation, lastNight)) {
        it.endLocation = String(it.startLocation || lastNight).trim();
      }
    };
    const isRepeatHotelDrop = (it) => /放下(?:全部|大件)?行李|放置(?:全部|大件)?行李|办理入住[^；。]*行李/.test(textOf(it))
      && !/小包|随身物品/.test(textOf(it))
      && (it.category === 'hotel' || hasHotelStorageWord(it));
    const normalizeRepeatHotelDrop = (it) => {
      const base = tonight || lastNight || '住宿地';
      it.activity = `返回${base}休息，整理随身物品`;
      it.note = String(it.note || '')
        .replace(/[^；。]*放下(?:全部|大件)?行李[^；。]*[；。]?/g, '')
        .replace(/[^；。]*放置(?:全部|大件)?行李[^；。]*[；。]?/g, '')
        .replace(/[；;]\s*[；;]/g, '；')
        .replace(/^[；;]|[；;]$/g, '')
        .trim();
    };

    // 换城但下午才离开原住宿片区的“白天轻装游玩”例外：
    // 行李只临时寄存在昨晚酒店，离开前必须取回，不把寄存误当成跨夜托管。
    const ordered = list.slice().sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    const oldBaseDeparture = changedBase
      ? ordered.find((it) => it.category === 'transport'
        && String(it.endLocation || '').trim()
        && !samePlace(it.endLocation, lastNight)
        && (isOldLodgingLocation(it.startLocation)
          || (!it.startLocation && sameTravelArea(it.activity, lastNight)))
        )
      : null;
    const oldBaseDepartureStart = toMin(oldBaseDeparture && oldBaseDeparture.startTime);
    const isImplicitOldHotelStore = (it) => {
      if (!changedBase || it.startLocation || it.endLocation
          || !hasHotelStorageWord(it) || !isStore(it)) return false;
      // 没有可用交通起终点时，只接受“退房/酒店条目”这种明确发生在
      // 旧住宿地的写法；普通抵达新酒店的“放下行李”不会命中 isStore。
      if (!oldBaseDeparture && it.category !== 'hotel' && !/退房/.test(textOf(it))) return false;
      const start = toMin(it.startTime);
      return !oldBaseDeparture || oldBaseDepartureStart === null || start === null || start <= oldBaseDepartureStart;
    };
    const departure = changedBase && !explicitCarry
      ? ordered.find((it) => it.category === 'transport'
        && String(it.endLocation || '').trim()
        && !samePlace(it.endLocation, lastNight)
        && (isOldLodgingLocation(it.startLocation)
          || (!it.startLocation && sameTravelArea(it.activity, lastNight)))
        && (toMin(it.startTime) === null || toMin(it.startTime) >= 12 * 60))
      : null;
    const departureStart = toMin(departure && departure.startTime);
    const meaningfulLocalVisit = (it) => {
      if (!it || !['sight', 'other'].includes(String(it.category || ''))) return false;
      const text = textOf(it);
      if (/早餐|早饭|午餐|午饭|晚餐|晚饭|酒店|民宿|客栈|宾馆|车站|候车|退房|寄存|行李|休息/.test(text)) return false;
      return it.category === 'sight'
        || /竹筏|骑行|骑车|游览|景区|景点|拍照|游玩|逛|观景|漂流|体验|打卡|徒步|公园|古镇|市场/.test(text);
    };
    const localVisit = departure
      ? ordered.find((it) => it !== departure
        && meaningfulLocalVisit(it)
        && !isStore(it)
        && (departureStart === null || (toMin(it.startTime) === null || toMin(it.startTime) < departureStart))
        && (sameTravelArea(it.startLocation, lastNight)
          || sameTravelArea(it.endLocation, lastNight)
          // 没有位置字段时，只有“离开交通”本身明确从昨晚住宿片区出发，
          // 且活动是当地游玩，才允许推断这是临时寄存；不能凭一个“游览”
          // 就在不会回来的最后一天制造寄存提醒。
          || (sameTravelArea(departure.startLocation, lastNight)
            && /竹筏|骑行|游览|景区|景点|拍照|游玩/.test(textOf(it)))))
      : null;
    // 早上从旧酒店片区去景点、下午再回到原片区的一日游，也应让大件行李
    // 留在酒店；只有明确存在“出去→回旧片区”的闭环时才启用临时寄存。
    const dayTripDeparture = changedBase && !explicitCarry
      ? ordered.find((it) => it.category === 'transport'
        && String(it.startLocation || '').trim()
        && String(it.endLocation || '').trim()
        && isOldLodgingLocation(it.startLocation)
        && !isOldLodgingLocation(it.endLocation))
      : null;
    const dayTripDepartureStart = toMin(dayTripDeparture && dayTripDeparture.startTime);
    const dayTripReturn = dayTripDeparture
      ? ordered.find((it) => it !== dayTripDeparture
        && it.category === 'transport'
        && (isOldLodgingLocation(it.endLocation) || explicitlyReturnsToOldLodging(it))
        && !isOldLodgingLocation(it.startLocation)
        && (dayTripDepartureStart === null || toMin(it.startTime) === null
          || toMin(it.startTime) > dayTripDepartureStart))
      : null;
    const dayTripReturnStart = toMin(dayTripReturn && dayTripReturn.startTime);
    const dayTripVisit = dayTripDeparture && dayTripReturn
      ? ordered.find((it) => it !== dayTripDeparture && it !== dayTripReturn
        && meaningfulLocalVisit(it)
        && !isStore(it)
        && (dayTripDepartureStart === null || toMin(it.startTime) === null
          || toMin(it.startTime) >= dayTripDepartureStart)
        && (dayTripReturnStart === null || toMin(it.endTime) === null
          || toMin(it.endTime) <= dayTripReturnStart))
      : null;
    // 模型也可能直接写出“清晨把大件留在昨晚酒店→看日出→回酒店取回”，
    // 但没有单独生成 dayTripDeparture/dayTripReturn 交通。只要结构化地点和
    // 后续时间线形成回到旧住宿地的闭环，这仍是合法的临时寄存，不应被换城
    // 规则改写成“退房带走”或删除取件动作。
    const explicitOldLodgingStorage = !explicitCarry && ordered.some((store) => {
      if (!isStore(store) || isPickup(store)
          || !(isOldLodgingLocation(store.startLocation) || isOldLodgingLocation(store.endLocation))) return false;
      const storeIndex = ordered.indexOf(store);
      return ordered.slice(storeIndex + 1).some((later) =>
        ((isOldLodgingLocation(later.endLocation)
          && !isOldLodgingLocation(later.startLocation))
          || (isPickup(later) && !String(later.endLocation || '').trim()
            && /返回|回到/.test(textOf(later))
            && /酒店|民宿|客栈|住宿地|旧住宿/.test(textOf(later))))
        && (toMin(later.startTime) === null || toMin(later.startTime) > toMin(store.startTime || '00:00')));
    });
    const existingOldHotelStore = ordered.some((it) => storageAt(it, lastNight, isImplicitOldHotelStore(it)));
    const storageDeparture = departure || dayTripDeparture;
    const storageDepartureStart = toMin(storageDeparture && storageDeparture.startTime);
    let temporaryStorage = !explicitCarry
      && !!((departure && localVisit) || (dayTripDeparture && dayTripReturn && dayTripVisit)
        || explicitOldLodgingStorage);
    const TIP_TEMP_STORE = `早上离开${lastNight}前将大件行李临时寄存在酒店前台，轻装游玩；下午离开前返回取回`;
    const TIP_TEMP_PICKUP = dayTripReturn
      ? `游玩结束后返回${lastNight}取回寄存的行李，再按后续行程前往下一站`
      : `离开前先返回${lastNight}取回寄存的行李，再前往${storageDeparture && storageDeparture.endLocation || '下一站'}`;
    const clearGeneratedTempStorageText = (value) => String(value || '')
      .replace(TIP_TEMP_STORE, '')
      .replace(TIP_TEMP_PICKUP, '')
      .replace(/早上离开[^；。]*?前将大件行李临时寄存在[^；。]*?，轻装游玩；下午离开前返回取回/g, '')
      .replace(/早上离开[^；。]*?前将携带全部大件行李[^；。]*，轻装游玩；下午离开前返回取回/g, '')
      .replace(/[；;]\s*[；;]/g, '；')
      .replace(/^[；;]|[；;]$/g, '')
      .trim();

    if (temporaryStorage && !existingOldHotelStore) {
      // 只在确实有“退房/整理行李”条目时把寄存写进时间线，避免出现
      // 早上文案仍说“携带全部行李”，下午却凭空“取回寄存行李”。
      const storeCandidate = ordered.find((it) => it !== storageDeparture
        && (it.category === 'hotel' || /退房|整理行李|收拾行李|大件行李/.test(textOf(it)))
        && !isPickup(it)
        && (toMin(it.startTime) === null || storageDepartureStart === null || toMin(it.startTime) <= storageDepartureStart)
        && (sameTravelArea(it.startLocation, lastNight)
          || sameTravelArea(it.endLocation, lastNight)
          || (!it.startLocation && !it.endLocation)));
      if (storeCandidate) {
        const old = String(storeCandidate.activity || '').trim();
        storeCandidate.activity = /退房/.test(old)
          ? old.replace(/携带全部大件行李前往下一站|携带(?:全部)?(?:大件)?行李[^，。；;]*/g,
            `将大件行李临时寄存在${lastNight}酒店前台，随后轻装游玩`)
          : `退房，将大件行李临时寄存在${lastNight}酒店前台，随后轻装游玩`;
        storeCandidate.note = String(storeCandidate.note || '')
          .replace(/今晚不回这家酒店，?退房请带走全部行李（行李随人走）/g, '')
          .replace(/退房请带走全部行李（行李随人走）/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/^[；;]|[；;]$/g, '')
          .trim();
        appendNote(storeCandidate, TIP_TEMP_STORE);
      } else {
        appendNote(localVisit, TIP_TEMP_STORE);
      }
    }
    // “上午寄存、下午换城”只有在时间线里真的回旧酒店取过行李才成立。
    // 若后面直接去了车站/下一城，寄存会变成无法兑现的旧酒店折返；此时
    // 宁可改成一开始就带走大件行李，也不要给用户留下取件幻觉。
    const storedRows = ordered.filter(isStore);
    if (temporaryStorage && storedRows.length) {
      const firstStoreIndex = ordered.indexOf(storedRows[0]);
      const departureIndex = storageDeparture ? ordered.indexOf(storageDeparture) : ordered.length;
      const returnsForStorage = !!dayTripReturn || ordered.slice(firstStoreIndex + 1,
        departureIndex < 0 ? ordered.length : departureIndex)
        .some((it) => {
          // 自动追加的“下午离开前返回取回”只是规则提示，不能把它
          // 自己当成已经发生的取件动作，否则最后一天会错误保留旧酒店寄存。
          const text = clearGeneratedTempStorageText(textOf(it));
          const pickup = /取回|取出|取件|拿回|领回|回酒店|返回酒店|回民宿|返回民宿/.test(text);
          const oldLodgingEnd = /酒店|民宿|客栈|宾馆|青旅|房间|前台/.test(String(it.endLocation || ''))
            || (samePlace(it.endLocation, lastNight)
              && !/站|机场|码头|景区|游客中心/.test(String(it.endLocation || '')));
          const returnTransport = it.category === 'transport'
            && oldLodgingEnd
            && !sameTravelArea(it.startLocation, lastNight);
          return pickup || returnTransport;
        });
      if (!returnsForStorage) {
        // `TIP_TEMP_STORE` 是本规则刚刚写入的提示，不等于已经真的
        // 执行了寄存。先区分真实存放动作，避免把“早餐后退房”这一条
        // 也当成寄存条目并改写成第二条退房记录。
        const oldLodgingStoredRows = storedRows.filter((it) =>
          storageAt(it, lastNight, isImplicitOldHotelStore(it)));
        const actualStoredRows = oldLodgingStoredRows.filter((it) => {
          const noteText = String(it.note || '');
          const hasIndependentNoteStorage = /寄存|暂存|存放|寄放|存包/.test(stripNegation(noteText))
            && !noteText.includes(TIP_TEMP_STORE)
            && !/早上离开[^；。]*?前将大件行李临时寄存/.test(noteText);
          return it.category === 'hotel' || hasStorageActionInActivity(it)
            || hasRoomHoldAction(it) || hasIndependentNoteStorage;
        });
        storedRows.filter((it) => !actualStoredRows.includes(it)
          && isGeneratedTempStoreNote(it.note)).forEach((it) => {
          it.note = clearGeneratedTempStorageText(it.note);
          appendNote(it, TIP_TAKE);
        });
        actualStoredRows.forEach((it) => {
          invalidStores.add(it);
          it.note = clearGeneratedTempStorageText(it.note);
          rewriteHotelStorageAsCarry(it);
          appendNote(it, TIP_TAKE);
        });
        temporaryStorage = false;
      }
    }
    if (temporaryStorage) appendNote(dayTripReturn || storageDeparture, TIP_TEMP_PICKUP);
    if (temporaryStorage) {
      // 已确认是“旧住宿地寄存、游玩后取回”的闭环时，模型偶尔还会把
      // 拾取条目写成“从金佛顶下山取回”，导致人像从景点直接跳到行李点。
      // 只改取件动作的文字，保留后面的步行/换乘安排。
      ordered.filter(isPickup).forEach((it) => {
        const old = String(it.activity || '');
        const fixed = old.replace(/(?:从|由)[^；。]{0,80}(?:取回|取出|取件|拿回|领回)(?:寄存|暂存|存放|寄放)?的?(?:全部|大件)?行李/g,
          `返回${lastNight}取回寄存的大件行李`);
        if (fixed !== old) it.activity = fixed;
      });
    }
    if (temporaryStorage && dayTripReturn) {
      const returnStart = toMin(dayTripReturn.startTime);
      ordered.forEach((it) => {
        it.activity = String(it.activity || '')
          .replace(/[（(][^）)]*(?:若未寄存|未寄存|没有寄存)[^）)]*[）)]/g, '')
          .trim();
        if (it === dayTripReturn || returnStart === null || toMin(it.startTime) === null
            || toMin(it.startTime) <= returnStart) return;
        it.note = String(it.note || '')
          .replace(/离开前(?:记得)?(?:先)?(?:返回[^；。]*?)?(?:取回|取出|取件|拿回|领回)(?:寄存|暂存|存放|寄放)?的?行李[^；。]*[；。]?/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/^[；;]|[；;]$/g, '')
          .trim();
      });
    }
    if (changedBase && !temporaryStorage) {
      // 没有形成“下午回旧酒店取行李”的闭环时，清掉前面可能残留的
      // 临时寄存提示；它不是实际存放动作，不能继续出现在返程日。
      ordered.forEach((it) => {
        if (!hasStorageActionInActivity(it) && isGeneratedTempStoreNote(it.note)) {
          it.note = clearGeneratedTempStorageText(it.note);
          appendNote(it, TIP_TAKE);
        }
      });
    }

    // 细化模型常把“取回寄存行李”写在跨城当天，但前面既没有存放动作，
    // 也没有前一天在该酒店寄存的事实。没有真实寄存依据时改回“携带大件
    // 行李”，避免用户被安排先离开、再为一件不存在的行李折返。
    const previousRows = byDay.get(di - 1) || [];
    const previousStoredAtBase = previousRows.some((it) => {
      const raw = `${it && it.activity || ''} ${it && it.note || ''}`;
      return /行李/.test(raw) && /寄存|暂存|存放|存包|寄放/.test(stripNegation(raw))
        && !pickupOnlyStorageText(raw)
        && (sameTravelArea(it && it.startLocation, lastNight)
          || sameTravelArea(it && it.endLocation, lastNight)
          || (!it.startLocation && !it.endLocation && /酒店|民宿|客栈|宾馆|前台/.test(raw)));
    });
    const hasCurrentOldStore = ordered.some((it) => storageAt(it, lastNight, isImplicitOldHotelStore(it)));
    const hasAnyCurrentStorage = ordered.some((it) => isStore(it) && !isPickup(it));
    const hasCurrentLodgingStorage = ordered.some((it) => isStore(it) && !isPickup(it)
      && (sameTravelArea(it.startLocation, tonight) || sameTravelArea(it.endLocation, tonight)));
    const actualStorageRecord = (it) => isStore(it) && !isPickup(it)
      && !pickupOnlyStorageText(textOf(it));
    // 只有“先存放、后取回”的记录才算事实；单独一句“取回寄存行李”
    // 不能反过来为自己提供寄存依据。
    const hasStorageFact = previousRows.some(actualStorageRecord)
      || ordered.some(actualStorageRecord);
    const clearFalseStorageClaims = (value) => String(value || '')
      .replace(/[（(][^）)]*(?:若未寄存|未寄存|没有寄存|如有)[^）)]*[）)]/g, '')
      .replace(/(?:全部|大件)?行李[^。；;，,]{0,24}(?:已|暂时|临时)?(?:在[^。；;，,]{0,20})?(?:寄存|暂存|存放)[^。；;，,]*/g, '携带全部大件行李')
      .replace(/(?:寄存|暂存|存放)(?:在|于)?[^。；;，,]{0,24}(?:全部|大件)?行李/g, '携带全部大件行李')
      .replace(/(?:大箱|大件行李)[^。；;，,]{0,12}留在酒店/g, '大件行李随身携带')
      .replace(/大件行李可随身携带或寄存于[^。；;，,]*/g, '大件行李随身携带')
      .replace(/携带(?:大件)?(?:物品|行李)[^。；;，,]{0,12}(?:于|在)前台/g, '携带全部大件行李出发')
      .replace(/(?:将|把)?(?:全部|大件)?行李(?:携带|放置|留在)[^。；;，,]{0,8}(?:于|在)(?:酒店|前台|房间)[^。；;，,]*/g, '携带全部大件行李出发')
      .replace(/(?:行李条|寄存凭证|寄存牌)[^。；;，,]{0,24}(?:下午|随后|离开前)?(?:取回|领取|拿回)[^。；;，,]*/g, '')
      .replace(/(?:与|和)(?:之前|先前|此前)寄存的行李(?:汇合|会合)(?:[（(][^）)]*[）)])?/g, '携带全部大件行李')
      .replace(/(?:之前|先前|此前)寄存的行李(?:汇合|会合)?(?:[（(][^）)]*[）)])?/g, '携带全部大件行李')
      .replace(/(?:与|和)携带全部大件行李汇合(?:[（(][^）)]*[）)])?/g, '检查行李')
      .replace(/携带全部大件行李汇合(?:[（(][^）)]*[）)])?/g, '检查行李')
      .replace(/(?:离开前(?:先)?(?:记得|务必)?\s*)?取回\s*$/g, '')
      .replace(/(?:将|把)大件行李随身携带在[，,]?只带随身小包/g, '游玩时只带随身小包')
      .replace(/携带于酒店前台/g, '随身携带出发')
      .replace(/(?:离开前(?:记得|先)?\s*)?(?:携带全部大件行李|行李)\s*$/g, '')
      .replace(/[；;]\s*[；;]/g, '；')
      .replace(/[，,]\s*(?=；|$)/g, '')
      .replace(/^[；;]|[；;]$/g, '')
      .trim();
    // 临时寄存规则刚刚形成的“存放→返回取回”计划本身就是有效事实，
    // 不能被下面的“没有寄存依据”清洗掉；否则会把合法的白天轻装游玩
    // 重新改成一段残缺的“取回/携带”文案。
    if (!hasStorageFact && !temporaryStorage) {
      ordered.forEach((it) => {
        if (isStore(it) || isGeneratedTempPlan(it && it.note)) return;
        it.activity = clearFalseStorageClaims(it.activity);
        it.note = clearFalseStorageClaims(it.note);
      });
    }
    if (changedBase && !temporaryStorage && !previousStoredAtBase
        && !hasCurrentOldStore && !hasAnyCurrentStorage) {
      const rewritePickupText = (value) => String(value || '')
        // 不只匹配“取回寄存的行李”：模型还会写成“取回在明仕田园附近
        // 寄存的行李（若未寄存则忽略）”。没有真实寄存记录时，整段都应回写
        // 成“携带大件行李”，不能留下一个看似需要折返的地点名。
        .replace(/(?:返回|回到|前往)[^。；;，,]{0,50}(?:取|拿|领)(?:回|出|件)?(?:寄存|暂存|存放|寄放)?的?(?:全部|大件)?行李(?:[（(][^）)]*[）)])?/g, '携带全部大件行李')
        .replace(/(?:取回|取出|取件|拿回|领回)[^。；;，,\n]{0,80}?(?:行李|箱子|大件)/g, '携带全部大件行李')
        .replace(/(?:取|拿|领)(?:回|出|件|寄存|暂存)(?:在[^。；;，,]{0,30})?(?:寄存|暂存|存放|寄放)?的?(?:全部|大件)?行李(?:[（(][^）)]*[）)])?/g, '携带全部大件行李')
        .replace(/[（(][^）)]*(?:若未寄存|未寄存|没有寄存)[^）)]*[）)]/g, '')
        .replace(/(?:若未寄存|未寄存|没有寄存)[^。；;，,\n]{0,24}(?:忽略|跳过)[^。；;，,\n]*/g, '')
        .replace(/取回(?:(?:寄存|暂存)的?|存放的?|寄放的?)?(?:全部|大件)?行李/g, '携带全部大件行李')
        .replace(/取出(?:(?:寄存|暂存)的?|存放的?|寄放的?)?(?:全部|大件)?行李/g, '携带全部大件行李');
      ordered.forEach((it) => {
        if (!isPickup(it)) return;
        const originalActivity = String(it.activity || '');
        if (it.category === 'transport' && it.startLocation && it.endLocation
            && /取|拿|领/.test(originalActivity)) {
          it.activity = `从${it.startLocation}前往${it.endLocation}，携带全部大件行李`;
        } else {
          it.activity = rewritePickupText(originalActivity);
        }
        it.note = rewritePickupText(it.note)
          .replace(/离开前(?:先)?返回[^；。]*?取回寄存的行李[^；。]*?/g, '')
          .replace(/离开前(?:记得)?携带全部大件行李/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/^[；;]|[；;]$/g, '')
          .trim();
      });
    }

    // 连住同一酒店时，早上只带小包出门，晚上回到原房间不是“再次放下行李”。
    // 将模型重复生成的动作改成休息/整理随身物品，保留真实的入住日放行李。
    if (!changedBase && lastNight && samePlace(lastNight, tonight)) {
      ordered.forEach((it) => {
        const activity = String(it.activity || '');
        if (!/退房/.test(activity) || !/(?:行李)?(?:寄存|暂存|存放)|确认行李/.test(activity)) return;
        // 连住同一住宿地只需把大件行李留在房间/前台，不能同时出现
        // “退房”与“今晚继续住”的矛盾文案。
        it.activity = activity
          .replace(/退房(?:或确认)?行李(?:寄存|暂存|存放)/g, '大件行李留在房间，轻装出发')
          .replace(/退房或确认行李寄存/g, '大件行李留在房间，轻装出发')
          .replace(/退房(?:，|,)?(?=前往|出发)/g, '整理随身物品，')
          .replace(/[，,、]{2,}/g, '，')
          .trim();
      });
      let leftBase = false;
      ordered.forEach((it) => {
        if (leftBase && isRepeatHotelDrop(it)) normalizeRepeatHotelDrop(it);
        const movedOut = (it.category === 'transport' || it.category === 'sight' || it.category === 'other')
          && sameTravelArea(it.startLocation, lastNight)
          && (it.endLocation && !sameTravelArea(it.endLocation, lastNight));
        if (movedOut || /轻装出发|前往景区|游览景区|外出游玩/.test(textOf(it))) leftBase = true;
      });
    }

    // 若上午已经离开昨晚住宿地、且没有满足“下午仍在原片区游玩再离开”
    // 的条件，回旧酒店取行李就是错误折返。模型有时会把提示词里的
    // 临时寄存例外泛化到普通换城日，确定性删除这类回头交通。
    if (changedBase) {
      ordered.forEach((it) => {
        if (it.category !== 'transport' || drop.has(it)) return;
        const endText = String(it.endLocation || '').trim();
        const startText = String(it.startLocation || '').trim();
        const endsAtOldLodging = (
          /酒店|民宿|客栈|宾馆|青旅|房间|前台/.test(endText)
          && (sameTravelArea(endText, lastNight)
            || /昨晚住宿|昨晚酒店|上一晚|原酒店|旧酒店/.test(textOf(it)))
        ) || (samePlace(endText, lastNight)
          && !/站|机场|码头|景区|游客中心/.test(endText));
        const reverseToOldBase = endsAtOldLodging
          && !sameTravelArea(startText, lastNight)
          && [safeHotelOf(today), tonight, today.city]
            .filter(Boolean)
            .some((place) => sameTravelArea(startText, place));
        if (!reverseToOldBase || /取回|取件|拿回|领回|行李/.test(textOf(it))) return;
        drop.add(it);
        console.warn('[generatePlan] 第%d天删除无临时寄存依据的旧酒店折返：%s→%s',
          di + 1, String(it.startLocation || '').slice(0, 28), String(it.endLocation || '').slice(0, 28));
      });
      const currentBase = safeHotelOf(today) || tonight;
      const previousLodging = safeHotelOf(prevDay)
        || String(prevDay && prevDay.hotel || '').trim()
        || lastNight;
      let reachedCurrentBase = false;
      ordered.forEach((it) => {
        if (drop.has(it)) return;
        if (reachedCurrentBase && !it.outlineMove && sameTravelArea(it.startLocation, previousLodging)
            && !/取回|取件|拿回|领回|行李/.test(textOf(it))) {
          const oldStart = String(it.startLocation || '').trim();
          if (currentBase) it.startLocation = currentBase;
          if (oldStart && String(it.activity || '').includes(oldStart)) {
            it.activity = String(it.activity).split(oldStart).join(currentBase);
          }
        }
        // 食物/景点的 endLocation 可能只是“用餐地点/游玩片区”，不能据此
        // 认定已经完成跨城抵达；只在住宿或交通真正落到今晚基地后开启
        // 后续地点纠偏，且大纲锁定的交通永远不改起点。
        if (['hotel', 'transport'].includes(String(it.category || ''))
            && sameTravelArea(it.endLocation, currentBase)) reachedCurrentBase = true;
      });
    }

    // ①② 换住处：行李必须随人走
    if (changedBase && !temporaryStorage) {
      // 返程/换城日偶尔会出现“从旧酒店退房，前往同一旧酒店”这种
      // 自环文本；人应从旧酒店携带行李直接进入下一段交通，不能重复回到
      // 已退房住宿地。保留原时间和起点，只清掉错误终点/文案。
      list.forEach((it) => {
        const end = String(it.endLocation || '').trim();
        const activity = String(it.activity || '');
        if (it.category !== 'transport'
            || !sameTravelArea(it.startLocation, lastNight)
            || !/退房|携带全部行李|携带大件行李/.test(activity)
            || (end && !sameTravelArea(end, lastNight))) return;
        it.activity = '退房，携带全部大件行李前往下一站';
        it.endLocation = '';
        it.transportType = '';
        appendNote(it, TIP_TAKE);
      });
      list.forEach((it) => {
        const raw = textOf(it);
        const explicitHotelStorage = (hasStorageActionInActivity(it)
          || (/寄存|暂存|存放|寄放|存包/.test(stripNegation(String(it.note || '')))
            && !isGeneratedTempStoreNote(it.note)))
          && /酒店|民宿|客栈|宾馆|前台|房间/.test(raw);
        const looksLikeOldHotelStore = isStore(it) && hasHotelStorageWord(it)
          && (/昨晚住宿|昨晚酒店|上一晚|原酒店|旧酒店|退房[^。；;]*寄存|寄存[^。；;]*酒店前台/.test(raw)
            || sameTravelArea(it.startLocation, lastNight));
        if (!storageAt(it, lastNight, isImplicitOldHotelStore(it))
            && !looksLikeOldHotelStore && !explicitHotelStorage) return;
        // 景区/车站/机场的临时寄存是合理操作，别误伤
        // 只看同一分句内“存放动作 + 寄存地点”。不能因为这条记录的
        // 起点/终点字段里有“车站”，就把“寄存在旧酒店、随后去车站”
        // 误判成车站寄存而跳过跨城行李校正。
        const transitStorage = [String(it.activity || ''), String(it.note || '')]
          .flatMap((value) => value.split(/[；;。]/))
          .some((clause) => {
            const clean = stripNegation(clause);
            // 必须让“寄存动作”和“景区/交通枢纽”在同一小段文字内相邻，
            // 不能把“暂存酒店前台，随后前往汽车站”误识别成车站寄存。
            return new RegExp('(?:寄存|暂存|存放|寄放|存包)[^，,。；;]{0,16}(?:景区|景点|游客中心|寄存柜|车站|机场|码头)').test(clean)
              || new RegExp('(?:景区|景点|游客中心|寄存柜|车站|机场|码头)[^，,。；;]{0,16}(?:寄存|暂存|存放|寄放|存包)').test(clean);
          });
        if (transitStorage) return;
        invalidStores.add(it);
        it.note = clearGeneratedTempStorageText(it.note);
        rewriteHotelStorageAsCarry(it);
        const position = ordered.indexOf(it);
        const next = position >= 0 ? ordered[position + 1] : null;
        // 这类“先把行李寄在旧酒店、再去新城市”的模型条目，常把下一条
        // 早餐/车站活动的起点也串成今晚酒店。旧行李条目已改为从旧酒店
        // 携带出发后，下一条仍未抵达新基地时必须沿用旧酒店位置。
        if (next && sameTravelArea(next.startLocation, tonight)
            && !sameTravelArea(next.endLocation, tonight)) {
          const oldStart = String(next.startLocation || '').trim();
          next.startLocation = String(lastNight || it.startLocation || '').trim();
          if (oldStart && String(next.activity || '').includes(oldStart)) {
            next.activity = String(next.activity).split(oldStart).join(next.startLocation);
          }
        }
        appendNote(it, TIP_TAKE);
      });
      if (!list.some(hasLuggage)) {
        const first = ordered.find((it) => !(it.category === 'hotel'
          && sameTravelArea(it.endLocation, tonight)
          && /抵达|入住|办理入住|放下行李/.test(textOf(it)))) || ordered[0];
        // 如果当天只有“抵达新酒店办理入住”这一条，不能把“今晚不回这家
        // 酒店，退房带走”贴到入住动作上；真正的退房/携行李条目会在有内容
        // 的细化结果里命中上面的 hasLuggage 分支。
        if (!(first && first.category === 'hotel'
          && sameTravelArea(first.endLocation, tonight)
          && /抵达|入住|办理入住|放下行李/.test(textOf(first)))) {
          appendNote(first, TIP_TAKE);
        }
      }
    }

    // 前面的错误寄存条目被改写后，原文里常还残留“离开前取回”提示；
    // 既然这天没有任何真实存放动作，就把取回提示一并改成携带大件行李。
    const hasOldLodgingStore = ordered.some((it) => storageAt(it, lastNight, isImplicitOldHotelStore(it)));
    if (changedBase && !temporaryStorage && !hasOldLodgingStore) {
      const rewritePickupWithoutStore = (value) => String(value || '')
        .replace(/(?:游玩结束后|离开前|随后)?(?:返回|回到|前往)[^。；;，,]{0,60}(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,40}(?:行李|物品|背包|箱子)(?:[（(][^）)]*(?:如有|若未|没有)[^）)]*[）)])?/g, '')
        .replace(/(?:取回|取出|取件|拿回|领回)(?:寄存|暂存|存放|寄放)?的?(?:全部|大件|随身)?(?:行李|物品|背包|箱子)(?:[（(][^）)]*(?:如有|若未|没有)[^）)]*[）)])?/g, '')
        .replace(/(?:离开前(?:先)?返回[^。；;，,]{0,80}?)?(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,50}(?:寄存|暂存|存放|寄放|存包)?的?(?:全部|大件)?行李/g, '携带全部大件行李')
        .replace(/离开前记得取回寄存的行李/g, '携带全部大件行李')
        .replace(/在([^，。；]{1,30})，(?=乘|前往)/g, '在$1')
        .replace(/再按后续行程/g, '按后续行程')
        .replace(/([；;])\s*[，,]/g, '$1')
        .replace(/[；;]\s*[；;]/g, '；')
        .replace(/^[；;]|[；;]$/g, '')
        .trim();
      const mentionsOldLodging = (value) => {
        const text = String(value || '');
        return /昨晚|上一晚|原酒店|旧酒店|返回[^。；;，,]{0,40}(?:酒店|民宿|客栈|宾馆|住宿|成都市|阳朔|桂林|重庆)/.test(text);
      };
      ordered.forEach((it) => {
        const raw = textOf(it);
        const structuredOld = isOldLodgingLocation(it.startLocation)
          || isOldLodgingLocation(it.endLocation);
        const falsePickup = /取回|取件|拿回|领回/.test(raw)
          && ((raw.includes(lastNight) && !structuredOld)
            || (!hasAnyCurrentStorage && !previousStoredAtBase));
        if ((isPickup(it) || /取回|取件|拿回|领回/.test(raw))
            && !hasCurrentLodgingStorage
            && (mentionsOldLodging(raw) || falsePickup)) {
          it.activity = rewritePickupWithoutStore(it.activity);
          it.note = rewritePickupWithoutStore(it.note);
        }
      });
    }

    // 返程日不会再回到当天的寄存点。模型有时把“景区游客中心/车站寄存
    // 大件行李”当成轻装游玩，但后面直接去了另一座车站或回家，实际上没有
    // 取件路径；这和旧酒店寄存一样不可执行。最后一天统一改为随身携带，
    // 同时清掉“轻装/取回寄存”措辞，避免用户以为还要折返。
    const isReturnDay = di === days.length - 1 || /返程|回家|家中/.test(tonight);
    const canRetrieveOnReturnDay = (store) => {
      const index = ordered.indexOf(store);
      if (index < 0) return false;
      const later = ordered.slice(index + 1);
      // 模型明确写了“取回/领回”时，说明人会回到寄存点；保留寄存，
      // 下面的统一提醒会避免重复追加。
      if (later.some(isPickup)) return true;
      // 酒店/民宿寄存必须有明确取回或回到旧住宿地的交通，不能只因为
      // 后面还有一条“从阳朔出发”就假设已经回酒店拿过行李。
      const lodgingStore = store.category === 'hotel' || hasHotelStorageWord(store);
      if (lodgingStore) return later.some((it) =>
        it.category === 'transport'
        && (sameTravelArea(it.startLocation, lastNight)
          || /返回|回到|取回|取件|拿回|领回/.test(textOf(it)))
        && !sameTravelArea(it.endLocation, lastNight));
      // 景区/车站/游客中心寄存，只要后续交通从同一类枢纽/景区离开，
      // 就视为先回到该点取件；这是“景区→下一站”的常见简写。
      const transitStore = /游客中心|景区|景点|车站|机场|码头|寄存柜/.test(storageText(store));
      return transitStore && later.some((it) => it.category === 'transport'
        && /游客中心|景区|景点|车站|机场|码头|站/.test(`${it.startLocation || ''} ${it.endLocation || ''}`));
    };
    if (isReturnDay) {
      const rewriteReturnDayStorage = (it) => {
        const rewrite = (value) => String(value || '')
          .replace(/[^。；;，,]{0,30}(?:使用|在)?(?:行李)?储物柜[^。；;，,]*/g, '随身携带必要物品')
          .replace(/(?:将|把)?(?:全部|大件|随身)?(?:行李|背包)s*(?:寄存|暂存|存放|寄放|存包)(?:在|于)?[^，,。；;]{0,24}/g, '随身携带必要物品')
          .replace(/(?:寄存|暂存|存放|寄放|存包)(?:在|于)?[^，,。；;]{0,24}(?:全部|大件|随身)?(?:行李|背包)/g, '随身携带必要物品')
          .replace(/(?:将|把)?(?:全部|大件)?行李\s*(?:寄存|暂存|存放|寄放|存包)(?:在|于)?[^，,。；;]{0,24}/g, '携带全部大件行李')
          .replace(/(?:寄存|暂存|存放|寄放|存包)(?:在|于)?[^，,。；;]{0,24}(?:全部|大件)?行李/g, '携带全部大件行李')
          .replace(/(?:取回|取出|取件|拿回|领回)[^，,。；;]{0,60}(?:寄存|暂存|存放|寄放|存包)?的?(?:全部|大件)?行李/g, '携带全部大件行李')
          .replace(/寄存|暂存|存放|寄放|存包/g, '随身携带')
          .replace(/(?:务必|建议)?使用(?:行李)?储物柜或人工随身携带/g, '随身携带')
          .replace(/(?:使用|放入)?(?:行李)?储物柜[^，,。；;]*/g, '')
          .replace(/轻装(?=前往|进入|准备|游玩|出发)/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/(?:离开前|返回后|随后)\s*(?:记得|务必)?\s*$/g, '')
          .replace(/^[；;]|[；;]$/g, '')
          .trim();
        it.activity = rewrite(it.activity);
        it.note = rewrite(it.note);
      };
      // 返程日即使模型写的是“寄存随身背包/使用储物柜”，也不保留这类
      // 描述：用户不会再返回当天的寄存点，返程日只携带必要物品继续离开。
      ordered.filter((it) => /寄存|暂存|存放|寄放|存包|储物柜/.test(textOf(it)))
        .forEach((it) => {
          invalidStores.add(it);
          rewriteReturnDayStorage(it);
          appendNote(it, '返程日不安排寄存，必要物品随身携带');
        });
      ordered.filter(isStore).filter((it) => !canRetrieveOnReturnDay(it)).forEach((it) => {
        invalidStores.add(it);
        rewriteReturnDayStorage(it);
        appendNote(it, TIP_TAKE);
      });
      // 存放条目已经改掉后，原先单独生成的“回来取行李”也失去依据；
      // 保留交通/游玩本身，但改成直接携带全部大件行李继续返程。
      if (!ordered.some(isStore)) {
        const validGeneratedPlan = ordered.some((it) => isGeneratedTempPlan(it && it.note)
          && ordered.some((next) => next !== it
            && next.category === 'transport'
            && sameTravelArea(next.startLocation, lastNight)
            && next.endLocation
            && !sameTravelArea(next.endLocation, lastNight)));
        if (!validGeneratedPlan) {
          ordered.filter((it) => isGeneratedTempPlan(it && it.note)).forEach((it) => {
            it.note = clearGeneratedTempStorageText(it.note);
            appendNote(it, TIP_TAKE);
          });
        }
        ordered.filter((it) => isPickup(it) && !validGeneratedPlan).forEach((it) => {
          invalidStores.add(it);
          if (it.category === 'transport' && it.startLocation && it.endLocation) {
            it.activity = `从${it.startLocation}前往${it.endLocation}，携带全部大件行李`;
          } else {
            it.activity = String(it.activity || '')
              .replace(/(?:返回|回到|前往)[^。；;，,]{0,60}(?:取|拿|领)(?:回|出|件)?(?:寄存|暂存|存放|寄放)?的?(?:全部|大件)?行李/g, '携带全部大件行李')
              .replace(/(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,60}(?:行李|箱子|大件)/g, '携带全部大件行李');
          }
          it.note = String(it.note || '')
            .replace(/离开前(?:先)?返回[^；。]*?(?:取回|取出|取件|拿回|领回)[^；。]*?/g, '')
            .replace(/(?:取回|取出|取件|拿回|领回)[^；。]*?(?:行李|箱子|大件)/g, '')
            .replace(/(?:寄存|暂存|存放|寄放)的行李/g, '')
            .replace(/(?:离开前|返回后|随后)\s*(?:记得|务必)?\s*$/g, '')
            .replace(/[；;]\s*[；;]/g, '；')
            .replace(/^[；;]|[；;]$/g, '')
            .trim();
        });
      }
    }

    // 最后一轮文案收口：模型常把“寄存在前台/带走”拼成不通顺的
    // “携带于前台”“携带在，只带小包”，只修文字，不改变已经确认的
    // 存放事实和交通地点。
    const cleanLuggageWording = (value) => {
      let text = String(value || '')
        .replace(/(?:大件)?行李携带(?:至|到|于)?(?:酒店)?前台/g, '将大件行李寄存在前台')
      .replace(/(?:将|把)大件行李随身携带在[，,]?只带随身小包/g, '游玩时只带随身小包')
      .replace(/携带于酒店前台/g, '随身携带出发')
      .replace(/(?:与|和)携带全部大件行李汇合(?:[（(][^）)]*[）)])?/g, '检查行李')
      .replace(/携带全部大件行李汇合(?:[（(][^）)]*[）)])?/g, '检查行李')
      .replace(/(全部大件行李)行李/g, '$1')
      .replace(/[，,]\s*(?=；|$)/g, '')
      .replace(/[，,]\s*(?=；|$)/g, '')
      .replace(/[；;]\s*[；;]/g, '；')
      .trim();
      // 换住处且没有合法临时寄存时，“携带全部大件行李”与“仅带小包”
      // 不能同时出现。保留前者，避免用户误以为大件行李还留在旧酒店。
      if (changedBase && !temporaryStorage
          && /(?:(?:携带|带走)(?:全部|大件)?行李|(?:全部|大件)?行李[^。；;，,]{0,12}(?:携带|带走))/.test(text)
          && /(?:仅携带|只带)(?:轻便)?(?:随身)?(?:物品|小包)/.test(text)) {
        text = text
          .replace(/[，,；;]\s*(?:仅携带|只带)(?:轻便)?(?:随身)?(?:物品|小包)[^。；;，,]*(?:出发)?/g, '')
          .replace(/(?:仅携带|只带)(?:轻便)?(?:随身)?(?:物品|小包)[^。；;，,]*(?:出发)?/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/[，,]\s*(?=；|$)/g, '')
          .trim();
      }
      return text;
    };
    ordered.forEach((it) => {
      it.activity = cleanLuggageWording(it.activity);
      it.note = cleanLuggageWording(it.note);
    });

    // 换城日的早餐/退房条目有时会把“携带行李前往下一站”错误填成
    // “携带行李前往同一间昨晚酒店”。这是住宿自环，不应让用户理解成
    // 退房后还要回房间；保留早餐和退房事实，去掉虚假的同地点前往。
    if (changedBase) {
      ordered.forEach((it) => {
        const start = String(it.startLocation || '').trim();
        const end = String(it.endLocation || '').trim();
        const activity = String(it.activity || '').trim();
        if (!start || !end || !samePlace(start, end)
            || !/退房|整理行李|携带(?:全部|大件)?行李/.test(activity)
            || !/前往|出发/.test(activity)) return;
        const destinationIndex = activity.search(/前往|出发/);
        const rawPrefix = destinationIndex >= 0 ? activity.slice(0, destinationIndex) : '';
        const checkoutIndex = rawPrefix.search(/退房|整理行李|携带(?:全部|大件)?行李/);
        const prefix = destinationIndex >= 0
          ? (checkoutIndex >= 0 ? rawPrefix.slice(0, checkoutIndex) : rawPrefix)
              .replace(/[。；;，,\s]+$/, '')
          : '';
        it.activity = `${prefix}${prefix ? '。' : ''}退房并整理行李，携带全部大件行李出发`;
        it.endLocation = start;
        it.endLon = '';
        it.endLat = '';
      });
    }

    // ③ 寄存了就得有人喊你取回
    const storeIdx = list.findIndex(isStore);
    if (storeIdx < 0) return;
    const store = list[storeIdx];
    const storePlace = String(store.endLocation || store.startLocation || '');
    // 抵达新住宿地后把行李放进新房间是正确动作，不是“旧酒店寄存”。
    // 只有当天后面还要离开且没有回房间，才需要在离开前提示取出。
    if (changedBase && storePlace && sameTravelArea(storePlace, tonight)
        && !sameTravelArea(storePlace, lastNight)) {
      const laterDeparture = ordered.slice(ordered.indexOf(store) + 1)
        .some((it) => it.category === 'transport' && it.startLocation
          && sameTravelArea(it.startLocation, tonight)
          && it.endLocation && !sameTravelArea(it.endLocation, tonight));
      if (!laterDeparture) return;
    }
    // 上面刚判过这条是错的寄存（换住处还留在酒店）→ 已经改成"带走"了，别再喊他回来取
    if (String(list[storeIdx].note || '').includes('退房请带走全部行李')) return;
    // 行李就寄在本家酒店（今晚还回这家）：回来自然拿到，别多嘴喊"取回"
    // （实测：'大件行李留在酒店房间或寄存前台'被追加了'记得取回'——今晚回同一家，取什么？）
    if (!changedBase && /酒店|民宿|客栈|宾馆|青旅|房间|前台/.test(textOf(list[storeIdx]))) return;
    let reminded = false;
    for (let i = storeIdx; i < list.length; i++) {
      if (isPickup(list[i])) { reminded = true; break; }
    }
    if (reminded) return;
    const storeIsLodging = /酒店|民宿|客栈|宾馆|青旅|房间|前台/.test(textOf(store))
      || store.category === 'hotel';
    // 找寄存之后第一条“真正离开寄存片区”的交通：酒店寄存通常下一段
    // 就要取走；景区/游客中心寄存则跳过景区内部摆渡，提醒放到离开景区
    // 前往车站/下一站的交通上，避免用户刚存完就被提示取回。
    let target = null;
    for (let i = storeIdx + 1; i < list.length; i++) {
      const it = list[i];
      if (it.category !== 'transport') continue;
      const end = String(it.endLocation || '').trim();
      const leavesToHub = (/(?:站|机场|码头|车站|客运)/.test(end)
        && !/索道|上站|下站/.test(end))
        || /(?:离开|前往|返回)[^。；;]*(?:车站|机场|码头|客运站|下一站)/.test(textOf(it));
      if (storeIsLodging || leavesToHub) { target = it; break; }
    }
    if (!target) target = list[list.length - 1];
    if (target === list[storeIdx]) return;   // 全天就这一条，别自言自语
    appendNote(target, TIP_PICKUP);

    // 上面的寄存查漏可能刚刚追加了“取回”提醒；如果最终确认并没有
    // 真实存放事实（例如模型只写了“之前寄存/如需”），再收一次尾，
    // 防止留下孤零零的“离开前记得取回”。
    if (!hasStorageFact && !temporaryStorage) {
      list.forEach((it) => {
        it.activity = clearFalseStorageClaims(it.activity);
        it.note = clearFalseStorageClaims(it.note);
      });
    }
  });

  // 最后做一次“跨条目”行李状态审计。模型常把“寄存在旧酒店”放在一条
  // 早餐/退房记录里，又在下一条单独写“携带全部大件行李前往下一站”；两句
  // 分开时，逐条清洗无法判断它们互相矛盾。若中间没有“取回/领回”事实，
  // 以实际出发状态为准：把旧寄存改成随身携带，并删除重复的退房提示。
  byDay.forEach((list, di) => {
    const today = days[di] || {};
    const previous = di > 0 ? days[di - 1] || {} : null;
    const tonight = String(today.overnight || today.city || '').trim();
    const lastNight = previous ? String(previous.overnight || previous.city || '').trim() : '';
    if (!previous || !lastNight || samePlace(lastNight, tonight)) return;
    const ordered = list.slice().sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    const positiveStorage = (item) => {
      const text = `${item && item.activity || ''} ${item && item.note || ''}`
        .replace(/(?:不|无|无需|不用|禁止|避免|严禁|不能|不可|不得)(?:[^；。]{0,3})?(?:寄存|暂存|存放|存包|寄放)/g, '');
      return /行李|箱子|大件/.test(text)
        && /寄存|暂存|存放|存包|寄放|留房|留存|留在(?:酒店|民宿|客栈|房间|前台)|放在(?:酒店|民宿|客栈|房间|前台)/.test(text)
        && !/(?:之前|先前|此前|如需|如有|若未|若有|如果|可能)[^；。]{0,24}(?:寄存|暂存|存放|存包|寄放)/.test(text)
        && !/(?:取回|取件|拿回|领回)[^；。]{0,36}(?:寄存|暂存|存放|存包|寄放)/.test(text);
    };
    const pickup = (item) => /(?:取回|取件|拿回|领回|取出)[^；。]{0,70}(?:行李|箱子|大件)|(?:返回|回到)[^；。]{0,50}(?:酒店|民宿|客栈|前台)/.test(
      `${item && item.activity || ''} ${item && item.note || ''}`,
    );
    const carryOnlyCheckout = (item) => item && item.category !== 'transport'
      && /退房|整理行李|收拾行李|携带(?:全部|大件)?行李/.test(String(item.activity || ''))
      && !/早餐|午餐|晚餐|游览|拍照|景区|乘车|前往下一站/.test(String(item.activity || ''));
    ordered.filter(positiveStorage).forEach((store) => {
      const storeIndex = ordered.indexOf(store);
      const pickupIndex = ordered.findIndex((item, index) => index > storeIndex && pickup(item));
      const carryRows = ordered.filter((item, index) => index > storeIndex
        && (pickupIndex < 0 || index < pickupIndex)
        && /(?:携带|带走)(?:全部|大件)?行李|(?:全部|大件)?行李[^；。]{0,12}(?:携带|带走)/.test(
          `${item && item.activity || ''} ${item && item.note || ''}`,
        ));
      if (!carryRows.length || pickupIndex >= 0) return;
      const oldActivity = String(store.activity || '').trim();
      store.activity = /退房/.test(oldActivity)
        ? '退房并整理行李，携带全部大件行李前往下一站'
        : oldActivity.replace(/(?:寄存|暂存|存放|寄放|存包)/g, '携带');
      store.note = String(store.note || '')
        .replace(/寄存|暂存|存放|寄放|存包/g, '随身携带')
        .replace(/酒店前台|酒店房间|房间|前台/g, '')
        .replace(/[；;]\s*[；;]/g, '；')
        .replace(/^[；;]|[；;]$/g, '')
        .trim();
      carryRows.filter(carryOnlyCheckout).forEach((item) => drop.add(item));
      console.warn('[generatePlan] 第%d天清理互相矛盾的行李状态：寄存后未取回又写携带', di + 1);
    });
  });

  // 最后一次行李叙事收口。LLM 常把“寄存/取回”拆进不同条目的备注，
  // 或把连住酒店写成“回房取回大件行李”。这里按当天是否真的回到旧住宿地
  // 建立一个小状态机：有真实回收路径才保留临时寄存，否则统一改为随身携带；
  // 连住日只保留“轻装出门/回房休息”，不重复生成放下或取回大件行李。
  byDay.forEach((list, di) => {
    const today = days[di] || {};
    const previous = di > 0 ? days[di - 1] || {} : null;
    const tonight = String(today.overnight || today.city || '').trim();
    const lastNight = previous ? String(previous.overnight || previous.city || '').trim() : '';
    if (!list.length || !previous || !lastNight) return;
    const sameStay = samePlace(lastNight, tonight);
    const ordered = list.filter((it) => !drop.has(it)).sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    const textOfFinal = (it) => `${it && it.activity || ''} ${it && it.note || ''}`;
    const stripNegativeFinal = (value) => String(value || '')
      .replace(/(?:不|无|无需|不用|禁止|避免|严禁|不能|不可|不得)(?:[^；。]{0,3})?(?:寄存|暂存|存放|存包|寄放)/g, '');
    const hasPickupFinal = (it) => /(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,80}(?:行李|箱子|大件|物品|背包)|(?:返回|回到)[^。；;，,]{0,60}(?:取回|取件|拿回|领回)/.test(textOfFinal(it));
    const hasStorageFinal = (it) => {
      const text = stripNegativeFinal(textOfFinal(it));
      if (!/行李|箱子|大件|背包/.test(text)) return false;
      if (/(?:寄存|暂存|存放|存包|寄放|留房|留存|留在|放在)/.test(text)) return true;
      if (/(?:取回|取出|取件|拿回|领回)[^。；;，,]{0,50}(?:寄存|暂存|存放|存包|寄放)/.test(text)
          && !/(?:寄存|暂存|存放|存包|寄放)[^。；;，,]{0,50}(?:取回|取出|取件|拿回|领回)/.test(text)) return false;
      return /寄存|暂存|存放|存包|寄放|留房|留存|留在(?:酒店|民宿|客栈|房间|前台)|放在(?:酒店|民宿|客栈|房间|前台)/.test(text);
    };
    const generatedTempStorageFinal = (it) => /早上离开[^。]*?前将(?:全部)?(?:大件)?行李[^。]*?(?:寄存|暂存|存放|寄放|存包)[^。]*?(?:轻装游玩|轻装出发)[^。]*?(?:返回|取回)/.test(textOfFinal(it));
    const isOldLodgingFinal = (value) => {
      const text = String(value || '').trim();
      if (!text) return false;
      // samePlace("大新汽车站", "大新县") 为真，但车站不是可回收行李的
      // 住宿地。只有名称本身明确是住宿 POI 时，才允许通过同片区匹配。
      const isLodging = /酒店|民宿|客栈|宾馆|青旅|住宿|房间|前台/.test(text);
      if (/车站|客运|汽车|机场|码头|景区|游客中心|停车场/.test(text) && !isLodging) return false;
      if (samePlace(text, lastNight)) return true;
      return sameTravelArea(text, lastNight)
        && isLodging
        && !/车站|客运|汽车|机场|码头|景区|游客中心|停车场/.test(text);
    };
    const mentionsOldStorageFinal = (it) => {
      const text = textOfFinal(it);
      const oldLocation = isOldLodgingFinal(it && it.startLocation)
        || isOldLodgingFinal(it && it.endLocation);
      const oldName = !!lastNight && text.includes(lastNight);
      const oldWords = /昨晚住宿|昨晚酒店|原酒店|旧酒店|留房|留在酒店|留存在酒店|酒店前台|酒店房间/.test(text);
      const noLocationDeparture = !String(it && it.startLocation || '').trim()
        && !String(it && it.endLocation || '').trim()
        && /行李|箱子|大件|背包/.test(text)
        && /退房|整理行李|寄存|留房|前往|出发|取回|取件/.test(text);
      return oldLocation || oldName || oldWords || noLocationDeparture;
    };
    const cleanupPunctuationFinal = (value) => String(value || '')
      .replace(/[；;]\s*[；;]/g, '；')
      .replace(/[，,]\s*(?=；|。|$)/g, '')
      .replace(/^[；;，,。\s]+|[；;，,。\s]+$/g, '')
      .trim();
    const normalizeNoStorageFinal = (value, preferCarry) => {
      const carry = '携带全部大件行李';
      const replacement = preferCarry ? carry : '';
      let text = String(value || '');
      text = text
        .replace(/早上离开[^；。]*?前将(?:全部|大件)?行李[^；。]*?(?:寄存|暂存|存放|寄放|存包)[^；。]*?(?:轻装游玩|轻装出发)[^；。]*?(?:返回|取回)[^；。]*/g, replacement)
        .replace(/(?:将|把)?(?:全部)?(?:大件)?行李[^；。]*(?:寄存|暂存|存放|寄放|存包)[^；。]*/g, replacement)
        .replace(/(?:将|把)?(?:全部)?(?:大件)?行李(?:箱)?(?:留存|留在|留置|放置|放在)(?:于|在)?[^；。;，,]{0,24}(?:酒店|民宿|客栈|前台|房间)[^；。]*(?:返回|取回|取件|拿回|领回)[^；。]*/g, replacement)
        .replace(/(?:将|把)?(?:全部)?(?:大件)?行李(?:箱)?(?:留存|留在|留置|放置|放在)(?:于|在)?[^；。;，,]{0,24}(?:酒店|民宿|客栈|前台|房间)[^；。]*/g, replacement)
        .replace(/(?:将|把)?(?:大件|全部)?行李(?:箱)?携带(?:在|于)(?:酒店|民宿)?前台[^；。;，,]*/g, carry)
        .replace(/(?:稍后|随后|下午|之后)?(?:需|要)?返回取件[^；。;，,]*/g, replacement)
        .replace(/(?:游玩结束后|离开前|随后)?返回(?:旧住宿地|昨晚住宿地|原酒店|旧酒店)[^；。]*/g, replacement)
        .replace(/(?:离开前|出发前)?(?:先)?返回[^；。;，,]{0,60}(?:携带|带走)(?:全部)?(?:大件)?行李[^；。;，,]*/g, replacement)
        .replace(/(?:返回|回到|前往)[^；。;，,]{0,50}(?:取回|取件|拿回|领回)(?:[^；。;，,]{0,50})?(?:行李|箱子|大件|物品|背包)?/g, replacement)
        .replace(/(?:取回|取出|取件|拿回|领回)[^。；;，,\n]{0,48}(?:全部|大件|随身)?(?:行李|箱子|物品|背包)/g, replacement)
        .replace(/(?:取回|取出|取件|拿回|领回)(?:携带|寄存|暂存|存放|寄放)?的?(?:全部)?(?:大件)?(?:行李|箱子|物品|背包)[^；。;，,]*/g, replacement)
        .replace(/(?:取回|取出|取件|拿回|领回)携带(?:全部)?(?:大件)?行李[^；。;，,]*/g, replacement)
        .replace(/(?:轻装游玩|轻装出发|仅携带轻便随身物品|仅携带轻便背包和贵重物品|只带轻便背包和贵重物品)/g, '')
        .replace(/携带全部大件行李(?:出发)?[，,；;\s]*携带全部大件行李(?:出发)?/g, '携带全部大件行李出发');
      return cleanupPunctuationFinal(text);
    };

    if (sameStay) {
      ordered.forEach((it) => {
        const activity = String(it.activity || '');
        const raw = textOfFinal(it);
        const repeatHotel = it.category === 'hotel'
          && /办理入住|入住|续住|放下(?:全部)?(?:大件)?行李/.test(activity)
          && !/退房/.test(activity);
        // 连住同一酒店时，模型还会写成“取回之前携带全部大件行李”或
        // “拿回先前的大件行李”。这不是景区/车站寄存柜的取件，而是把
        // 房间里本来没有离开的行李又写成了回酒店取件，必须和普通回房
        // 休息一样清掉；真正的游客中心、车站、码头寄存仍保留。
        const falseRepeatPickup = /(?:取回|取出|取件|拿回|领回)[^。；;，,\n]{0,80}(?:全部|大件|随身)?(?:行李|箱子|物品|背包)/.test(raw)
          && !/寄存柜|游客中心|车站|机场|码头/.test(raw);
        if (repeatHotel) {
          it.activity = `返回${tonight || lastNight}休息，整理随身物品`;
          it.note = normalizeNoStorageFinal(it.note, false)
            .replace(/(?:当晚住宿|住宿时间)[^；。]*[；。]?/g, '')
            .replace(/结束今日行程[；。]?/g, '')
            .trim();
        } else if (falseRepeatPickup) {
          it.activity = normalizeNoStorageFinal(it.activity, false);
          it.note = normalizeNoStorageFinal(it.note, false);
        }
      });
      return;
    }

    const storageRows = ordered.filter((it) => hasStorageFinal(it) && mentionsOldStorageFinal(it));
    const isOldBaseWithoutHubFinal = (value) => isOldLodgingFinal(value)
      || (sameTravelArea(value, lastNight)
        && !/车站|客运|汽车|机场|码头|景区|游客中心|停车场/.test(String(value || '')));
    const validStorageRows = storageRows.filter((store) => {
      const index = ordered.indexOf(store);
      return ordered.slice(index + 1).some((later) => {
        const structuredReturn = ['transport', 'other', 'sight', 'hotel'].includes(String(later.category || ''))
          && isOldLodgingFinal(later.endLocation)
          && !isOldLodgingFinal(later.startLocation);
        const textOnlyReturn = hasPickupFinal(later)
          && !String(later.endLocation || '').trim()
          && /返回|回到/.test(textOfFinal(later))
          && /酒店|民宿|客栈|住宿地|旧住宿/.test(textOfFinal(later));
        const generatedPlanReturn = generatedTempStorageFinal(store)
          && later.category === 'transport'
          && isOldBaseWithoutHubFinal(later.startLocation)
          && later.endLocation
          && !sameTravelArea(later.endLocation, lastNight);
        const returnAfterSameRowStore = !isOldLodgingFinal(store.startLocation)
          && isOldLodgingFinal(store.endLocation)
          && later.category === 'transport'
          && isOldBaseWithoutHubFinal(later.startLocation)
          && later.endLocation
          && !sameTravelArea(later.endLocation, lastNight);
        return structuredReturn || textOnlyReturn || generatedPlanReturn || returnAfterSameRowStore;
      });
    });
    const hasValidTemporaryStorage = validStorageRows.length > 0;
    if (hasValidTemporaryStorage) {
      const firstStoreIndex = ordered.indexOf(validStorageRows[0]);
      // 若模型先写“退房携带全部行李”，随后才写酒店寄存，则两句矛盾；
      // 仅在寄存发生于出发之后时改成“退房寄存、轻装游玩”。
      const departureBeforeStore = ordered.find((it, index) => index < firstStoreIndex
        && /退房|整理行李|携带(?:全部)?(?:大件)?行李/.test(String(it.activity || ''))
        && !/寄存|暂存|存放|寄放|存包|留房/.test(textOfFinal(it)));
      if (departureBeforeStore) {
        departureBeforeStore.activity = String(departureBeforeStore.activity || '')
          .replace(/退房并整理行李，?携带全部大件行李(?:前往下一站)?/g,
            `办理退房，将大件行李临时寄存在${lastNight}酒店前台，随后轻装出发`)
          .replace(/携带全部大件行李(?:前往下一站)?/g,
            `将大件行李临时寄存在${lastNight}酒店前台，随后轻装出发`);
        departureBeforeStore.note = String(departureBeforeStore.note || '')
          .replace(/退房请带走全部行李（行李随人走）/g, '')
          .replace(/今晚不回这家酒店/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/^[；;]|[；;]$/g, '')
          .trim();
      }
      const returnAtStore = validStorageRows.find((store) => {
        const storeIndex = ordered.indexOf(store);
        return isOldLodgingFinal(store.endLocation)
          && ordered.slice(storeIndex + 1).some((later) => later.category === 'transport'
            && isOldBaseWithoutHubFinal(later.startLocation)
            && later.endLocation
            && !sameTravelArea(later.endLocation, lastNight));
      });
      if (returnAtStore) {
        const storeIndex = ordered.indexOf(returnAtStore);
        const nextDeparture = ordered.slice(storeIndex + 1).find((later) => later.category === 'transport'
          && isOldBaseWithoutHubFinal(later.startLocation)
          && later.endLocation
          && !sameTravelArea(later.endLocation, lastNight));
        const pickupPlace = String(returnAtStore.endLocation || lastNight).trim();
        returnAtStore.activity = `返回${pickupPlace}取回寄存的大件行李，随后前往${nextDeparture.endLocation || '下一站'}`;
        returnAtStore.note = `已返回${pickupPlace}取回寄存的大件行李；随后按后续行程出发`;
      }
      // 相同的“早上寄存、下午取回”提示只展示一次，避免每个景点条目都重复。
      validStorageRows.slice(1).forEach((store) => {
        store.note = String(store.note || '')
          .replace(/早上离开[^；。]*?前将(?:大件|全部)?行李[^；。]*?(?:寄存|暂存|存放|寄放|存包)[^；。]*?(?:轻装游玩|轻装出发)[^；。]*?(?:返回|取回)[^；。]*/g, '')
          .replace(/[；;]\s*[；;]/g, '；')
          .replace(/^[；;]|[；;]$/g, '')
          .trim();
      });
      return;
    }

    // 换城日没有真实“返回旧住宿地”的闭环：清掉旧酒店寄存、返回取件和
    // “只带小包但大件还在前台”等互相矛盾文案，出发条目明确写成随身携带。
    ordered.forEach((it) => {
      if (!mentionsOldStorageFinal(it)) return;
      const raw = textOfFinal(it);
      if (!hasStorageFinal(it) && !hasPickupFinal(it)
          && !/留房|留在酒店|留存在酒店|放在酒店|前台|仅携带轻便|只带轻便/.test(raw)) return;
      const departureLike = it.category === 'transport'
        || /退房|整理行李|收拾行李|携带|前往下一站|出发/.test(String(it.activity || ''));
      it.activity = normalizeNoStorageFinal(it.activity, departureLike);
      it.note = normalizeNoStorageFinal(it.note, false);
      if (departureLike && !/携带(?:全部)?(?:大件)?行李|行李随身携带/.test(String(it.activity || ''))
          && /行李|箱子|大件/.test(raw)) {
        it.activity = cleanupPunctuationFinal(`${it.activity || '整理行李'}，携带全部大件行李出发`);
      }
    });
  });

  const result = drop.size ? asArray(items).filter((it) => !drop.has(it)) : items;
  // 兜底清理上一轮清洗留下的孤立半句；只有后面没有“寄存/暂存/存放”
  // 事实时才删除，真实寄存提醒仍保留完整的取件信息。
  result.forEach((it) => {
    const hasStorageWord = /寄存|暂存|存放|寄放|存包/.test(`${it.activity || ''} ${it.note || ''}`);
    if (hasStorageWord) return;
    // 前面的状态审计可能已经把“取回寄存行李”改成“携带全部大件行李”，
    // 但留下了“返回旧片区”的壳。没有任何真实寄存事实时，连这个回头
    // 叙事也要删除；否则用户仍会误以为要先回酒店再去车站。
    const stripFalseReturnCarry = (value) => String(value || '')
      .replace(/(?:离开前|出发前)?(?:先)?返回[^；。;，,]{0,70}(?:携带|带走)(?:全部)?(?:大件)?行李[^；。;，,]*(?:[，,]?再)?/g, '')
      .replace(/[；;]\s*[；;]/g, '；')
      .replace(/^[；;]|[；;]$/g, '')
      .trim();
    it.activity = String(it.activity || '')
      .replace(/返回景区出口，与之前检查行李或直接前往大巴站/g, '返回景区出口，检查随身物品后前往大巴站')
      .trim();
    it.note = stripFalseReturnCarry(String(it.note || ''))
      .replace(/(?:^|[；;])\s*离开前(?:先)?(?:记得|务必)?\s*取回\s*$/g, '')
      .replace(/[；;]\s*[；;]/g, '；')
      .replace(/^[；;]|[；;]$/g, '')
      .trim();
  });
  return result;
}

// ============================================================
// 餐次纠偏 / 白天不回酒店 / 细化失败天骨架兜底
// ============================================================

/**
 * 餐次词纠偏：LLM 偶尔把"晚餐"排在早上 8 点（实测"早上就吃晚饭"）。
 * 按条目实际开始时间，把 activity 里写错的餐次词换成对的：
 *   <10:30 → 早餐；10:30~15:00 → 午餐；≥16:30 → 晚餐（中间时段不动，可能是下午茶）。
 * 只换餐次词本身，不动店名/菜品等其他内容。
 */
function fixMealLabels(items, outline) {
  asArray(items).forEach((it) => {
    if (!it || it.category !== 'food') return;
    const t = toMin(it.startTime);
    if (t == null) return;
    let wantFull = null;
    let wantShort = null;
    if (t < 10 * 60 + 30) { wantFull = '早餐'; wantShort = '早饭'; }
    else if (t < 15 * 60) { wantFull = '午餐'; wantShort = '午饭'; }
    else if (t >= 16 * 60 + 30) { wantFull = '晚餐'; wantShort = '晚饭'; }
    else return;
    let act = String(it.activity || '');
    if (!act) return;
    [['晚餐', wantFull], ['晚饭', wantShort], ['午餐', wantFull], ['午饭', wantShort], ['早餐', wantFull], ['早饭', wantShort]]
      .forEach(([from, to]) => {
        if (from !== to) act = act.split(from).join(to);
      });
    if (act !== String(it.activity || '')) {
      console.warn('[generatePlan] 「%s…」排在 %s，餐次词已纠偏',
        String(it.activity || '').slice(0, 16), it.startTime);
      it.activity = act;
    }
  });
  return items;
}

/** Remove unscheduled optional side trips from descriptions so they are not mistaken for itinerary stops. */
function removeOptionalRouteDetours(items) {
  const strip = (value) => String(value || '')
    .replace(/(?:也可选择|可以选择|可选择|若体力允许可|如体力允许可|若时间允许可|时间允许时可)(?:去|前往|游览|体验|登上|短途移动至|打卡)?[^。；;\n]*?(?:[。；;]|$)/g, '')
    .replace(/[，,；;\s]+$/g, '').trim();
  return asArray(items).map((item) => {
    if (!item) return item;
    if (['sight', 'other'].includes(String(item.category || ''))) item.activity = strip(item.activity);
    if (item.note) item.note = strip(item.note);
    return item;
  });
}

/** Audit declared visit durations without inventing destination-specific walking times. */
function enforceScenicRouteTiming(items) {
  return asArray(items).map((item) => {
    if (!item || item.category !== 'sight') return item;
    const duration = parseDurationMin(String(item.note || ''));
    const start = toMin(item.startTime), end = toMin(item.endTime);
    if (duration && start !== null && end !== null && end - start < duration) {
      const barrier = asArray(items).filter((row) => row !== item
        && Number(row.dayIndex || 0) === Number(item.dayIndex || 0)
        && (row.schedSource === '12306' || row.scheduleRequired)
        && toMin(row.startTime) >= start)
        .reduce((limit, row) => Math.min(limit, toMin(row.startTime)), 24 * 60);
      if (start + duration <= barrier && start + duration < 1440) item.endTime = fmtMin(start + duration);
      else item.note = [item.note, '游览时间不足，与后续交通冲突，需调整路线后确认。'].filter(Boolean).join('；');
    }
    return item;
  });
}

/**
 * 把大纲中的必玩点落实到至少一条真实游览/体验条目。
 *
 * 仅靠详细提示词仍可能出现“青城前山”代替“青城山”、或只写“游览龙王海”
 * 却没有在任何 sight 条目中出现“毕棚沟”。这里不新增虚构时段，优先把当天
 * 已有的景点条目补成“在 X 内游览 …”，保留原有线路和时长；只有当天完全没
 * 有景点条目时才不强行造一段游玩，避免用一条空泛活动掩盖时间不够。
 */
function ensureDetailHighlightCoverage(items, outline) {
  const rows = asArray(items);
  const days = asArray(outline && outline.days);
  days.forEach((day, dayIndex) => {
    const highlights = asArray(day && day.highlights).map((x) => String(x || '').trim()).filter(Boolean);
    if (!highlights.length) return;
    const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === dayIndex);
    const visitRows = dayRows.filter((item) => ['sight', 'other'].includes(String(item && item.category || ''))
      && !/候车|安检|检票|行李|办理入住|退房/.test(String(item.activity || '')));
    // note 里的“毕棚沟很适合拍照”只是说明，不代表用户真的到过毕棚沟。
    // 覆盖审计只认可执行的 activity 和结构化起终点，避免把景点名称藏在备注
    // 中就误判为已游览。
    const textOf = (item) => `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`;
    highlights.forEach((highlight) => {
      const stem = placeStem(highlight);
      const normalized = normalizeRoutePlace(highlight);
      const light = String(highlight).match(/^(.*?)(日出|日落)$/);
      if (light) {
        const lightName = light[1].trim();
        const lightWord = light[2];
        const lightTarget = visitRows.find((item) => {
          const location = `${item.startLocation || ''} ${item.endLocation || ''}`;
          const text = textOf(item);
          return (lightName && (text.includes(lightName) || sameTravelArea(location, lightName)))
            || (!lightName && text.includes(lightWord));
        });
        if (lightTarget) {
          const old = String(lightTarget.activity || '').trim() || `游览${lightName || '观景点'}`;
          if (!old.includes(lightWord)) lightTarget.activity = `${old}，观赏${lightWord}`.slice(0, 200);
          return;
        }
        // 模型偶尔只在大纲里保留“西山韶乐日出”，详细计划却从早餐直接跳到
        // 离开龙脊。若前一晚确实住在龙脊、当天首项和固定离开交通之间有空间，
        // 插入一条可执行的清晨观景项；其他景点的“相公山日出”等不在这里臆造。
        if (lightWord === '日出' && /西山韶乐/.test(lightName) && dayIndex > 0) {
          const previousDay = days[dayIndex - 1] || {};
          const previousStay = String(previousDay.overnight || previousDay.hotel || previousDay.city || '').trim();
          const previousText = `${previousDay.city || ''} ${previousDay.theme || ''} ${previousStay}`;
          const departureStart = asArray(day && day.moves)
            .filter((move) => move && toMin(move.startTime) !== null
              && /龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.from || ''))
              && !/龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.to || '')))
            .map((move) => toMin(move.startTime))
            .sort((a, b) => a - b)[0];
          const firstStart = dayRows.map((item) => toMin(item.startTime))
            .filter((value) => value !== null)
            .sort((a, b) => a - b)[0];
          const sunriseEnd = firstStart !== undefined
            ? firstStart - 10
            : departureStart !== undefined ? departureStart - 20 : 7 * 60;
          const sunriseStart = sunriseEnd - 60;
          const enough = /龙脊|金坑大寨|田头寨/.test(previousText)
            && (departureStart === undefined || departureStart >= 7 * 60)
            && sunriseStart >= 4 * 60 + 30
            && sunriseEnd > sunriseStart;
          if (enough && !rows.some((item) => /西山韶乐/.test(`${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`)
              && /日出/.test(String(item.activity || '')))) {
            rows.push({
              dayIndex,
              startTime: fmtMin(sunriseStart),
              endTime: fmtMin(sunriseEnd),
              activity: '前往西山韶乐观赏日出',
              category: 'sight',
              startLocation: previousStay || '龙脊住宿地',
              endLocation: '西山韶乐',
              transportType: 'walk',
              note: '按当天实际日出时间和景区开放/接驳时间微调',
            });
            console.warn('[generatePlan] 第%d天补齐西山韶乐日出：%s-%s', dayIndex + 1, fmtMin(sunriseStart), fmtMin(sunriseEnd));
          }
        }
        // 日出/日落是带有地点含义的特殊高亮，找不到对应游玩项时不要把它
        // 强行塞进另一个景点的 activity，避免出现“在相公山日出内游览兴坪古镇”。
        return;
      }
      const covered = dayRows.some((item) => {
        if (!['sight', 'other'].includes(String(item && item.category || ''))) return false;
        const text = textOf(item);
        const compact = normalizeRoutePlace(text);
        return (stem.length >= 2 && text.includes(stem))
          || (normalized.length >= 2 && compact.includes(normalized));
      });
      if (covered) {
        // “青城前山”是“青城山”的实际景区别名，但 mustVisit/审计可能使用
        // “青城山”。保留模型的前山路线，同时把标准目的地名落到执行文案，
        // 避免用户需求在联动页面只剩一个难以检索的别名。
        if (/青城前山/.test(highlight)) {
          const aliasTarget = dayRows.find((item) => ['sight', 'other'].includes(String(item && item.category || ''))
            && /青城前山/.test(textOf(item))
            && !textOf(item).includes('青城山'));
          if (aliasTarget) aliasTarget.activity = `${String(aliasTarget.activity || '').trim()}（青城山景区）`.slice(0, 200);
        }
        return;
      }

      // 细化模型偶尔把“到达景区后留出的游览时间”错误生成成一段长途
      // transport（例如已买票进山后又从景区车站开往另一个城市），导致
      // 用户点名的景区只剩 ticket、没有实际游览。只有同时满足“已有票/到达
      // 证据”“交通从该景区范围出发”“时长足够”“不是已核实铁路/飞机/船”
      // 才把这条坏交通回收为景区游览，不凭空把正常离园交通改成观光。
      // 这里不能用 sameTravelArea：明仕田园、德天瀑布都在崇左/大新
      // 大片区内，若把行政片区相同当成“已经游览”，会把德天的必玩项
      // 错判成明仕田园的交通，从而不再补景点窗口。
      const highlightLocation = (value) => {
        const actual = normalizeRoutePlace(value);
        return (normalized.length >= 2 && actual.includes(normalized))
          || (stem.length >= 2 && String(value || '').includes(stem));
      };
      const matchesDeclaredMove = (item) => asArray(day && day.moves).some((move) => move
        && move.from && move.to
        && (samePlace(move.from, item && item.startLocation)
          || sameTravelArea(move.from, item && item.startLocation))
        && (samePlace(move.to, item && item.endLocation)
          || sameTravelArea(move.to, item && item.endLocation)));
      const evidence = dayRows
        .filter((item) => ['ticket', 'transport', 'other'].includes(String(item && item.category || '')))
        .filter((item) => highlightLocation(item.startLocation) || highlightLocation(item.endLocation)
          || textOf(item).includes(stem))
        .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
      if (evidence) {
        const evidenceEnd = toMin(evidence.endTime);
        const recover = dayRows
          .filter((item) => item && item.category === 'transport'
            && item.startLocation && item.endLocation
            && !highlightLocation(item.endLocation)
            && highlightLocation(item.startLocation)
            // outlineMove 但不在当天大纲中时仍可能是模型拼出的异常
            // 长交通，可以回收为游览；真正的大纲离场段必须保留。
            && !(item.outlineMove && matchesDeclaredMove(item))
            && !item.schedSource
            && !item.scheduleRequired
            && !/train|plane|ship|高铁|动车|火车|航班|飞机|游船|轮渡|渡船/.test(
              `${item.transportType || ''} ${item.activity || ''} ${item.note || ''}`.toLowerCase()))
          .filter((item) => {
            const start = toMin(item.startTime), end = toMin(item.endTime);
            return start !== null && end !== null && end - start >= 60
              && (evidenceEnd === null || start >= evidenceEnd - 15);
          })
          .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
      if (recover) {
          recover.category = 'sight';
          recover.activity = `游览${highlight}，按景区开放线路安排观景、步行与拍照`.slice(0, 200);
          recover.startLocation = highlight;
          recover.endLocation = highlight;
          recover.transportType = '';
          recover.outlineMove = false;
          recover.autoConnector = false;
          recover.timingEstimated = false;
          recover.scheduleRequired = false;
          recover.note = '原生成交通段未形成有效离园路线，已回收为景区游览；开放时间和排队情况以现场为准。';
          visitRows.push(recover);
          console.warn('[generatePlan] 第%d天将景区后的异常长交通回收为游览：%s', dayIndex + 1, highlight);
        }
      }

      // 当天只有“抵达景区→下一站”的交通、完全没有 sight/other 时，不能
      // 让必玩景点只停留在大纲或车程文案里。若离开交通不是已核验的铁路/
      // 飞机/船，先为景区留出至少 60 分钟；必要时顺延这条普通接驳，后续
      // 时间线审计会继续把候车和返程边界向后接好。
      const hasVisitForHighlight = visitRows.some((item) =>
        highlightLocation(item.startLocation) || highlightLocation(item.endLocation)
          || textOf(item).includes(stem));
      if (!hasVisitForHighlight) {
        const arrival = dayRows.filter((item) => item && item.category === 'transport'
          && highlightLocation(item.endLocation)
          && !highlightLocation(item.startLocation)
          && toMin(item.endTime) !== null)
          .sort((a, b) => (toMin(a.endTime) ?? 1440) - (toMin(b.endTime) ?? 1440))[0];
        const departure = dayRows.filter((item) => item && item.category === 'transport'
          && highlightLocation(item.startLocation)
          && toMin(item.startTime) !== null
          && (!arrival || (toMin(item.startTime) ?? 0) >= (toMin(arrival.endTime) ?? 0))
          && !item.schedSource && !item.scheduleRequired
          && !/train|plane|ship|高铁|动车|火车|航班|飞机|游船|轮渡|渡船/.test(
            `${item.transportType || ''} ${item.activity || ''} ${item.note || ''}`.toLowerCase()))
          .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
        if (arrival) {
          const arrivalEnd = toMin(arrival.endTime);
          // 抵达后如果先办理入住/放行李，游览窗口要接在这些动作之后，
          // 不能把酒店条目覆盖掉再声称“已经游览”。
          const postArrival = dayRows
            .filter((item) => item !== arrival && item.category !== 'transport'
              && highlightLocation(item.startLocation) || item !== arrival
                && item.category !== 'transport' && highlightLocation(item.endLocation))
            .filter((item) => (toMin(item.startTime) ?? 1440) >= (arrivalEnd ?? 1440))
            .sort((a, b) => (toMin(b.endTime) ?? toMin(b.startTime) ?? 0)
              - (toMin(a.endTime) ?? toMin(a.startTime) ?? 0));
          const anchorEnd = postArrival.length
            ? (toMin(postArrival[0].endTime) ?? arrivalEnd)
            : arrivalEnd;
          let departureStart = departure ? toMin(departure.startTime) : null;
          if (departure && departureStart !== null && anchorEnd !== null
              && departureStart - anchorEnd < 80) {
            const shift = 80 - (departureStart - anchorEnd);
            const depEnd = toMin(departure.endTime);
            const shiftedEnd = depEnd === null ? null : depEnd + shift;
            if (shiftedEnd !== null && shiftedEnd <= 23 * 60 + 59) {
              departure.startTime = fmtMin(departureStart + shift);
              departure.endTime = fmtMin(shiftedEnd);
              departure.timingEstimated = true;
              departure.note = [departure.note, '为景区游览预留至少60分钟，普通接驳时段按顺序顺延'].filter(Boolean).join('；');
              departureStart = departureStart + shift;
            }
          }
          const sightStart = anchorEnd === null ? null : anchorEnd + 10;
          const sightEnd = departureStart === null
            ? Math.min(23 * 60 + 30, (sightStart ?? 0) + 90)
            : Math.min(departureStart - 10, (sightStart ?? 0) + 90);
          if (sightStart !== null && sightEnd - sightStart >= 60) {
            const created = {
              dayIndex,
              startTime: fmtMin(sightStart),
              endTime: fmtMin(sightEnd),
              activity: `游览${highlight}，按景区开放线路安排观景、步行与拍照`.slice(0, 200),
              category: 'sight',
              startLocation: highlight,
              endLocation: highlight,
              transportType: '',
              note: '已根据抵达与离开交通补足实际游览窗口；开放时间和排队情况以现场为准。',
            };
            rows.push(created);
            visitRows.push(created);
            console.warn('[generatePlan] 第%d天为抵达后缺失游览的景点补窗口：%s %s-%s',
              dayIndex + 1, highlight, created.startTime, created.endTime);
          }
        }
      }

      if (!visitRows.length) return;
      const isCruiseVisit = (item) => /漓江|游船|游览船|船游|乘船|三星|四星/.test(
        `${item && item.activity || ''} ${item && item.startLocation || ''} ${item && item.endLocation || ''}`,
      );
      // 兴坪古镇、20 元背景图等陆上点位不能直接拼进游船条目，
      // 否则会出现“在兴坪古镇内乘四星船”这种既不准确又无法导航的文案。
      // 船型高亮仍优先匹配船；其他高亮只在非船的游览条目中落地。
      const targetRows = /漓江|游船|三星|四星/.test(highlight)
        ? visitRows
        : visitRows.filter((item) => !isCruiseVisit(item));
      if (!targetRows.length) return;
      // 日出/日落是独立的光线活动，不能把“20 元背景图、大榕树”等
      // 其他高亮前缀拼进日出条目；同一条已经承载一个明确景点的文案
      // 也不再继续叠加第二个景点，避免出现“在 A 内，在 B 内”的伪路线。
      const usableTargets = targetRows.filter((item) => {
        const activity = String(item.activity || '');
        if (/日出|日落/.test(activity) && !/日出|日落/.test(highlight)) return false;
        return !/^在.+内[，,、]/.test(activity);
      });
      if (!usableTargets.length) return;
      const target = usableTargets.find((item) => {
        const location = `${item.startLocation || ''} ${item.endLocation || ''}`;
        return highlightLocation(location);
      });
      // 同一行政区不是同一景点。不能为了“覆盖”把 A 硬写进 B 的
      // 游览文案，也不能把到站手续写成“在日出景点内”。
      if (!target) return;
      const old = String(target.activity || '').trim();
      target.activity = `在${highlight}内，${old || `游览${highlight}`}`.slice(0, 200);
      console.warn('[generatePlan] 第%d天详细游览补落地要点：%s', dayIndex + 1, highlight);
    });
  });
  return rows;
}

/** 最终边界兜底：有龙脊过夜且次日 07:00 后才离开时，必须落出日出条目。 */
function ensureLongjiSunriseDetail(items, outline) {
  const rows = asArray(items);
  const days = asArray(outline && outline.days);
  const duplicateSunrises = new Set();
  const isLongji = (day) => /龙脊|金坑大寨|田头寨/.test(String(day && (day.overnight || day.hotel || day.city) || ''));
  days.forEach((day, index) => {
    const next = days[index + 1];
    if (!isLongji(day) || !next) return;
    const departure = asArray(next.moves)
      .filter((move) => move && toMin(move.startTime) !== null
        && /龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.from || ''))
        && !/龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.to || '')))
      .map((move) => toMin(move.startTime))
      .sort((a, b) => a - b)[0];
    const nextRows = rows.filter((item) => Number(item && item.dayIndex || 0) === index + 1);
    const sunriseRows = nextRows
      .filter((item) => /西山韶乐/.test(String(item.activity || ''))
        && /日出/.test(String(item.activity || '')))
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    if (sunriseRows.length) {
      // 详细阶段和续跑审计都可能各自尝试补齐同一条日出。按天只保留
      // 最早的一条，避免它在数组末尾形成“晚间入住后又回龙脊”的假折返。
      sunriseRows.slice(1).forEach((item) => duplicateSunrises.add(item));
      const sunriseAt = longjiSolarMinute(next.date, false);
      if (sunriseAt !== null && (departure === undefined || departure >= sunriseAt + 35)) {
        const first = sunriseRows[0];
        first.startTime = fmtMin(Math.max(4 * 60 + 30, sunriseAt - 30));
        first.endTime = fmtMin(Math.min(8 * 60, sunriseAt + 35));
        first.timingLocked = 'sunrise';
        first.note = `日出约${fmtMin(sunriseAt)}，请按当天公告和景区开放时间微调`;
      }
      return;
    }
    if (departure !== undefined && departure < 7 * 60) return;
    const firstStart = nextRows.map((item) => toMin(item.startTime))
      .filter((value) => value !== null)
      .sort((a, b) => a - b)[0];
    const sunriseAt = longjiSolarMinute(next.date, false);
    const solarStart = sunriseAt !== null ? Math.max(4 * 60 + 30, sunriseAt - 30) : null;
    const solarEnd = sunriseAt !== null ? Math.min(8 * 60, sunriseAt + 35) : null;
    // 已有条目在日出观景窗口前结束不了，说明当天没有足够时间，不硬插一条
    // 会把后续早餐/返程挤成倒序；有余量时才锁定太阳时刻。
    if (solarEnd !== null && firstStart !== undefined && firstStart < solarEnd) return;
    const end = solarEnd !== null ? solarEnd
      : firstStart !== undefined ? firstStart - 10
        : departure !== undefined ? departure - 20 : 7 * 60;
    const start = solarStart !== null ? solarStart : end - 60;
    if (start < 4 * 60 + 30 || end <= start) return;
    const previousStay = String(day.overnight || day.hotel || '龙脊住宿地').trim();
    rows.push({
      dayIndex: index + 1,
      startTime: fmtMin(start),
      endTime: fmtMin(end),
      activity: '前往西山韶乐观赏日出',
      category: 'sight',
      startLocation: previousStay,
      endLocation: '西山韶乐',
      transportType: 'walk',
      timingLocked: sunriseAt !== null ? 'sunrise' : undefined,
      note: sunriseAt !== null
        ? `日出约${fmtMin(sunriseAt)}，请按当天公告和景区开放时间微调`
        : '按当天实际日出时间和景区开放/接驳时间微调',
    });
    console.warn('[generatePlan] 最终边界补齐西山韶乐日出：第%d天 %s-%s',
      index + 2, fmtMin(start), fmtMin(end));
  });
  // 该函数可能在 fixDayTimeOverlaps 之后被续跑审计调用，不能依赖调用方
  // 再做一次排序；统一按天、按开始时间返回。
  return rows.filter((item) => !duplicateSunrises.has(item)).sort((a, b) => {
    const dayDiff = Number(a && a.dayIndex || 0) - Number(b && b.dayIndex || 0);
    if (dayDiff) return dayDiff;
    return (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440);
  });
}

/**
 * 龙脊日落的详细阶段兜底：有过夜且大纲确认时间充足时，把金佛顶安排在
 * 当地真实太阳时刻附近，并让前后普通游玩/用餐给观景段让路。若前后有已
 * 核对的大交通冲突，则不硬改交通，也不生成“看完日落再赶早班车”的假安排。
 */
function ensureLongjiSunsetDetail(items, outline) {
  const rows = asArray(items);
  const days = asArray(outline && outline.days);
  const positive = (text) => !/(不去|不安排|不看|明天|次日|后一天)/.test(text);
  days.forEach((day, dayIndex) => {
    const overnight = String(day && (day.overnight || day.hotel || day.city) || '');
    const highlights = asArray(day && day.highlights).join(' ');
    if (!/龙脊|金坑大寨|田头寨/.test(overnight)
        // 只要当天明确安排了金佛顶/龙脊核心景点且住在龙脊，就按有时间
        // 观日落处理；不能依赖模型是否恰好把“日落”写进 highlights，
        // 否则详细阶段已经写了金佛顶却仍会错过真实日落时刻。
        || !/金佛顶|千层天梯|西山韶乐/.test(highlights)
        || !validDate(day && day.date)) return;
    const sunsetAt = longjiSolarMinute(day.date, true);
    if (sunsetAt === null) return;
    const sunsetStart = Math.max(16 * 60, sunsetAt - 30);
    const sunsetEnd = Math.min(21 * 60, sunsetAt + 20);
    const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === dayIndex);
    const arrivalEnd = dayRows
      .filter((item) => item && toMin(item.endTime) !== null
        && toMin(item.startTime) !== null && toMin(item.startTime) <= sunsetStart
        && /龙脊|金坑大寨|田头寨/.test(String(item.endLocation || ''))
        && item.category === 'transport')
      .map((item) => toMin(item.endTime))
      .sort((a, b) => b - a)[0];
    const leavingStart = dayRows
      .filter((item) => item && toMin(item.startTime) !== null
        && toMin(item.startTime) < sunsetEnd
        && item.category === 'transport'
        && /龙脊|金坑大寨|田头寨|西山韶乐|千层天梯|金佛顶|大寨|观景台/.test(String(item.startLocation || ''))
        && !/龙脊|金坑大寨|田头寨|西山韶乐|千层天梯|金佛顶|大寨|观景台/.test(String(item.endLocation || '')))
      .map((item) => toMin(item.startTime))
      .sort((a, b) => a - b)[0];
    if ((arrivalEnd !== undefined && arrivalEnd > sunsetStart - 20)
        || (leavingStart !== undefined && leavingStart < sunsetStart)) return;

    const goldenRows = dayRows.filter((item) => item && item.category === 'sight'
      && positive(String(item.activity || ''))
      && /金佛顶|3号观景台/.test(String(item.activity || '')))
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    if (!goldenRows.length) return;
    const sunsetRows = goldenRows.filter((item) => /日落|夕阳|落日/.test(String(item.activity || '')));
    const target = sunsetRows.slice().reverse().find((item) => /金佛顶/.test(`${item.startLocation || ''} ${item.endLocation || ''}`))
      || sunsetRows[sunsetRows.length - 1]
      || goldenRows[goldenRows.length - 1];
    const stripSunsetMentions = (value) => String(value || '')
      .replace(/[^。；;]*?(?:日落|夕阳|落日)[^。；;]*[。；;]?/g, '')
      .replace(/[；;]{2,}/g, '；')
      .replace(/^[；;]|[；;]$/g, '')
      .trim();

    // 已核对的交通不能被观景段挤掉；普通游览和用餐则在日落前收尾，
    // 日落后的普通活动顺延到观景结束，保持完整时间线。
    const blocked = dayRows.some((item) => {
      if (!item || item === target || !isTransportItem(item)) return false;
      const start = toMin(item.startTime);
      const end = toMin(item.endTime);
      // 只有在日落前已经出发、且交通本身跨过日落时刻时才算硬冲突。
      // 例如“金佛顶→住宿地”18:30 才出发是日落后的合理返程，不能因为
      // 它的结束时间落在观景保护窗内，就阻止把前面的观景段校准到日落。
      return start !== null && end !== null && start < sunsetStart && end > sunsetStart;
    });
    if (blocked) return;
    dayRows.forEach((item) => {
      if (!item || item === target || isTransportItem(item)) return;
      const start = toMin(item.startTime);
      const end = toMin(item.endTime);
      if (start === null || end === null) return;
      if (item.category === 'sight' && start < sunsetStart) {
        if (/日落|夕阳|落日/.test(String(item.activity || ''))) {
          item.activity = String(item.activity || '')
            .replace(/[，,、；;\s]*(?:等待并)?(?:观赏|观看|欣赏)?(?:日落|夕阳|落日)(?:景色)?/g, '')
            .replace(/[，,、；;]\s*$/, '')
            .trim();
        }
        if (/日落|夕阳|落日/.test(String(item.note || ''))) item.note = stripSunsetMentions(item.note);
      }
      if (start < sunsetStart && end > sunsetStart) item.endTime = fmtMin(sunsetStart);
      if (start >= sunsetStart && start < sunsetEnd) {
        const duration = Math.max(20, end - start);
        item.startTime = fmtMin(sunsetEnd);
        item.endTime = fmtMin(Math.min(1439, sunsetEnd + duration));
      }
    });
    target.startTime = fmtMin(sunsetStart);
    target.endTime = fmtMin(sunsetEnd);
    target.activity = String(target.activity || '').includes('日落')
      ? target.activity : `${String(target.activity || '游览金佛顶')}，观赏日落`;
    target.timingLocked = 'sunset';
    target.note = `日落约${fmtMin(sunsetAt)}，已预留观景时间，请按当天云量和景区末班接驳微调`;
  });
  return rows.sort((a, b) => {
    const dayDiff = Number(a && a.dayIndex || 0) - Number(b && b.dayIndex || 0);
    if (dayDiff) return dayDiff;
    return (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440);
  });
}

/**
 * 返程日最终边界兜底：最后一条必须真正落到用户填写的出发地。
 *
 * 模型有时会把“金童路地铁站”当成“金童路”而提前结束，也有时在返程
 * 到站后留下多条车站出口/地铁描述，导致指定的到家时刻被推迟。这里以末日
 * 最后一段铁路/飞机等城际抵达为锚点，清掉其后的残留站内接驳，再重建一条
 * 到 origin 的最终接驳。只使用通用地点和用户交通偏好，不依赖城市名单。
 */
function ensureFinalHomeArrival(items, p, outline) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const lastDay = days.length - 1;
  const origin = String(p && p.origin || '').trim();
  if (!origin || lastDay < 0 || !rows.length) return rows;
  const sortOutput = (list) => list.slice().sort((a, b) => {
    const dayDiff = Number(a && a.dayIndex || 0) - Number(b && b.dayIndex || 0);
    if (dayDiff) return dayDiff;
    return (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440);
  });

  const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === lastDay)
    .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
  if (!dayRows.length) return rows;
  const isExactHome = (item) => {
    const end = String(item && item.endLocation || '').trim();
    const activity = String(item && item.activity || '');
    return end === origin || samePlace(end, origin)
      || (/(回家|到家|返家|抵达家中|返回家中)/.test(activity) &&
        (activity.includes(origin) || matchesOriginPlace(end, origin)));
  };
  const isIntercityArrival = (item) => {
    if (!item || item.category !== 'transport') return false;
    const text = `${item.transportType || ''} ${item.activity || ''}`;
    return /train|plane|ship|高铁|动车|火车|列车|航班|飞机|大巴|班车|城际/.test(text);
  };
  const anchor = dayRows.slice().reverse().find(isIntercityArrival);
  let anchorEnd = toMin(anchor && anchor.endTime);
  const requested = toMin(p && p.backTime);
  const targetStart = requested !== null ? Math.max(0, requested - 40) : null;
  let adjustedUnverifiedAnchor = false;

  // 12306 可能只返回一趟“能查到但明显赶不上用户到家时间”的车。
  // 这时不能把已核验的晚班车和 16:00 到家接驳并排展示成“先到家、再坐车”，
  // 也不能继续把这趟车当成可执行事实。清除这段官方锁定信息，改成待核实的
  // 估算交通，再由下面的统一倒推逻辑把抵达站放回到家接驳之前。规则按路线和
  // 时间判断，不依赖具体城市或车站名称。
  const returnMove = asArray(days[lastDay] && days[lastDay].moves).slice().reverse().find((move) => {
    if (!move || !move.from || !move.to || samePlace(move.from, origin)) return false;
    // 返程大交通通常只到“重庆西站/重庆北站”，而用户填写的是“重庆市金童路”
    // 这类家门地址；这里按出发城市判断，不要求车站名称包含完整地址。
    const moveToHome = matchesOriginCity(move.to, origin);
    const anchorRoute = anchor && sameTravelArea(anchor.startLocation, move.from)
      && sameTravelArea(anchor.endLocation, move.to);
    return moveToHome && (!anchor || anchorRoute || (move.code && String(anchor.activity || '').includes(move.code)));
  });
  const officialReturn = returnMove && (returnMove.schedSource === '12306'
    || asArray(returnMove.sched).some((candidate) => String(candidate && candidate.source || '') === '12306'));
  if (anchor && anchorEnd !== null && targetStart !== null && anchorEnd > targetStart && officialReturn) {
    const returnFrom = String(returnMove.from || anchor.startLocation || '').trim();
    const returnTo = String(returnMove.to || anchor.endLocation || '').trim();
    const conflictNote = `未找到能在${fmtMin(targetStart)}前到站、并衔接${p.backTime}到家的官方班次；返程车次与时刻待核实`;
    const oldNote = String(anchor.note || '').trim();
    anchor.note = oldNote.includes(conflictNote) ? oldNote : [oldNote, conflictNote].filter(Boolean).join('；');
    anchor.activity = /plane|航班|飞机/i.test(`${anchor.transportType || ''} ${anchor.activity || ''}`)
      ? `乘飞机从${returnFrom}前往${returnTo}`
      : /ship|游船|轮渡/i.test(`${anchor.transportType || ''} ${anchor.activity || ''}`)
        ? `乘船从${returnFrom}前往${returnTo}`
        : `乘列车从${returnFrom}前往${returnTo}`;
    anchor.startLocation = returnFrom;
    anchor.endLocation = returnTo;
    anchor.schedSource = 'return-deadline-conflict';
    anchor.scheduleRequired = true;
    anchor.timingEstimated = true;

    const moveFrom = String(returnMove.from || '').trim();
    const moveTo = String(returnMove.to || '').trim();
    returnMove.code = '';
    returnMove.sched = [];
    returnMove.schedSource = 'return-deadline-conflict';
    returnMove.scheduleRequired = true;
    returnMove.startTime = '';
    returnMove.endTime = '';
    returnMove.timingEstimated = true;
    returnMove.transfer = [returnMove.transfer, conflictNote].filter(Boolean).join('；');
    const day = days[lastDay];
    day.note = String(day.note || '')
      .replace(/按返程班次[^；。]*(?:；|。)?/g, '')
      .replace(/；{2,}/g, '；')
      .trim();
    if (Array.isArray(day.sched)) {
      day.sched = day.sched.filter((candidate) => {
        const sameRoute = sameTravelArea(candidate && candidate.from, moveFrom)
          && sameTravelArea(candidate && candidate.to, moveTo);
        return !sameRoute;
      });
    }
    console.warn('[generatePlan] 返程官方班次晚于到家目标，改为待核实时段：%s→%s（目标 %s）',
      returnFrom, returnTo, p.backTime);
  }
  if (anchor && anchorEnd !== null && targetStart !== null && anchorEnd > targetStart
      && anchor.schedSource !== '12306') {
    const oldStart = toMin(anchor.startTime);
    const duration = oldStart !== null && anchorEnd > oldStart ? anchorEnd - oldStart : 90;
    const newStart = Math.max(0, targetStart - duration);
    anchor.startTime = fmtMin(newStart);
    anchor.endTime = fmtMin(targetStart);
    anchorEnd = targetStart;
    anchor.timingEstimated = true;
    anchor.note = [anchor.note, `按用户 ${p.backTime} 到家目标倒推返程时段，车次与时刻待核实`]
      .filter(Boolean).join('；');
    adjustedUnverifiedAnchor = true;
    console.warn('[generatePlan] 未核验返程交通晚于到家目标，按 %s 到家倒推：%s-%s',
      p.backTime, anchor.startTime, anchor.endTime);
  }

  // 已有精确的到家条目时也要收掉它之后的旧站内行程，并把结束时间校准到
  // 用户目标；非官方铁路条目才允许这样校准，绝不改动已核验的车次事实。
  const existingHome = dayRows.slice().reverse().find(isExactHome);
  const pruneAt = adjustedUnverifiedAnchor ? toMin(anchor.startTime) : anchorEnd;
  const keepUntil = anchorEnd !== null ? anchorEnd
    : existingHome ? (toMin(existingHome.startTime) ?? 0) : null;
  const kept = dayRows.filter((item) => {
    if (item === existingHome || item === anchor) return true;
    const start = toMin(item && item.startTime);
    if (pruneAt !== null && start !== null && start >= pruneAt && !isExactHome(item)) return false;
    return true;
  });

  let from = String(anchor && anchor.endLocation || '').trim();
  if (!from && existingHome) from = String(existingHome.startLocation || '').trim();
  if (!from) {
    const previous = kept.slice().reverse().find((item) =>
      String(item && (item.endLocation || item.startLocation) || '').trim());
    from = String(previous && (previous.endLocation || previous.startLocation) || '').trim();
  }
  if (!from) from = String((days[lastDay] && (days[lastDay].city || days[lastDay].overnight)) || '').trim();
  if (!from || samePlace(from, origin)) return rows.filter((item) => !dayRows.includes(item)).concat(kept);

  let start = targetStart !== null ? targetStart : (anchorEnd !== null ? anchorEnd : 0);
  let end = requested !== null ? requested : start + 40;
  let late = false;
  if (anchorEnd !== null && start < anchorEnd) {
    start = anchorEnd;
    end = requested !== null && requested > start ? requested : start + 40;
    late = requested !== null && anchorEnd > targetStart;
  }
  if (end <= start) end = start + 40;
  end = Math.min(end, 23 * 60 + 59);
  const mode = defaultTransferMode(p);
  const transfer = existingHome || {
    dayIndex: lastDay,
    startTime: '',
    endTime: '',
    activity: '',
    category: 'transport',
    startLocation: '',
    endLocation: '',
    transportType: mode,
    note: '',
  };
  transfer.dayIndex = lastDay;
  transfer.startTime = fmtMin(start);
  transfer.endTime = fmtMin(end);
  transfer.startLocation = from;
  transfer.endLocation = origin;
  transfer.category = 'transport';
  transfer.transportType = mode;
  transfer.activity = drivingAllowed(p)
    ? `自行驾驶从${from}返回${origin}，到家休息`
    : `${homeTransferText(from, origin, mode)}，到家休息`;
  if (late) {
    const msg = `返程到站时间已晚于计划接驳起点，预计 ${fmtMin(end)} 到家；请按实际班次核实`;
    transfer.note = String(transfer.note || '').includes(msg)
      ? transfer.note : [transfer.note, msg].filter(Boolean).join('；');
  }
  if (!kept.includes(transfer)) kept.push(transfer);

  const daySet = new Set(dayRows);
  const rebuilt = rows.filter((item) => !daySet.has(item)).concat(kept);
  console.warn('[generatePlan] 末日收口到出发地：%s→%s，%s-%s', from, origin, transfer.startTime, transfer.endTime);
  return sortOutput(rebuilt);
}

/**
 * 返程日最后一道时间边界审计。
 *
 * ensureFinalHomeArrival 会把返程大交通倒推到“到家时刻 - 市内接驳”，
 * 但后续补齐大纲接驳时，偶尔会又插入一段“景区站→铁路枢纽”，把倒推的
 * 城际段向后挤掉。这里在所有大纲/景区清洗完成后重新整理最后一段链路：
 * 未核验交通允许前移，前置接驳保留时长但整体前移；实在没有空间的普通
 * 游览/餐饮让出位置。已核验的官方车次不改，只保留真实晚到信息。
 */
function fitFinalReturnWindow(items, p, outline) {
  const rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const lastDay = days.length - 1;
  const requested = toMin(p && p.backTime);
  const origin = String(p && p.origin || '').trim();
  if (!rows.length || lastDay < 0 || requested === null || !origin) return rows;

  const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === lastDay)
    .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
  if (!dayRows.length) return rows;
  const isHome = (item) => {
    const end = String(item && item.endLocation || '').trim();
    const activity = String(item && item.activity || '');
    return samePlace(end, origin)
      || (/(回家|到家|返家|抵达家中|返回家中)/.test(activity)
        && (activity.includes(origin) || matchesOriginPlace(end, origin)));
  };
  const isIntercity = (item) => item && item.category === 'transport'
    && /train|plane|ship|高铁|动车|火车|列车|航班|飞机|大巴|班车|城际/.test(
      `${item.transportType || ''} ${item.activity || ''} ${item.code || ''}`);
  const home = dayRows.slice().reverse().find(isHome);
  if (!home) return rows;

  const homeStart = toMin(home.startTime);
  const homeEnd = toMin(home.endTime);
  const homeDuration = homeStart !== null && homeEnd !== null && homeEnd > homeStart
    ? homeEnd - homeStart : 40;
  const targetHomeStart = Math.max(0, requested - homeDuration);
  const anchor = dayRows.slice().reverse().find((item) => item !== home && isIntercity(item));
  const drop = new Set();

  if (anchor) {
    const anchorStart = toMin(anchor.startTime);
    const anchorEnd = toMin(anchor.endTime);
    const official = anchor.schedSource === '12306'
      || String(anchor.scheduleSource || '').toLowerCase() === '12306';
    if (!official) {
      const duration = anchorStart !== null && anchorEnd !== null && anchorEnd > anchorStart
        ? anchorEnd - anchorStart : 90;
      anchor.endTime = fmtMin(targetHomeStart);
      anchor.startTime = fmtMin(Math.max(0, targetHomeStart - duration));
    }

    const finalAnchorStart = toMin(anchor.startTime);
    const anchorIndex = dayRows.indexOf(anchor);
    // 城际抵达之后只允许保留回家接驳；站内旧候车/景区收尾会把到家时间
    // 再次推迟，且如果确有必要应由城际条目的备注说明。
    dayRows.slice(anchorIndex + 1).forEach((item) => {
      if (item !== home) drop.add(item);
    });

    if (!official && finalAnchorStart !== null) {
      // 从返程高铁前倒着整理，给相邻大交通留 5 分钟换乘缓冲。普通活动
      // 若无法容纳会在后续迭代中被压缩；所有条目仍保留原有地点和语义。
      const before = dayRows.slice(0, anchorIndex)
        .filter((item) => !drop.has(item))
        .sort((a, b) => (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
      let cursor = Math.max(0, finalAnchorStart - 5);
      for (let i = before.length - 1; i >= 0; i--) {
        const item = before[i];
        const start = toMin(item.startTime);
        const end = toMin(item.endTime);
        if (start === null || end === null || end <= cursor) {
          if (start !== null) cursor = Math.min(cursor, start);
          continue;
        }
        const duration = Math.max(15, Math.min(240, end - start));
        const nextEnd = cursor;
        const nextStart = Math.max(0, nextEnd - duration);
        item.startTime = fmtMin(nextStart);
        item.endTime = fmtMin(nextEnd);
        cursor = nextStart;
      }
    }

    const finalEnd = toMin(anchor.endTime);
    if (finalEnd !== null && finalEnd <= targetHomeStart) {
      home.startTime = fmtMin(targetHomeStart);
      home.endTime = fmtMin(requested);
    } else if (!official) {
      // 极端情况下大交通本身已占满倒推窗口，保留真实链路并让接驳紧随
      // 其后；这只会发生在输入的到家时刻短于交通/接驳最小时长时。
      const start = finalEnd !== null ? finalEnd : targetHomeStart;
      home.startTime = fmtMin(start);
      home.endTime = fmtMin(Math.max(requested, start + homeDuration));
    }
  } else {
    home.startTime = fmtMin(targetHomeStart);
    home.endTime = fmtMin(requested);
  }

  return rows.filter((item) => !drop.has(item)).sort((a, b) => {
    const dayDiff = Number(a && a.dayIndex || 0) - Number(b && b.dayIndex || 0);
    if (dayDiff) return dayDiff;
    return (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440);
  });
}

/** Remove duplicate sightseeing stops, preserving luggage, meals and final lodging returns.
 * Location identities come from structured endpoints, never a scenic-name lookup table.
 */
function enforceScenicRouteSeparation(items) {
  const rows = asArray(items);
  const drop = new Set();
  const days = [...new Set(rows.map((row) => Number(row.dayIndex || 0)))];
  days.forEach((day) => {
    const visits = rows.filter((row) => Number(row.dayIndex || 0) === day && row.category === 'sight')
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    const seen = new Set();
    visits.forEach((row, index) => {
      const place = normalizeRoutePlace(row.endLocation || '');
      if (!place) return;
      const purposeful = /行李|寄存|取回|休息|入住|用餐|午餐|晚餐|必经|唯一通道/.test(String(row.activity || '') + String(row.note || ''));
      if (seen.has(place) && index < visits.length - 1 && !purposeful) {
        drop.add(row);
      }
      seen.add(place);
    });
  });
  return rows.filter((row) => !drop.has(row));
}

/**
 * 清掉景区内部“离开后又被接驳回到已经游过的点”的中途折返。
 *
 * 这是地点链的通用审计，不写任何景区名单：如果一个非官方交通条目把人
 * 送回此前已经游览过的具体点位，且没有寄存/取行李/休息/换乘等明确目的，
 * 就删除它；随后紧跟着从该点继续游览的条目也会被删除，避免出现“青城山
 * 游完天师洞→回青城山站→又去天师洞”的折叠路线。最终回到住宿地休息不在
 * 此规则内，因此“西山韶乐→千层天梯→金佛顶→回西山韶乐收尾”会保留。
 */
function removeScenicReentryBacktracks(items) {
  const rows = asArray(items);
  const byDay = new Map();
  rows.forEach((row) => {
    const day = Number(row && row.dayIndex || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  });
  const dropped = new Set();
  const normalize = (value) => normalizeRoutePlace(value);
  const sameNamed = (a, b) => {
    const x = normalize(a), y = normalize(b);
    return !!x && !!y && (x === y || (x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y)));
  };
  const mentions = (row, place) => {
    const target = normalize(place);
    if (!target || target.length < 3) return false;
    const text = normalize(`${row && row.activity || ''} ${row && row.startLocation || ''} ${row && row.endLocation || ''}`);
    return text.includes(target) || target.includes(text) && text.length >= 3;
  };
  const purposeful = (row) => /行李|寄存|取回|休息|入住|用餐|午餐|晚餐|换乘|换乘点|放下/.test(
    `${row && row.activity || ''} ${row && row.note || ''}`);
  const scenic = (row) => row && ['sight', 'other'].includes(String(row.category || ''))
    && !/候车|安检|检票|进站|退房|办理入住/.test(String(row.activity || ''));

  byDay.forEach((dayRows) => {
    const sorted = dayRows.slice().sort((a, b) =>
      (toMin(a && a.startTime) ?? 1440) - (toMin(b && b.startTime) ?? 1440));
    const kept = [];
    const visited = [];
    sorted.forEach((row) => {
      if (dropped.has(row)) return;
      const previous = kept[kept.length - 1];
      const confirmedRail = row.schedSource === '12306'
        || /train|rail|高铁|动车|列车|火车/.test(`${row.transportType || ''} ${row.activity || ''}`);
      if (row.category === 'transport' && row.startLocation && row.endLocation
          && !purposeful(row) && !confirmedRail && row.outlineMove !== true) {
        const reentry = visited.some((visit) => mentions(visit, row.endLocation));
        const leftPoint = previous && previous.category === 'transport'
          && previous.endLocation && !sameNamed(row.endLocation, previous.endLocation);
        if (reentry && leftPoint) {
          dropped.add(row);
          console.warn('[generatePlan] 删除景区内部重复回折交通：%s→%s', row.startLocation, row.endLocation);
          return;
        }
      }
      if (scenic(row) && row.startLocation && !purposeful(row)) {
        const reentry = visited.some((visit) => mentions(visit, row.startLocation));
        const leftPoint = previous && previous.category === 'transport'
          && previous.endLocation && !sameNamed(row.startLocation, previous.endLocation);
        if (reentry && leftPoint) {
          dropped.add(row);
          console.warn('[generatePlan] 删除已经游过地点的中途回折游览：%s', row.activity);
          return;
        }
      }
      kept.push(row);
      if (scenic(row)) visited.push(row);
    });
  });
  return dropped.size ? rows.filter((row) => !dropped.has(row)) : rows;
}

/**
 * 同一天同一方向的直达交通只保留真正需要的一段。重点处理“细化原文已经
 * 写了一段 A→B，后续又按大纲补出 autoConnector A→B”的重复；若两段之间
 * 已经出现景区游览/用餐，保留后面的接续段，避免把离开景区排到游览尚未
 * 结束的位置。官方核验班次永远优先保留。
 */
function dedupeDirectedTransportRoutes(items) {
  const rows = asArray(items);
  const byDay = new Map();
  rows.forEach((row) => {
    if (!row || row.category !== 'transport' || !row.startLocation || !row.endLocation) return;
    const day = Number(row.dayIndex || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  });
  const sameRoute = (a, b) => sameTravelArea(a && a.startLocation, b && b.startLocation)
    && sameTravelArea(a && a.endLocation, b && b.endLocation);
  const dropped = new Set();
  byDay.forEach((transports, day) => {
    const sorted = transports.slice().sort((a, b) =>
      (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    for (let i = 0; i < sorted.length; i++) {
      const first = sorted[i];
      if (dropped.has(first) || first.schedSource === '12306' || first.outlineMove === true) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const second = sorted[j];
        if (dropped.has(second) || second.outlineMove === true || !sameRoute(first, second)) continue;
        if (second.schedSource === '12306') { dropped.add(first); break; }
        const firstAuto = first.autoConnector === true || first.timingEstimated === true;
        const secondAuto = second.autoConnector === true || second.timingEstimated === true;
        if (!firstAuto && !secondAuto) continue;
        const early = first;
        const late = second;
        const earlyEnd = toMin(early.endTime);
        const lateStart = toMin(late.startTime);
        const hasInterveningActivity = rows.some((row) => row !== early && row !== late
          && Number(row.dayIndex || 0) === day
          && row.category !== 'transport'
          && toMin(row.startTime) !== null && toMin(row.startTime) >= (earlyEnd ?? 0)
          && (lateStart === null || toMin(row.startTime) < lateStart));
        if (hasInterveningActivity) {
          dropped.add(early);
          console.warn('[generatePlan] 同日同向交通被后续景区安排分隔，删除前置重复段：%s→%s',
            early.startLocation, early.endLocation);
        } else {
          dropped.add(firstAuto ? first : second);
          console.warn('[generatePlan] 删除同日重复接驳：%s→%s', first.startLocation, first.endLocation);
        }
        break;
      }
    }
  });
  return dropped.size ? rows.filter((row) => !dropped.has(row)) : rows;
}

/**
 * 白天不回酒店睡觉：非返程日 15:00 前的"回酒店休息/午休"类条目直接删掉。
 * 换住处当天"到酒店放行李/办理入住"是正当操作，放行；末日不受限。
 * 实测踩过：中午 13:00 安排"返回酒店附近稍作休息"，游客被摁回酒店睡觉，
 * 下午半天凭空蒸发。
 */
function enforceNoMiddayHotel(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const legit = (it) => /入住|办理|放(行李|下)|寄存|行李/.test(`${it.activity || ''}${it.note || ''}`);
  const sleepy = (it) => it.category === 'hotel'
    || /回(酒店|住宿|房间)|返回酒店|午休|午睡/.test(String(it.activity || ''));
  const out = [];
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    const t = toMin(it.startTime);
    const isLastDay = di === days.length - 1;
    if (!isLastDay && it.category !== 'transport' && it.category !== 'food'
      && sleepy(it) && !legit(it) && t != null && t < 15 * 60) {
      console.warn('[generatePlan] 第%d天 %s 白天安排「%s」，删除（游客不该中午回酒店睡觉）',
        di + 1, it.startTime, String(it.activity || '').slice(0, 18));
      return;
    }
    out.push(it);
  });
  return out;
}

/**
 * 细化失败天的骨架兜底：LLM 某天重试耗尽后那天就是空白（只剩代码补的
 * 大交通+接驳，实测返程日整天空掉）。用大纲里该天的 moves / hl / meals
 * 生成一份"骨架行程"：大交通 + 三餐 + 每个必玩点一条游览，插空排时刻，
 * 保证每天至少是可执行的完整骨架，而不是半页空白。
 */
function skeletonDayItems(p, day, idx, outline) {
  const isLast = idx === outline.days.length - 1;
  const city = String(day.city || day.overnight || '').trim() || '目的地';
  const items = [];
  const mk = (startTime, endTime, activity, category, extra = {}) => items.push(Object.assign({
    dayIndex: idx,
    startTime: fmtMin(startTime),
    endTime: fmtMin(endTime),
    activity,
    category,
    startLocation: '',
    endLocation: '',
    transportType: '',
    note: '',
  }, extra));

  // 忙碌区间 = 大交通；三餐/游玩在 [6:30, 23:00] 的空档里插
  const busy = [];
  asArray(day.moves).forEach((m) => {
    const s = toMin(m.startTime);
    const e = toMin(m.endTime);
    if (s == null || e == null) return;
    busy.push([s, e]);
    const mode = String(m.mode || '').toLowerCase();
    const tt = /plane|航班|飞机/.test(mode) ? 'plane' : /train|高铁|动车|火车/.test(mode) ? 'train'
      : /bus|大巴|直通/.test(mode) ? 'bus' : defaultTransferMode(p);
    mk(s, e, moveActivityText(m, p), 'transport', {
      startLocation: String(m.from || '').trim(),
      endLocation: String(m.to || '').trim(),
      transportType: tt,
    });
  });
  busy.sort((a, b) => a[0] - b[0]);
  const DAY_S = 6 * 60 + 30;
  const DAY_E = 23 * 60;
  const place = (earliest, dur) => {
    let cur = Math.max(DAY_S, earliest);
    for (const [s, e] of busy) {
      if (cur + dur <= s) return cur;
      if (e > cur) cur = Math.max(cur, e);
    }
    return cur + dur <= DAY_E ? cur : null;
  };
  const occupy = (s, e) => { busy.push([s, e]); busy.sort((a, b) => a[0] - b[0]); };

  // 三餐（第 1 天早餐在家吃，不补；返程日晚餐看时间，交给 EveningPlan/Closure）
  if (idx > 0) {
    const s = place(8 * 60, 40);
    if (s != null) { mk(s, s + 40, `在${city}吃早餐`, 'food'); occupy(s, s + 40); }
  }
  const meals = asArray(day.meals);
  const ls = place(12 * 60, 60);
  if (ls != null) {
    mk(ls, ls + 60, meals[0] ? `午餐：${meals[0]}` : `在${city}吃午餐，尝当地特色`, 'food');
    occupy(ls, ls + 60);
  }
  // 游玩：每个必玩点一条，顺序往后排
  let cur = 9 * 60 + 30;
  let currentLocation = city;
  asArray(day.highlights).forEach((h) => {
    const name = String(h || '').trim();
    if (!name) return;
    if (drivingAllowed(p) && !samePlace(currentLocation, name)) {
      const driveStart = place(cur, 30);
      if (driveStart == null) return;
      const driveEnd = driveStart + 30;
      mk(driveStart, driveEnd, `自行驾驶从${currentLocation}前往${name}`, 'transport', {
        startLocation: currentLocation,
        endLocation: name,
        transportType: 'car',
      });
      occupy(driveStart, driveEnd);
      const parkStart = driveEnd;
      mk(parkStart, parkStart + 10, `抵达${name}后先停好车、确认停妥`, 'other', {
        startLocation: name,
        endLocation: name,
        note: '停车后再开始游览。',
        parking: true,
      });
      occupy(parkStart, parkStart + 10);
      cur = parkStart + 10;
    }
    const s = place(cur, 120) || place(cur, 90);
    if (s == null) return;
    const dur = place(cur, 120) != null ? 120 : 90;
    mk(s, s + dur, `游览${name}`, 'sight', {
      startLocation: !drivingAllowed(p) && cur === 9 * 60 + 30 ? city : '',
      endLocation: name,
      transportType: !drivingAllowed(p) && cur === 9 * 60 + 30 ? defaultTransferMode(p) : '',
    });
    occupy(s, s + dur);
    cur = s + dur + 15;
    currentLocation = name;
  });
  if (!isLast) {
    const ds = place(18 * 60 + 30, 60);
    if (ds != null) {
      mk(ds, ds + 60, meals[1] ? `晚餐：${meals[1]}` : `在${city}吃晚餐，尝当地特色`, 'food');
      occupy(ds, ds + 60);
    }
  }
  return items;
}

/**
 * 细化失败/残缺天的骨架兜底：LLM 某天重试耗尽后那天就是空白，或细化超时
 * 只落下 2~3 条（大交通+接驳），残缺得没法看。两种天都按大纲里该天的
 * moves / hl / meals 重建"骨架行程"：大交通 + 三餐 + 每个必玩点一条游览，
 * 插空排时刻，保证每天至少是可执行的完整骨架。
 * @returns {{items: Array, replaced: number[]}} replaced 是被重建的天（原条目要丢弃）
 */
function skeletonForEmptyDays(p, outline, items, doneDayIndexes) {
  const days = asArray(outline && outline.days);
  if (!days.length) return { items: [], replaced: [] };
  const counts = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    counts.set(di, (counts.get(di) || 0) + 1);
  });
  // 之前轮次已完成的天不在本轮 items 里，必须排除，否则会被误判成空天重复重建
  const done = new Set(asArray(doneDayIndexes).map(Number));
  // 空天，或只剩 ≤3 条的"残天"（细化超时只落了大交通+代码兜底接驳）都重建
  const rebuild = [];
  days.forEach((d, i) => {
    if (done.has(i)) return;
    const n = counts.get(i) || 0;
    if (n === 0 || n <= 3) rebuild.push(i);
  });
  if (!rebuild.length) return { items: [], replaced: [] };
  console.warn('[generatePlan] 第 %s 天 AI 细化未产出/残缺，用大纲骨架重建',
    rebuild.map((i) => i + 1).join('、'));
  const out = [];
  rebuild.forEach((i) => out.push(...skeletonDayItems(p, days[i], i, outline)));
  return { items: out, replaced: rebuild };
}

/**
 * 班次时刻规整到 5 分钟的整数倍。
 * 真实列车运行图的发车/到达时刻只会出现整点、半点或 5 分/10 分这类刻度，
 * "08:37 发车""16:02 到达"百分百是模型随手编的。规整之后至少"像个真班次"，
 * 与真实时刻的偏差也控制在 2 分钟以内（用户查 12306 时才对得上号）。
 */
function snapScheduleMinutes(outline) {
  const snap = (v) => {
    const m = toMin(v);
    return m == null ? v : fmtMin(Math.round(m / 5) * 5);
  };
  asArray(outline && outline.days).forEach((d) => {
    asArray(d.moves).forEach((m) => {
      const modeStr = `${m.mode || ''}${m.code || ''}`.toLowerCase();
      if (!/train|plane|ship|高铁|动车|火车|航班|飞机|游船/.test(modeStr)) return;
      // 来源已回写的运行图不能取整；08:37 之类的官方时刻同样有效。
      if (m.schedSource && m.schedSource !== 'official-unavailable') return;
      if (m.startTime) m.startTime = snap(m.startTime);
      if (m.endTime) m.endTime = snap(m.endTime);
    });
  });
  return outline;
}

function applyTripEdgeTimes(p, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length) return outline;
  if (drivingAllowed(p)) {
    days.forEach((day) => {
      day.moves = asArray(day.moves).map((move) => Object.assign({}, move, {
        mode: 'car', code: '', sched: [], schedSource: '', scheduleRequired: false,
      }));
      day.sched = [];
    });
    const first = days[0];
    if (!asArray(first.moves).length && p.origin) {
      first.moves.push({ from: p.origin, to: first.city || first.overnight || p.dest, mode: 'car', code: '', startTime: '', endTime: '' });
    }
    const firstMove = asArray(first.moves)[0];
    if (firstMove) {
      firstMove.from = p.origin || firstMove.from;
      if (p.goTime) firstMove.startTime = p.goTime;
      if (p.goTime && (!toMin(firstMove.endTime) || toMin(firstMove.endTime) <= toMin(p.goTime))) {
        firstMove.endTime = fmtMin(Math.min(toMin(p.goTime) + 60, 23 * 60 + 59));
      }
    }
    if (days.length > 1 && p.origin) {
      const last = days[days.length - 1];
      if (!asArray(last.moves).length) {
        last.moves.push({ from: last.city || last.overnight || p.dest, to: p.origin, mode: 'car', code: '', startTime: '', endTime: '' });
      }
      const returnMove = last.moves[last.moves.length - 1];
      returnMove.to = p.origin;
      returnMove.mode = 'car';
      returnMove.code = '';
      if (p.backTime) {
        returnMove.endTime = p.backTime;
        if (!toMin(returnMove.startTime) || toMin(returnMove.startTime) >= toMin(p.backTime)) {
          returnMove.startTime = fmtMin(Math.max(0, toMin(p.backTime) - 60));
        }
      }
    }
    return outline;
  }
  // 只认城际大交通段（市内接驳不挪）
  const railLike = (m) => /train|plane|高铁|动车|火车|航班|飞机|ship|游船/
    .test(`${m.mode || ''}${m.code || ''}`.toLowerCase());
  snapScheduleMinutes(outline);

  // ⚠️ 这里的历史做法是把整段班次"整体平移"到用户填的时刻 —— 结果车次号还是
  // 模型给的（如 G2249），时刻却被我们算成了 16:15，真实 G2249 根本不是这个点发车，
  // 用户一查就"每班车都对不上"。
  // 正确原则：**列车/航班时刻是事实，用户的出发意向才是可以商量的那个**。
  // 代码绝不改写班次时刻，只在偏差明显时把真实时刻写进当天提示，让人自己调。
  const TOL = 45;   // 期望与真实相差 45 分钟以内都算"对得上"

  const noteOf = (day) => {
    if (!day) return null;
    day.note = String(day.note || '').trim();
    return day;
  };
  const appendNote = (day, text) => {
    if (!day) return;
    const old = String(day.note || '').trim();
    if (old && old.indexOf(text) >= 0) return;
    day.note = old ? `${old}；${text}` : text;
  };

  const goMin = toMin(p.goTime);
  const backMin = toMin(p.backTime);

  if (goMin != null) {
    const first = days[0];
    const list = asArray(first && first.moves);
    const m = list.find(railLike) || list[0];
    if (m) {
      // goTime = **离开出发地（家门口/酒店）的时刻**，不是发车时刻。
      // 期望发车 = goTime + 市内接驳 40 分钟 + 安检候车（高铁 45 分 / 飞机 2 小时）。
      const modeStr = `${m.mode || ''}${m.code || ''}`.toLowerCase();
      const buffer = /plane|航班|飞机/.test(modeStr) ? 160
        : /train|高铁|动车|火车/.test(modeStr) ? 85
        : 60;                                    // bus/car/ship：门到门 40 分 + 余量
      const wantStart = goMin + buffer;
      const realStart = toMin(m.startTime);
      noteOf(first);
      if (realStart != null && Math.abs(realStart - wantStart) > TOL) {
        // 真实班次与用户意向冲突：保留真实时刻，把该几点出门写进提示
        const leaveAt = Math.max(0, realStart - buffer);
        appendNote(first, `参考${m.code ? ` ${m.code}` : ''} ${m.startTime || ''} 发车，建议 ${fmtMin(leaveAt)} 前出发（原计划的 ${p.goTime} 当天没有合适班次）`);
        console.warn('[generatePlan] 去程班次 %s %s 与用户出发时间 %s 冲突，保留真实时刻',
          m.code || '', m.startTime || '', p.goTime || '');
      }
    }
  }
  if (backMin != null && days.length > 1) {
    const last = days[days.length - 1];
    const list = asArray(last && last.moves);
    const m = list.slice().reverse().find(railLike) || list[list.length - 1];
    if (m) {
      const wantEnd = Math.max(0, backMin - 40);   // 到站后还要 ~40 分钟市内返家
      const realEnd = toMin(m.endTime);
      noteOf(last);
      if (realEnd != null && Math.abs(realEnd - wantEnd) > TOL) {
        appendNote(last, `参考${m.code ? ` ${m.code}` : ''} ${m.endTime || ''} 到站，预计 ${fmtMin(Math.min(1439, realEnd + 40))} 到家（与计划的 ${p.backTime} 有出入）`);
        console.warn('[generatePlan] 返程班次 %s %s 与用户到家时间 %s 冲突，保留真实时刻',
          m.code || '', m.endTime || '', p.backTime || '');
      }
    }
  }
  return outline;
}

function enforceOutlineTransportPreference(p, outline) {
  if (!outline) return outline;
  const days = asArray(outline.days);
  if (drivingAllowed(p)) {
    days.forEach((day) => {
      day.moves = asArray(day.moves).map((move) => Object.assign({}, move, {
        mode: 'car', code: '', sched: [], schedSource: '', scheduleRequired: false,
      }));
      day.sched = [];
    });
    return outline;
  }

  // 大纲也会直接展示给用户，不能只在细化条目阶段清洗“自驾/开车”。
  // mode=car 可能是模型把打车、包车和本人驾驶混在一起的结果；没有明确的
  // 单段自驾要求时统一改成公共交通/旅游专线或有司机接送，避免前端先看到
  // 一条未经授权的本人驾驶安排。
  const fallbackMode = /大巴|直通车/.test(String(p && p.transport || '')) ? 'bus' : 'ride';
  days.forEach((day) => {
    day.moves = asArray(day.moves).map((move) => {
      const current = Object.assign({}, move);
      const modeText = `${current.mode || ''} ${current.transfer || ''}`;
      const ownDriveText = /自驾|开车|驾车|驾驶|驱车/.test(modeText)
        || (/^car$/i.test(String(current.mode || '').trim()) && !/打车|网约车|出租车|包车|司机/.test(modeText));
      if (!ownDriveText || explicitSelfDriveSegment(p, {
        startLocation: current.from,
        endLocation: current.to,
      })) return current;
      current.mode = fallbackMode;
      current.code = '';
      current.sched = [];
      current.schedSource = '';
      current.scheduleRequired = false;
      current.transfer = [
        fallbackMode === 'bus' ? '改乘旅游专线/大巴' : '改乘公共交通或有司机接送',
        '实际班次与耗时请按当天情况核实',
      ].join('；');
      return current;
    });
  });

  // A rail-first plan must not keep an invented flight. When an outbound rail
  // segment already identifies the route's rail hub, use that corridor in
  // reverse and move the preceding night/road transfer to the hub.
  if (!/高铁|动车/.test(String(p && p.transport || '')) || days.length < 2 || !p.origin) return outline;
  const lastIndex = days.length - 1;
  const last = days[lastIndex];
  const lastMoves = asArray(last && last.moves);
  const headsHome = (move) => move && move.from && move.to
    && matchesOriginCity(move.to, p.origin) && !matchesOriginCity(move.from, p.origin);
  const returnRail = lastMoves.find((move) => headsHome(move)
    && /train|高铁|动车|火车/i.test(String(move.mode || '')));
  const returnFlights = lastMoves.filter((move) => headsHome(move)
    && /plane|航班|飞机/i.test(String(move.mode || '')));
  const leavesHomeAgain = (move) => move && matchesOriginCity(move.from, p.origin)
    && !matchesOriginCity(move.to, p.origin);
  if (returnRail && !returnFlights.length) {
    // mv 只描述城际大交通。模型有时还会把“重庆北站→金童路”这种
    // 到站后的本地回家接驳塞进末日 moves，随后又与真实返程铁路并列，
    // 形成顺序冲突；详细行程会按返程规则单独补这一段。
    last.moves = lastMoves.filter((move) => move === returnRail
      || (!leavesHomeAgain(move) && !(matchesOriginCity(move && move.from, p.origin)
        && matchesOriginCity(move && move.to, p.origin))));
    return outline;
  }
  // If the outbound trip already uses rail, carry that corridor back on the
  // final day when the model omitted the return leg or substituted a flight,
  // taxi, or charter. A valid explicit rail return remains untouched.
  if (returnRail && !returnFlights.length) return outline;
  let outboundRail = null;
  days.slice(0, lastIndex).some((day) => asArray(day && day.moves).some((move) => {
    if (!move || !/train|高铁|动车|火车/i.test(String(move.mode || ''))
        || !matchesOriginCity(move.from, p.origin) || matchesOriginCity(move.to, p.origin)) return false;
    outboundRail = move;
    return true;
  }));
  if (!outboundRail) {
    console.warn('[generatePlan] 用户优先高铁/动车，但末日航班没有可复用的去程铁路枢纽，保留路线供后续复核');
    return outline;
  }

  const railHub = String(outboundRail.to || '').trim();
  const homeTerminal = String(outboundRail.from || '').trim();
  const stationCity = (value) => String(value || '').trim()
    .replace(/(?:东|南|西|北|中)?(?:高铁站|动车站|火车站|铁路站|站)$/, '')
    .replace(/(?:市|县|区)$/, '');
  const hubCity = stationCity(railHub) || railHub;
  const previous = days[lastIndex - 1];
  const previousBase = String(previous && (previous.overnight || previous.city) || '').trim();
  // 去程铁路走廊只说明“出发地→某个城市”可行，不代表返程也应
  // 从这个城市发车。若末日前一晚已经在另一条目的地链（例如南宁），
  // 强行把它改成桂林/成都等去程终点，会制造“南宁→桂林→重庆”的
  // 反向折返。此时保留模型已有的返程方案，后续只在真实可核验班次
  // 或公共交通兜底上做校正。
  if (previous && previousBase && !sameTravelArea(previousBase, railHub)) {
    if (asArray(previous.highlights).length) {
      console.warn('[generatePlan] 末日前一晚仍有明确游览点（%s），不改写其住宿地为去程铁路枢纽 %s',
        asArray(previous.highlights).slice(0, 3).join('、'), railHub);
      return outline;
    }
    console.warn('[generatePlan] 末日前一晚位于%s，不复用去程铁路走廊 %s→%s，避免返程回折',
      previousBase, railHub, homeTerminal);
  }
  if (previous && !sameTravelArea(previous.overnight || previous.city, railHub)) {
    const roadIndex = asArray(previous.moves).map((move, index) => ({ move, index }))
      .filter(({ move }) => move && move.from && move.to
        && !/train|plane|ship|高铁|动车|火车|航班|飞机|游船/i.test(String(move.mode || '')))
      .map(({ index }) => index).pop();
    if (roadIndex !== undefined) {
      const move = previous.moves[roadIndex];
      move.to = railHub;
      move.mode = 'bus';
      move.code = '';
      move.sched = [];
      move.schedSource = '';
      move.scheduleRequired = false;
      move.transfer = [move.transfer, '改乘旅游专线/大巴前往铁路枢纽；实际班次与耗时需核实'].filter(Boolean).join('；');
    } else if (previous.overnight || previous.city) {
      previous.moves = asArray(previous.moves).concat({
        from: previous.overnight || previous.city, to: railHub, mode: 'bus', code: '',
        startTime: '12:00', endTime: '18:00', timingEstimated: true,
        transfer: '改乘旅游专线/大巴前往铁路枢纽；实际班次与耗时需核实',
      });
    }
    previous.overnight = hubCity;
    previous.city = `${String(previous.city || '').trim()}→${hubCity}`.replace(/^→|→$/g, '');
    previous.hotel = '';
  }

  const outboundDuration = toMin(outboundRail.endTime) - toMin(outboundRail.startTime);
  const duration = Number.isFinite(outboundDuration) && outboundDuration > 0
    ? Math.max(60, outboundDuration) : 120;
  const arrivalAt = toMin(p.backTime);
  const returnStart = arrivalAt === null ? null : Math.max(0, arrivalAt - 40 - duration);
  const returnEnd = arrivalAt === null ? null : Math.max(0, arrivalAt - 40);
  const returnMove = {
    from: railHub, to: homeTerminal, mode: 'train', code: '', sched: [], schedSource: '',
    startTime: returnStart === null ? '' : fmtMin(returnStart),
    endTime: returnEnd === null ? '' : fmtMin(returnEnd),
    timingEstimated: true, scheduleRequired: true,
    transfer: '末日按高铁/动车优先；到站后再乘公共交通/司机接送回家，班次待核实',
  };
  // 原计划的末日返程常写成“青城山站→重庆西站”或“景区→机场”。
  // 替换返程铁路时必须保留这个外地起点，并先接到 railHub；不能把上一段
  // 直接丢掉后让连续性兜底从 origin（如金童路）反向开去成都东站。
  const oldReturn = lastMoves.slice().reverse().find((move) => headsHome(move));
  const priorExternal = lastMoves.slice().reverse().find((move) => move && move.to
    && !matchesOriginCity(move.to, p.origin) && !matchesOriginCity(move.from, p.origin));
  const oldReturnConnected = oldReturn && (
    sameTravelArea(oldReturn.from, previousBase)
    || lastMoves.some((move) => move !== oldReturn && sameTravelArea(move && move.to, oldReturn.from))
  );
  const oldReturnUsable = oldReturn && (oldReturnConnected
    // 返程大纲常只留下“景区/景区站→家乡车站”这一段，前一晚住宿地
    // 经过铁路枢纽重写后，未必还能和 oldReturn.from 做同城匹配。只要
    // 起点不是明显失效的机场残留，就应保留它到铁路枢纽的接驳，不能
    // 让连续性兜底从用户家门口反向开去成都东站。
    || (!/机场|航站楼|候机楼/.test(String(oldReturn.from || ''))
      && !matchesOriginCity(oldReturn.from, p.origin)));
  // 旧返程有时是模型残留的“机场→家”，但上一晚已经被改到铁路枢纽；
  // 这类机场既不是当前住宿地，也没有前序接驳，不能再凭空塞回末日路线。
  // 只有旧返程起点与上一晚/前序移动相连时才复用，否则从上一晚枢纽继续。
  const accessFrom = String((oldReturnUsable ? oldReturn.from
    : priorExternal && priorExternal.to) || previousBase || '').trim();
  const keptLastMoves = lastMoves.filter((move) => !headsHome(move) && !leavesHomeAgain(move)
    && !(matchesOriginCity(move && move.from, p.origin)
      && matchesOriginCity(move && move.to, p.origin)));
  if (accessFrom && !sameTravelArea(accessFrom, railHub)) {
    const accessEnd = returnStart === null ? toMin(oldReturn && oldReturn.startTime) : returnStart - 30;
    const accessStart = accessEnd === null ? null : Math.max(0, accessEnd - 90);
    keptLastMoves.push({
      from: accessFrom,
      to: railHub,
      mode: 'bus',
      code: '',
      sched: [],
      schedSource: '',
      scheduleRequired: false,
      startTime: accessStart === null ? '' : fmtMin(accessStart),
      endTime: accessEnd === null ? '' : fmtMin(accessEnd),
      timingEstimated: true,
      railReturnAccess: true,
      transfer: '前往铁路枢纽换乘高铁/动车；公共交通/旅游专线班次与耗时请按当天情况核实',
    });
  }
  last.moves = keptLastMoves.concat(returnMove);
  last.city = `${hubCity}→${p.origin}`;
  last.overnight = '返程';
  last.hotel = '';
  last.note = [String(last.note || '').trim(), '已按高铁/动车优先改为从最近的铁路枢纽返程；末日前一晚调整到该枢纽，接驳班次需核实。']
    .filter(Boolean).join('；');
  console.warn('[generatePlan] 用户优先高铁/动车，末日返程改用已确认的铁路走廊：%s→%s', railHub, homeTerminal);
  return outline;
}

/** 大纲 JSON（短键名）→ 归一化结构 */
function normalizeOutlineJson(raw, p) {
  const days = asArray(raw && raw.ds).map((d, i) => ({
    date: validDate(d.d) ? d.d : shiftDate(p.startDate, i),
    city: String(d.city || '').trim(),
    theme: String(d.t || '').trim(),
    moves: asArray(d.mv).map((m) => ({
      from: m.f || '', to: m.to || '', mode: m.m || '', code: m.c || '',
      startTime: m.s || '', endTime: m.e || '',
      transfer: String(m.st || '').trim(),   // 到站后的接驳方式与耗时（选站是否合格的尺子）
    })),
    highlights: asArray(d.hl).map((x) => String(x || '').trim()).filter(Boolean),
    meals: asArray(d.ml).map((x) => String(x || '').trim()).filter(Boolean),
    overnight: String(d.ov || d.city || '').trim(),
    hotel: String(d.h || '').trim(),     // 每晚推荐酒店（按预算/节奏/兴趣挑，可空）
    note: String(d.n || '').trim(),
    sched: [],                           // 联网检索到的真实班次候选（细化阶段要照着挑）
  }));
  const nights = asArray(raw && raw.nt).map((n) => ({ date: n.d || '', city: String(n.c || '').trim() }));
  return {
    title: String((raw && raw.t) || `${p.dest}行程`).trim().slice(0, 60),
    summary: String((raw && raw.s) || '').trim().slice(0, 200),
    nights,
    days,
  };
}

/** 归一化大纲 → 短键名 JSON（修订请求里要回喂给 LLM，省 token） */
function outlineToShortJson(outline) {
  return {
    t: outline.title,
    s: outline.summary,
    nt: asArray(outline.nights).map((n) => ({ d: n.date, c: n.city })),
    ds: asArray(outline.days).map((d) => ({
      d: d.date, city: d.city, t: d.theme,
      mv: asArray(d.moves).map((m) => ({
        f: m.from, to: m.to, m: m.mode, c: m.code, s: m.startTime, e: m.endTime, st: m.transfer,
      })),
      hl: d.highlights, ml: d.meals, ov: d.overnight, n: d.note,
    })),
  };
}

// 景区常见的"名字尾巴"：用户写「明仕庄园」、模型写「明仕田园」这种一字之差
// 不该被判成"漏了"（真跑时踩过：大纲里明明有明仕田园，却报缺明仕庄园，
// 结果白跑一次修订请求，还把这次修订挤到超时）。
const PLACE_SUFFIX = /(景区|风景区|名胜区|庄园|田园|梯田|古镇|古村|公园|森林公园|国家公园|博物馆|观景台|度假区|遗址|寺庙|保护区|海岛|海滨|瀑布|岩洞|溶洞|竹筏|游船)$/;
/** 去掉尾巴后的地名词干（太短就不剥，避免误判） */
function placeStem(name) {
  const s = String(name || '').replace(/\s+/g, '');
  const stripped = s.replace(PLACE_SUFFIX, '');
  return stripped.length >= 2 ? stripped : s;
}

/** 用户点名的地点里，大纲还没"真正去玩"的（词干匹配，容忍"庄园/田园"这类一字之差） */
function missingMustVisit(p, outline) {
  // 只认游玩字段：城市 / 当天主题 / 必玩点。mv 描述、n 提示里的出现不算——
  // 真踩过：都江堰只出现在 mv 的"坐车经过都江堰游客中心"里，
  // 整串 JSON 比对误判成已覆盖，用户想玩的地方被当成走廊开过去了。
  const playText = outline.days.map((d) =>
    [d.city, d.theme, ...asArray(d.highlights)].join('|')).join('|');
  return (p.mustVisit || []).filter((name) => {
    if (playText.includes(name)) return false;
    const stem = placeStem(name);
    if (stem.length >= 2 && playText.includes(stem)) return false;
    // 「成都市」→「成都」：城市字段常写简称，别因为带了个"市"字判成漏了
    const bare = String(name || '').replace(/(市|县|区)$/, '');
    if (bare.length >= 2 && playText.includes(bare)) return false;
    return true;
  });
}

/**
 * 目的地出现在“当天主题”里还不够：详细阶段只会展开 highlights，因此把
 * 用户点名但尚未落到任何 highlights 的具体地点补到最匹配的一天。行政区
 * 城市本身可由当天 city/交通落地，不强行把“成都市”变成一个景点条目。
 */
function ensureOutlineHighlightCoverage(outline, p) {
  const days = asArray(outline && outline.days);
  const mustVisit = asArray(p && p.mustVisit).map((x) => String(x || '').trim()).filter(Boolean);
  if (!days.length || !mustVisit.length) return outline;
  const isAdminOnly = (value) => /(?:市|县|区|自治州|地区|盟)$/.test(String(value || '').trim());
  const hit = (value, target) => {
    const text = String(value || '').replace(/\s+/g, '');
    const stem = placeStem(target).replace(/\s+/g, '');
    return stem.length >= 2 && text.includes(stem);
  };
  mustVisit.forEach((name) => {
    if (isAdminOnly(name) || days.some((day) => asArray(day && day.highlights).some((h) => hit(h, name)))) return;
    const candidates = days.map((day, index) => {
      const moveContext = asArray(day && day.moves)
        .map((move) => `${move && move.from || ''} ${move && move.to || ''}`)
        .join(' ');
      const context = `${day && day.city || ''} ${day && day.theme || ''} ${day && day.overnight || ''} ${moveContext}`;
      if (/返程|回家|到家/.test(context)) return null;
      if (!hit(context, name)) return null;
      return { day, index };
    }).filter(Boolean);
    const selected = candidates[0];
    if (!selected) return;
    const highlights = asArray(selected.day.highlights).map((x) => String(x || '').trim()).filter(Boolean);
    const genericIndex = highlights.findIndex((h) => /^(?:自由活动|自由探索|市区漫游|周边轻松游|沿途风光|当地特色体验)$/.test(h));
    if (highlights.length >= 4 && genericIndex >= 0) highlights[genericIndex] = name;
    else highlights.push(name);
    selected.day.highlights = [...new Set(highlights)];
    console.warn('[generatePlan] 用户点名地点「%s」已从当天主题落到必玩点：第%d天', name, selected.index + 1);
  });
  return outline;
}

/**
 * 龙脊金坑的三个核心观景台在时间足够时优先安排同一天。
 *
 * 模型有时会把金佛顶单独挪到第二天，导致已经从龙脊出发的路线又折回景区。
 * 这里只合并相邻两天、且首日已有明确抵达时间并至少留出约 6.5 小时的情况；
 * 时间不足时保留拆分，避免为了满足“同日”硬塞进固定离开交通。合并后把次日
 * 离开段的起点改回前一晚住宿片区，防止留下“从金佛顶出发”的过期地点链。
 */
function enforceLongjiSameDayRoute(outline, p) {
  const days = asArray(outline && outline.days);
  const corpus = `${p && p.dest || ''} ${p && p.mustGo || ''} ${(p && p.mustVisit || []).join(' ')} `
    + days.map((day) => `${day && day.city || ''} ${day && day.theme || ''} ${asArray(day && day.highlights).join(' ')}`).join(' ');
  if (!/龙脊|金坑大寨|千层天梯|西山韶乐|金佛顶/.test(corpus)) return outline;

  const has = (day, re) => re.test(`${day && day.city || ''} ${day && day.theme || ''} ${asArray(day && day.highlights).join(' ')}`);
  const westRe = /西山韶乐/;
  const ladderRe = /千层天梯|2号天梯|2号观景台/;
  const goldenRe = /金佛顶|3号观景台/;
  const anchorIndex = days.findIndex((day) => has(day, westRe) && has(day, ladderRe));
  if (anchorIndex < 0 || anchorIndex + 1 >= days.length) return outline;
  const goldenIndex = days.findIndex((day, index) => index > anchorIndex && has(day, goldenRe));
  if (goldenIndex !== anchorIndex + 1) return outline;

  const anchor = days[anchorIndex];
  const next = days[goldenIndex];
  const moves = asArray(anchor.moves);
  const incoming = moves
    .filter((move) => move && toMin(move.endTime) !== null)
    .find((move) => /龙脊|金坑大寨|千层天梯|西山韶乐/.test(`${move.to || ''} ${move.from || ''}`));
  const arrivalEnd = toMin(incoming && incoming.endTime);
  const leaving = moves
    .filter((move) => move && toMin(move.startTime) !== null && move.to)
    .filter((move) => !/龙脊|金坑大寨|千层天梯|西山韶乐|金佛顶/.test(String(move.to || '')))
    .sort((a, b) => toMin(a.startTime) - toMin(b.startTime))[0];
  const departureStart = toMin(leaving && leaving.startTime);
  const availableUntil = departureStart !== null ? departureStart : (20 * 60);
  const available = arrivalEnd !== null ? availableUntil - arrivalEnd : 0;
  const required = 6 * 60 + 30;
  if (arrivalEnd === null || available < required) {
    console.warn('[generatePlan] 龙脊核心观景台时间不足，不强行合并同日路线（可用 %d 分钟）', available);
    return outline;
  }

  const anchorHighlights = asArray(anchor.highlights).map((x) => String(x || '').trim()).filter(Boolean);
  if (!anchorHighlights.some((item) => goldenRe.test(item))) anchorHighlights.push('金佛顶');
  anchor.highlights = [...new Set(anchorHighlights)];
  next.highlights = asArray(next.highlights).filter((item) => !goldenRe.test(String(item || '')));

  const departure = asArray(next.moves).find((move) => move && move.from && move.to
    && goldenRe.test(String(move.from)) && !goldenRe.test(String(move.to)));
  if (departure) {
    const base = String(anchor.overnight || anchor.city || '').trim();
    if (base) departure.from = base;
    departure.transfer = [departure.transfer, '前一晚已在龙脊住宿，次日从住宿片区直接出发'].filter(Boolean).join('；');
  }
  if (!next.highlights.length && departure && departure.to) {
    next.city = String(departure.to).trim();
    next.theme = `前往${next.city}`;
  }
  next.note = [next.note, '龙脊核心观景台已在前一天按西山韶乐→千层天梯→金佛顶连续游览；次日直接离开，避免折返'].filter(Boolean).join('；');
  console.warn('[generatePlan] 龙脊时间充足，合并同日路线：第%d天安排西山韶乐→千层天梯→金佛顶', anchorIndex + 1);
  return outline;
}

/**
 * 龙脊有过夜且时间允许时，把日出/日落落实成可执行的大纲要点：
 * 抵达日看金佛顶日落，次日若不是清晨立即离开则去西山韶乐看日出。
 * 不依赖固定日期或景区营业时间，只在大纲明确留有过夜和离开余量时加入，
 * 详细计划会继续按当天真实时间检查是否能落地。
 */
function ensureLongjiSunriseSunset(outline) {
  const days = asArray(outline && outline.days);
  const isLongjiStay = (day) => /龙脊|金坑大寨|田头寨/.test(String(day && (day.overnight || day.hotel) || ''));
  const dayText = (day) => `${day && day.city || ''} ${day && day.theme || ''} ${day && day.note || ''} `
    + `${asArray(day && day.highlights).join(' ')} ${asArray(day && day.moves).map((m) => `${m && m.from || ''} ${m && m.to || ''}`).join(' ')}`;
  const addHighlight = (day, value) => {
    if (!day) return;
    const list = asArray(day.highlights).map((x) => String(x || '').trim()).filter(Boolean);
    const light = String(value).match(/^(.*?)(日出|日落)$/);
    const alreadyCovered = light
      ? list.some((x) => x.includes(light[1]) && x.includes(light[2]))
      : list.some((x) => x.includes(value));
    if (!alreadyCovered) list.push(value);
    day.highlights = [...new Set(list)];
  };
  const appendNote = (day, value) => {
    if (!day || String(day.note || '').includes(value)) return;
    day.note = [day.note, value].filter(Boolean).join('；');
  };
  const arrivalEndOf = (day) => asArray(day && day.moves)
    .filter((move) => move && toMin(move.endTime) !== null
      && /龙脊|金坑大寨|田头寨/.test(String(move.to || '')))
    .map((move) => toMin(move.endTime))
    .sort((a, b) => b - a)[0];
  const departureStartOf = (day) => asArray(day && day.moves)
    .filter((move) => move && toMin(move.startTime) !== null
      && /龙脊|金坑大寨|田头寨/.test(String(move.from || ''))
      && !/龙脊|金坑大寨|田头寨/.test(String(move.to || '')))
    .map((move) => toMin(move.startTime))
    .sort((a, b) => a - b)[0];

  days.forEach((day, index) => {
    if (!isLongjiStay(day)) return;
    const arrivalEnd = arrivalEndOf(day);
    // 未给出精确抵达时刻时交给详细计划判断；已知 17:30 后抵达则不硬塞日落。
    if (arrivalEnd === undefined || arrivalEnd <= 17 * 60 + 30) {
      addHighlight(day, '金佛顶日落');
      appendNote(day, '龙脊有过夜且抵达时间允许，安排金佛顶日落；以当天日落和末班接驳为准');
    }

    const next = days[index + 1];
    if (!next) return;
    const nextRelated = /龙脊|金坑大寨|田头寨|千层天梯|西山韶乐|金佛顶/.test(dayText(next));
    const nextDeparture = departureStartOf(next);
    // 次日主题可能已经被修订成阳朔/桂林，只有“从龙脊片区出发”的
    // move 仍能证明这是住龙脊后的第一天；不能因为 next.city 改名就漏掉日出。
    if ((nextRelated || nextDeparture !== undefined)
        && (nextDeparture === undefined || nextDeparture >= 7 * 60)) {
      addHighlight(next, '西山韶乐日出');
      appendNote(next, '前一晚住在龙脊且次日离开时间允许，安排西山韶乐日出；按实际日出时间调整');
    }
  });
  return outline;
}

/**
 * 漓江游船的方向与船型校正：三星、四星都应是“桂林出发→阳朔到达”；
 * 四星再额外校正为竹江码头，三星保留其票面码头（通常是磨盘山）。
 * 这里只改游船字段，不把普通接驳误判成游船。
 */
function cruiseDirectionNote(explicitFourStar, explicitOtherShip) {
  if (explicitFourStar) return '四星级漓江游船：桂林出发→阳朔到达，出发码头为竹江码头，请按船票核对';
  if (explicitOtherShip) return '三星级漓江游船：桂林出发→阳朔到达，请按船票核对出发码头';
  return '漓江游船方向为桂林出发→阳朔到达，请按船票核对船型和码头';
}

function normalizeCruiseDirection(record, explicitFourStar) {
  const out = record;
  const from = String(out.from || out.startLocation || '').trim();
  const to = String(out.to || out.endLocation || '').trim();
  if (/阳朔/.test(from) && /桂林/.test(to)) {
    if (out.from !== undefined) out.from = to;
    if (out.to !== undefined) out.to = from;
    if (out.startLocation !== undefined) out.startLocation = to;
    if (out.endLocation !== undefined) out.endLocation = from;
    ['activity', 'transfer', 'note', 'bookingInfo'].forEach((field) => {
      if (!out[field]) return;
      out[field] = String(out[field])
        .replace(/阳朔\s*(?:→|到|至|前往)\s*桂林/g, '桂林→阳朔')
        .replace(/从阳朔[^。；，,]*?(?:到|至|前往)桂林/g, '从桂林前往阳朔');
    });
  }
  const nextFrom = String(out.from || out.startLocation || '').trim();
  const nextTo = String(out.to || out.endLocation || '').trim();
  if (!nextFrom && /阳朔/.test(nextTo)) {
    const source = explicitFourStar ? '竹江码头' : '桂林';
    if (out.from !== undefined) out.from = source;
    if (out.startLocation !== undefined) out.startLocation = source;
  }
  if (!nextTo && /桂林/.test(nextFrom)) {
    if (out.to !== undefined) out.to = '阳朔';
    if (out.endLocation !== undefined) out.endLocation = '阳朔';
  }
  return out;
}

function normalizeLijiangCruiseOutline(outline) {
  const days = asArray(outline && outline.days);
  const replacePier = (value) => String(value || '').replace(/磨盘山(?:码头)?/g, '竹江码头');
  const replaceFourStarPier = (value) => replacePier(value)
    .replace(/(?:桂林|漓江)(?:市)?(?:游船)?码头/g, '竹江码头');
  days.forEach((day) => {
    const text = dayTextForCruise(day);
    const explicitFourStar = /(?:四星|4\s*星)/.test(text);
    const explicitOtherShip = /(?:三星|3\s*星|普通游船|三星级)/.test(text);
    const explicitShip = explicitFourStar || explicitOtherShip;
    const cruiseContext = /(?:漓江|磨盘山|竹江|阳朔)/.test(text)
      && /(?:游船|游览船|船游|ship|cruise|船)/i.test(text);
    if (!cruiseContext || !explicitShip) return;
    if (explicitFourStar) {
      ['city', 'theme', 'note', 'hotel'].forEach((field) => {
        if (day[field]) day[field] = replacePier(day[field]);
      });
      day.highlights = asArray(day.highlights).map(replacePier);
    }
    day.moves = asArray(day.moves).map((move) => {
      const next = Object.assign({}, move);
      const moveText = `${next.from || ''} ${next.to || ''} ${next.activity || ''} ${next.transfer || ''} ${next.note || ''} ${next.mode || ''}`;
      const isCruiseMove = /(?:漓江|磨盘山|竹江|阳朔|桂林)/.test(moveText)
        && /(?:游船|游览船|船游|ship|cruise|船)/i.test(moveText);
      // 四星游船当天的前序接驳也必须直接去竹江，不能先到磨盘山再折返；
      // 这类接驳本身没有“游船”字样，所以不能只依赖 isCruiseMove。
      const fourStarFeeder = explicitFourStar && !isCruiseMove
        && /(?:磨盘山|(?:桂林|漓江)(?:市)?(?:游船)?码头)/.test(moveText);
      if (fourStarFeeder) {
        ['from', 'to', 'activity', 'transfer', 'note'].forEach((field) => {
          if (next[field]) next[field] = replaceFourStarPier(next[field]);
        });
      }
      if (!isCruiseMove && !fourStarFeeder) return next;
      if (explicitFourStar) {
        ['from', 'to', 'activity', 'transfer', 'note'].forEach((field) => {
          if (next[field]) next[field] = replaceFourStarPier(next[field]);
        });
        if (!next.from || /磨盘山/.test(String(next.from))) next.from = '竹江码头';
      }
      normalizeCruiseDirection(next, explicitFourStar);
      const note = cruiseDirectionNote(explicitFourStar, explicitOtherShip);
      next.note = String(next.note || '').includes(note)
        ? next.note : [next.note, note].filter(Boolean).join('；');
      return next;
    }).filter((move) => !(move
      // 归一化后仍可能出现“竹江码头→桂林竹江码头”的旧接驳，
      // 它不是实际游船段，只会让用户在同一片区来回折返。
      && /竹江码头/.test(String(move.from || ''))
      && /竹江码头/.test(String(move.to || ''))
      && !/ship|游船|船|轮渡/i.test(String(move.mode || '') + String(move.transfer || ''))));
  });
  return outline;
}

function dayTextForCruise(day) {
  return `${day && day.city || ''} ${day && day.theme || ''} ${day && day.note || ''} ${day && day.hotel || ''} `
    + `${asArray(day && day.highlights).join(' ')} ${asArray(day && day.moves).map((m) => `${m && m.from || ''} ${m && m.to || ''} ${m && m.transfer || ''} ${m && m.mode || ''} ${m && m.note || ''}`).join(' ')}`;
}

function normalizeLijiangCruiseItems(items, outline) {
  const cruiseDays = new Set(asArray(outline && outline.days)
    .filter((day) => {
      const text = dayTextForCruise(day);
      const hasCruiseMove = asArray(day && day.moves).some((move) =>
        /ship|游船|船|轮渡/i.test(String(move && move.mode || ''))
        && /(?:漓江|磨盘山|竹江|阳朔龙头山|阳朔|桂林)/.test(`${move && move.from || ''} ${move && move.to || ''}`));
      const inferredLijiangCruise = /漓江[^\n]{0,20}(?:游船|船游)|(?:游船|船游)[^\n]{0,20}阳朔/.test(text);
      return /(?:四星|4\s*星|三星|3\s*星|普通游船)/.test(text)
        && /(?:漓江|磨盘山|竹江)/.test(text)
        && /(?:游船|游览船|船游|ship|cruise|船)/i.test(text)
        || hasCruiseMove || inferredLijiangCruise;
    })
    .map((day) => asArray(outline && outline.days).indexOf(day)));
  const dayItemTexts = new Map();
  asArray(items).forEach((row) => {
    const index = Number(row && row.dayIndex || 0);
    const text = `${row && row.activity || ''} ${row && row.note || ''} ${row && row.startLocation || ''} ${row && row.endLocation || ''}`;
    dayItemTexts.set(index, `${dayItemTexts.get(index) || ''} ${text}`);
  });
  const normalized = asArray(items).map((item) => {
    if (!item) return item;
    const text = `${item.activity || ''} ${item.note || ''} ${item.startLocation || ''} ${item.endLocation || ''} ${item.bookingInfo || ''}`;
    const explicitFourStar = /(?:四星|4\s*星)/.test(text);
    const explicitOtherShip = /(?:三星|3\s*星|普通游船|三星级)/.test(text);
    const cruiseContext = /(?:漓江|磨盘山|竹江)/.test(text)
      && /(?:游船|游览船|船游|ship|cruise|船)/i.test(text);
    const dayIndex = Number(item.dayIndex || 0);
    const dayCruiseContext = cruiseDays.has(dayIndex);
    const dayOutline = asArray(outline && outline.days)[dayIndex] || {};
    const dayCruiseText = dayCruiseContext
      ? `${dayTextForCruise(dayOutline)} ${dayItemTexts.get(dayIndex) || ''}` : '';
    const fourStarContext = explicitFourStar || /(?:四星|4\s*星)/.test(dayCruiseText);
    const otherShipContext = explicitOtherShip || /(?:三星|3\s*星|普通游船|三星级)/.test(dayCruiseText);
    const bambooContext = dayCruiseContext && /竹江码头/.test(dayCruiseText);
    // 同一天驶向旧码头的接驳也必须同步改到竹江码头，不能只修正船上
    // 那一行，留下“先去磨盘山、再从竹江上船”的断链。
    if ((!cruiseContext && !dayCruiseContext)) return item;
    const out = Object.assign({}, item);
    const replacePier = (value) => String(value || '').replace(/磨盘山(?:码头)?/g, '竹江码头');
    if (fourStarContext) {
      ['activity', 'note', 'startLocation', 'endLocation', 'bookingInfo'].forEach((field) => {
        if (out[field]) out[field] = replacePier(out[field]);
      });
    }
    const isCruiseItem = out.transportType === 'ship'
      || (['transport', 'ticket', 'sight'].includes(String(out.category || ''))
        && /(?:登船|乘船|船游|漓江[^。；，,]{0,24}游船|游船[^。；，,]{0,24}(?:航行|从|前往|抵达)|乘坐[^。；，,]{0,20}(?:漓江|游船|轮渡|渡船))/.test(out.activity || ''));
    const genericPier = /(?:桂林|漓江)(?:市)?(?:码头|游船码头)|磨盘山/.test(String(out.endLocation || ''))
      && !/竹江|阳朔/.test(String(out.endLocation || ''));
    if (fourStarContext && !isCruiseItem && out.category === 'transport' && genericPier) {
      ['activity', 'note', 'startLocation', 'endLocation', 'bookingInfo'].forEach((field) => {
        if (out[field]) {
          out[field] = String(out[field])
            .replace(/磨盘山(?:码头)?/g, '竹江码头')
            .replace(/(?:桂林|漓江)(?:市)?(?:游船)?码头/g, '竹江码头');
        }
      });
      out.endLocation = '竹江码头';
    }
    // 细化模型已经写了“旧住宿地→竹江码头”时，后续的大纲对齐有时还会
    // 留下一条“旧住宿地→桂林码头”的普通接驳。两条是同一段去船码头的
    // 交通，不能让人先到竹江又继续去另一个桂林码头；优先保留已经落到
    // 竹江码头的真实条目。这个判断只处理同日、同起点、相邻时段的码头
    // 接驳，不会影响阳朔下船后的市内交通。
    const alreadyAtBamboo = dayCruiseContext && !isCruiseItem && asArray(items).some((other) => {
      if (!other || other === item || other.category !== 'transport' || other.transportType === 'ship') return false;
      if (!/竹江码头/.test(String(other.endLocation || ''))) return false;
      if (!sameTravelArea(other.startLocation, out.startLocation)) return false;
      const otherEnd = toMin(other.endTime);
      const currentStart = toMin(out.startTime);
      return otherEnd === null || currentStart === null || Math.abs(otherEnd - currentStart) <= 45;
    });
    if (genericPier && alreadyAtBamboo) return null;
    if (isCruiseItem
      && (out.category === 'transport' || out.transportType === 'ship' || /游船|船/.test(out.activity || ''))
      && (dayCruiseContext || !out.startLocation || /码头/.test(String(out.startLocation)))) {
      // 只要大纲已经明确这是竹江码头出发的漓江船段，详细计划里即使
      // 把“兴坪段/磨盘山”写成了船的起点，也统一回写为竹江码头，
      // 后续的交通对齐才能识别为同一段而不是再补一艘重复游船。
      if (fourStarContext || bambooContext) out.startLocation = '竹江码头';
    }
    if (isCruiseItem) {
      if (['transport', 'sight'].includes(String(out.category || ''))) out.transportType = 'ship';
      // 高亮补齐有时会把“在20元人民币背景图内、在兴坪古镇内”直接
      // 拼到船上那一条的开头，变成“在景点内乘船”。这些是沿途景观，
      // 不能改变游船的出发/抵达语义；删除前缀后保留干净的船程描述。
      if (out.activity) {
        let activity = String(out.activity);
        for (let i = 0; i < 5; i++) {
          const next = activity
            .replace(/^(?:在)?(?:20元人民币背景图|兴坪古镇|九马画山|黄布倒影|相公山)(?:内|附近|景区)?[，,、；;]\s*/, '')
            .replace(/^[，,、；;]\s*/, '')
            .trim();
          if (next === activity) break;
          activity = next;
        }
        out.activity = activity;
      }
      normalizeCruiseDirection(out, fourStarContext);
      const cruiseNote = cruiseDirectionNote(fourStarContext, otherShipContext);
      if (!String(out.note || '').includes(cruiseNote)) {
        out.note = [out.note, cruiseNote].filter(Boolean).join('；');
      }
    }
    return out;
  }).filter(Boolean);

  // 游船已经从桂林驶抵阳朔后，模型偶尔会追加“阳朔→漓江游船”或
  // “抵达阳朔后再回船上”的接驳，并把兴坪/九马画山等船上景观重新排到
  // 下船之后。它们不是实际换乘，而是把同一段游船折叠成了往返路线。
  const isShipRow = (item) => item && (
    item.transportType === 'ship'
    || (/(?:登船|乘船|船游|漓江四星|漓江三星)/.test(String(item.activity || ''))
      && !/(?:前往|返回|回到)漓江游船/.test(String(item.activity || '')))
  );
  const drop = new Set();
  const byDay = new Map();
  normalized.forEach((item) => {
    const di = Number(item && item.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(item);
  });
  byDay.forEach((dayRows) => {
    // 游船体验有时被模型放在 sight，随后大纲对齐又补出一条同起终点的
    // transport。两条时间完全重叠时只保留带 ship 的游船体验，避免用户
    // 看到“同一时段既乘游船又乘大巴”的矛盾安排；前往码头的 feeder
    // 起终点不同，不会命中这里。
    const shipRows = dayRows.filter((item) => isShipRow(item)
      && item.startLocation && item.endLocation);
    shipRows.forEach((ship) => {
      const shipStart = toMin(ship.startTime);
      const shipEnd = toMin(ship.endTime);
      dayRows.forEach((other) => {
        if (!other || other === ship || other.category !== 'transport'
            || isShipRow(other) || !other.startLocation || !other.endLocation) return;
        if (!sameTravelArea(other.startLocation, ship.startLocation)
            || !sameTravelArea(other.endLocation, ship.endLocation)) return;
        const otherStart = toMin(other.startTime);
        const otherEnd = toMin(other.endTime);
        const overlap = shipStart === null || shipEnd === null || otherStart === null || otherEnd === null
          || (otherStart < shipEnd && shipStart < otherEnd);
        if (!overlap) return;
        drop.add(other);
        console.warn('[generatePlan] 同时段游船已覆盖重复陆路交通：%s→%s',
          other.startLocation, other.endLocation);
      });
    });
    const cruiseArrivals = dayRows.filter((item) => isShipRow(item)
      && toMin(item.endTime) !== null
      && /阳朔|龙头山|兴坪/.test(`${item.endLocation || ''} ${item.activity || ''}`))
      .map((item) => toMin(item.endTime));
    if (!cruiseArrivals.length) return;
    const cruiseEnd = Math.max(...cruiseArrivals);
    const arrivedYangshuo = dayRows.some((item) => isShipRow(item)
      && /阳朔|龙头山/.test(String(item.endLocation || ''))
      && toMin(item.endTime) !== null);
    dayRows.forEach((item) => {
      if (!item || item.category !== 'transport' || isShipRow(item)) return;
      const start = toMin(item.startTime);
      if (start === null || start < cruiseEnd) return;
      const text = `${item.activity || ''} ${item.note || ''} ${item.startLocation || ''} ${item.endLocation || ''}`;
      // 四星/三星桂林→阳朔船已经在阳朔下船，模型偶尔还会把船上
      // 经过的兴坪古镇写成“兴坪→阳朔”的后续接驳。这会让游客下船后
      // 又回到船上路线，直接删除；真正的兴坪段游船不会命中
      // arrivedYangshuo，因此不影响合法的“兴坪→阳朔”陆路接驳。
      if (arrivedYangshuo
          && /兴坪|九马画山|黄布倒影|相公山|20元人民币背景/.test(String(item.startLocation || '') + String(item.activity || ''))
          && /阳朔|龙头山|西街/.test(String(item.endLocation || '') + String(item.activity || ''))) {
        drop.add(item);
        console.warn('[generatePlan] 删除漓江船已抵阳朔后的重复陆路接驳：%s→%s',
          item.startLocation || '兴坪沿线', item.endLocation || '阳朔');
        return;
      }
      if (/漓江游船|游船甲板|客舱|船上/.test(text)
          && /阳朔|龙头山|兴坪/.test(text)) {
        drop.add(item);
        console.warn('[generatePlan] 清理游船抵达阳朔后的无效回船接驳：%s→%s',
          item.startLocation || '阳朔', item.endLocation || '漓江游船');
      }
    });
    // 船上景观属于桂林→阳朔船程，不能在下船后又安排一次兴坪/相公山
    // 的“漓江精华段”游览；阳朔本地的普通散步和晚餐不受影响。
    dayRows.forEach((item) => {
      if (!item || drop.has(item) || !['sight', 'other'].includes(String(item.category || ''))) return;
      const start = toMin(item.startTime);
      if (start === null || start < cruiseEnd) return;
      const text = `${item.activity || ''} ${item.note || ''}`;
      if (/兴坪|九马画山|黄布倒影|相公山|漓江精华段|20元人民币背景/.test(text)) {
        drop.add(item);
        console.warn('[generatePlan] 删除下船后重复的漓江船上景观：%s', item.activity || '');
      }
    });
  });
  // 详细游览查漏会把大纲高亮词追加到当天第一条 sight；若第一条是
  // 龙脊次日的日出，就不能把“兴坪/相公山/漓江精华段”拼进日出文案。
  normalized.forEach((item) => {
    if (!item || item.category !== 'sight') return;
    const activity = String(item.activity || '');
    if (!/西山韶乐/.test(activity) || !/日出/.test(activity)) return;
    item.activity = activity
      .replace(/在(?:阳朔|兴坪古镇|相公山观景台|相公山|20元人民币背景图打卡点|漓江精华段)内?[，,、；;]?/g, '')
      .replace(/(?:观赏)?(?:九马画山|黄布倒影)[^。；;，,]*(?:[。；;]|$)/g, '')
      .replace(/[，,、；;]{2,}/g, '，')
      .replace(/^[，,、；;]|[，,、；;]$/g, '')
      .trim();
  });
  return drop.size ? normalized.filter((item) => !drop.has(item)) : normalized;
}

/** 详细阶段确认船型/码头后，回写大纲中的同一段游船，避免两页出现不同出发码头。 */
function syncLijiangCruiseOutlineFromItems(outline, items) {
  const days = asArray(outline && outline.days);
  asArray(items).forEach((item) => {
    const text = `${item && item.activity || ''} ${item && item.note || ''} ${item && item.bookingInfo || ''}`;
    const explicitFourStar = /(?:四星|4\s*星)/.test(text);
    const explicitOtherShip = /(?:三星|3\s*星|普通游船|三星级)/.test(text);
    const cruiseMention = /(?:漓江|游船|船)/.test(text);
    if (!item || !cruiseMention
      || (!/竹江码头/.test(`${item.startLocation || ''} ${text}`) && !explicitOtherShip)) return;
    const day = days[Number(item.dayIndex || 0)];
    if (!day) return;
    const replacePier = (value) => String(value || '').replace(/磨盘山(?:码头)?/g, '竹江码头');
    if (explicitFourStar) day.highlights = asArray(day.highlights).map(replacePier);
    day.moves = asArray(day.moves).map((move) => {
      const routeText = `${move && move.from || ''} ${move && move.to || ''} ${move && move.mode || ''} ${move && move.transfer || ''}`;
      const feederToConfirmedPier = item.startLocation && /竹江码头/.test(String(item.startLocation))
        && move && move.to && /磨盘山|竹江|桂林(?:市)?(?:游船)?码头/.test(routeText)
        && !/ship|游船|船|轮渡/.test(routeText);
      const sameDestination = feederToConfirmedPier || (item.endLocation && move && move.to
        && (sameTravelArea(item.endLocation, move.to) || String(item.endLocation).includes(String(move.to))
          || String(move.to).includes(String(item.endLocation))));
      if (!move || !(/ship|游船|船/.test(routeText) || /磨盘山|竹江|桂林|阳朔/.test(routeText)) || !sameDestination) return move;
      const next = Object.assign({}, move);
      if (explicitFourStar) {
        if (feederToConfirmedPier) next.to = item.startLocation;
        else next.from = '竹江码头';
        next.transfer = replacePier(move.transfer);
      } else if (explicitOtherShip) {
        if (item.startLocation) next.from = item.startLocation;
        if (item.endLocation) next.to = item.endLocation;
        normalizeCruiseDirection(next, false);
      }
      const cruiseNote = cruiseDirectionNote(explicitFourStar, explicitOtherShip);
      if (!String(next.note || '').includes(cruiseNote)) {
        next.note = [next.note, cruiseNote].filter(Boolean).join('；');
      }
      return next;
    });
  });
  return outline;
}

/** 竹江码头游船回填后，把“下船后入住/游玩”重新放到游船之后。 */
function repairLijiangCruiseSequence(items, outline) {
  const rows = asArray(items);
  asArray(outline && outline.days).forEach((day, dayIndex) => {
    const cruiseMove = asArray(day && day.moves).find((move) =>
      move && /ship|游船|船|轮渡/i.test(String(move.mode || ''))
      && (/竹江码头|磨盘山码头/.test(String(move.from || ''))
        || (/桂林/.test(String(move.from || '')) && /阳朔/.test(String(move.to || '')))));
    if (!cruiseMove) return;
    const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === dayIndex);
    const cruise = dayRows
      .filter((item) => item && (item.outlineMove === true || item.transportType === 'ship'
        || /(?:漓江|三星|四星|游船|乘船|船游)/.test(String(item.activity || ''))))
      .filter((item) => item.endLocation && toMin(item.endTime) !== null)
      .sort((a, b) => (toMin(b.endTime) || 0) - (toMin(a.endTime) || 0))[0];
    if (!cruise) return;
    const cruiseEnd = toMin(cruise.endTime);
    if (cruiseEnd === null) return;
    dayRows.forEach((item) => {
      if (!item || item === cruise || !item.startLocation
          || !['hotel', 'food', 'sight', 'other'].includes(String(item.category || ''))) return;
      const start = toMin(item.startTime);
      if (start === null || start >= cruiseEnd || !sameTravelArea(item.startLocation, cruise.endLocation)) return;
      const end = toMin(item.endTime);
      const duration = end !== null && end > start ? end - start : 30;
      item.startTime = fmtMin(Math.min(cruiseEnd + 10, 23 * 60));
      item.endTime = fmtMin(Math.min(item.startTime ? toMin(item.startTime) + duration : cruiseEnd + 40, 23 * 60 + 59));
      item.timingEstimated = true;
      item.note = [item.note, '已按竹江码头游船抵达后顺序重排'].filter(Boolean).join('；');
    });
  });
  return rows;
}

/**
 * 龙脊核心点识别。
 *
 * 模型经常把“游览千层天梯，沿单向步道前往金佛顶”写成一条连续的
 * 千层天梯段。不能因为文案提到了下一个点，就把它误判成“已经游览金佛顶”；
 * 否则同一条路线会被重复补成两段金佛顶。只有明确写了在/游览/观赏金佛顶，
 * 或把金佛顶作为日落观景点，才算金佛顶实际游览。
 */
function isLongjiWestVisit(item) {
  const activity = String(item && item.activity || '');
  return item && item.category === 'sight'
    && /西山韶乐/.test(activity)
    && !/返回|回到|下山|途经|经过/.test(activity);
}

function isLongjiLadderVisit(item) {
  const activity = String(item && item.activity || '');
  return item && item.category === 'sight'
    && /千层天梯|2号天梯|2号观景台/.test(activity)
    && !/西山韶乐/.test(activity)
    && !/^(?:游览|前往|抵达|到达)?\s*金佛顶/.test(activity);
}

function isLongjiGoldenVisit(item) {
  const activity = String(item && item.activity || '');
  if (!item || item.category !== 'sight' || !/金佛顶|3号观景台/.test(activity)) return false;
  // “千层天梯→前往金佛顶”仍是前一段路线，不算已在金佛顶停留。
  if (/千层天梯|2号天梯|2号观景台/.test(activity)
      && /前往|前去|走向|到达|抵达/.test(activity)
      && !/(?:在|游览|观赏|观看|欣赏|停留|驻足)金佛顶|金佛顶观景台/.test(activity)) return false;
  return /(?:游览|观赏|观看|欣赏|停留|驻足|拍照|等待|日落|夕阳|落日)/.test(activity);
}

function isLongjiGoldenMention(item) {
  if (isLongjiGoldenVisit(item)) return true;
  const activity = String(item && item.activity || '');
  return item && item.category === 'sight'
    && /金佛顶|3号观景台/.test(activity)
    && /日落|夕阳|落日/.test(activity)
    && /千层天梯|2号天梯|2号观景台/.test(activity)
    && /前往|前去|上行|走向/.test(activity);
}

/** 详细阶段必须把龙脊三处核心观景台落实成三个独立游览段。 */
function ensureLongjiDetailRoute(items, outline) {
  const rows = asArray(items);
  asArray(outline && outline.days).forEach((day, dayIndex) => {
    const highlights = asArray(day && day.highlights).join(' ');
    if (!/西山韶乐/.test(highlights) || !/千层天梯|2号天梯|2号观景台/.test(highlights)
      || !/金佛顶|3号观景台/.test(highlights)) return;
    const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === dayIndex);
    const sightRows = dayRows.filter((item) => item && item.category === 'sight');
    const hasWest = sightRows.some(isLongjiWestVisit);
    const hasLadder = sightRows.some(isLongjiLadderVisit);
    const hasGolden = sightRows.some(isLongjiGoldenVisit);
    if (hasWest && hasLadder && hasGolden) return;

    const firstOf = (pattern, extra) => sightRows
      .filter((item) => pattern.test(String(item.activity || ''))
        && (!extra || extra(item)))
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
    const west = firstOf(/西山韶乐/, isLongjiWestVisit);
    const ladder = firstOf(/千层天梯|2号天梯|2号观景台/, isLongjiLadderVisit);
    const golden = firstOf(/金佛顶|3号观景台/, isLongjiGoldenVisit);
    const firstExisting = !hasWest ? (west || ladder || golden)
      : !hasLadder ? (ladder || golden) : golden;
    const base = String(day.hotel || day.overnight || day.city || '龙脊住宿地').trim();
    const make = (name, start, end, from, to, activity) => ({
      dayIndex,
      startTime: fmtMin(start),
      endTime: fmtMin(end),
      activity,
      category: 'sight',
      startLocation: from,
      endLocation: to,
      transportType: 'walk',
      note: '龙脊核心路线按西山韶乐→千层天梯→金佛顶，避免中途折返',
    });

    // 模型有时把龙脊三处核心点全写进大纲，却在细化阶段只留下“到达/入住”
    // 和次日的日出，导致 firstExisting 为空，原来的“缺一补一”没有锚点，
    // 最终整天只剩交通。时间足够时直接按抵达、入住后的空档生成一条完整
    // 的景区骨架；金佛顶的开始时间贴着当地日落前约 30 分钟，西山韶乐和
    // 千层天梯沿单向路线安排，等待日落的空档明确写成原地休息，不制造折返。
    if (!hasWest && !hasLadder && !hasGolden && !firstExisting) {
      const arrivalEnd = asArray(day && day.moves)
        .filter((move) => move && toMin(move.endTime) !== null
          && /龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.to || '')))
        .map((move) => toMin(move.endTime))
        .sort((a, b) => b - a)[0];
      const departureStart = asArray(day && day.moves)
        .filter((move) => move && toMin(move.startTime) !== null
          && /龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.from || ''))
          && !/龙脊|金坑大寨|田头寨|西山韶乐/.test(String(move.to || '')))
        .map((move) => toMin(move.startTime))
        .sort((a, b) => a - b)[0];
      const occupiedEnds = dayRows
        .filter((item) => item && toMin(item.endTime) !== null
          && ['hotel', 'food', 'other'].includes(String(item.category || ''))
          && !/日出|日落|西山韶乐|千层天梯|金佛顶/.test(String(item.activity || '')))
        .map((item) => toMin(item.endTime));
      const arrivalBase = arrivalEnd === undefined ? 10 * 60 : arrivalEnd + 10;
      const afterExisting = occupiedEnds.length ? Math.max(...occupiedEnds) + 10 : arrivalBase;
      const routeStart = Math.max(arrivalBase, afterExisting);
      const sunset = longjiSolarMinute(day && day.date, true);
      const latestEnd = departureStart === undefined
        ? 21 * 60
        : Math.max(0, departureStart - 20);
      let goldenStart = sunset === null ? Math.min(17 * 60, latestEnd - 50) : sunset - 30;
      const fixedMinutes = 70 + 25 + 100 + 25 + 50;
      if (goldenStart < routeStart + fixedMinutes - 20) goldenStart = routeStart + fixedMinutes - 20;
      const goldenEnd = goldenStart + 50;
      if (routeStart < 23 * 60 && goldenEnd <= latestEnd && goldenEnd <= 23 * 60 + 30) {
        const westEnd = routeStart + 70;
        const ladderTransferStart = westEnd;
        const ladderStart = ladderTransferStart + 25;
        const ladderEnd = ladderStart + 100;
        const goldenTransferStart = ladderEnd;
        const goldenTransferEnd = goldenTransferStart + 25;
        rows.push(make('west', routeStart, westEnd, base, '西山韶乐观景台',
          '游览西山韶乐观景台，按景区单向路线前往千层天梯'));
        rows.push({
          dayIndex,
          startTime: fmtMin(ladderTransferStart),
          endTime: fmtMin(ladderStart),
          activity: '沿景区单向步道从西山韶乐前往千层天梯',
          category: 'transport',
          startLocation: '西山韶乐观景台',
          endLocation: '千层天梯观景台',
          transportType: 'walk',
          note: '按景区游览方向前进，不回到西山韶乐折返',
        });
        rows.push(make('ladder', ladderStart, ladderEnd, '西山韶乐观景台', '千层天梯观景台',
          '游览千层天梯观景台，沿单向步道继续前往金佛顶'));
        rows.push({
          dayIndex,
          startTime: fmtMin(goldenTransferStart),
          endTime: fmtMin(goldenTransferEnd),
          activity: '沿景区游览方向从千层天梯前往金佛顶',
          category: 'transport',
          startLocation: '千层天梯观景台',
          endLocation: '金佛顶观景台',
          transportType: 'walk',
          note: '按单向路线前进，预留金佛顶日落观景时间',
        });
        if (goldenTransferEnd < goldenStart) {
          rows.push({
            dayIndex,
            startTime: fmtMin(goldenTransferEnd),
            endTime: fmtMin(goldenStart),
            activity: '在金佛顶观景区域休息，等待日落',
            category: 'other',
            startLocation: '金佛顶观景台',
            endLocation: '金佛顶观景台',
            transportType: 'walk',
            note: '原地等待日落，不返回西山韶乐或千层天梯',
          });
        }
        rows.push(make('golden', goldenStart, goldenEnd, '千层天梯观景台', '金佛顶观景台',
          '游览金佛顶观景台，预留观景与日落时间'));
        console.warn('[generatePlan] 第%d天细化缺失龙脊核心点，补齐西山韶乐→千层天梯→金佛顶：%s-%s',
          dayIndex + 1, fmtMin(routeStart), fmtMin(goldenEnd));
      }
    }
    const missingBefore = [];
    if (!hasWest) missingBefore.push('west');
    if (!hasLadder) missingBefore.push('ladder');
    // 缺少的前置观景台要放在现有第一个核心点之前，按路线顺序连续补齐；
    // fixDayTimeOverlaps 会再根据午餐/交通等真实条目顺延，不会制造重叠。
    if (missingBefore.length && firstExisting) {
      const targetStart = toMin(firstExisting.startTime) ?? 12 * 60;
      let cursor = targetStart - missingBefore.length * 60;
      if (cursor >= 5 * 60) {
        missingBefore.forEach((name) => {
          const next = name === 'west'
            ? make(name, cursor, cursor + 60, base, '西山韶乐', '游览西山韶乐观景台，按单向路线前往千层天梯')
            : make(name, cursor, cursor + 60, '西山韶乐', '千层天梯', '游览千层天梯观景台，沿单向步道前往金佛顶');
          rows.push(next);
          console.warn('[generatePlan] 第%d天补齐龙脊%s核心游览：%s-%s',
            dayIndex + 1, name === 'west' ? '西山韶乐' : '千层天梯', fmtMin(cursor), fmtMin(cursor + 60));
          cursor += 60;
        });
      }
    }
    if (!hasGolden) {
      const previous = [west, ladder].filter(Boolean)
        .sort((a, b) => (toMin(b.endTime) ?? 0) - (toMin(a.endTime) ?? 0))[0];
      const start = previous && toMin(previous.endTime) !== null
        ? toMin(previous.endTime) : null;
      if (start !== null && start >= 5 * 60 && start + 90 <= 23 * 60 + 30) {
        rows.push(make('golden', start, start + 90, '千层天梯', '金佛顶', '游览金佛顶观景台，预留观景与日落时间'));
        console.warn('[generatePlan] 第%d天补齐龙脊金佛顶核心游览：%s-%s',
          dayIndex + 1, fmtMin(start), fmtMin(start + 90));
      }
    }
  });
  return rows;
}

/**
 * 统一龙脊三处核心观景台的实际时间线。
 *
 * 模型有时会先写“千层天梯”，再补一段“去西山韶乐”，导致时间线出现
 * 西山韶乐→千层天梯→西山韶乐→金佛顶。这里只调整同一天已经生成的核心段
 * 和通往西山韶乐的接驳，不改其它景点；按西山韶乐→千层天梯→金佛顶重排，
 * 末尾回西山韶乐休息仍然保留。规则只依赖景点路线关系，不依赖城市映射。
 */
function normalizeLongjiCoreRoute(items, outline) {
  const rows = asArray(items);
  const redundant = new Set();
  const positive = (text) => !/(不绕行|不去|不安排|不前往|不考虑|勿前往|不登|明天|次日|后一天|储备精力)/.test(text);
  const timeOf = (item) => toMin(item && item.startTime);
  const durationOf = (item) => {
    const start = toMin(item && item.startTime);
    const end = toMin(item && item.endTime);
    if (start !== null && end !== null && end > start) return end - start;
    return Math.max(30, Math.min(180, parseDurationMin(`${item && item.note || ''} ${item && item.activity || ''}`) || 60));
  };
  const textOf = (item) => `${item && item.activity || ''} ${item && item.startLocation || ''} ${item && item.endLocation || ''}`;
  asArray(outline && outline.days).forEach((day, dayIndex) => {
    const highlights = asArray(day && day.highlights).join(' ');
    if (!/西山韶乐/.test(highlights)
      || !/千层天梯|2号天梯|2号观景台/.test(highlights)
      || !/金佛顶|3号观景台/.test(highlights)) return;
    const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === dayIndex);
    const sights = dayRows.filter((item) => item && item.category === 'sight' && positive(String(item.activity || '')));
    const first = (pattern, extra) => sights.filter((item) => pattern.test(textOf(item))
      && (!extra || extra(item))).sort((a, b) => (timeOf(a) ?? 1440) - (timeOf(b) ?? 1440))[0];
    const west = first(/西山韶乐/, isLongjiWestVisit);
    const ladder = first(/千层天梯|2号天梯|2号观景台/, isLongjiLadderVisit);
    const golden = first(/金佛顶|3号观景台/, isLongjiGoldenVisit);
    // “西山韶乐→千层天梯→西山韶乐→金佛顶”里的第二个西山韶乐
    // 通常是模型重复安排的观景段；真正写成“回住宿地休息”的条目保留，
    // 这样用户提出的“看完金佛顶回去休息”仍然是合理闭环。
    // 只按“实际游览 activity”识别重复观景台。千层天梯这一段的
    // startLocation 会合法地写成“西山韶乐”，如果把起终点也当作重复
    // 观景，就会在补齐后把“西山韶乐→千层天梯”整段误删。
    sights.filter((item) => /西山韶乐/.test(String(item.activity || '')) && item !== west)
      .forEach((item) => {
        if (!/休息|回酒店|回民宿|返回住宿|回到.*住宿/.test(String(item.activity || ''))) redundant.add(item);
      });
    if (!west || !ladder || !golden) return;
    const westAt = timeOf(west) ?? 1440;
    const ladderAt = timeOf(ladder) ?? 1440;
    const goldenAt = timeOf(golden) ?? 1440;
    if (westAt <= ladderAt && ladderAt <= goldenAt) return;

    const westName = '西山韶乐观景台';
    const ladderName = '千层天梯观景台';
    const goldenName = '金佛顶观景台';
    // 选当前时间上最接近西山韶乐的“到西山”接驳，避免把末尾
    // “金佛顶→西山休息”误当成前序接驳。
    const bridge = dayRows.filter((item) => item && item.category === 'transport'
      && /西山韶乐/.test(`${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`)
      && (timeOf(item) ?? 1440) <= westAt)
      .sort((a, b) => Math.abs((toMin(a.endTime) ?? timeOf(a) ?? 1440) - westAt)
        - Math.abs((toMin(b.endTime) ?? timeOf(b) ?? 1440) - westAt))[0];
    let cursor = Math.min(westAt, ladderAt, goldenAt);
    if (!Number.isFinite(cursor) || cursor >= 1440) cursor = 12 * 60;
    if (bridge) {
      const bridgeDuration = durationOf(bridge);
      bridge.startTime = fmtMin(cursor);
      bridge.endTime = fmtMin(Math.min(cursor + bridgeDuration, 23 * 60 + 59));
      bridge.endLocation = westName;
      bridge.outlineMove = bridge.outlineMove === true;
      cursor += bridgeDuration;
    }
    [west, ladder, golden].forEach((item) => {
      const duration = durationOf(item);
      item.startTime = fmtMin(cursor);
      item.endTime = fmtMin(Math.min(cursor + duration, 23 * 60 + 59));
      cursor += duration;
    });
    west.endLocation = westName;
    ladder.startLocation = westName;
    ladder.endLocation = ladderName;
    golden.startLocation = ladderName;
    golden.endLocation = goldenName;
    const routeNote = '龙脊核心路线已按西山韶乐→千层天梯→金佛顶重排，避免中途折返';
    [west, ladder, golden].forEach((item) => {
      item.note = String(item.note || '').includes(routeNote)
        ? item.note : [item.note, routeNote].filter(Boolean).join('；');
    });
    console.warn('[generatePlan] 第%d天修正龙脊核心路线：西山韶乐→千层天梯→金佛顶', dayIndex + 1);
  });
  return rows.filter((item) => !redundant.has(item));
}

/**
 * 龙脊最终时间线收口。
 *
 * 前置清洗可能先生成了“金佛顶→西山”的回程，再被景区回折审计删掉金佛顶
 * 正文；也可能在次日离开前残留一条“索道上山游览千层天梯和金佛顶”。
 * 这里在所有会删景点的规则之后再做一次事实校正：补回缺失的核心游览，
 * 把金佛顶后的返回安排推到观景结束，并清掉已经在前一天完成的重复核心点。
 */
function repairLongjiCoreTimeline(items, outline) {
  const rows = asArray(items).slice();
  const drop = new Set();
  const coreDays = [];
  const positive = (text) => !/(不去|不安排|不前往|不考虑|勿前往|不登|明天|次日|后一天)/.test(text);
  const durationOf = (item, fallback) => {
    const start = toMin(item && item.startTime);
    const end = toMin(item && item.endTime);
    return start !== null && end !== null && end > start ? end - start : fallback;
  };
  const isGolden = (item) => positive(String(item && item.activity || ''))
    && isLongjiGoldenVisit(item);
  const isLadder = (item) => positive(String(item && item.activity || ''))
    && isLongjiLadderVisit(item);
  const isWest = (item) => positive(String(item && item.activity || ''))
    && isLongjiWestVisit(item);

  asArray(outline && outline.days).forEach((day, dayIndex) => {
    const highlights = asArray(day && day.highlights).join(' ');
    if (!/西山韶乐/.test(highlights)
        || !/千层天梯|2号天梯|2号观景台/.test(highlights)
        || !/金佛顶|3号观景台/.test(highlights)) return;
    const dayRows = rows.filter((item) => Number(item && item.dayIndex || 0) === dayIndex);
    const west = dayRows.filter(isWest).sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
    const ladder = dayRows.filter(isLadder).sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
    const goldenCandidates = dayRows.filter((item) => positive(String(item && item.activity || ''))
      && isLongjiGoldenMention(item));
    const directGoldenCandidates = goldenCandidates.filter(isLongjiGoldenVisit);
    const golden = (directGoldenCandidates.length ? directGoldenCandidates : goldenCandidates).slice().sort((a, b) => {
      const sunsetA = /日落|夕阳|落日/.test(String(a.activity || '')) ? 1 : 0;
      const sunsetB = /日落|夕阳|落日/.test(String(b.activity || '')) ? 1 : 0;
      if (sunsetA !== sunsetB) return sunsetB - sunsetA;
      return durationOf(b, 0) - durationOf(a, 0);
    })[0];
    if (!west || !ladder || !golden) return;
    coreDays.push(dayIndex);

    // 详细高亮补齐有时会额外生成一条只有几十分钟的“金佛顶”说明，
    // 再接一条真正的日落观景；同一景点不应连续显示两次。
    goldenCandidates.filter((item) => item !== golden).forEach((item) => {
      drop.add(item);
      console.warn('[generatePlan] 合并龙脊同日重复的金佛顶游览：%s', item.activity || '');
    });

    // 模型也常把“千层天梯→金佛顶”写在千层天梯这一条里，随后又
    // 单独生成金佛顶观景。两条记录在空间上是连续路线，但前一条不能
    // 再把金佛顶算成已游览，否则前端和测试都会显示“重复金佛顶”。
    // 保留千层天梯这段实际时长，只收窄文案，不删除单向步道逻辑。
    if (directGoldenCandidates.length) {
      dayRows.filter((item) => item !== golden
        && isLongjiLadderVisit(item)
        && /金佛顶|3号观景台/.test(String(item.activity || ''))
        && /前往|前去|上行|走向/.test(String(item.activity || '')))
        .forEach((item) => {
          item.activity = '游览千层天梯观景台，按景区单向路线继续前行';
          item.endLocation = '千层天梯观景台';
          item.note = [item.note, '金佛顶由后续独立观景段安排，本段不重复计入'].filter(Boolean).join('；');
          console.warn('[generatePlan] 收窄龙脊千层天梯段文案，避免与独立金佛顶重复：%s', item.activity);
        });
    }

    const base = String(day.hotel || day.overnight || day.city || '龙脊住宿地').trim();
    west.startLocation = base;
    west.endLocation = '西山韶乐观景台';
    ladder.startLocation = '西山韶乐观景台';
    ladder.endLocation = '千层天梯观景台';
    golden.startLocation = '千层天梯观景台';
    golden.endLocation = '金佛顶观景台';

    const goldenStart = toMin(golden.startTime);
    const goldenEnd = toMin(golden.endTime);
    if (goldenStart !== null && goldenEnd !== null) {
      // “前往民宿办理入住/放下行李”有时被模型错误地生成为 sight，
      // 并插在千层天梯与金佛顶之间。它不是新的景点，而是把西山韶乐
      // 折返回核心路线中间的隐性跳点。若当天更早已有入住/放行李，
      // 直接删除重复项；若这是唯一入住段，则把它顺延到金佛顶观景
      // 结束后，保证路线始终是西山韶乐→千层天梯→金佛顶→住宿。
      const ladderEnd = toMin(ladder.endTime) ?? toMin(ladder.startTime) ?? goldenStart;
      const westStart = toMin(west.startTime) ?? 0;
      const isLodgingInterlude = (item) => {
        const text = `${item && item.activity || ''} ${item && item.note || ''} ${item && item.startLocation || ''} ${item && item.endLocation || ''}`;
        return /办理入住|入住|放下行李|放行李|寄存大件行李|住宿|民宿|客栈|酒店/.test(text)
          && /西山韶乐|千层天梯|金佛顶|观景台|龙脊|住宿|民宿|客栈|酒店/.test(text);
      };
      const hasEarlierLodging = dayRows.some((item) => item !== golden && isLodgingInterlude(item)
        && (toMin(item.startTime) ?? 1440) < westStart
        && (toMin(item.endTime) ?? toMin(item.startTime) ?? 1440) <= ladderEnd + 5);
      dayRows.forEach((item) => {
        if (!item || item === golden || !isLodgingInterlude(item)) return;
        const start = toMin(item.startTime);
        if (start === null || start < ladderEnd - 5 || start >= goldenStart) return;
        if (hasEarlierLodging) {
          drop.add(item);
          console.warn('[generatePlan] 第%d天删除龙脊核心路线中间重复入住/放行李：%s',
            dayIndex + 1, String(item.activity || '').slice(0, 80));
          return;
        }
        const duration = Math.max(20, durationOf(item, 30));
        const returnStart = Math.min(1430, goldenEnd + 10);
        item.startTime = fmtMin(returnStart);
        item.endTime = fmtMin(Math.min(1439, returnStart + duration));
        item.category = 'hotel';
        item.startLocation = String(golden.endLocation || '金佛顶观景台').trim();
        item.endLocation = base;
        item.activity = `金佛顶观景结束后返回${base}办理入住，放下行李休息`;
        item.note = [item.note, '已移到金佛顶观景结束后，避免西山韶乐与核心路线中途折返'].filter(Boolean).join('；');
        item.timingEstimated = true;
        console.warn('[generatePlan] 第%d天将龙脊中间入住顺延到金佛顶之后：%s-%s',
          dayIndex + 1, item.startTime, item.endTime);
      });
      dayRows.forEach((item) => {
        if (!item || item.category !== 'transport' || item === golden) return;
        const start = toMin(item.startTime);
        if (start === null || start >= goldenStart) return;
        const text = `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`;
        if (!/金佛顶|3号观景台/.test(text) || !/西山韶乐|住宿|民宿|客栈|酒店/.test(text)) return;
        const duration = durationOf(item, 45);
        item.startTime = fmtMin(goldenEnd);
        item.endTime = fmtMin(Math.min(1439, goldenEnd + duration));
        item.timingEstimated = true;
        item.note = [item.note, '金佛顶观景结束后再返回住宿点，避免在日落前折返'].filter(Boolean).join('；');
      });

      // 日落等待只能发生在金佛顶日落前。模型有时把同一条“等待日落”
      // 顺延到晚餐之后（甚至 23:57），会把晚餐和休息一起推到深夜。
      // 删除这类过期占位后，把后续普通活动按“观景结束→回住宿→晚餐”
      // 的最早可行顺序前移；已经核验的城际交通仍保持原时刻。
      const lateSunsetWaits = dayRows.filter((item) => item && item !== golden
        && /等待日落|等待夕阳|观赏日落/.test(String(item.activity || ''))
        && (toMin(item.startTime) ?? 0) >= goldenEnd);
      if (lateSunsetWaits.length) {
        lateSunsetWaits.forEach((item) => {
          drop.add(item);
          console.warn('[generatePlan] 删除龙脊日落结束后的过期等待：%s', item.activity || '');
        });
        let cursor = goldenEnd + 10;
        dayRows.filter((item) => item && item !== golden && !drop.has(item)
          && (toMin(item.startTime) ?? 1440) >= goldenEnd
          && item.schedSource !== '12306' && item.scheduleRequired !== true)
          .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))
          .forEach((item) => {
            const start = toMin(item.startTime);
            const end = toMin(item.endTime);
            if (start === null || end === null || end <= start) return;
            const duration = end - start;
            if (start > cursor) {
              item.startTime = fmtMin(cursor);
              item.endTime = fmtMin(Math.min(1439, cursor + duration));
              item.timingEstimated = true;
              item.note = [item.note, '已删除日落后重复等待，按金佛顶观景结束后的合理顺序前移'].filter(Boolean).join('；');
            }
            cursor = Math.max(cursor, (toMin(item.endTime) ?? cursor) + 10);
          });
      }

      // 日落校准会把金佛顶锁回太阳时刻；如果模型原本把千层天梯
      // 排在金佛顶之后，前面的顺序修复就会再次被覆盖。最终收口时
      // 以“金佛顶日落”为硬锚点，把西山韶乐和千层天梯压回它之前，
      // 并删掉日落之后重复的核心游览。普通午餐/休息可以适度收短，
      // 已核验大交通不改时刻；这样既保持单向路线，也不凭空制造折返。
      const coreMention = /西山韶乐|千层天梯|2号天梯|2号观景台|金佛顶|3号观景台/;
      dayRows.filter((item) => item && item !== west && item !== ladder && item !== golden
        && ['sight', 'other'].includes(String(item.category || ''))
        && coreMention.test(String(item.activity || ''))
        && (toMin(item.startTime) ?? 1440) >= goldenStart
        && !/返回|回到|下山|住宿|民宿|客栈|酒店|休息/.test(String(item.activity || '')))
        .forEach((item) => {
          drop.add(item);
          console.warn('[generatePlan] 第%d天删除金佛顶日落后的重复龙脊核心游览：%s',
            dayIndex + 1, String(item.activity || '').slice(0, 80));
        });
      dayRows.filter((item) => item && item !== ladder && item !== golden && isLadder(item)).forEach((item) => {
        drop.add(item);
        console.warn('[generatePlan] 第%d天删除重复千层天梯游览：%s',
          dayIndex + 1, String(item.activity || '').slice(0, 80));
      });

      const westAt = toMin(west.startTime) ?? 1440;
      const ladderAt = toMin(ladder.startTime) ?? 1440;
      if (westAt > ladderAt || ladderAt >= goldenStart) {
        let westDuration = Math.min(45, Math.max(30, durationOf(west, 45)));
        let ladderDuration = Math.min(60, Math.max(45, durationOf(ladder, 60)));
        const gap = 5;
        let routeStart = goldenStart - gap - westDuration - ladderDuration;
        const coreSet = new Set([west, ladder, golden]);
        // 先给核心路线留出完整窗口；普通餐饮/休息与景点可收尾让路。
        dayRows.filter((item) => item && !coreSet.has(item) && !drop.has(item)
          && !isTransportItem(item)
          && toMin(item.startTime) !== null && toMin(item.endTime) !== null
          && toMin(item.startTime) < goldenStart && toMin(item.endTime) > routeStart)
          .forEach((item) => {
            const start = toMin(item.startTime);
            const newEnd = routeStart - 5;
            if (start !== null && newEnd > start + 15) {
              item.endTime = fmtMin(newEnd);
              item.timingEstimated = true;
              item.note = [item.note, '为龙脊核心单向游览路线预留时间'].filter(Boolean).join('；');
            } else if (start !== null && start >= routeStart - 5) {
              drop.add(item);
              console.warn('[generatePlan] 第%d天删除与龙脊核心路线冲突的短活动：%s',
                dayIndex + 1, String(item.activity || '').slice(0, 80));
            }
          });
        const latestBlockEnd = dayRows.filter((item) => item && !coreSet.has(item) && !drop.has(item)
          && toMin(item.endTime) !== null && (toMin(item.endTime) ?? 0) <= goldenStart
          && (toMin(item.endTime) ?? 0) > routeStart)
          .map((item) => toMin(item.endTime)).sort((a, b) => b - a)[0];
        if (latestBlockEnd !== undefined && latestBlockEnd + 5 > routeStart) {
          routeStart = latestBlockEnd + 5;
          const available = goldenStart - routeStart - gap;
          if (available >= 55) {
            westDuration = Math.max(25, Math.min(westDuration, Math.floor(available * 0.4)));
            ladderDuration = Math.max(25, available - westDuration);
          }
        }
        if (routeStart + westDuration + gap + ladderDuration <= goldenStart) {
          west.startTime = fmtMin(routeStart);
          west.endTime = fmtMin(routeStart + westDuration);
          ladder.startTime = fmtMin(routeStart + westDuration);
          ladder.endTime = fmtMin(routeStart + westDuration + ladderDuration);
          west.endLocation = '西山韶乐观景台';
          ladder.startLocation = '西山韶乐观景台';
          ladder.endLocation = '千层天梯观景台';
          golden.startLocation = '千层天梯观景台';
          golden.endLocation = '金佛顶观景台';
          console.warn('[generatePlan] 第%d天按日落锚点重排龙脊核心路线：%s→%s→%s',
            dayIndex + 1, `${west.startTime}-${west.endTime}`,
            `${ladder.startTime}-${ladder.endTime}`, `${golden.startTime}-${golden.endTime}`);
        }
      }
    }
  });

  const firstCoreDay = coreDays.sort((a, b) => a - b)[0];
  if (firstCoreDay !== undefined) {
    rows.forEach((item) => {
      const dayIndex = Number(item && item.dayIndex || 0);
      if (!item || dayIndex <= firstCoreDay || item.category !== 'sight') return;
      const text = String(item.activity || '');
      if (!/西山韶乐|千层天梯|2号天梯|金佛顶|3号观景台/.test(text)) return;
      // 次日清晨在西山韶乐看日出是合理的独立安排，保留；其余核心点
      // 已在前一晚按单向路线完成，不应在离开前再上山一次。
      if (/西山韶乐/.test(text) && /日出/.test(text)) return;
      drop.add(item);
      console.warn('[generatePlan] 删除龙脊核心景点的跨日重复安排：第%d天 %s', dayIndex + 1, text);
    });
  }
  return drop.size ? rows.filter((item) => !drop.has(item)) : rows;
}

/**
 * 续跑落库前对“已完成天数 + 本轮新天数”做一次全行程审计。
 * 分轮生成时，前几天已经写库，后续轮次拿不到那些条目；只审计本轮会
 * 让龙脊核心路线、日出和游船码头修正永远错过已完成的天数。
 */
/** 输出边界只补真实缺失的入住/用餐/回房与进站缓冲，不重新生成已完成日期。 */
function finalizeExecutionEdges(items, outline, p) {
  let rows = asArray(items).slice();
  const days = asArray(outline && outline.days);
  const activeDays = [...new Set(rows.map((item) => Number(item.dayIndex || 0)))];
  // 依据明确的大纲时段回写普通转场，不能把下午离场漂移成上午。
  days.forEach((day, di) => asArray(day.moves).forEach((move) => {
    if (toMin(move.startTime) === null || toMin(move.endTime) === null) return;
    const matches = rows.filter((item) => Number(item.dayIndex || 0) === di
      && item.category === 'transport'
      && sameStation(item.startLocation, move.from) && sameStation(item.endLocation, move.to));
    const item = matches[0];
    if (!item || item.schedSource === '12306') return;
    item.startTime = move.startTime;
    item.endTime = move.endTime;
    item.timingEstimated = true;
  }));
  const firstAccess = rows.find((item) => Number(item.dayIndex || 0) === 0
    && item.category === 'transport' && samePlace(item.startLocation, p.origin));
  const departure = toMin(p.goTime);
  if (firstAccess && departure !== null) {
    const duration = Math.max(15, (toMin(firstAccess.endTime) ?? departure + 40)
      - (toMin(firstAccess.startTime) ?? departure));
    firstAccess.startTime = fmtMin(departure);
    firstAccess.endTime = fmtMin(departure + duration);
    const main = rows.find((item) => Number(item.dayIndex || 0) === 0
      && item.category === 'transport' && item !== firstAccess
      && /train|plane/.test(item.transportType || ''));
    const buffer = main && main.transportType === 'plane' ? 90 : 45;
    const earliest = departure + duration + buffer;
    if (main && main.schedSource !== '12306' && (toMin(main.startTime) ?? earliest) < earliest) {
      const moveDuration = Math.max(30, (toMin(main.endTime) ?? earliest + 120)
        - (toMin(main.startTime) ?? earliest));
      main.startTime = fmtMin(earliest);
      main.endTime = fmtMin(earliest + moveDuration);
      main.timingEstimated = true;
      const move = asArray(days[0] && days[0].moves).find((entry) => sameStation(entry.from, main.startLocation)
        && sameStation(entry.to, main.endLocation));
      if (move) { move.startTime = main.startTime; move.endTime = main.endTime; }
    }
  }
  const append = (dayIndex, start, duration, category, activity, from, to) => rows.push({
    dayIndex, startTime: fmtMin(start), endTime: fmtMin(Math.min(1439, start + duration)),
    category, activity, startLocation: from || '', endLocation: to || '',
    transportType: '', note: '', timingEstimated: true,
  });
  activeDays.forEach((di) => {
    if (di >= days.length - 1) return;
    const day = days[di] || {};
    const target = safeHotelOf(day) || String(day.overnight || '').trim();
    if (!target || /返程|回家|家中/.test(target)) return;
    let list = rows.filter((item) => Number(item.dayIndex || 0) === di)
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    const firstSight = list.find((item) => item.category === 'sight' && !/日出/.test(item.activity || ''));
    const arrival = list.find((item) => item.category === 'transport' && item.outlineMove
      && sameTravelArea(item.endLocation, day.overnight || day.city)
      && !sameTravelArea(item.startLocation, item.endLocation));
    if (arrival && firstSight && toMin(arrival.endTime) <= toMin(firstSight.startTime)
        && !list.some((item) => item.category === 'hotel'
          && !/退房/.test(item.activity || '') && toMin(item.startTime) < toMin(firstSight.startTime))) {
      append(di, toMin(arrival.endTime) + 10, 30, 'hotel',
        `抵达${target}办理入住或寄存行李，随后轻装游玩`, arrival.endLocation, target);
    }
    rows = fixDayTimeOverlaps(rows);
    list = rows.filter((item) => Number(item.dayIndex || 0) === di)
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    if (!list.some((item) => item.category === 'food' && (toMin(item.startTime) ?? 0) >= 17 * 60)) {
      // 只在真正空闲的晚餐窗口补餐，不把晚饭追加到深夜。
      let dinner = 18 * 60 + 30;
      for (const item of list) {
        const start = toMin(item.startTime), end = toMin(item.endTime);
        if (start === null || end === null || end <= dinner) continue;
        if (dinner + 45 <= start) break;
        dinner = Math.max(dinner, end + 10);
      }
      if (dinner + 45 <= 21 * 60) append(di, dinner, 45, 'food',
        `在${day.overnight || day.city}享用晚餐`, '', day.overnight || day.city);
    }
    list = rows.filter((item) => Number(item.dayIndex || 0) === di)
      .sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    const last = list[list.length - 1];
    if (last && !(last.category === 'hotel' && !/退房/.test(last.activity || ''))) {
      const start = (toMin(last.endTime) ?? 0) + 10;
      if (start + 30 < 1439) append(di, start, 30, 'hotel',
        `返回${target}休息，整理随身物品`, last.endLocation || last.startLocation, target);
    }
  });
  rows = fixDayTimeOverlaps(rows);
  // 不再在合并末尾按宽泛地点匹配倒推接驳；此前会把07:00出发拽到
  // 06:30，与早餐重叠。进站缓冲与整天重排由独立执行复核验收。
  rows = ensureFinalHomeArrival(rows, p, outline);
  rows = removeAfterHomeArrival(rows, p, outline);
  return dedupeDuplicateHotelItems(rows);
}

function auditMergedDetailItems(items, outline, p) {
  // savePlan/续跑传入的通常是原始表单（endTime/startTime），而不是
  // buildPlan 内部的规范 profile（backTime/goTime）。合并审计若直接读取
  // 原始对象，会丢掉用户填写的返程到家时刻，最后一段回家接驳就会被错误
  // 地按“车站到家约 40 分钟”重建，出现提前到家或与页面不一致。
  const profile = normalizeInput(p || {});
  const reviewed = asArray(items).filter((item) => item.executionReview === REVIEW_VERSION);
  if (reviewed.length) {
    const readyDays = new Set(reviewed.map((item) => Number(item.dayIndex || 0)));
    const remaining = asArray(items).filter((item) => !readyDays.has(Number(item.dayIndex || 0)));
    // 已复核的日期不能再被景区补齐/大纲重排修改。剩余日期仅做局部边界
    // 清洗，不递归运行整份大纲的规则（那些规则会改动已复核日期的 moves）。
    const legacy = remaining.length ? finalizeExecutionEdges(
      stripUnverifiedSchedules(remaining.map((row) => Object.assign({}, row)), outline), outline, profile,
    ) : [];
    return ensureStableItemIds(reviewed.concat(enforceTransportPreference(legacy, profile))
      .sort((a, b) => Number(a.dayIndex || 0) - Number(b.dayIndex || 0)
        || (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440)));
  }
  const activeDays = [...new Set(asArray(items).map((item) => Number(item.dayIndex || 0)))];
  const seen = new Set();
  let rows = asArray(items).filter((item) => {
    const key = item.itemId || JSON.stringify([item.dayIndex, item.startTime, item.endTime,
      item.category, item.activity, item.startLocation, item.endLocation]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => Object.assign({}, item));
  // 合并不是重新规划。过去在这里重复跑数十轮补点/删点/顺延规则，
  // 会把已生成的游线删掉、改坏日落窗口，并在下一次落库继续漂移。
  // 知识与整天重排交给独立执行复核；落库只做幂等的字段清洗和边界收口。
  rows = enforceTransportPreference(rows, profile);
  rows = rows.filter((item) => activeDays.includes(Number(item.dayIndex || 0)));
  rows = stripUnverifiedSchedules(rows, outline);
  rows = finalizeExecutionEdges(rows, outline, profile);
  return ensureStableItemIds(rows);
}

/** hl 里不算景点的泛化词（按天重复是正常的） */
const GENERIC_HL = /^(自由活动|自由行|自由探索|酒店休息|休整|集合|出发|到达|抵达|返程|返程回家|逛逛|市区漫游|市区自由活动)$/;

// 同一个景区在大纲里经常被模型写成“毕棚沟景区入口 / 毕棚沟雪景 /
// 毕棚沟游客中心”。这些不是三个游玩日，跨天去重时要先去掉入口、景区、
// 雪景等描述性尾巴，再比较真正的景区名称。
function highlightStem(name) {
  let value = String(name || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s，,、·]/g, '')
    .replace(/^(?:晨拍|冬季|夏季|秋季|春季|深度游览|游览|体验|打卡|前往|探访|抵达)/, '');
  let previous = '';
  while (value && value !== previous) {
    previous = value;
    value = value.replace(/(?:景区入口|景区门口|游客服务中心|游客中心|主景区|景区内部|景区|雪景|蓝冰瀑布|水利工程|前山|观景台|观景点|日出|日落|漂流|骑行|夜景|风光)$/g, '');
  }
  return value.length >= 2 ? value : placeStem(name);
}

/**
 * 跨天重复游玩的景点：同一个 hl 词条（或包含它的变体，如"晨拍毕棚沟"
 * vs"毕棚沟"）出现在 ≥2 个不同的天。真踩过：毕棚沟在大纲里被排了两天，
 * 行程硬生生多出一天重复爬山。
 * @returns Array<{name, days:number[]}> days 是 dayIndex（0 起）
 */
function duplicateHighlights(outline) {
  const items = [];
  outline.days.forEach((d, i) => asArray(d.highlights).forEach((h) => {
    const s = String(h || '').trim();
    if (s && !GENERIC_HL.test(s)) items.push({ s, stem: highlightStem(s), day: i });
  }));
  // 归并：词条 stem 相同，或一个是另一个的子串（"毕棚沟" ⊂ "晨拍毕棚沟"）就算同一个
  const groups = [];
  items.forEach((it) => {
    const g = groups.find((grp) => grp.members.some((m) =>
      m.stem === it.stem
      || (m.stem.length >= 2 && it.s.includes(m.stem))
      || (it.stem.length >= 2 && m.s.includes(it.stem))));
    if (g) { g.members.push(it); g.days.add(it.day); } else {
      groups.push({ members: [it], days: new Set([it.day]) });
    }
  });
  return groups
    .filter((g) => g.days.size >= 2)
    .map((g) => ({ name: g.members[0].stem, days: [...g.days].sort((a, b) => a - b) }));
}

/** 从"地铁30分钟""打车约 45 分钟""步行 1 小时 10 分"这类接驳描述里读出分钟数（通用，不认地名） */
function transferMinutes(text) {
  const s = String(text || '');
  const hm = /(\d+)\s*(?:小时|个?钟头)\s*(?:(\d+)\s*分(?:钟)?)?/.exec(s);
  if (hm) return (+hm[1]) * 60 + (+(hm[2] || 0));
  const m = /(\d+)\s*分(?:钟)?/.exec(s);
  return m ? +m[1] : null;
}

/** 接驳描述里说的是不是"打车类"（打车/网约车/包车/自驾）；轨道交通与步行不算绕路 */
function isCarTransfer(text) {
  return /打车|出租车|网约|包车|租车|自驾|驾车/.test(String(text || ''));
}

/**
 * 找出"到站后还要长途打车"的大交通段（通用体检：只看接驳方式与耗时，不认任何地名/车站）。
 * 判据：到站后还得打车 carLimit 分钟以上才到当天目的地 → 站多半选在了反方向（舍近求远）；
 * 轨交/步行本身就便宜不绕路，1 小时内都算正常（大城市地铁 40 分钟到酒店很常见）。
 */
function detourTransfers(outline, carLimit) {
  // 阈值放宽到 15 分钟：模型自报的接驳耗时常常偏短（实测报"打车20分钟"，
  // 细化出来是 30 分钟），放宽一点才拦得住；验收端还要求"必须真的变好"才采纳，
  // 所以宁可多问一次，也别漏掉真正的绕路。
  const lim = carLimit || 15;
  const out = [];
  asArray(outline && outline.days).forEach((d, i) => {
    asArray(d.moves).forEach((m) => {
      const mins = transferMinutes(m.transfer);
      if (mins == null) return;
      const byCar = isCarTransfer(m.transfer);
      if ((byCar && mins >= lim) || mins > 60) {
        out.push({ dayIndex: i, move: m, minutes: mins, byCar });
      }
    });
  });
  return out;
}

/** 中途已经回到出发地，却还没到行程最后一天的日期。 */
function prematureOriginDays(p, outline) {
  const days = asArray(outline && outline.days);
  const origin = String(p && p.origin || '').trim();
  if (!origin || days.length < 3) return [];
  const originIsDestination = asArray(p.destList).some((name) => matchesOriginPlace(name, origin));
  if (originIsDestination) return [];
  const out = [];
  for (let i = 1; i < days.length - 1; i++) {
    const day = days[i] || {};
    const returnLabel = /返程|回家|到家/.test(String(day.overnight || ''));
    const moves = asArray(day.moves);
    const movesHome = moves.some((move) => matchesOriginCity(move && move.to, origin));
    // 出发之后的中间日又从家附近坐车去别的城市，通常表示首末日/中途返程顺序被模型颠倒。
    const leavesHomeAgain = moves.some((move) => matchesOriginCity(move && move.from, origin)
      && !matchesOriginCity(move && move.to, origin));
    if (returnLabel || movesHome || leavesHomeAgain
        || matchesOriginCity(day.city, origin) || matchesOriginCity(day.overnight, origin)) out.push(i);
  }
  return out;
}

function matchesOriginPlace(value, origin) {
  const place = normalizeRoutePlace(value);
  const home = normalizeRoutePlace(origin);
  if (place.length < 2 || home.length < 2) return false;
  return place === home || place.includes(home) || home.includes(place) || samePlace(value, origin);
}

function matchesOriginCity(value, origin) {
  if (matchesOriginPlace(value, origin)) return true;
  const root = (text) => {
    const cleaned = normalizeRoutePlace(text).replace(/(?:北|南|东|西|站|机场|火车站|高铁站)$/g, '');
    return cleaned.slice(0, 2);
  };
  const a = root(value);
  const b = root(origin);
  return a.length === 2 && a === b;
}

/**
 * 如果模型修订仍把中途日期排在出发地，确定性地把这些日期留在最后的外地
 * 基地，并把回家大交通移到末日。返程车次留空并标成待核实，避免挪用旧日期的班次。
 */
function deferPrematureReturn(p, outline, indexes) {
  const days = asArray(outline && outline.days);
  const early = [...new Set(asArray(indexes).filter((i) => Number.isInteger(i) && i > 0 && i < days.length - 1))]
    .sort((a, b) => a - b);
  if (!early.length || !p.origin) return outline;
  const firstEarly = early[0];
  const areaBefore = (index) => {
    for (let i = Math.min(index - 1, days.length - 2); i >= 0; i--) {
      const day = days[i] || {};
      const area = String(day.overnight || day.city || '').trim();
      if (area && !/返程|回家|到家/.test(area) && !matchesOriginPlace(area, p.origin)) return area;
    }
    return '';
  };
  const cityTailBeforeHome = (day) => String(day && day.city || '')
    .split(/(?:->|→|⇒|＞|>|—|–|；|;|，|,)/)
    .map((part) => part.trim())
    .filter((part) => part && !/返程|回家|到家/.test(part) && !matchesOriginPlace(part, p.origin))
    .pop() || '';
  const returnBase = areaBefore(days.length - 1) || areaBefore(firstEarly);
  if (!returnBase) return outline;
  // 模型常把城际返程车的终点直接写成用户家门地址。复用途中明确出现的
  // 出发城市车站/机场作为返程终点，家门接驳再单独安排在该段之后。
  const homeTerminal = days.flatMap((day) => asArray(day && day.moves)).flatMap((move) => {
    const options = [];
    if (matchesOriginCity(move && move.from, p.origin) && !matchesOriginCity(move && move.to, p.origin)) options.push(move.from);
    if (matchesOriginCity(move && move.to, p.origin) && !matchesOriginCity(move && move.from, p.origin)) options.push(move.to);
    return options;
  }).find((value) => /(?:站|机场|客运中心|客运站|码头|港口|[东西南北])$/.test(String(value || '').trim())) || '';

  early.forEach((index) => {
    const day = days[index];
    const base = cityTailBeforeHome(day) || areaBefore(index) || returnBase;
    const previousBase = areaBefore(index);
    day.city = base;
    day.overnight = base;
    day.theme = `在${base}慢游休整，按兴趣安排当地体验`;
    day.highlights = [
      `${base}周边轻松游`,
      p.interests && p.interests.includes('当地美食') ? '当地特色美食' : '当地特色体验',
      p.interests && p.interests.includes('拍照打卡') ? '沿途拍照打卡' : '自由活动与休息',
    ];
    day.moves = asArray(day.moves).filter((move) =>
      !matchesOriginCity(move && move.to, p.origin) && !matchesOriginCity(move && move.from, p.origin));
    if (previousBase && base && !sameTravelArea(previousBase, base)
        && !day.moves.some((move) => sameTravelArea(move && move.from, previousBase)
          && sameTravelArea(move && move.to, base))) {
      // 把“从家出发再去下一站”恢复成当前住宿地出发。没有查证铁路班次时用大巴/旅游专线占位，
      // 详细计划再根据当日可用公共交通补时；不伪造车次，也不默认让用户开车。
      day.moves.unshift({
        from: previousBase,
        to: base,
        mode: drivingAllowed(p) ? 'car' : 'bus',
        code: '',
        startTime: '',
        endTime: '',
        transfer: '优先查询铁路、旅游专线或大巴；没有或明显不便时再打车/选择有司机包车',
        scheduleRequired: false,
      });
    }
    day.hotel = '';
    day.note = [String(day.note || '').trim(), '回家交通统一安排在行程最后一天'].filter(Boolean).join('；');
  });

  const last = days[days.length - 1];
  const base = areaBefore(days.length - 1) || returnBase;
  const transport = String(p.transport || '');
  const mode = drivingAllowed(p) ? 'car'
    : /高铁|动车|铁路|火车/.test(transport) ? 'train'
      : /飞机|航空/.test(transport) ? 'plane' : 'bus';
  const returnTo = drivingAllowed(p) ? p.origin : (homeTerminal || p.origin);
  const backMin = toMin(p.backTime);
  last.city = base;
  last.theme = '从行程最后一站返程回家';
  last.highlights = [];
  last.meals = [];
  last.overnight = '返程';
  last.hotel = '';
  last.moves = [{
    from: base,
    to: returnTo,
    mode,
    code: '',
    startTime: '',
    endTime: backMin == null ? '' : fmtMin(Math.max(0, backMin - 40)),
    transfer: '抵达后按实际车站乘市内交通回到出发地',
    scheduleRequired: mode === 'train' || mode === 'plane' || mode === 'bus',
  }];
  last.note = '返程班次及到家接驳按实际日期核实，预计按用户指定时刻到家';
  return outline;
}

/**
 * 修订大纲：把漏掉的点名地点排进去 / 清掉跨天重复游玩的景点，
 * 其余安排尽量保持不变。
 *
 * ⚠️ 只让模型输出**需要改动的那几天**，不再让它重写整份大纲：
 *    整份 8 天大纲要写 ~2700 token（实测约 30s），而这次修订是在主大纲跑完之后
 *    的剩余时间里做的，根本挤不下 —— 实测被超时掐断，漏掉的点一个也没补回来。
 *    改成"只吐 1~3 天的补丁"（几百 token，8s 左右）就能在剩余时间里跑完。
 *
 * 兼容：模型万一还是返回了完整大纲（ds 天数 = 总天数），按整份替换处理。
 * 失败返回 null（保留原大纲）。
 */
async function repairOutline(p, outline, missing, dups, detours, earlyReturns, deadline) {
  try {
    const issues = [];
    if (missing.length) {
      issues.push(`漏掉了用户点名要去的地点：${missing.join('、')}（每一个都必须安排进某天：成为城市、当天主题或必玩点，不能只"途经"）`);
    }
    if (dups.length) {
      issues.push(`有景点被跨天重复安排：${dups.map((d) => `「${d.name}」出现在第 ${d.days.map((x) => x + 1).join('、')} 天`).join('；')}。重复的只保留一天，其余那天换成同区域其他不重复的景点`);
    }
    if (detours && detours.length) {
      issues.push(`有以下大交通段"到站后还得长途打车才到当天目的地"（说明站选在了反方向、舍近求远）：${detours.map((x) => `第 ${x.dayIndex + 1} 天 ${x.move.from}→${x.move.to}，到站后${x.move.transfer}`).join('；')}。请为这些天改用离当天最终目的地（景点/住宿）最近的车站/码头/机场——同城市域铁路、城际线、机场快线优先，班次密、票价低、不堵车；交通方式与时刻保持不变，只改到发站（车次跟着改），并把新的到站接驳写进 mv.st（争取变成步行或轨道交通）`);
    }
    if (earlyReturns && earlyReturns.length) {
      issues.push(`第 ${earlyReturns.map((x) => x + 1).join('、')} 天已经回到出发地，但行程还未结束。请把这些天改为沿途最后一个目的地区域的休整/游玩，并将从该区域返回「${p.origin}」的大交通移到最后一天（${p.endDate}），末日到家时间必须是 ${p.backTime || '用户指定时间'}；不得在中途安排回家或在出发地住宿`);
    }
    const prompt = `下面这份旅行路线大纲有问题：${issues.join('。')}。
请**只输出需要改动的那几天**（其余天不要输出），把问题修掉。

【旅行需求】${profileText(p)}

【当前大纲（短键名）】
${JSON.stringify(outlineToShortJson(outline))}

# 输出格式
{"ds":[{"d":"YYYY-MM-DD","city":"城市","t":"当天主题短语","mv":[{"f":"出发站","to":"到达站","m":"train/plane/car/bus/ship","c":"车次/航班号","s":"HH:mm","e":"HH:mm","st":"到站后接驳"}],"hl":["必玩1","必玩2","必玩3"],"ov":"当晚住宿","n":"提示（20字内）"}]}

# 要求
1. ds 只包含**需要改动的天**（一般 1~2 天就够），d 必须原样抄当前大纲里的日期。mv 只在**这段交通需要改到发站**时才填（要改就把该天所有 mv 一起原样带回，别只给一段）。
2. ${missing.length ? `${missing.join('、')} 每一个都必须出现在某天的 city / t / hl 里。` : ''}${dups.length ? `重复景点每个只保留一天，被清掉的那天补上新的、不重复的景点；不要因为去重就把某天改空。` : ''}${(detours && detours.length) ? '改站的那天：交通方式与时刻保持不变，只改到发站与车次，mv.st 写新的到站接驳（争取步行/轨道交通）；没有更近的站就别改，把理由写进 n。' : ''}${earlyReturns && earlyReturns.length ? `中途回到出发地的日期改为沿途最后目的地区域的轻松安排，清除提前回家的 mv；最后一天必须新增「${p.origin}」返程 mv，并到家于 ${p.backTime || '用户指定时刻'}。` : ''}
3. 改动尽量小：能塞进已有某天的 hl 就别重排整条路线，其他天保持原样。住宿闭环别破坏：每晚 ov 保持原样。
4. 只输出这个 JSON 对象，不要任何解释。`;
    const text = await llm.chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], { deadline });
    const parsed = parseJSONFromText(text);
    const patched = asArray(parsed && parsed.ds);

    // 模型返回了整份大纲 → 走老的整份替换逻辑
    if (patched.length && patched.length === p.days) {
      const repaired = applyTripEdgeTimes(p, normalizeOutlineJson(parsed, p));
      if (repaired.days.length !== p.days) {
        console.warn('[generatePlan] 修订大纲天数不符（%d ≠ %d），弃用', repaired.days.length, p.days);
        return null;
      }
      return repaired;
    }

    // 只改了几天的补丁 → 按日期合并回原大纲
    const byDate = new Map();
    outline.days.forEach((d) => byDate.set(d.date, d));
    let changed = 0;
    patched.forEach((raw) => {
      const date = validDate(raw && raw.d) ? raw.d : '';
      const nd = normalizeOutlineJson({ ds: [raw] }, p).days[0];
      const target = byDate.get(date);
      if (!nd || !target) return;
      if (nd.city) target.city = nd.city;
      if (nd.theme) target.theme = nd.theme;
      if (asArray(nd.highlights).length) target.highlights = nd.highlights;
      if (asArray(nd.moves).length) target.moves = nd.moves;
      if (nd.overnight) target.overnight = nd.overnight;
      if (nd.hotel) target.hotel = nd.hotel;
      if (nd.note) target.note = nd.note;
      changed++;
    });
    if (!changed) {
      console.warn('[generatePlan] 修订补丁没有匹配到任何一天，弃用');
      return null;
    }
    console.log('[generatePlan] 修订补丁已合并 %d 天', changed);
    return applyTripEdgeTimes(p, outline);
  } catch (e) {
    console.error('[generatePlan] 大纲修订失败（保留原大纲）:', e.message);
    return null;
  }
}

// ============================================================
// ② 逐天细化（并行）
// ============================================================

const ITEM_SCHEMA =
  '{"dayIndex":0,"startTime":"HH:mm","endTime":"HH:mm","activity":"行程描述","category":"sight/food/hotel/transport/ticket/other","startLocation":"","endLocation":"","transportType":"car/walk/ride/train/plane","note":""}';

function dayDetailPrompt(p, day, idx, outline) {
  const prev = idx > 0 ? outline.days[idx - 1] : null;
  const next = idx < outline.days.length - 1 ? outline.days[idx + 1] : null;
  const isFirst = idx === 0;
  const isLast = idx === outline.days.length - 1;
  // 行李怎么走，取决于今晚回不回昨晚那家酒店（换住处 = 行李必须随身）
  const tonight = day.overnight || day.city || '';
  const lastNight = prev ? (prev.overnight || prev.city || '') : '';
  const moveList = asArray(day.moves).filter((move) => move && move.from && move.to);
  const activityArea = String(day.overnight || (moveList.length ? moveList[moveList.length - 1].to : '')
    || day.city || '').trim();
  const sameBase = samePlace(lastNight, tonight);
  const explicitCarry = explicitCarryLuggagePreference(p);
  const temporaryStorageRule = !sameBase && !isLast && !explicitCarry
    ? `若上午仍在${lastNight || '昨晚住宿片区'}进行竹筏、骑行或景点游玩、下午才去${tonight || '下一站'}，把大件行李寄存在昨晚酒店前台，轻装游玩；在离开${lastNight || '原住宿片区'}前返回酒店取回，再去乘车。`
    : '';
  const officialUnavailable = asArray(day.moves).some((m) => m && m.scheduleRequired);
  const accessMode = defaultTransferMode(p);
  const accessInstruction = drivingAllowed(p)
    ? '用户已选「自驾出行」：所有交通路段都由用户本人驾驶；每到酒店、景区、餐馆等目的地，先安排停车，再办理入住、游览或用餐；'
    : taxiAllowed(p)
      ? '用户未选「自驾出行」：禁止默认让用户开车/租车，只有补充要求明确写出的具体路段可自驾；先安排高铁/动车、步行、公共交通、景区接驳、旅游专线或大巴；这些方式没有或明显不方便时，可用打车、网约车或有司机包车，且不得写成用户开车；'
      : '用户明确不使用打车/包车；先安排高铁/动车、步行、公共交通、景区接驳、旅游专线或大巴，且不得默认让用户本人开车；只有补充要求点名的具体路段才可自驾；';
  const longjiDay = /龙脊|金坑大寨|千层天梯|西山韶乐|金佛顶/.test(
    `${day.city || ''} ${day.theme || ''} ${asArray(day.highlights).join(' ')}`);
  const longjiDetailRule = longjiDay
    ? '龙脊金坑大寨不可为凑点折返：千层天梯（2号）与西山韶乐（1号）要按实际入口和游览方向连续安排；只要固定离开交通前时间足够，金佛顶（3号）优先与两处安排在同一天，并把上山、下山、接驳、放行李、拍照和休息时间算入。允许“西山韶乐放行李/休息点→千层天梯→金佛顶→最后回西山韶乐收尾”，禁止“西山→千层→西山→金佛顶→西山”的中途折返；只有时间确实不足时才删掉后到的短停或拆日，不要用“可选”掩盖冲突。'
    : '';
  const longjiLightRule = longjiDay && /龙脊|金坑大寨|田头寨/.test(String(day.overnight || day.hotel || ''))
    ? '本晚住在龙脊：若抵达时间不晚于日落前，安排金佛顶看日落；若次日不是清晨立即离开且时间充足，安排西山韶乐看日出。日出日落都要单独写入时间线，按当天实际日出日落、末班接驳和体力调整，不要只写在备注。'
    : '';
  const cruiseDetailRule = /漓江|四星级游船|四星游船|磨盘山|竹江码头/.test(
    `${day.city || ''} ${day.theme || ''} ${day.note || ''} ${asArray(day.highlights).join(' ')} ${asArray(day.moves).map((m) => `${m.from || ''} ${m.to || ''}`).join(' ')}`)
    ? '漓江四星级游船从竹江码头出发；如果船型写四星级，startLocation/endLocation、activity、note 和购票提醒统一写竹江码头，禁止出现“四星级游船从磨盘山码头出发”。'
    : '';

  const block =
    `【旅行需求】${profileText(p)}\n\n` +
    `【今天】${day.date}（周${weekdayOf(day.date)}）｜${day.theme}\n` +
    `路线背景：${day.city}\n` +
    `今天主要游玩/入住片区：${activityArea}\n` +
    `大纲要点：${asArray(day.highlights).join('、')}\n` +
    (asArray(day.moves).length
      ? `【今天的大交通（路线既定）】${asArray(day.moves).map(
          (m) => `${m.from || '?'}→${m.to || '?'} ${m.mode || ''} ${m.code || ''} ${m.startTime || ''}-${m.endTime || ''}`
            + (m.transfer ? `；到站后接驳：${m.transfer}` : '')
        ).join('；')}\n`
      : '') +
    (asArray(day.sched).length
      // 联网检索到的真实班次：模型只负责"挑哪一班"，不许再凭记忆编时刻
      ? `【真实班次（已联网核对）】${asArray(day.sched).map(
          (c) => `${c.code}${c.from ? ` ${c.from}→${c.to}` : ''} ${c.s}-${c.e}`
        ).join('；')}\n**只能从这里面挑，禁止自创车次号或改写时刻**；若这些班次都不合适，也必须保持车次号与时刻的原样。\n`
      : '') +
    (officialUnavailable
      ? '【12306 班次状态】当天官方查询没有返回可用车次；只写“乘列车”及行程估算时间，严禁编造 G/D/C 车次号或把估算时间写成已核对时刻。备注写“班次与时刻待12306核实”。\n'
      : '') +
    (day.meals && asArray(day.meals).length ? `餐饮建议：${asArray(day.meals).join('、')}\n` : '') +
    `全程餐饮分配：${JSON.stringify(asArray(outline.days).map((entry) => ({ date: entry.date, meals: entry.meals })))}。每天更换当地代表菜，不连续多天重复同一道主菜；用户明确要求重复的除外。\n` +
    (day.note ? `提示：${day.note}\n` : '') +
    `当晚住宿：${day.overnight || day.city}${day.hotel ? `（推荐酒店：${day.hotel}${day.hotelPoiAddress ? `；核验地址：${day.hotelPoiAddress}` : ''}，已按用户预算「${p.budget}」档挑选，最后的入住条目用它）` : ''}\n\n` +
    (prev ? `【昨天】${prev.date}｜${prev.theme}，昨晚住${prev.overnight || prev.city} —— 今天第一条行程从这里出发。\n` : '') +
    (next ? `【明天】${next.date}｜${next.theme}（今天的行程要为明天的移动留出余量）\n\n` : '\n');

  const rules =
    `请把"今天"展开为**详细到可以直接照着执行**的行程项 JSON 数组，每个元素格式：${ITEM_SCHEMA}
${longjiDetailRule ? `\n【龙脊路线约束】${longjiDetailRule}\n` : ''}
${longjiLightRule ? `\n【龙脊日出日落】${longjiLightRule}\n` : ''}
${cruiseDetailRule ? `\n【漓江船型与码头】${cruiseDetailRule}\n` : ''}
dayIndex 全部填 ${idx}。

# 细致度要求（核心）
1. ${isFirst || isLast
      ? `这是${isFirst && isLast ? '首末日' : isFirst ? '出发日' : '返程日'}，按真实可用时间安排，**不要求覆盖整天或凑条数**。${isFirst ? `首日从 ${p.goTime || '大交通前的合理时间'} 离开${p.origin || '出发地'}，只能在抵达后安排游玩；${p.goTime ? `不得把任何游玩安排在 ${p.goTime} 之前。` : ''}` : ''}${isLast ? `返程日只安排大交通前能完成的内容，${p.backTime ? `以 ${p.backTime} 回到${p.origin || '出发地'}为终点。` : '以回到出发地为终点。'}大交通出发后不得再安排景点、酒店或餐饮活动；返程日结束在家，不得要求回酒店。` : ''}交通时刻和必要候车/接驳优先，宁可少排项目也不要挤压、倒置或编造时间。`
      : `覆盖合理游玩时段：早餐 → 上午安排 → 午餐 → 下午安排 → 晚餐 → 适量夜间活动 → 回酒店休息。通常 6～10 条，内容多就多写、少就少写——**不要为了凑条数删掉有用的安排，也不要把一件事拆成好几条凑数**。`
    }
2. 每条 startTime / endTime 必须具体且**首尾相接**：后一条的 startTime 等于前一条的 endTime（中间留间隔也算合理，如 转场/休息），全天从起床开始、到回酒店休息结束。禁止输出空时间、"--:--"、或 endTime 等于 startTime。
3. 时间分配要符合常识和${p.pace}节奏：早餐 07:00 前后；午餐 12:00-13:00；晚餐 18:30-20:00；景区游览至少 1-2 小时；晚上安排到 21:30-22:30 之间收尾回酒店。${/轻松|慢游/.test(p.pace) ? '每天最多 2 个主景点，留出休息和慢逛时间。' : /紧凑|充实/.test(p.pace) ? '行程可以更满，但必须保证吃饭和必要的交通接驳时间。' : '劳逸适中：把交通、排队、步行和休息都计入，避免连续高强度安排。'}
4. activity 要写得像真人行程："14:44 乘 G2249 前往桂林西（约 4 小时 54 分）"、"20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉"、"21:00 步行前往杉湖，看日月双塔夜景"。**要有具体名称**（店名/菜品/景点具体区域/观景台），不要写"吃晚饭""逛逛"这种空话；餐饮条目统一写"店名/片区 + 招牌菜"。路线背景里若出现“甲→乙”，甲只是出发/中转地，除非今天大纲要点明确列出甲，否则不要在甲安排景点、餐饮或夜游；游玩应围绕“今天主要游玩/入住片区”和明确的大纲要点。
4.1 **每个主要景点展开成完整链条**：抵达 → 游览（写清到底玩什么：哪段索道/哪个观景台/乘船还是徒步/核心体验与拍照点，可拆 1~3 条）→ 前往下一站。禁止只写一条"游览XX"就凭空跳到下一个景点；景区内的移动（乘索道/换观景台）也要单独成条。**【大纲要点必须落地】今天“大纲要点”里列出的每个用户点名景点，都必须在今天的详细行程中出现至少一条真实的抵达/游览/体验条目；不能只写在备注、餐饮建议或“可选”里。时间不够时删掉非核心活动，保留点名景点并重新安排时段。**
5. 涉及移动的动作必须填 startLocation / endLocation（起点空着时，用上一条的位置或昨晚住宿地），并填 transportType：步行=walk，公共交通/公交地铁/景区接驳=ride，火车=train，飞机=plane。${accessInstruction}没有移动（吃饭、休息、游览）三项都留空。
6. 备注写进 note：预约要求、末班车时间、门票信息、行李寄存、拍照机位、当地支付/语言提示等实用信息。
7. ${isFirst ? drivingAllowed(p)
      ? `第一天第 1 条必须是从${p.origin || '出发地'}自行驾驶前往当天目的地，startLocation=${p.origin || '出发地'}，transportType=car；${p.goTime ? `在 ${p.goTime} 准时启程。` : ''}抵达后先停车再开始任何活动。`
      : `第一天：**第 1 条必须是出发接驳**——「${p.goTime || '按大交通倒推'} 从${p.origin || '出发地'}出发，前往${(asArray(day.moves)[0] && asArray(day.moves)[0].from) || '车站/机场'}」，startLocation 填${p.origin || '出发地'}、endLocation 填车站/机场、transportType=${accessMode}；${accessInstruction}随后安排候车并乘坐既定大交通。${p.goTime ? `**${p.goTime} 是离开${p.origin || '出发地'}的时刻（去程开始时间），不是发车时刻**；大交通发车时刻以【今天的大交通】给的 s 为准。` : ''}` : ''}
8. ${isLast ? drivingAllowed(p)
      ? `最后一天最后一段必须自行驾驶回到${p.origin || '出发地'}，endLocation=${p.origin || '出发地'}、transportType=car，${p.backTime ? `并于 ${p.backTime} 到家。` : '合理安排返程启程时刻。'}抵达家中后结束行程。`
      : `最后一天：以回到${p.origin || '出发地'}结束——大交通到达站**之后**最多补一条回家接驳（endLocation=${p.origin || '出发地'}，transportType=${accessMode}），不要先去酒店，也不要在返程大交通后继续安排游玩。${p.backTime ? `**${p.backTime} 是回到${p.origin || '出发地'}的时刻（到家时刻，不是发车也不是到站）**：大交通到达时刻要为此留出接驳时间。` : ''}` : ''}
9. category 取值：景点游览=sight，餐饮=food，住宿/回酒店=hotel，交通=transport，门票预订/取票=ticket，其他=other。
10. 输出顺序按时间先后。只输出数组，不要任何解释。
11. **【今天的大交通】是既定路线**：交通方式、车次、出发站/到达站照抄，不许改成别的交通方式、不许编造新车次。
    ${officialUnavailable ? '若【12306 班次状态】显示没有可用车次，车次字段留空，activity 只写“乘列车从A前往B”；时间是行程估算，note 必须标注“班次与时刻待12306核实”。' : ''}
    - 大交通条目必须排在它**真实被乘坐的时刻位置**（15:00 的车就写在 15:00 前后的时段），严禁为了"衔接顺"把它提前写成"倒叙/桥接/预告"。
    - ${((isFirst && p.goTime) || (isLast && p.backTime))
      ? '起止时刻是**用户指定的硬约束**，必须原样照抄，不许微调（首日照抄发车时刻、末日照抄到达时刻，用户指定的启程/到家时刻用来安排前后接驳）。'
      : '大纲里的起止时刻只是**粗排参考**：若你确知该车次实际时刻与之不符、或与今天其他安排衔接不上，就按实际/合理的时刻微调，前后条目跟着顺移，保证全天时间线首尾相接；'}
    - 时刻要调就**静默地调**，绝不允许在 activity / note 里解释、质疑、论证冲突（"鉴于…必须原样执行…""此为错误约束""修正…"这类字样一概不许出现）——用户看不见你的思考过程，只看得见行程。
    - 写的是 train/高铁/动车 → 按火车站流程安排（提前 45 分钟到站、安检、候车、上车），全程不得出现"机场""航站楼""航班""值机"等字样，transportType 填 train。
    - 写的是 plane/航班 → 按机场流程安排（提前 2 小时到机场），transportType 填 plane。不要自作主张把火车改飞机、把飞机改火车；即便你觉得另一种方式更快也不行，这是用户的选择。
${/高铁|动车/.test(p.transport) ? '12. 用户交通偏好是「高铁/动车优先」：后续所有城际段一律按高铁或动车安排（优先高铁，没有合适高铁就走动车/城际），不要生成任何航班。' : ''}
${drivingAllowed(p) ? '12. 用户已选「自驾出行」：今天所有交通都由用户本人驾驶，禁止生成火车、飞机、包车或公共交通；抵达每个目的地后先安排停车，再做其他事情。' : ''}
13. **activity 里只写"要做什么"，禁止写你的推理过程**：不要出现"注：根据大纲…""此处假设…""若用户…""我无法/我需要"这类自我纠错或向我的解释。这段文字会原样显示在用户的行程里，写了就很难看。
14. **住宿闭环（铁律）**：昨晚住哪，今天第 1 条就从哪出发——${prev ? `昨晚住「${prev.overnight || prev.city}」，第 1 条应写成"从该住宿地出发"，startLocation 填它` : '今天从出发地启程'}；${isLast ? '返程日以回到出发地结束，禁止安排回酒店或虚构返程日晚住宿。' : `当天最后 1 条必须是"回到${day.overnight || day.city}住宿地休息"（category=hotel，endLocation 填住宿地）。`}绝不允许昨晚住 A 今早却凭空从 B 出发、或晚上收在 C 但住宿地是 D。${sameBase ? '当晚回同一家酒店时，早上可加一条"大件行李留在房间/寄存前台，轻装出发"（note 写明回来续住）。' : temporaryStorageRule || (explicitCarry ? '用户明确表示行李方便随身携带，今天行李全程随人走。' : '**今晚不回昨晚这家酒店，常规情况下行李随身走**（见第 16 条；若上午仍在原住宿片区、下午才换城，可按第 16 条临时寄存并取回）。')}
15. **地点名要用地图搜得到的通用叫法**：startLocation / endLocation 只写地点真名，别自造"XX公园""XX景区大门"这种后缀（"象鼻山"不要写成"象鼻山公园"——地图上真有另一个"象鼻山公园"在别的省，导航会导错）；也不要带括号补注、不要写"附近/周边"这类模糊词。车站写标准站名（如"桂林北站""南宁东站"）。` +
    `\n16. **行李处理（铁律，为游客方便着想，必须落实到今天的行程条目里）**：昨晚「${lastNight || '出发地'}」→ 今晚「${tonight || '返程'}」——${sameBase
      ? '**今晚回同一家酒店**：大件行李留在房间或寄存在前台，轻装出门，晚上回来续住同一家。'
      : temporaryStorageRule || explicitCarry
        ? (explicitCarry
          ? '**用户明确说明行李方便随身携带**：行李全程随人走，不另加酒店寄存。'
          : `**今天允许临时寄存**：早上离开${lastNight || '昨晚住宿地'}前把大件行李寄存在酒店前台，轻装完成白天活动；去${tonight || '下一站'}前必须返回取回，严禁把寄存行李留在原地。`)
      : `**今晚不回昨晚那家酒店，行李必须随身走**：\n    - 早上写一条"退房，携带全部行李出发"；**禁止写"把大件行李寄存在${lastNight || '酒店'}前台"**——今晚不回来取，寄存等于逼游客折返取件。\n    - ${isLast
        ? '返程日行李全程随身；需要轻装时用车站/机场的寄存柜，上车前记得取回。'
        : `抵达「${tonight}」后**先到当晚酒店放行李**（写一条"到酒店放行李、轻装出门"，category=hotel），再出去游玩。`}`
    }\n    - 带着行李游玩时：写一条"在游客中心/寄存柜寄存行李"，并在**离开景区前往下一站的那一条**的 note 里写明"取回寄存的行李，别落下"。
17. **白天不许回酒店睡觉**：15:00 前禁止安排"回酒店休息/午休/回房间"（仅换住处当天的"到酒店放行李/办理入住"除外）。游客白天在外面玩，想歇脚就写景区内的茶座/长椅/观光车，回酒店只属于晚上。
18. **市内/短途交通按用户预算「${p.budget}」选型（用户预算和偏好优先于个人习惯）**：
    - ${/^经济/.test(p.budget) ? '经济实惠：3km 内步行；更远优先地铁/公交/景区接驳。公共交通没有或明显不便时才打车/包车。' : /^品质/.test(p.budget) ? '品质优选：可用打车/包车提升舒适度，仍须尊重用户是否选择自驾出行。' : '舒适适中：地铁/公交/景区接驳优先；赶时间、携带行李或公共交通不便时可打车/包车。'}
    - ${accessInstruction}
    - 不确定公交线路或票价时不要编造线路号/费用，写清公共交通类型并提示核对当日班次。
    - **【今天的大交通】到达后的市内接驳同样遵守以上规则**；到站离目的地很近时直接步行前往。
19. **别重复排已安排过的内容**：对照大纲其他天的 hl/ml——今天不要再安排其他天已经玩过的具体景点（同一景点整个行程只玩一次），也不要和其他天吃同一家店；同一类体验（火锅/烧烤等同类的饭、古镇老街/博物馆/夜市等同类的玩法）全程最多 2 次，今天尽量给出和别的天不一样的花样。`;

  return [
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: block + rules },
  ];
}

/**
 * 逐天细化：分批并行 + 时间预算，撞上限就返回已完成的部分（续跑模式）
 *
 * 为什么要分批：8 天一次性并行要 35~40s，遇到慢模型随时撞上云函数 60s 上限，
 * 一撞就前功尽弃。改成"每批 N 天、跑完一批看一眼剩余时间"，时间不够就先把
 * 已经生成好的天交回去（partial=true），前端静默再调一次接着生成剩下几天。
 * 用户全程只看到"正在细化…"，感觉不到中间断过。
 *
 * ⚠️ 失败的天必须重试，不能静默丢弃：
 *    之前 failed 的天被排除在 stillTodo 之外，导致 partial=false、整轮直接结束，
 *    用户只能事后发现"行程少了第 3 天"，而且云函数日志之外没有任何提示。
 *    现在失败天重新进队列（同一天最多 MAX_RETRY 次），耗尽才放弃，
 *    并把 gaveUpDayIndexes 交回前端明确提示。
 *
 * @param {object} p 归一化输入
 * @param {object} outline 大纲
 * @param {object} opts { doneDayIndexes: 已完成的天（续跑时跳过）,
 *                        attempts: { [dayIndex]: 已尝试次数 }（续跑时回传，避免无限重试）,
 *                        deadline: 本次调用的截止时间戳 }
 */
const MAX_DAY_RETRY = 3;

async function genDayItems(p, outline, opts = {}) {
  const days = outline.days;
  const done = new Set(asArray(opts.doneDayIndexes).map(Number));
  const attempts = Object.assign({}, opts.attempts || {});
  // 只排队"没完成 且 还没试满"的天：失败的天会再排进来重试一次
  const pending = days.map((_, i) => i)
    .filter((i) => !done.has(i) && (attempts[i] || 0) < MAX_DAY_RETRY);
  const deadline = opts.deadline || (Date.now() + 40 * 1000);
  // 一批最多 4 天（并行，耗时 ≈ 最慢那一天而不是 4 天相加，实测 ~25-35s）；
  // 剩余时间不够时自动缩批 —— 固定大批次时预算只剩 20s 就整批放弃，
  // 实测返程日因此整天空掉，兜底只剩"17:40 高铁 + 17:00 吃早餐"。
  const WAVE = 4;
  const FIRST_PER_DAY_ESTIMATE = 8500;   // 首轮按单天 ~8.5s 估

  const items = [];
  const finished = [];
  const failed = [];
  let lastCost = 0;
  let prevWave = WAVE;

  for (let k = 0; k < pending.length;) {
    // 批大小自适应：剩余预算 >30s 开满 4 天，>19s 缩到 2 天，再紧就 1 天
    // （细化预算默认 38s：首轮 rem≈38s → 4 天；跑完一批剩几秒 → 收尾 1 天）
    const rem = deadline - Date.now();
    const wave = Math.max(1, Math.min(WAVE, pending.length - k,
      rem > 30 * 1000 ? 4 : rem > 19 * 1000 ? 2 : 1));
    const batch = pending.slice(k, k + wave);
    // 单天耗时估算：首轮用默认值，之后按上一批均摊 ×1.2（单天封顶 15s）
    const perDay = lastCost
      ? Math.min(Math.ceil((lastCost / prevWave) * 1.2), 15 * 1000)
      : FIRST_PER_DAY_ESTIMATE;
    // batch 内请求是 Promise.all 并发，估算应接近最慢的一天；按天数相加会让
    // 4 天首批在剩余 38 秒时被误判为 34 秒甚至更高，提前少跑一波。
    const estimate = perDay + 1000;
    if (Date.now() + estimate > deadline) {
      console.log('[generatePlan] 时间预算不足，停止在已完成部分（续跑）: 已完成=%d 剩余=%d',
        finished.length, pending.length - finished.length - failed.length);
      break;
    }
    const waveStart = Date.now();
    const rs = await Promise.all(batch.map((idx) =>
      // 把本轮 deadline 传进去：单次超时会按剩余时间收敛，重试也会先问时间够不够
      // 这里同样不设 max_tokens：一天 10~15 条细化的正常输出就接近 3000 token，
      // 封顶会让当天的后半段（晚餐 + 夜间 + 回酒店）凭空消失
      llm.chatWithRetry(dayDetailPrompt(p, days[idx], idx, outline), { deadline })
        .then((t) => ({ i: idx, items: asArray(parseJSONFromText(t)) }))
        .catch((e) => ({ i: idx, error: e.message }))
    ));
    lastCost = Date.now() - waveStart;
    rs.forEach((r) => {
      if (r.error || !r.items.length) {
        failed.push(r.i);
        attempts[r.i] = (attempts[r.i] || 0) + 1;   // 记一次失败，续跑时才知道还能不能再试
        console.error(`[generatePlan] 第${r.i + 1}天细化失败（第${attempts[r.i]}次）:`,
          r.error || 'LLM 返回了空数组');
        return;
      }
      r.items.forEach((it) => {
        if (!it || !String(it.activity || '').trim()) return;
        items.push(Object.assign({}, it, { dayIndex: r.i })); // dayIndex 由代码强制写入，不信任 LLM
      });
      // 住宿闭环兜底：LLM 偶尔忘了把"昨晚住宿"写成第一条的起点。
      // 这里做确定性修补：当天第一条的 startLocation 为空 → 补昨晚住宿地；
      // 当天最后一条的 endLocation 为空且 category=hotel → 补今晚住宿地。
      const prevOv = r.i > 0 ? (days[r.i - 1].overnight || days[r.i - 1].city || '') : '';
      const tonightOv = days[r.i].overnight || days[r.i].city || '';
      const dayItems = items.filter((it) => it.dayIndex === r.i);
      if (dayItems.length) {
        const first = dayItems[0];
        if (!String(first.startLocation || '').trim() && prevOv) first.startLocation = prevOv;
        const last = dayItems[dayItems.length - 1];
        if (last.category === 'hotel' && !String(last.endLocation || '').trim() && tonightOv) {
          last.endLocation = tonightOv;
        }
      }
      // 每天返回即作基础验收，记录具体问题供下一轮修订；不丢掉整天重新生成。
      const localIssues = executionIssues(dayItems, {
        isFirst: r.i === 0, isLast: r.i === days.length - 1,
        origin: p.origin, goTime: p.goTime, backTime: p.backTime,
        hotel: days[r.i].hotel, overnight: tonightOv,
        sameHotel: r.i > 0 && !!days[r.i].hotel && days[r.i].hotel === days[r.i - 1].hotel,
        lightLuggage: explicitCarryLuggagePreference(p), noDrive: !drivingAllowed(p),
        selfDriveAllowed: (row) => explicitSelfDriveSegment(p, row),
      });
      if (localIssues.length) days[r.i].executionReviewIssues = localIssues;
      else delete days[r.i].executionReviewIssues;
      finished.push(r.i);
    });
    k += wave;
    prevWave = wave;
  }

  const doneAll = Array.from(done).concat(finished);
  // 还要再跑的天 = 没完成 且 还有重试机会；试满 3 次的进 gaveUp，不再占用后续轮次
  // 注意用 doneAll（含本轮刚成功的天）排除，否则本轮成功的天会被误判成"待续"
  const stillTodo = days.map((_, i) => i)
    .filter((i) => !doneAll.includes(i) && (attempts[i] || 0) < MAX_DAY_RETRY);
  const gaveUp = days.map((_, i) => i)
    .filter((i) => !doneAll.includes(i) && (attempts[i] || 0) >= MAX_DAY_RETRY);

  if (!items.length && !stillTodo.length && !done.size) {
    throw new Error('逐天细化全部失败，未能生成任何行程项');
  }

  console.log('[generatePlan] 本轮：完成=%d 失败=%d 放弃=%d 待续=%d',
    finished.length, failed.length, gaveUp.length, stillTodo.length);

  return {
    items,                       // 本次新生成的条目（续跑时只含剩余天）
    doneDayIndexes: doneAll,     // 已完成（含之前轮次）
    failedDayIndexes: failed,    // 本轮失败的天（还有重试机会）
    gaveUpDayIndexes: gaveUp,    // 重试耗尽、彻底放弃的天 → 前端要提示用户
    attempts,                    // 回传尝试次数，前端原样带回下一轮
    partial: stillTodo.length > 0,  // 还有没生成的天 → 前端继续调
  };
}

// ============================================================
// ③ 闹钟：LLM 提名 + 代码算时间
// ============================================================

// 中国铁路 12306 互联网售票预售期为 15 天（含乘车当日）
// 参考真实案例：9月30日的车 → 9月16日开票（相差 14 天）
const TRAIN_PRESALE_DAYS = 14;
// 热门景区门票常规提前预约天数
const TICKET_PRESALE_DAYS = 7;

/**
 * 把 LLM 提名的闹钟做时间与合法性校验（铁律：不能全信 LLM）
 * @returns {Array} 通过校验的闹钟原始对象
 */
function sanitizeAlarmCandidates(list, p) {
  const now = Date.now();
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const out = [];
  const seen = new Set();

  asArray(list).forEach((a) => {
    const title = String((a && a.title) || '').trim();
    if (!title) return;
    const ts = parseCnTime(a.fireAt);
    // ① 时间必须解析得出来 ② 不能是已经过去的时刻 ③ 不能晚于行程结束后一天
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
      dayIndex: Number.isInteger(Number(a.dayIndex)) ? Number(a.dayIndex) : undefined,
      bookingInfo: String(a.bookingInfo || '').slice(0, 160),
      linkedItemId: String(a.linkedItemId || '').slice(0, 100),
    });
  });
  return out;
}

/**
 * 规则闹钟工厂：统一处理"算出的开票日已过去 → 降级成近期提醒"，
 * 供 buildFallbackAlarms（底线闹钟）和 backfillMissingAlarms（查漏补齐）共用。
 */
function makeRuleAlarmPusher(list, tripStartTs, tripEndTs) {
  let overdueCount = 0; // 已经过了开票日的条数：错开提醒时间，别一堆闹钟挤在同一分钟
  const nowMs = () => Date.now();
  return function push(title, dateStr, timeStr, type, note, meta = {}) {
    let ts = parseCnTime(`${dateStr}T${timeStr}:00`);
    if (!ts || isNaN(ts)) return;
    const finalTitle = String(title || '提醒');
    if (type === 'hotel') {
      if (tripEndTs < nowMs()) return;
      const hotelCount = list.filter((a) => a.type === 'hotel').length;
      const immediateAt = nowMs() + (2 + hotelCount * 5) * 60 * 1000;
      const defaultHotelNote = '酒店可随时提前预订，没有统一放票时间；越早确认越好。请到「酒店住宿」分类逐项核对并预订。';
      const hotelNote = String(meta.bookingNote || defaultHotelNote).slice(0, 500);
      list.push({
        title: ('尽早确认酒店预订：' + finalTitle.replace(/^(?:预订|确认酒店预订|尽早确认酒店预订)[：: ]*/, '')).slice(0, 100),
        note: hotelNote,
        fireAt: immediateAt,
        fireAtStr: tsToCnDateTimeStr(immediateAt),
        type,
        source: 'ai-rule',
        dayIndex: Number.isInteger(Number(meta.dayIndex)) ? Number(meta.dayIndex) : undefined,
        bookingInfo: String(meta.bookingInfo || '').slice(0, 160),
        hotelPoiAddress: String(meta.hotelPoiAddress || '').slice(0, 200),
        hotelRecommendationReason: String(meta.hotelRecommendationReason || '').slice(0, 300),
        linkedItemId: String(meta.linkedItemId || '').slice(0, 100),
      });
      return;
    }
    if (ts < nowMs() && ['train', 'plane', 'bus', 'ticket'].includes(type)) {
      if (tripEndTs < nowMs() || tripStartTs < nowMs() - DAY_MS) return;
      overdueCount += 1;
      const immediateAt = nowMs() + Math.min(overdueCount, 3) * 60 * 1000;
      const action = type === 'ticket' ? '立即查看并预约' : '立即查看并购买';
      list.push({
        title: (action + '：' + finalTitle.replace(/^(?:开抢|抢|开始盯|关注|查询|预约)+/, '')).slice(0, 100),
        note: '原定提醒日 ' + dateStr + ' 已过，请现在打开官方售票/预约渠道核实是否已开售；若已放票请立即购买，不要等待下一次提醒。' + String(note || ''),
        fireAt: immediateAt,
        fireAtStr: tsToCnDateTimeStr(immediateAt),
        type,
        source: 'ai-rule',
        dayIndex: Number.isInteger(Number(meta.dayIndex)) ? Number(meta.dayIndex) : undefined,
        bookingInfo: String(meta.bookingInfo || '').slice(0, 160),
        linkedItemId: String(meta.linkedItemId || '').slice(0, 100),
      });
      return;
    }
    let finalNote = note || '';
    if (ts < nowMs()) {
      // 算出来的开票日已经过去了：行程还没出发的话，降级成"赶紧去看"的近期提醒
      // （用户多半是临时才规划，这一步能救回大量"本该早就抢票"的场景）
      if (tripEndTs < nowMs()) return;          // 行程都结束了，不再打扰
      if (tripStartTs < nowMs() - DAY_MS) return; // 出发超过一天 → 购票窗口已过
      overdueCount += 1;
      ts = nowMs() + (1 + overdueCount) * 3600 * 1000;
      // 半夜别打扰：降级提醒落在 22:00~08:00 的推到早上 9 点（同一时刻扎堆由后续错峰逻辑处理）
      // 云函数运行在 UTC，必须按北京时间判断小时，否则北京时间凌晨会被当成下午。
      const cnNow = tsToCnDateTimeStr(ts);
      const h = Number(cnNow.slice(11, 13));
      if (h >= 22 || h < 8) {
        const d9 = h >= 22 ? shiftDate(cnNow.slice(0, 10), 1) : cnNow.slice(0, 10);
        ts = parseCnTime(`${d9}T09:00:00`);
      }
      finalNote = `按常规 ${dateStr} 就该开票/预订了，现在已经进入抢票期：${finalNote}`;
    }
    list.push({
      title: title.slice(0, 100),
      note: finalNote,
      fireAt: ts,
      fireAtStr: tsToCnDateTimeStr(ts),
      type,
      source: 'ai-rule',
      dayIndex: Number.isInteger(Number(meta.dayIndex)) ? Number(meta.dayIndex) : undefined,
      bookingInfo: String(meta.bookingInfo || '').slice(0, 160),
      linkedItemId: String(meta.linkedItemId || '').slice(0, 100),
    });
  };
}

function hotelBookingTasks(outline) {
  const days = asArray(outline && outline.days);
  const tasks = [];
  for (let i = 0; i < Math.max(0, days.length - 1);) {
    const day = days[i] || {};
    const place = String(day.hotel || day.overnight || day.city || '').trim();
    const hotel = safeHotelOf(day);
    let end = i + 1;
    while (end < days.length - 1) {
      const next = days[end] || {};
      const nextPlace = String(next.hotel || next.overnight || next.city || '').trim();
      const nextHotel = safeHotelOf(next);
      const sameStay = hotel || nextHotel
        ? !!hotel && hotel === nextHotel
        : !!place && !!nextPlace && place === nextPlace;
      if (!sameStay) break;
      end += 1;
    }
    tasks.push({
      dayIndex: i,
      checkIn: String(day.date || ''),
      nights: Math.max(1, end - i),
      place,
      hotel,
      hotelPoiVerified: day.hotelPoiVerified === true && !!hotel,
      hotelPoiAddress: String(day.hotelPoiAddress || '').trim(),
      hotelRecommendationReason: String(day.hotelRecommendationReason || '').trim(),
    });
    i = end;
  }
  return tasks;
}

function hotelTaskNote(task) {
  const base = '酒店可随时提前预订，没有统一放票时间；越早确认越好。请到「酒店住宿」分类逐项核对并预订。';
  if (task && task.hotelPoiVerified) {
    return [base, task.hotelPoiAddress ? `地图 POI 地址：${task.hotelPoiAddress}。` : '',
      task.hotelRecommendationReason || '已核验完整名称，可复制到主流平台核对后预订。'].filter(Boolean).join('');
  }
  return [base, task && task.hotelRecommendationReason].filter(Boolean).join('');
}

function hotelRecommendationNote(day) {
  const d = day || {};
  const hotel = String(d.hotel || '').trim();
  if (!hotel) return '';
  const area = String(d.overnight || d.city || '').trim();
  if (d.hotelPoiVerified === true && String(d.hotelPoiVerifiedName || '').trim() === hotel) {
    return [
      `推荐酒店：${hotel}`,
      area ? `所在区域：${area}` : '',
      d.hotelPoiAddress ? `地址：${d.hotelPoiAddress}` : '',
      '已用地图 POI 核验，可复制完整名称到主流平台（携程、去哪儿、美团或高德）核对房型、价格与取消规则。',
    ].filter(Boolean).join('；');
  }
  return [
    `住宿建议：${hotel}`,
    area ? `所在区域：${area}` : '',
    '这是片区+档次的可搜索范围，不是虚构的具体酒店名称；请在主流平台搜索后核对真实物业、地址和取消规则。',
  ].filter(Boolean).join('；');
}

/**
 * 酒店名称是跨天链路的一部分：当天入住卡、第二天早餐/退房、后续交通起点
 * 都可能引用同一家酒店。大纲经 POI 核验或用户编辑酒店后，不能只改 hotel
 * 条目，否则时间线里会同时出现新旧两个名称，地图和闹钟也会指向不同地方。
 */
function syncHotelReferences(items, outline) {
  const days = asArray(outline && outline.days);
  const targets = days.map((day) => safeHotelOf(day) || String(day && day.hotel || '').trim());
  const scopes = days.map((day) => dayScope(day));
  const aliases = days.map(() => new Set());
  const addAlias = (dayIndex, value) => {
    const text = String(value || '').trim();
    if (!text || !aliases[dayIndex]) return;
    if (LODGING_WORD_RE.test(text) || text === targets[dayIndex]) aliases[dayIndex].add(text);
  };
  days.forEach((day, index) => addAlias(index, day && day.hotel));
  asArray(items).forEach((item) => {
    if (String(item && item.category || '') !== 'hotel') return;
    const dayIndex = Number(item.dayIndex || 0);
    addAlias(dayIndex, item.startLocation);
    addAlias(dayIndex, item.endLocation);
    addAlias(dayIndex, item.bookingInfo);
  });

  const matches = (value, dayIndex) => {
    const text = String(value || '').trim();
    if (!text || dayIndex < 0 || !scopes[dayIndex]) return false;
    return aliases[dayIndex].has(text)
      || (LODGING_WORD_RE.test(text) && sameTravelArea(text, scopes[dayIndex]));
  };
  const replaceExact = (text, replacements) => {
    let out = String(text || '');
    replacements
      .filter((pair) => pair && pair[0] && pair[1] && pair[0] !== pair[1])
      .sort((a, b) => b[0].length - a[0].length)
      .forEach(([before, after]) => { out = out.split(before).join(after); });
    return out;
  };

  return asArray(items).map((item) => {
    if (!item) return item;
    const out = Object.assign({}, item);
    const dayIndex = Number(item.dayIndex || 0);
    const previousTarget = targets[dayIndex - 1] || '';
    const currentTarget = targets[dayIndex] || '';
    const previousScope = scopes[dayIndex - 1] || '';
    const currentScope = scopes[dayIndex] || '';
    const start = String(item.startLocation || '').trim();
    let end = String(item.endLocation || '').trim();
    const activity = String(item.activity || '');
    const knownDestinations = asArray(days[dayIndex] && days[dayIndex].moves)
      .flatMap((move) => [move.from, move.to]).filter(Boolean);
    const statedDestination = knownDestinations.find((name) =>
      ['前往', '赶往', '去往', '赴'].some((verb) => activity.includes(`${verb}${name}`)));
    if (statedDestination && statedDestination !== end && /退房/.test(activity)) {
      end = out.endLocation = statedDestination;
      out.endLon = ''; out.endLat = '';
    }
    const morningDeparture = String(item.category || '') === 'food'
      || /早餐|早饭|早餐店|退房|收拾行李|整理行李/.test(`${activity} ${item.note || ''}`)
      || ((toMin(item.startTime) ?? 1440) < 10 * 60 + 30 && /出发|离开/.test(activity));
    const replacements = [];

    // 第二天早上的早餐/退房仍发生在前一晚酒店；其余普通住宿起点也优先
    // 使用上一晚的已核验名称，避免“酒店 A→酒店 B”被旧文本切断。
    let startTarget = '';
    if (start && previousTarget && matches(start, dayIndex - 1)
        && (morningDeparture || !matches(start, dayIndex))) {
      startTarget = previousTarget;
    } else if (start && currentTarget && matches(start, dayIndex)) {
      startTarget = currentTarget;
    }
    if (startTarget && start !== startTarget) {
      replacements.push([start, startTarget]);
      out.startLocation = startTarget;
      out.startLon = '';
      out.startLat = '';
    }

    // 入住/回酒店条目必须落到当天酒店；早餐、退房等如果仍指向上一晚，
    // 则沿用上面的 previousTarget，而不是把人瞬移到今晚酒店。
    let endTarget = '';
    const checkingOut = /退房/.test(activity) && !/不退房|无需退房/.test(activity);
    const hotelArrival = !checkingOut && /入住|回房|回到|返回|休息/.test(activity)
      && (!end || LODGING_WORD_RE.test(end));
    if (String(item.category || '') === 'hotel' && currentTarget && hotelArrival) {
      endTarget = currentTarget;
    } else if (end && previousTarget && matches(end, dayIndex - 1)
        && (morningDeparture || !matches(end, dayIndex))) {
      endTarget = previousTarget;
    } else if (end && currentTarget && matches(end, dayIndex)) {
      endTarget = currentTarget;
    }
    if (endTarget && end !== endTarget) {
      replacements.push([end, endTarget]);
      out.endLocation = endTarget;
      out.endLon = '';
      out.endLat = '';
    }

    if (replacements.length) out.activity = replaceExact(activity, replacements);
    if (String(item.category || '') === 'hotel') {
      out.bookingInfo = checkingOut ? previousTarget : currentTarget;
      // 分类不能覆盖动作语义：退房后去交通枢纽仍是移动，不是今晚入住。
      if (checkingOut && /前往|赶往|去往|赴/.test(activity)
          && end && !LODGING_WORD_RE.test(end)) out.category = 'transport';
    }
    return out;
  });
}

/** 把酒店核验结果带到最终行程卡片，用户不必只看一条无法检索的酒店名。 */
function annotateHotelItems(items, outline) {
  const days = asArray(outline && outline.days);
  // Canonicalizing aliases can collapse a hotel-to-hotel leg into no movement.
  // Clean those legs after the rewrite, before IDs and alarms are linked.
  const synced = removeCheckoutBacktracks(removeZeroDistanceTransports(syncHotelReferences(items, outline)));
  return synced.map((item) => {
    if (!item || String(item.category || '') !== 'hotel') return item;
    const offset = /退房/.test(item.activity || '') && !/不退房|无需退房/.test(item.activity || '') ? -1 : 0;
    const day = days[Number(item.dayIndex || 0) + offset] || {};
    const hotel = String(day.hotel || item.endLocation || '').trim();
    if (!hotel) return item;
    const out = Object.assign({}, item, { bookingInfo: hotel });
    const note = hotelRecommendationNote(day);
    // 推荐附注是派生数据，替换酒店后不能把旧地址一直追加保留下来。
    out.note = String(out.note || '').split(/(?:推荐酒店|住宿建议|所在区域|地址)[：:]/)[0].replace(/[；;\s]+$/, '');
    if (note && !String(out.note || '').includes(note)) {
      out.note = [String(out.note || '').trim(), note].filter(Boolean).join('；');
    }
    return out;
  });
}

function sameHotelTaskAlarm(alarm, task, bookingInfo) {
  return !!alarm && alarm.type === 'hotel'
    && Number(alarm.dayIndex) === Number(task.dayIndex)
    && String(alarm.bookingInfo || '') === String(bookingInfo || '');
}

/**
 * 代码兜底：无论如何都要有的几条硬闹钟
 *   · 去程/返程火车票开票日（12306 提前 15 天含当日 → T-14）
 *   · 酒店：出发前 7 天锁定可免费取消房型
 *   · 热门景区门票：提前 N 天开始预约
 * 只有当这些日期还没过去时才生成。
 */
function buildFallbackAlarms(p, outline) {
  const now = Date.now();
  const list = [];
  const tripStartTs = parseCnTime(`${p.startDate}T00:00:00`);
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const push = makeRuleAlarmPusher(list, tripStartTs, tripEndTs);
  const alreadyBooked = (target, type) => bookingStatusMatches(p, target, type);

  // 1. 大交通：找第一天和最后一天里的火车/飞机班次
  // LLM 可能写 "train" 也可能写 "高铁"/"动车"，两边都要认，否则会被误判成机票（提前 30 天）
  const firstDay = outline.days[0] || {};
  const lastDay = outline.days[outline.days.length - 1] || {};
  const modeRaw = (m) => `${m.mode || ''}${m.code || ''}`.toLowerCase();
  const railMove = (day) => asArray(day.moves).find((m) => /train|plane|高铁|动车|火车|航班|飞机/.test(modeRaw(m)));
  const isTrainMove = (m) => !/plane|航班|飞机/.test(modeRaw(m));
  const go = railMove(firstDay);
  const back = railMove(lastDay);

  if (go) {
    const isTrain = isTrainMove(go);
    const ticketType = isTrain ? 'train' : 'plane';
    const target = `${go.from || ''}→${go.to || ''}${go.code ? ` ${go.code}` : ''}`;
    if (!alreadyBooked(`${isTrain ? '去程火车票' : '去程机票'} ${target}`, ticketType)) {
      const before = isTrain ? TRAIN_PRESALE_DAYS : 30; // 机票通常提前 30 天以上关注
      const d = shiftDate(firstDay.date, -before);
      push(
        `${isTrain ? '开抢去程火车票' : '关注去程机票'}：${go.from || ''}→${go.to || ''}${go.code ? '（参考车次 ' + go.code + '）' : ''}`,
        d, '09:00', isTrain ? 'train' : 'plane',
        `按${isTrain ? '12306 提前 15 天预售（含当日）' : '航司常见提前 30 天放票'}推算：${d} 开票。各站/各航司具体放票时刻不同，请在 App 内设置起售提醒并提前录入乘客信息。`,
        { dayIndex: 0, bookingInfo: `${go.from || ''}→${go.to || ''}${go.code ? ` ${go.code}` : ''}` }
      );
    }
  }
  if (back && outline.days.length > 1) {
    const isTrain = isTrainMove(back);
    const ticketType = isTrain ? 'train' : 'plane';
    const target = `${back.from || ''}→${back.to || ''}${back.code ? ` ${back.code}` : ''}`;
    if (!alreadyBooked(`${isTrain ? '返程火车票' : '返程机票'} ${target}`, ticketType)) {
      const before = isTrain ? TRAIN_PRESALE_DAYS : 30;
      const d = shiftDate(lastDay.date, -before);
      push(
        `${isTrain ? '开抢返程火车票' : '关注返程机票'}：${back.from || ''}→${back.to || ''}${back.code ? '（参考车次 ' + back.code + '）' : ''}`,
        d, '09:00', isTrain ? 'train' : 'plane',
        `返程${lastDay.date}的${isTrain ? '火车票' : '机票'}，按提前 ${before + 1} 天（含当日）推算 ${d} 开票。长假返程务必当天卡点抢。`,
        { dayIndex: outline.days.length - 1, bookingInfo: `${back.from || ''}→${back.to || ''}${back.code ? ` ${back.code}` : ''}` }
      );
    }
  }

  // 2. 每段住宿各生成一条尽早办理的待办；酒店没有统一放票日。
  hotelBookingTasks(outline).forEach((task) => {
    const stay = task.hotel || `${task.place || '目的地住宿'}${task.nights > 1 ? `（${task.nights}晚）` : ''}`;
    push(
      `尽早确认酒店预订：${stay}`,
      task.checkIn || p.startDate, '09:00', 'hotel',
      hotelTaskNote(task),
      {
        dayIndex: task.dayIndex,
        bookingInfo: stay,
        hotelPoiAddress: task.hotelPoiAddress,
        hotelRecommendationReason: task.hotelRecommendationReason,
        bookingNote: hotelTaskNote(task),
      }
    );
  });

  // 3. 门票：挑一个最像"需要预约"的景点（有景区/瀑布/竹筏等特征词的优先）
  const TICKET_HINT = /景区|瀑布|梯田|竹筏|游船|漓江|岩洞|古镇|古镇|森林公园|国家公园|博物馆|观景台|漂流|温泉|演出|剧场|音乐会|演唱会|展览|展馆|号$|寨$/;
  const likelyScenicHighlight = (highlight, day) => {
    const name = String(highlight || '');
    const context = `${day && day.city || ''} ${day && day.theme || ''} ${day && day.overnight || ''}`;
    return TICKET_HINT.test(name)
      || (name === String(day && day.city || '').trim()
        && name.length >= 3
        && !/市区|县城|返程|住宿|美食|拍照|休息/.test(name))
      || (/景区|瀑布|梯田|游船|竹筏|漂流|观景台|温泉/.test(context)
        && !/美食|餐|拍照|夜景|休息/.test(name));
  };
  const allHighlights = [];
  outline.days.forEach((d, i) => {
    if (i === outline.days.length - 1) return; // 返程日的景点不值得预约
    asArray(d.highlights).forEach((h) => h && allHighlights.push({ name: String(h), dayIndex: i, day: d }));
  });
  // 门票：最多盯 3 个最像"需要预约"的景点，别只给一条
  const hotSpots = allHighlights.filter((h) => likelyScenicHighlight(h.name, h.day)).slice(0, 3);
  const spots = hotSpots.length ? hotSpots : allHighlights.slice(0, 1);
  spots.forEach((s, i) => {
    if (alreadyBooked(`${s.name} 门票/预约`, 'ticket')) return;
    push(
      `开始盯${String(s.name).slice(0, 20)}门票/预约放票`,
      shiftDate(p.startDate, -TICKET_PRESALE_DAYS + i), '09:00', 'ticket',
      '热门景区多提前 1-7 天限额放票，假期需每天查看余票公告，具体规则以景区官方通知为准，下单前请核对。',
      { dayIndex: s.dayIndex, bookingInfo: s.name }
    );
  });

  // 4. 自驾：用户选了全程自驾时，提前确认车辆与停车条件
  if (drivingAllowed(p)) {
    push(
      '确认自驾车辆及停车安排',
      shiftDate(p.startDate, -7), '10:00', 'other',
      '若需租车，提前确认车型、保险、取还车点和异地还车条件；逐日核对酒店/景区停车条件。'
    );
  }

  // 5. 行前准备：证件 / 订单 / 装备核对（行程前 2 天）
  push(
    '核对证件、订单与装备清单',
    shiftDate(p.startDate, -2), '20:00', 'other',
    '把车票/门票/酒店订单、身份证、充电宝与药品逐项过一遍，缺的当晚补齐。'
  );

  return list;
}

/**
 * 查漏补齐：LLM 提名经常"只挑重点"，导致某段城际车票或某一晚酒店漏掉。
 * 这里对着大纲逐项清点：每段城际交通（按乘车日-预售期无同类型闹钟 → 补开票提醒）、
 * 每一晚住宿（无 hotel 闹钟 → 补预订提醒），确定性补齐，用户才不用逐条手工加。
 */
function backfillMissingAlarms(p, outline, nominated) {
  const list = [];
  const tripStartTs = parseCnTime(`${p.startDate}T00:00:00`);
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const push = makeRuleAlarmPusher(list, tripStartTs, tripEndTs);
  const dayKey = (ts) => tsToDateStr(ts);
  const alreadyBooked = (target, type) => bookingStatusMatches(p, target, type);

  const days = asArray(outline.days);

  // ① 城际交通段：每一段（train/plane/bus）都该有一条"开抢"提醒
  days.forEach((d) => {
    asArray(d.moves).forEach((m) => {
      const mode = String(m.mode || '').toLowerCase();
      const isTrain = /train|高铁|动车|火车/.test(mode + (m.code || ''));
      const isPlane = /plane|航班|飞机/.test(mode + (m.code || ''));
      const isBoat = /ship|船|轮渡|渡船|游船|竹筏/.test(mode);
      const isBus = /bus|大巴|直通|旅游专线/.test(mode);
      if (!isTrain && !isPlane && !isBoat && !isBus) return;
      if (isBus && m.bookingRequired === false) return;
      const type = isTrain ? 'train' : isPlane ? 'plane' : isBoat ? 'ticket' : 'bus';
      const presale = isTrain ? TRAIN_PRESALE_DAYS : isPlane ? 30 : isBoat ? TICKET_PRESALE_DAYS : 5;
      const target = `${m.from || ''}→${m.to || ''}${m.code ? ` ${m.code}` : ''}`;
      if (alreadyBooked(`${target} ${isBoat ? '游船/船票' : type === 'train' ? '火车票' : type === 'plane' ? '机票' : '汽车票'}`, type)) return;
      const buyDate = shiftDate(d.date, -presale);
      // 同一天的另一班车、相反方向或邻日去程票都不能替本段车票背书。
      const routeKey = (value) => String(value || '').replace(/[\s（）()]/g, '').replace(/站(?=→|$)/g, '');
      const identity = routeKey(`${m.from || ''}→${m.to || ''}`);
      const covered = nominated.concat(list).some((a) => a.type === type
        && Number(a.dayIndex || 0) === days.indexOf(d)
        && routeKey(`${a.bookingInfo || ''} ${a.title || ''}`).includes(identity));
      if (covered) return;
      push(
        `开抢${d.date} ${m.from || ''}→${m.to || ''}${m.code ? '（参考 ' + m.code + '）' : ''}票`,
        buyDate, '09:00', type,
        `这段城际交通（第${days.indexOf(d) + 1}天）AI 提名时漏了，按预售期自动补上。具体放票时间以官方 App 为准。`,
        { dayIndex: days.indexOf(d), bookingInfo: `${m.from || ''}→${m.to || ''}${m.code ? ` ${m.code}` : ''}` }
      );
    });
  });

  // ② 住宿：每个连续住宿地点单独生成提醒，不把酒店开售日期假设成 T-7。
  hotelBookingTasks(outline).forEach((task) => {
    const stay = task.hotel || `${task.place || '目的地住宿'}${task.nights > 1 ? `（${task.nights}晚）` : ''}`;
    push(
      `尽早确认酒店预订：${stay}`,
      task.checkIn || p.startDate, '09:00', 'hotel',
      hotelTaskNote(task),
      {
        dayIndex: task.dayIndex,
        bookingInfo: stay,
        hotelPoiAddress: task.hotelPoiAddress,
        hotelRecommendationReason: task.hotelRecommendationReason,
        bookingNote: hotelTaskNote(task),
      }
    );
  });

  return list;
}

/**
 * 详细行程查漏：大纲里的 highlights 可能漏掉了 LLM 在某一天细化时新增的门票、
 * 游船、竹筏、演出等事项。对明确写出“需要预约/购票”的条目按规则补一条，
 * 让提醒来源真正覆盖最终详细行程。
 */
function backfillDetailAlarms(p, outline, items, existing) {
  const list = [];
  const tripStartTs = parseCnTime(`${p.startDate}T00:00:00`);
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const push = makeRuleAlarmPusher(list, tripStartTs, tripEndTs);
  const base = asArray(existing);
  const days = asArray(outline.days);
  // 父景区入园与内部观景点是同一购票事项；真正的竹筏、演出等另行提醒。
  const scenicEntries = new Set();
  const normalize = (s) => String(s || '').replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
  const actionClockOf = (text, fallback) => {
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
  };
  const covered = (type, date, text) => {
    const needle = normalize(text).slice(0, 8);
    return base.concat(list).some((a) => {
      if (a.type !== type || tsToDateStr(a.fireAt) !== date) return false;
      const old = normalize(a.title);
      return needle.length >= 4 && (old.indexOf(needle.slice(0, 4)) >= 0 || needle.indexOf(old.slice(0, 4)) >= 0);
    });
  };
  asArray(items).forEach((it) => {
    const text = `${it.activity || ''} ${it.note || ''}`;
    const action = String(it.activity || '');
    const actualBooking = /购买|购票|预约|预订|(?:乘坐|搭乘|体验|观看).{0,16}(?:游船|竹筏|漂流|演出|缆车|索道)/.test(action);
    const waitingOnly = /取票|安检|候车|候船|检票/.test(action) && !actualBooking;
    const baggageOnly = it.category !== 'sight' && /行李|箱子|大件/.test(action)
      && /寄存|暂存|取回|退房|整理/.test(action) && !actualBooking;
    if (waitingOnly || baggageOnly) return;
    const day = days[Number(it.dayIndex || 0)] || {};
    const date = validDate(day.date) ? day.date : shiftDate(p.startDate, Number(it.dayIndex || 0));
    const titleText = String(it.activity || it.endLocation || it.startLocation || '该项目').slice(0, 28);
    const statusType = it.category === 'transport' ? bookingKindOf(text) : it.category === 'ticket' ? 'ticket' : '';
    if (BOOKING_DONE_RE.test(text)
      || (statusType && bookingStatusMatches(p, `${titleText} ${text}`, statusType))) return;
    const entryLocation = String(it.endLocation || '').replace(/(?:正门|大门|门口|出口|入口).*$/, '').trim();
    const scoped = String(it.visitScope || '').trim();
    const scenicScope = scoped && `${action} ${it.startLocation || ''} ${it.endLocation || ''}`.includes(`${scoped}景区`)
      ? `${scoped}景区` : '';
    const parent = /景区|梯田|瀑布|山|公园|沟|田园|博物馆|祠|寺|宫/.test(scoped) ? scoped
      : scenicScope || (/景区|公园|博物馆|祠$|寺$|宫$/.test(entryLocation) ? entryLocation
        : /(?:^|[\s，,：:])(?:游览|参观)([^\s，,。；;（）()与及]{1,20}(?:祠|寺|宫))/.exec(action)?.[1] || '');
    if (it.category === 'sight' && /景区|梯田|瀑布|山|公园|沟|田园|博物馆|祠|寺|宫/.test(parent)
      && !scenicEntries.has(parent)) {
      scenicEntries.add(parent);
      const entryKey = (value) => normalize(value).replace(/风景区|景区|门票|预约|放票/g, '');
      const existingEntry = base.some((alarm) => alarm.type === 'ticket' && /门票\/预约放票/.test(alarm.title || '')
        && entryKey(alarm.bookingInfo) === entryKey(parent));
      if (!existingEntry && !bookingStatusMatches(p, `${parent} 门票`, 'ticket')) {
        const entry = asArray(items).find((row) => Number(row.dayIndex || 0) === Number(it.dayIndex || 0)
          && row.category === 'ticket' && `${row.activity || ''} ${row.endLocation || ''}`.includes(parent)) || it;
        push(`${parent}${/景区$/.test(parent) ? '' : '景区'}门票/预约放票`, shiftDate(date, -TICKET_PRESALE_DAYS), '09:00', 'ticket',
          '提前核验景区官方预约及售票规则；连续游玩时确认门票有效期，内部观景点不重复购票。',
          { dayIndex: Number(it.dayIndex || 0), bookingInfo: parent, linkedItemId: entry.itemId });
      }
    }
    const ticketEvidence = /门票|购票|放票|入园预约|实名预约|船票|游船|竹筏|漂流|演出|缆车|索道|温泉票|跟拍/.test(text);
    const movementOnly = it.category === 'transport'
      || /^(walk|ride|bus|train|plane|car)$/.test(String(it.transportType || '').toLowerCase())
      || /步行|打车|网约车|乘车|乘坐|前往|接驳/.test(String(it.activity || ''));
    const ticketLike = ticketEvidence && (!movementOnly || /门票|购票|放票|入园预约|实名预约|船票|游船|竹筏|漂流|演出|缆车|索道|温泉票|跟拍/.test(String(it.activity || '')))
      || it.category === 'ticket' && !movementOnly;
    if (ticketLike) {
      const clock = actionClockOf(text, '09:00');
      if (!covered('ticket', shiftDate(date, -TICKET_PRESALE_DAYS), titleText)) {
        push(
          `预约${date} ${titleText}`,
          shiftDate(date, -TICKET_PRESALE_DAYS), clock, 'ticket',
          '根据最终详细行程自动补齐，热门项目通常提前 1-7 天放票或预约。具体开放时间以景区官方公告为准，下单前请核对。',
          { dayIndex: Number(it.dayIndex || 0), bookingInfo: titleText, linkedItemId: it.itemId }
        );
      }
      return;
    }
    // 日常携带行李、回房和游玩备注不等于行前待办，证件/装备已有统一清单。
    const prepLike = /^(?:出发前|行前|提前|预先|准备|整理|核对|检查|备好|备齐|预约|预订|确认).{0,20}(?:身份证|护照|签证|通行证|驾照|药品|充电宝|装备|宠物|外币|流量卡|保险|值机|选座|租车|包车|接送机)/.test(action)
      || /护照|签证|通行证|外币|流量卡|保险|值机|选座/.test(action);
    if (prepLike && !covered('other', shiftDate(date, -3), titleText)) {
      push(
        `准备${date} ${titleText}`,
        shiftDate(date, -3), '20:00', 'other',
        '根据最终详细行程自动补齐，出发前检查材料、装备或服务是否已经准备好。',
        { dayIndex: Number(it.dayIndex || 0) }
      );
    }
  });
  return list;
}

/**
 * 时间不够让 LLM 提名时的底线闹钟：硬规则 + 查漏补齐（都是确定性的，不调 LLM）
 * 顺序有讲究：先 buildFallbackAlarms 铺底线，再让 backfillMissingAlarms 对着它查漏，
 * 这样"每段城际票 + 每晚住宿"都能补上，不会退化成只有 1 条酒店提醒。
 */
function fallbackAlarms(p, outline) {
  const base = buildFallbackAlarms(p, outline);
  return base.concat(backfillMissingAlarms(p, outline, base));
}

async function genAlarms(p, outline, deadline) {
  const lines = outline.days.map((d, i) => {
    const mv = asArray(d.moves).map((m) => `${m.mode || ''}${m.code ? ' ' + m.code : ''} ${m.from || ''}→${m.to || ''} ${m.startTime || ''}${m.endTime ? '-' + m.endTime : ''}`).join('；');
    return `第${i + 1}天 ${d.date}｜${d.theme}｜住${d.overnight || d.city}${mv ? '｜交通：' + mv : ''}`;
  }).join('\n');

  const prompt = `一份${p.days}天行程（${p.startDate} ~ ${p.endDate}）的「待办日历」。今天按北京时间计算。

【行程】
${lines}

【旅行需求】${profileText(p)}

请**穷举**这份行程里所有需要提前预订、抢购、预约或提前准备的事项，输出 JSON 数组，每个元素：
{"title":"...","fireAt":"YYYY-MM-DD HH:mm","type":"train/plane/bus/ticket/hotel/other","note":"..."}

# 必须覆盖的类别（漏了要补）
1. 大交通票：去程/返程火车票（type=train）、机票（plane）、长途汽车票/直通车票（bus）。
2. 行程内每一段城际交通：跨城高铁、城际大巴、轮渡、包车/租车（对应 train/bus/other）。
3. 酒店：LLM 不生成酒店开售日期提醒；程序会按每段住宿生成立即显示在「酒店住宿」分类中的尽早预订待办。
4. 门票/预约：每一个需要实名预约、限量放票或分时段入园的景区/项目（type=ticket）。
5. 体验项目：竹筏/游船/漂流/潜水/温泉/跟拍/演出等需提前预订的项目（type=ticket 或 other）。
6. 行前准备：证件（身份证/护照/签证/边境通行证）、租车驾照、宠物寄养、装备采购、药品、外币/流量卡等（type=other），按"出发前 N 天"排。

# 票务状态硬约束
用户需求中的“已购票/已买票/已订票/已预约/已预订/已订好/无需购买”等明确完成状态，表示对应车票、门票、游船票、演出门票等已经处理：**不要为对应事项再输出提醒**。若只写“火车票已购”而没有说门票已购，只跳过火车票，门票仍要提醒；“未购/尚未/还没买”必须继续提醒。酒店不属于已购票范围，仍生成尽早预订提醒。

# 时间推算规则（按中国各平台实际能查到的开放时间）
- 火车票 12306 预售期 15 天（含乘车当日）：乘车日减 14 天 = 开票日，时刻取 09:00（各站起售时刻不同）。
- 机票：普遍提前 30 天以上放票/开卖，取 30 天前的 10:00 开始关注。
- 长途汽车票/直通车：一般提前 3-7 天开售，取 5 天前的 09:00。
- 酒店没有统一开售时间，用户可以随时预订；不要推算酒店放票日。
- 景区门票：按国内主流 OTA/景区公众号，普遍提前 1-7 天放票，热门景区取 7 天前 09:00 开始盯。
- 行前准备类：证件/装备取出发前 3-5 天，值机/选座取出发前 1 天。

# 输出要求
0. **先在心里点数，再逐一输出**：城际交通共几段（含去程/返程/行程内中转）、住宿共几晚、需要门票/预约的点有几个——每一段/每一晚/每一个都要有对应条目，一个都不许少。宁多勿漏，这是硬要求。
1. title 写清楚抢什么、对应哪一天（例："抢去程票：重庆北→桂林西 G2249（9月30日车次）"）。
2. fireAt 必须是**未来的具体日期+时刻**，且**按时间从早到晚排序**。
3. note 里写明推算依据，并以「具体放票/开放时间以官方 App 或景区公告为准，下单前请核对」结尾。
4. 每个需要购票/预约/准备的事项只输出**一条**闹钟：fireAt 填用户真正要办理/开抢/使用前需要处理的时刻，系统会按用户设置的提前分钟数统一计算提醒时刻；不要为同一事项另起“提前准备”和“到点”两条记录，也不要自行固定 5 分钟。
5. **拒绝编造**：只用上面的日期推算；算不准宁可不输出，不要输出模糊或已过去的日期。
6. ${p.holiday ? '这是法定长假行程，抢票/预约压力极大，宁多勿漏。' : ''}
7. 同一件事不要重复。只输出数组。`;

  let nominated = [];
  try {
    const text = await llm.chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], deadline ? { deadline } : undefined);   // 20+ 条闹钟很常见，不设上限才能一次写完
    // 酒店由规则按实际连续住宿段生成；不采纳模型假设的酒店开售日期。
    nominated = sanitizeAlarmCandidates(asArray(parseJSONFromText(text)), p)
      .filter((a) => a.type !== 'hotel');
  } catch (e) {
    console.error('[generatePlan] 闹钟提名失败，只走规则兜底:', e.message);
  }

  // 查漏补齐：LLM 漏提的城际段/酒店晚数，按规则确定性补上（用户别再手工加）
  nominated = nominated.concat(backfillMissingAlarms(p, outline, nominated));

  // 规则兜底补上必需的几条（去重：同一天同类型已有 LLM 提名的就跳过）
  const fallback = buildFallbackAlarms(p, outline);
  const have = new Set(nominated.map((a) => a.type === 'hotel'
    ? `hotel|${Number(a.dayIndex)}|${String(a.bookingInfo || '')}`
    : `${tsToDateStr(a.fireAt)}|${a.type}`));
  fallback.forEach((a) => {
    const key = a.type === 'hotel'
      ? `hotel|${Number(a.dayIndex)}|${String(a.bookingInfo || '')}`
      : `${tsToDateStr(a.fireAt)}|${a.type}`;
    if (!have.has(key)) {
      nominated.push(a);
      have.add(key);
    }
  });

  // 时间扎堆的闹钟（AI 常把一堆酒店预订都定在 20:00）错开 5 分钟，避免同时炸
  const usedTs = new Map();
  const out = [];
  nominated.forEach((a) => {
    let ts = a.fireAt;
    while (usedTs.has(ts)) ts += 5 * 60 * 1000;
    usedTs.set(ts, true);
    if (ts !== a.fireAt) {
      out.push(Object.assign({}, a, {
        fireAt: ts,
        fireAtStr: tsToCnDateTimeStr(ts),
        note: `${a.note ? a.note + ' ' : ''}（与其他提醒同一时刻，已自动错开）`.trim(),
      }));
    } else {
      out.push(a);
    }
  });

  return out;
}

// ============================================================
// ④ 旅行建议
// ============================================================

async function genSuggestions(p, outline, deadline) {
  const brief = outline.days.map((d) => `${d.date} ${d.theme}`).join('\n');
  const prompt = `为以下${p.days}天行程生成旅行建议 JSON 对象：{"weather":"天气与穿着建议","gear":"装备清单","food":"必吃推荐","tips":"注意事项","transport":"交通贴士","budget":"预算参考，纯文本每行一条「项目：金额元」"}。

【旅行需求】${profileText(p)}
【逐日主题】
${brief}

要求：全部简体中文，结合目的地与出行季节给出具体建议（不要正确的废话）。budget 按 ${p.budget} 档、${p.peopleNum} 人估算。只输出对象。`;

  try {
    // 之前设过 1200 / 1800：实测 budget 字段被截成 "bud"（截断抢救把它当成键名），
    // 预算建议整段丢失。现在不设上限，6 段中文建议能一次写完整。
    const text = await llm.chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], deadline ? { deadline } : undefined);
    const obj = parseJSONFromText(text);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.error('[generatePlan] 建议生成失败（不影响主流程）:', e.message);
    return {};
  }
}

// ============================================================
// 主入口
// ============================================================

/**
 * 生成大纲（第一阶段，单独一次云函数调用）
 */
// ---------------------------------------------------------------
// 真实班次：联网检索 → 回写大纲 → 细化阶段照着挑
// ---------------------------------------------------------------

/** 城际大交通段（火车/飞机）—— 这类才有"真实班次"可言，市内接驳没有 */
function isIntercityMove(m) {
  if (!m || !m.from || !m.to) return false;
  return /train|plane|高铁|动车|火车|航班|飞机/.test(`${m.mode || ''}${m.code || ''}`.toLowerCase());
}

/** 从大纲里收集所有需要查真实班次的城际段（同方向只查一次） */
function collectSegments(outline, context = {}) {
  const seen = new Map();
  asArray(outline && outline.days).forEach((d, di) => {
    asArray(d && d.moves).forEach((m) => {
      if (!isIntercityMove(m)) return;
      const from = String(m.from).trim();
      const to = String(m.to).trim();
      const date = d.date || '';
      const routeKey = `${from}→${to}`;
      const key = scheduleKeyOf({ from, to, date });
      if (!seen.has(key)) {
        seen.set(key, {
          key: routeKey,
          scheduleKey: key,
          from, to, date,
          dayCity: String(d.city || '').trim(),
          origin: String(context.origin || '').trim(),
          mode: String(m.mode || '').toLowerCase(),
        });
      }
    });
  });
  return [...seen.values()];
}

/** 保留旧版测试/调试使用的地名词干比较；真实班次回写使用 sameStation 严格校验。 */
function shareStem(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  for (let len = Math.min(x.length, y.length); len >= 2; len--) {
    for (let i = 0; i + len <= x.length; i++) {
      if (y.indexOf(x.substr(i, len)) >= 0) return true;
    }
  }
  return false;
}

/** 在候选里挑一个：优先挑离模型原意出发时刻最近的那一班；没时刻就挑上午的 */
function pickSchedule(list, wantTime) {
  if (!asArray(list).length) return null;
  const want = toMin(wantTime);
  if (want == null) return list[0];
  let best = list[0];
  let bestGap = Infinity;
  list.forEach((c) => {
    const v = toMin(c.s);
    if (v == null) return;
    const gap = Math.abs(v - want);
    if (gap < bestGap) { bestGap = gap; best = c; }
  });
  return best;
}

/** 末日返程优先选能在用户到家时刻前到站的官方班次；不可行时选最早抵站的一班。 */
function pickReturnSchedule(list, wantStart, latestArrival) {
  const valid = asArray(list).filter((candidate) =>
    toMin(candidate && candidate.s) !== null && toMin(candidate && candidate.e) !== null);
  if (!valid.length || latestArrival == null) return pickSchedule(valid, wantStart);
  const feasible = valid.filter((candidate) => toMin(candidate.e) <= latestArrival);
  const pool = feasible.length ? feasible : valid;
  const want = toMin(wantStart);
  return pool.slice().sort((a, b) => {
    const ae = toMin(a.e);
    const be = toMin(b.e);
    if (feasible.length && ae !== be) return be - ae; // 越接近返家接驳的截止时刻越好
    if (!feasible.length && ae !== be) return ae - be; // 都赶不上时至少减少迟到
    if (want !== null) return Math.abs(toMin(a.s) - want) - Math.abs(toMin(b.s) - want);
    return toMin(a.s) - toMin(b.s);
  })[0];
}

/** 当前 move 已锁定的官方班次；时间线调整后不能再从候选里按旧车次随便挑回去。 */
function selectedOfficialSchedule(move) {
  const list = asArray(move && move.sched);
  if (!list.length) return null;
  const code = String(move.code || '').trim().toUpperCase();
  const found = list.find((c) => String(c.code || '').trim().toUpperCase() === code
    && String(c.s || '') === String(move.startTime || '')
    && String(c.e || '') === String(move.endTime || ''));
  return found || pickSchedule(list, move.startTime);
}

/** 两段官方铁路移动之间的最小衔接时间。站名相同才要求站内换乘缓冲。 */
function railTransferBuffer(previous, current) {
  return sameStation(previous && previous.to, current && current.from) ? 20 : 0;
}

/**
 * 同一天有多段铁路移动时，不能逐段独立挑“最接近模型时间”的车。
 * 逐段挑会出现后一趟在前一趟到站之前发车（例如 14:24→15:32 后又选 14:23→15:46）。
 * 这里用一个很小的动态规划，在官方候选里选择与模型意图最接近、且能按行程顺序衔接的组合。
 * 候选来自 12306，算法只负责选班次，不生成或改写任何车次时刻。
 */
function resolveOfficialRailTimeline(outline) {
  let changed = 0;
  let conflicts = 0;
  const days = asArray(outline && outline.days);
  days.forEach((day, dayIndex) => {
    const moves = asArray(day && day.moves).filter((m) =>
      m && m.schedSource === '12306' && asArray(m.sched).some((c) =>
        toMin(c && c.s) !== null && toMin(c && c.e) !== null && toMin(c.e) > toMin(c.s)));
    if (moves.length < 2) return;

    const options = moves.map((move) => asArray(move.sched).filter((c) =>
      c && toMin(c.s) !== null && toMin(c.e) !== null && toMin(c.e) > toMin(c.s)));
    if (options.some((list) => !list.length)) return;

    const distance = (candidate, move) => {
      const want = toMin(move.startTime);
      return want === null ? 0 : Math.abs(toMin(candidate.s) - want);
    };
    const solve = (withBuffer) => {
      const layers = [];
      layers[0] = options[0].map((candidate) => ({
        cost: distance(candidate, moves[0]),
        prev: -1,
      }));
      for (let i = 1; i < options.length; i++) {
        const layer = options[i].map(() => null);
        options[i].forEach((candidate, currentIndex) => {
          const currentStart = toMin(candidate.s);
          options[i - 1].forEach((previous, previousIndex) => {
            const state = layers[i - 1][previousIndex];
            if (!state) return;
            const previousEnd = toMin(previous.e);
            const requiredStart = previousEnd + (withBuffer
              ? railTransferBuffer(moves[i - 1], moves[i]) : 0);
            if (currentStart < requiredStart) return;
            const next = {
              cost: state.cost + distance(candidate, moves[i]),
              prev: previousIndex,
            };
            if (!layer[currentIndex] || next.cost < layer[currentIndex].cost) {
              layer[currentIndex] = next;
            }
          });
        });
        if (!layer.some(Boolean)) return null;
        layers[i] = layer;
      }
      const last = layers[layers.length - 1];
      let index = -1;
      last.forEach((state, i) => {
        if (state && (index < 0 || state.cost < last[index].cost)) index = i;
      });
      if (index < 0) return null;
      const picked = new Array(options.length);
      for (let i = options.length - 1; i >= 0; i--) {
        picked[i] = options[i][index];
        index = layers[i][index].prev;
      }
      return picked;
    };

    // 先要求同站至少留出 20 分钟；极少数官方结果没有满足站内换乘的组合时，
    // 再退到“至少不重叠”，保证展示的车次先后顺序仍然可执行。
    const picked = solve(true) || solve(false);
    if (!picked) {
      conflicts += 1;
      console.warn('[generatePlan] 第%d天官方班次没有可衔接组合，保留候选中最接近的选择', dayIndex + 1);
      return;
    }
    picked.forEach((candidate, i) => {
      const move = moves[i];
      const before = `${move.code || ''}/${move.startTime || ''}/${move.endTime || ''}`;
      const after = `${candidate.code || ''}/${candidate.s || ''}/${candidate.e || ''}`;
      if (before !== after) changed += 1;
      move.code = candidate.code;
      move.startTime = candidate.s;
      move.endTime = candidate.e;
      move.from = candidate.from;
      move.to = candidate.to;
    });
  });
  return { changed, conflicts };
}

/**
 * 把检索到的真实班次写回大纲。
 * 只认"同一段"的候选：出发站和到达站都要经过 sameStation 校验，
 * 不满足时整条候选丢弃，避免把串线车次写进攻略。
 */
function applyRealSchedules(outline, found, tripContext) {
  if (!found) return null;
  const context = tripContext || {};
  const days = asArray(outline && outline.days);
  const lastDayIndex = days.length - 1;
  const backMin = toMin(context.backTime || context.endTime);
  const stationArrivalDeadline = backMin == null ? null : Math.max(0, backMin - 40);
  const lastDayRailMoves = asArray(days[lastDayIndex] && days[lastDayIndex].moves).filter((move) =>
    /train|高铁|动车|火车/.test(`${move && move.mode || ''}${move && move.code || ''}`.toLowerCase())
    && !/plane|航班|飞机/.test(`${move && move.mode || ''}${move && move.code || ''}`.toLowerCase()));
  const returnMove = lastDayRailMoves[lastDayRailMoves.length - 1];
  const get = (k) => (found.get ? found.get(k) : found[k]);
  const has = (k) => (found.has ? found.has(k) : Object.prototype.hasOwnProperty.call(found, k));
  const metaOf = (k) => (found.routeMeta && found.routeMeta.get ? found.routeMeta.get(k) : null);
  const routeKeyOf = (from, to) => `${String(from || '').trim()}→${String(to || '').trim()}`;
  const dataFor = (day, move) => {
    const from = String(move.from || '').trim();
    const to = String(move.to || '').trim();
    const date = String(day.date || '').trim();
    const exactKey = scheduleKeyOf({ from, to, date });
    // 新格式按日期隔离；保留 route-only 回退，兼容本地测试和旧缓存适配器。
    if (has(exactKey)) return {
      list: Array.isArray(get(exactKey)) ? get(exactKey) : [],
      meta: metaOf(exactKey),
      present: true,
    };
    const routeKey = routeKeyOf(from, to);
    if (has(routeKey)) return {
      list: Array.isArray(get(routeKey)) ? get(routeKey) : [],
      meta: metaOf(routeKey),
      present: true,
    };
    return { list: [], meta: null, present: false };
  };
  const routeMatch = (data, move) => {
    const targetFrom = data.meta && data.meta.from ? data.meta.from : move.from;
    const targetTo = data.meta && data.meta.to ? data.meta.to : move.to;
    return asArray(data.list).filter((c) =>
      c && sameStation(c.from, targetFrom) && sameStation(c.to, targetTo));
  };
  let hit = 0;
  let replaced = 0;
  asArray(outline && outline.days).forEach((d, dayIndex) => {
    asArray(d && d.moves).forEach((m) => {
      const data = dataFor(d, m);
      const list = routeMatch(data, m);
      if (!list.length) {
        // 清除未经核验的车次，但保留规划窗口并显式标为估算。
        // 若清空整个窗口，后续转场/返程会变成午夜或随机猜测。
        if (data.present && data.meta && data.meta.official && data.meta.attempted) {
          m.sched = [];
          m.schedSource = 'official-unavailable';
          m.scheduleRequired = true;
          m.code = '';
          m.timingEstimated = true;
          if (data.meta.unresolvedStations) {
            m.transfer = '铁路站名待确认，请核对有效上车站与下车站后查询班次；不可按未核验站名购票。';
          }
        }
        return;
      }
      hit += 1;
      // 一天可能有两段铁路交通，候选不能被后一个 move 覆盖。
      // 保留完整候选（当前 direct 查询最多 48 条）。若只保留前 24 条，
      // 19:00 左右的返程车可能被截掉，后面的 enforceRealSchedule 会把已核对
      // 的晚班车误换成早班车。给 prompt 的 day.sched 仍限 16 条以控制 token。
      m.sched = list.slice(0, 48);
      d.sched = asArray(d.sched).concat(list)
        .filter((c, i, all) => all.findIndex((x) =>
          x.code === c.code && x.s === c.s && x.e === c.e
          && sameStation(x.from, c.from) && sameStation(x.to, c.to)) === i)
        .slice(0, 16);
      const pick = dayIndex === lastDayIndex && m === returnMove && stationArrivalDeadline !== null
        ? pickReturnSchedule(list, m.startTime, stationArrivalDeadline)
        : pickSchedule(list, m.startTime);
      if (!pick) return;
      if (m.code !== pick.code || m.startTime !== pick.s) replaced += 1;
      m.code = pick.code;
      m.startTime = pick.s;
      m.endTime = pick.e;
      // routeMatch 已经要求出发站/到达站分别对得上，这里才允许采用官方结果的标准站名。
      m.from = pick.from;
      m.to = pick.to;
      m.schedSource = data.meta && data.meta.official ? '12306' : 'search';
      m.scheduleRequired = false;
    });
  });
  const timeline = resolveOfficialRailTimeline(outline);
  if (timeline.changed || timeline.conflicts) {
    console.log('[generatePlan] 官方班次按日衔接：调整 %d 段，无法完全衔接 %d 天',
      timeline.changed, timeline.conflicts);
  }
  // Official schedule resolution may replace model station names with canonical
  // stations. Recheck the trip shape after that rewrite so an intermediate move
  // through the origin cannot survive just because the pre-lookup outline passed.
  const earlyReturns = prematureOriginDays(context, outline);
  if (earlyReturns.length) {
    console.warn('[generatePlan] 班次校正后发现中途提前返程：第%s天，移到末日闭环',
      earlyReturns.map((index) => index + 1).join('、'));
    deferPrematureReturn(context, outline, earlyReturns);
    applyTripEdgeTimes(context, outline);
    alignOutlineMoveTimes(outline);
    normalizeOutlineLodging(outline);
  }
  alignOutlineMoveTimes(outline);
  ensureLongjiSunriseSunset(outline);
  normalizeLijiangCruiseOutline(outline);
  ensureOutlineMoveContinuity(outline, context);
  alignOutlineMoveTimes(outline);
  console.log('[generatePlan] 联网班次：命中 %d 段，其中 %d 段换成了检索到的真实车次',
    hit, replaced + timeline.changed);
  return {
    segments: hit,
    replaced: replaced + timeline.changed,
    timelineAdjusted: timeline.changed,
    timelineConflicts: timeline.conflicts,
  };
}

/**
 * 细化结果兜底：当天写出了班次，但没落在检索到的候选里 → 拽回真实候选。
 * 优先按起终点把候选绑定到具体 move；只有一天只有一段铁路交通时才回退到整天候选。
 */
function enforceRealSchedule(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const out = items.slice();
  const listForItem = (day, item) => {
    const moves = asArray(day && day.moves).filter((m) => asArray(m && m.sched).length);
    if (item.startLocation && item.endLocation) {
      const matchedMove = moves.find((m) => sameStation(m.from, item.startLocation)
        && sameStation(m.to, item.endLocation));
      if (matchedMove) return { list: asArray(matchedMove.sched), move: matchedMove };
    }
    // 模型有时漏填起点；若这天只有一段真实铁路交通，仍可安全使用这组候选。
    if (moves.length === 1 && (!item.startLocation || !item.endLocation)
        && (!item.startLocation || sameStation(moves[0].from, item.startLocation))
        && (!item.endLocation || sameStation(moves[0].to, item.endLocation))) {
      return { list: asArray(moves[0].sched), move: moves[0] };
    }
    // 多段铁路交通但条目没有起终点时，不能把另一段的车次套过来，宁可保留 AI 参考。
    return { list: moves.length ? [] : asArray(day && day.sched), move: null };
  };
  const rewriteActivity = (item, pick, oldCode) => {
    let act = String(item.activity || '');
    if (oldCode) act = act.replace(new RegExp(escapeRegExp(oldCode), 'i'), pick.code);
    if (/^\s*\d{1,2}:\d{2}/.test(act)) act = act.replace(/^\s*\d{1,2}:\d{2}/, pick.s);
    if (!act.includes(pick.code)) act = `乘 ${pick.code} 次列车从${pick.from}前往${pick.to}`;
    return act;
  };
  days.forEach((day, di) => {
    out.forEach((it) => {
      if (Number(it.dayIndex || 0) !== di) return;
      if (String(it.category || '') !== 'transport') return;
      if (!/^train$/i.test(String(it.transportType || '')) && !transportCodeOf(it)) return;
      const data = listForItem(day, it);
      const list = data.list;
      if (!list.length) return;
      const code = transportCodeOf(it);
      // 有真实候选时，即使模型挑中了正确车次，也要把发到时刻按候选纠正。
      const exact = code && list.find((c) => String(c.code || '').toUpperCase() === code);
      const pick = exact || pickSchedule(list, it.startTime);
      if (!pick) return;
      const old = code;
      if (!exact || code !== pick.code || it.startTime !== pick.s || it.endTime !== pick.e) {
        it.activity = rewriteActivity(it, pick, old);
        it.startTime = pick.s;
        it.endTime = pick.e;
      } else if (!String(it.activity || '').includes(pick.code)) {
        it.activity = rewriteActivity(it, pick, old);
      }
      it.startLocation = pick.from;
      it.endLocation = pick.to;
      it.schedSource = data.move && data.move.schedSource ? data.move.schedSource : 'search';
      if (!exact) {
        console.warn('[generatePlan] 第%d天车次 %s 不在联网检索结果里，拽回真实班次 %s', di + 1, old || '(缺失)', pick.code);
      }
    });
  });
  return out;
}

/**
 * 最后一层铁路防线：当天只要有 12306 官方候选，所有铁路条目里的车次都必须
 * 能落到某一段候选上。模型若漏填起终点或凭记忆多写一趟车，按候选重写；无法
 * 绑定的只保留“乘列车”描述，绝不把陌生车次展示给用户。
 */
function enforceOfficialRailItems(items, outline) {
  const days = asArray(outline && outline.days);
  const out = asArray(items).slice();
  const railish = (it) => /train|高铁|动车|火车|列车/.test(`${it.transportType || ''}${it.activity || ''}`);
  const append = (it, text) => {
    const old = String(it.note || '').trim();
    if (!old.includes(text)) it.note = old ? `${old}；${text}` : text;
  };
  days.forEach((day, di) => {
    const moves = asArray(day && day.moves).filter((m) => m && m.schedSource === '12306' && asArray(m.sched).length);
    if (!moves.length) return;
    out.forEach((it) => {
      if (Number(it.dayIndex || 0) !== di || String(it.category || '') !== 'transport' || !railish(it)) return;
      const code = transportCodeOf(it);
      const byRoute = moves.find((m) => it.startLocation && it.endLocation
        && sameStation(m.from, it.startLocation) && sameStation(m.to, it.endLocation));
      const byCode = code && moves.find((m) => {
        const selected = selectedOfficialSchedule(m);
        return selected && String(selected.code || '').toUpperCase() === code
          && (!it.startTime || selected.s === it.startTime)
          && (!it.endTime || selected.e === it.endTime);
      });
      const move = byRoute || byCode || (moves.length === 1
        && (!it.startLocation || !it.endLocation)
        && (!it.startLocation || sameStation(it.startLocation, moves[0].from))
        && (!it.endLocation || sameStation(it.endLocation, moves[0].to)) ? moves[0] : null);
      if (!move) {
        if (code) {
          const from = String(it.startLocation || moves[0].from || '').trim();
          const to = String(it.endLocation || moves[0].to || '').trim();
          it.activity = `乘列车从${from}前往${to}`;
          it.schedSource = 'official-unavailable';
          append(it, '原车次未在当天12306候选中，已清除');
        }
        return;
      }
      const list = asArray(move.sched);
      const pick = selectedOfficialSchedule(move) || pickSchedule(list, it.startTime);
      if (!pick) return;
      const oldCode = code;
      const exact = code && oldCode === String(pick.code || '').toUpperCase()
        && (!it.startTime || it.startTime === pick.s)
        && (!it.endTime || it.endTime === pick.e);
      if (!exact || oldCode !== pick.code || it.startTime !== pick.s || it.endTime !== pick.e
        || !String(it.activity || '').includes(pick.code)) {
        it.activity = `乘 ${pick.code} 次列车从${pick.from}前往${pick.to}`;
      }
      it.startTime = pick.s;
      it.endTime = pick.e;
      it.startLocation = pick.from;
      it.endLocation = pick.to;
      it.schedSource = '12306';
    });
  });
  return out;
}

/** 一段既定铁路移动只能对应一趟车；模型可能同时写出早晚两趟候选。 */
function dedupeOfficialRailItems(items, outline) {
  const out = asArray(items).slice();
  const drop = new Set();
  asArray(outline && outline.days).forEach((day, di) => {
    asArray(day && day.moves).filter((m) => m && m.schedSource === '12306').forEach((move) => {
      const bound = out.filter((it) => {
        if (Number(it.dayIndex || 0) !== di || String(it.category || '') !== 'transport') return false;
        if (!/train|高铁|动车|火车|列车/.test(`${it.transportType || ''}${it.activity || ''}`)) return false;
        const code = transportCodeOf(it);
        const sameRoute = it.startLocation && it.endLocation
          && sameStation(it.startLocation, move.from) && sameStation(it.endLocation, move.to);
        const inCandidates = code && asArray(move.sched).some((c) =>
          String(c.code || '').toUpperCase() === code
          && (!it.startTime || c.s === it.startTime)
          && (!it.endTime || c.e === it.endTime));
        return sameRoute || inCandidates;
      });
      if (bound.length < 2) return;
      const want = toMin(move.startTime);
      bound.sort((a, b) => {
        const av = toMin(a.startTime) == null ? 1440 : toMin(a.startTime);
        const bv = toMin(b.startTime) == null ? 1440 : toMin(b.startTime);
        if (want === null) return av - bv;
        return Math.abs(av - want) - Math.abs(bv - want);
      });
      bound.slice(1).forEach((it) => drop.add(it));
    });
  });
  if (drop.size) console.warn('[generatePlan] 清理同一官方铁路段的重复车次 %d 条', drop.size);
  return out.filter((it) => !drop.has(it));
}

async function generateOutline(rawInput, opts = {}) {
  const p = normalizeInput(rawInput);
  if (!p.dest) throw new Error('请填写目的地');
  const t0 = Date.now();
  const outline = await genOutline(p);
  ensureOvernightMoveContinuity(outline, p);
  enforceLongjiSameDayRoute(outline, p);
  alignOutlineMoveTimes(outline);
  normalizeLijiangCruiseOutline(outline);
  ensureOutlineMoveContinuity(outline, p);
  alignOutlineMoveTimes(outline);
  sanitizeOutlineLocalMoves(outline);
  removeOutlineBacktracks(outline);
  console.log('[generatePlan] 大纲完成 %dms, 天数=%d', Date.now() - t0, outline.days.length);

  // 联网核对真实班次（可选）：模型凭记忆给的车次号/时刻和现实对不上，
  // 这里让它先查一遍再落地。查不到就静默降级，绝不因为检索失败影响出大纲。
  let schedule = null;
  if (typeof opts.scheduleLookup === 'function') {
    try {
      const segs = collectSegments(outline, { origin: opts.origin || p.origin });
      const left = Math.min(
        opts.scheduleDeadline ? opts.scheduleDeadline - Date.now() : Infinity,
        opts.scheduleBudgetMs || Infinity,
      );
      if (segs.length && left > 6000) {
        const found = await opts.scheduleLookup(segs, left);
        schedule = applyRealSchedules(outline, found, p);
        // 班次回写可能重建/改名跨天交通，重新依据最终离开时间补
        // 龙脊次日的西山韶乐日出，避免只在初始大纲里短暂存在。
        ensureLongjiSunriseSunset(outline);
        ensureOvernightMoveContinuity(outline, p);
      }
    } catch (e) {
      console.warn('[generatePlan] 真实班次检索整体失败，沿用模型编排:', e.message);
    }
  }
  return {
    profile: p,
    outline,
    title: outline.title,
    summary: outline.summary,
    startDate: p.startDate,
    endDate: p.endDate,
    days: p.days,
    schedule,
  };
}

/**
 * 第二阶段：把大纲展开为逐天详情 + 闹钟 + 建议
 * @param {object} rawInput 与第一阶段相同的用户输入
 * @param {object} outlineData 第一阶段返回的 outline（含 days / nights / title / summary）
 */
/**
 * 给 Promise 加硬超时：到点没回来就用兜底值继续，不再干等。
 * （原 Promise 仍在后台跑，但云函数返回后进程会被回收，不影响结果）
 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      console.warn('[generatePlan] 子任务超时，走兜底');
      done(fallback);
    }, Math.max(1000, ms));
    promise.then(done).catch(() => done(fallback));
  });
}

/**
 * 同一天内时间线兜底：LLM 偶尔会排出"上一条 09:00-10:00，下一条 09:30 就开始"
 * 的重叠（真跑 101 条里出过 1 条）。按开始时间排序，重叠的把开始时间顺延到
 * 上一条结束；顺延后结束时间不晚于开始的，至少补 30 分钟，不造零时长条目。
 * 只动时间字段，不改文本。返回按天分组、天内按时间排序的新数组。
 */
/** 是否交通条目：这类条目带着真实班次时刻，时间线冲突时优先让别人让路 */
function isTransportItem(it) {
  if (!it) return false;
  if (it.parking === true) return true;
  const t = String(it.transportType || '').toLowerCase();
  if (['train', 'plane', 'ship', 'bus', 'car'].includes(t)) return true;
  return /乘[^，。;；]*(列车|航班|高铁|动车|火车|飞机|大巴|班车)/.test(String(it.activity || ''));
}

function fixDayTimeOverlaps(items) {
  const days = [...new Set(asArray(items).map((it) => Number(it.dayIndex || 0)))].sort((a, b) => a - b);
  const out = [];
  const dropped = new Set();
  days.forEach((d) => {
    const list = asArray(items).filter((it) => Number(it.dayIndex || 0) === d);
    // LLM 偶尔输出 9:30 而不是 09:30；字符串排序会把 10:00 放到 9:30 前面，
    // 这正是截图里“第一天顺序乱”的根因。先归一化，再按分钟数排序。
    list.forEach((it) => {
      const s = toMin(it.startTime);
      const e = toMin(it.endTime);
      if (s !== null) it.startTime = fmtMin(s);
      if (e !== null) it.endTime = fmtMin(e);
    });
    // 兜底函数或偶发模型输出可能留下空时间。按相邻安排插入时间，不能把所有空时间
    // 一律当 24:00 排到当天末尾；首项则从下一项之前留出合理时长。
    list.forEach((it, i) => {
      if (toMin(it.startTime) !== null) return;
      const duration = Math.max(15, Math.min(180,
        parseDurationMin(`${it.note || ''} ${it.activity || ''}`) || 30));
      const prev = list.slice(0, i).reverse()
        .find((x) => toMin(x.endTime) !== null || toMin(x.startTime) !== null);
      const next = list.slice(i + 1).find((x) => toMin(x.startTime) !== null);
      const prevEnd = prev && (toMin(prev.endTime) !== null ? toMin(prev.endTime) : toMin(prev.startTime));
      const nextStart = next ? toMin(next.startTime) : null;
      let start = prevEnd !== null && prevEnd !== undefined
        ? prevEnd
        : nextStart !== null ? Math.max(0, nextStart - duration) : 8 * 60;
      if (nextStart !== null && nextStart > start && nextStart - start > duration) start = nextStart - duration;
      it.startTime = fmtMin(Math.max(0, Math.min(start, 23 * 60 + 59)));
      if (toMin(it.endTime) === null) {
        it.endTime = fmtMin(Math.min(toMin(it.startTime) + duration, 23 * 60 + 59));
      }
    });
    const startValue = (it) => {
      const v = toMin(it.startTime);
      return v === null ? 24 * 60 : v;
    };
    list.sort((a, b) => startValue(a) - startValue(b));
    for (let i = 1; i < list.length; i++) {
      const prevEnd = toMin(list[i - 1].endTime);
      const curStart = toMin(list[i].startTime);
      if (prevEnd === null || curStart === null) continue;
      const current = list[i];
      const currentEnd = toMin(current.endTime);
      // 普通用餐/游览/接驳不能把结束时间绕回 00:xx；只有夜间大交通允许跨零点。
      const mode = String(current.transportType || '').toLowerCase();
      const overnightMove = ['train', 'plane', 'ship', 'bus'].includes(mode)
        && /列车|航班|火车|高铁|动车|飞机|大巴|班车|夜班/.test(String(current.activity || ''));
      if (currentEnd !== null && currentEnd < curStart && !overnightMove) {
        const duration = Math.max(15, Math.min(180,
          parseDurationMin(`${current.note || ''} ${current.activity || ''}`) || 30));
        current.endTime = fmtMin(Math.min(curStart + duration, 23 * 60 + 59));
      }
      if (currentEnd !== null && currentEnd <= curStart && current.schedSource !== '12306') {
        // 归一化到当天最后一分钟后已没有可执行时长；保留零时长条目会
        // 伪造一个“已完成”的景点/收尾，也会让下一段的地点链失真。
        dropped.add(current);
        continue;
      }
      if (curStart >= prevEnd) continue;
      // 日出/日落窗口由太阳时刻确定，普通游览或用餐给它让路；不能把
      // 观景时间顺延到模型原先的错误时间。已核对的大交通若仍冲突，
      // 由上游“是否有足够时间”判定，不在这里伪造班次。
      if (current.timingLocked && !isTransportItem(list[i - 1])) {
        list[i - 1].endTime = current.startTime;
        continue;
      }
      if (list[i - 1].timingLocked && !isTransportItem(current)) {
        const duration = currentEnd !== null && currentEnd > curStart
          ? currentEnd - curStart : 30;
        current.startTime = fmtMin(prevEnd);
        current.endTime = fmtMin(Math.min(1439, prevEnd + duration));
        continue;
      }
      // 官方班次的发到时刻是事实，任何时间线修复都不能改它。
      // 前一条若只是普通接驳/游览，可以提前收尾让路；两条已核对大交通
      // 真正冲突时保留两条官方时刻，交给用户重新选班次，不伪造第三个时刻。
      if (list[i].schedSource === '12306') {
        if (list[i - 1].schedSource !== '12306') list[i - 1].endTime = list[i].startTime;
        continue;
      }
      // 交通条目（尤其有真实班次的火车/飞机）**不许顺延**：把时刻一挪，
      // 车次号还是那个车次号，发车时间却成了我们算出来的，用户一查就对不上。
      // 正确做法：让上一条非交通的行程（景点/用餐/接驳）提前收尾来让路。
      if (isTransportItem(list[i])) {
        const prev = list[i - 1];
        const prevStart = toMin(prev.startTime);
        if (!isTransportItem(prev) && prevStart !== null && prevStart < curStart) {
          console.warn('[generatePlan] 第%d天「%s」压缩到 %s 给交通让路（不改班次时刻）',
            d + 1, String(prev.activity || '').slice(0, 20), list[i].startTime);
          prev.endTime = list[i].startTime;
          continue;
        }
      }
      console.warn('[generatePlan] 第%d天「%s」%s 早于上一条结束 %s，顺延',
        d + 1, String(list[i].activity || '').slice(0, 20), list[i].startTime, fmtMin(prevEnd));
      list[i].startTime = fmtMin(prevEnd);
      const curEnd = toMin(list[i].endTime);
      const duration = curEnd !== null && curEnd > curStart ? curEnd - curStart : 30;
      list[i].endTime = fmtMin(Math.min(1439, prevEnd + duration));
    }
    out.push(...list.filter((item) => !dropped.has(item)));
  });
  return out;
}

function stableItemId(item, index, used) {
  const it = item || {};
  if (it.itemId && !used.has(String(it.itemId))) {
    used.add(String(it.itemId));
    return String(it.itemId);
  }
  const seed = [it.dayIndex, it.category, it.activity, it.startLocation, it.endLocation]
    .map((x) => String(x || '').trim()).join('|');
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let id = `item-${Number(it.dayIndex || 0)}-${(hash >>> 0).toString(36)}`;
  let suffix = 1;
  while (used.has(id)) id = `item-${Number(it.dayIndex || 0)}-${(hash >>> 0).toString(36)}-${suffix++}`;
  used.add(id);
  return id;
}

function ensureStableItemIds(items) {
  const used = new Set();
  return asArray(items).map((it, index) => Object.assign({}, it, {
    itemId: stableItemId(it, index, used),
  }));
}

function bookingInfoFromItem(item) {
  const it = item || {};
  if (String(it.bookingInfo || '').trim()) return String(it.bookingInfo).trim();
  if (it.category === 'hotel') return String(it.endLocation || it.activity || '').trim();
  if (it.category === 'transport' && /train|火车|列车|高铁|动车/.test(`${it.transportType || ''} ${it.activity || ''}`)) {
    const route = [it.startLocation, it.endLocation].filter(Boolean).join('→');
    const code = transportCodeOf(it);
    return [route, code].filter(Boolean).join(' ');
  }
  if (it.category === 'ticket' || /门票|预约|船票|游船|竹筏|漂流|索道|缆车/.test(String(it.activity || ''))) {
    return String(it.activity || it.endLocation || '').trim();
  }
  return '';
}

function linkBookingAlarms(alarms, items) {
  const rows = asArray(items);
  const out = asArray(alarms).map((alarm) => {
    const a = Object.assign({}, alarm);
    const type = String(a.type || '');
    if (!['train', 'plane', 'bus', 'ticket', 'hotel'].includes(type)) return a;
    const day = Number(a.dayIndex);
    const linked = a.linkedItemId
      ? rows.find((it) => String(it.itemId || '') === String(a.linkedItemId))
      : null;
    if (linked) {
      a.dayIndex = Number(linked.dayIndex || 0);
      a.bookingInfo = String(a.bookingInfo || bookingInfoFromItem(linked)).slice(0, 160);
      return a;
    }
    const dayRows = Number.isInteger(day)
      ? rows.filter((it) => Number(it.dayIndex || 0) === day)
      : rows.slice();
    if (type === 'hotel' && a.bookingInfo) {
      const hotel = dayRows.find((row) => row.category === 'hotel'
        && String(row.endLocation || '').trim() === String(a.bookingInfo).trim());
      if (hotel) {
        a.dayIndex = Number(hotel.dayIndex || 0); a.linkedItemId = String(hotel.itemId || '');
        return a;
      }
    }
    if (type === 'ticket' && /门票\/预约放票/.test(a.title || '')) {
      const subject = String(a.bookingInfo || '').replace(/景区|风景区|门票|预约|放票/g, '').trim();
      const visits = dayRows.filter((row) => ['sight', 'ticket'].includes(row.category)
        && `${row.activity} ${row.startLocation} ${row.endLocation} ${row.visitScope || ''}`.includes(subject));
      let visit = visits.find((row) => row.category === 'ticket') || visits[0];
      if (!visit || subject.length < 2) return null; // 大纲可选点被复核删掉，不留下旧门票。
      const parent = visit.visitScope;
      if (parent && parent !== subject && /景区|梯田|瀑布|山|公园|沟|田园|博物/.test(parent)
        && !/游船|竹筏|漂流|演出|缆车|索道|温泉/.test(subject)) {
        visit = dayRows.find((row) => row.category === 'ticket'
          && `${row.activity} ${row.startLocation} ${row.endLocation}`.includes(parent))
          || dayRows.find((row) => row.category === 'sight' && row.visitScope === parent) || visit;
        a.bookingInfo = parent; a.title = `${parent}景区门票/预约放票`;
      }
      a.dayIndex = Number(visit.dayIndex || 0); a.linkedItemId = String(visit.itemId || '');
      return a;
    }
    const code = String(a.bookingInfo || a.title || '').match(/\b[GDCZTK]\d{1,5}\b/i);
    const byCode = code && dayRows.find((it) => it.category === 'transport'
      && new RegExp(`\\b${code[0]}\\b`, 'i').test(it.activity || ''));
    if (byCode) {
      a.linkedItemId = String(byCode.itemId || ''); a.dayIndex = Number(byCode.dayIndex || 0);
      return a;
    }
    const routeParts = String(a.bookingInfo || '').split('→');
    const stationKey = (value) => String(value || '').trim().replace(/\s+[GDCZTK]\d+.*$/i, '')
      .replace(/站$/, '').replace(/[\s（）()]/g, '');
    const byRoute = routeParts.length === 2 && dayRows.find((it) => it.category === 'transport'
      && stationKey(it.startLocation) === stationKey(routeParts[0])
      && stationKey(it.endLocation) === stationKey(routeParts[1]));
    if (byRoute) { a.linkedItemId = String(byRoute.itemId || ''); a.dayIndex = Number(byRoute.dayIndex || 0); return a; }
    const query = `${a.bookingInfo || ''} ${a.title || ''}`
      .replace(/\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?/g, '')
      .replace(/立即查看并(?:预约|购买)|开始盯|开抢|预约|预订|购票|购买/g, '')
      .replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
    const exact = dayRows.find((it) => {
      const activity = String(it.activity || '').replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
      const route = [it.startLocation, it.endLocation].filter(Boolean).join('→')
        .replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
      const activityHead = activity.slice(0, Math.min(16, activity.length));
      return (activityHead.length >= 8 && query.includes(activityHead))
        || (!!it.startLocation && !!it.endLocation && route.length >= 4 && query.includes(route));
    });
    if (exact) {
      a.dayIndex = Number(exact.dayIndex || 0);
      a.linkedItemId = String(exact.itemId || '');
      a.bookingInfo = String(a.bookingInfo || bookingInfoFromItem(exact)).slice(0, 160);
      return a;
    }
    let candidates = dayRows;
    if (type === 'hotel') candidates = candidates.filter((it) => it.category === 'hotel');
    else if (type === 'ticket') candidates = candidates.filter((it) => it.category === 'ticket'
      || /门票|预约|船票|游船|竹筏|漂流|索道|缆车/.test(String(it.activity || '')));
    else candidates = candidates.filter((it) => it.category === 'transport'
      && /train|plane|bus|火车|列车|高铁|动车|航班|飞机|大巴/.test(`${it.transportType || ''} ${it.activity || ''}`));
    if (!candidates.length && Number.isInteger(day)) {
      const nearby = rows.filter((it) => Math.abs(Number(it.dayIndex || 0) - day) <= 1);
      candidates = type === 'hotel' ? nearby.filter((it) => it.category === 'hotel')
        : type === 'ticket' ? nearby.filter((it) => it.category === 'ticket') : nearby.filter((it) => it.category === 'transport');
    }
    if (candidates.length) {
      const matchQuery = String(a.bookingInfo || a.title || '').replace(/\s/g, '');
      const match = candidates.find((it) => {
        const text = `${it.activity || ''}${it.startLocation || ''}${it.endLocation || ''}${it.bookingInfo || ''}`.replace(/\s/g, '');
        const route = [it.startLocation, it.endLocation].filter(Boolean).join('→').replace(/\s/g, '');
        return (it.startLocation && it.endLocation && route && matchQuery.includes(route))
          || (it.activity && matchQuery.includes(String(it.activity).slice(0, 12)));
      }) || (candidates.length === 1 && type === 'hotel' ? candidates[0] : null);
      if (!match) return a;
      a.dayIndex = Number(match.dayIndex || 0);
      a.linkedItemId = String(match.itemId || '');
      a.bookingInfo = String(a.bookingInfo || bookingInfoFromItem(match)).slice(0, 160);
    }
    return a;
  });
  return out.filter(Boolean);
}

/** 修正 LLM 把普通接驳误标成门票提醒的情况，并按实际交通类型归类。 */
function normalizeBookingAlarmKinds(alarms, items, p) {
  const rows = asArray(items);
  const experienceTicket = /门票|购票|放票|入园预约|实名预约|竹筏|游船|漂流|缆车|索道|温泉|演出|跟拍/;
  const scenicEntry = /景区|景点|瀑布|梯田|古镇|公园|博物馆|游客中心|观光车|园区|游览基地/;
  const hotelNote = '酒店可随时提前预订，没有统一放票时间；越早确认越好。请到「酒店住宿」分类逐项核对并预订。';
  const hotelNoteOf = (alarm) => {
    const note = String(alarm && alarm.note || '').trim();
    return note && (note.includes('酒店可随时') || note.includes('POI') || note.includes('地址') || note.includes('片区'))
      ? note : [hotelNote, note].filter(Boolean).join('');
  };
  const filtered = [];
  asArray(alarms).forEach((alarm) => {
    const current = Object.assign({}, alarm);
    const workflow = rows.find((row) => row.itemId && row.itemId === current.linkedItemId);
    if (workflow && current.type !== 'hotel') {
      const action = String(workflow.activity || '');
      const actualBooking = /购买|购票|预约|预订|(?:乘坐|搭乘|体验|观看).{0,16}(?:游船|竹筏|漂流|演出|缆车|索道)/.test(action);
      if (!actualBooking && (/取票|安检|候车|候船|检票/.test(action)
          || workflow.category !== 'sight' && /行李|箱子|大件/.test(action) && /寄存|暂存|取回|退房|整理/.test(action))) return;
    }
    if (String(current.type || '') === 'hotel') {
      const title = String(current.title || current.bookingInfo || '酒店预订').trim();
      if (!/尽早确认酒店预订/.test(title)) current.title = `尽早确认酒店预订：${title}`.slice(0, 100);
      current.note = hotelNoteOf(current);
      filtered.push(current);
      return;
    }
    const alarmType = String(current.type || '');
    if (['train', 'plane', 'bus', 'ticket'].includes(alarmType)) {
      const linked = current.linkedItemId
        ? rows.find((it) => String(it.itemId || '') === String(current.linkedItemId))
        : null;
      const targetText = [current.title, current.bookingInfo, linked && linked.activity,
        linked && linked.note, linked && linked.startLocation, linked && linked.endLocation]
        .filter(Boolean).join(' ');
      const statusType = alarmType === 'ticket' ? (bookingKindOf(targetText) || 'ticket') : alarmType;
      if (bookingStatusMatches(p, targetText, statusType)) return;
    }
    if (String(current.type || '') !== 'ticket') { filtered.push(current); return; }
    const linked = current.linkedItemId
      ? rows.find((it) => String(it.itemId || '') === String(current.linkedItemId))
      : null;
    const title = `${current.title || ''} ${current.bookingInfo || ''}`;
    const targetText = linked ? `${linked.activity || ''} ${linked.note || ''} ${linked.startLocation || ''} ${linked.endLocation || ''}` : '';
    const text = `${title} ${targetText}`;
    const textualMode = /(?:12306|火车票|车次|铁路|高铁|动车|列车)/i.test(text) ? 'train'
      : /(?:机票|航班|飞机票|航空)/i.test(text) ? 'plane'
        : /(?:汽车票|大巴票|客运票|旅游专线|直通车)/i.test(text) ? 'bus' : '';
    const linkedActivity = String(linked && linked.activity || '');
    const linkedMode = String(linked && linked.transportType || '').toLowerCase();
    const linkedMovement = !!linked && (linked.category === 'transport'
      || (linked.category !== 'sight' && /^(walk|ride|bus|train|plane|car)$/.test(linkedMode))
      || (linked.category !== 'sight' && /步行|打车|网约车|乘车|乘坐|前往|接驳/.test(linkedActivity)));
    const linkedTicketEvidence = /门票|购票|放票|入园预约|实名预约|船票|游船|竹筏|漂流|演出|缆车|索道|温泉票|跟拍/.test(linkedActivity);
    const titleTicketEvidence = /门票|购票|放票|船票|游船|竹筏|漂流|演出|缆车|索道|温泉票/.test(title);
    // “打车到游客中心，顺便购买门票”仍是一条交通条目：地点或动作里
    // 提到“购买门票”不能把普通接驳变成门票放票提醒。只有门票类条目，
    // 或明确的船票/竹筏/漂流/缆车等体验本身，才保留 ticket 闹钟。
    const startsAsTransfer = /^(?:打车|前往|抵达|到达|步行|乘坐|乘|从|搭乘)/.test(linkedActivity.trim());
    const bookingExperience = /船票|游船|竹筏|漂流|缆车|索道|温泉|演出|跟拍/.test(linkedActivity)
      && (linked && linked.category === 'sight' || !startsAsTransfer);
    if (linkedMovement && String(linked && linked.category || '') !== 'ticket'
      && !textualMode && (!bookingExperience || startsAsTransfer)) return;
    if (linkedMovement && !textualMode && !linkedTicketEvidence && !titleTicketEvidence) return;
    const movement = linked && String(linked.category || '') === 'transport';
    if (movement) {
      const modeText = `${linked.transportType || ''} ${linked.activity || ''}`;
      if (/train|火车|列车|高铁|动车|车次/i.test(modeText)) current.type = 'train';
      else if (/plane|航班|飞机/i.test(modeText)) current.type = 'plane';
      else if (/bus|大巴|班车|旅游专线|客运/i.test(modeText)) current.type = 'bus';
      else if (linkedMode === 'ship'
          && /船票|游船|竹筏|漂流|购票|门票/.test(modeText)) current.type = 'ticket';
      else return; // 地铁、打车、包车、普通景区接驳不需要“门票放票”闹钟
      filtered.push(current);
      return;
    }
    if (textualMode) {
      current.type = textualMode;
      filtered.push(current);
      return;
    }
    if (linked && String(linked.category || '') === 'hotel') {
      current.type = 'hotel';
      const title = String(current.title || current.bookingInfo || '酒店预订').trim();
      if (!/尽早确认酒店预订/.test(title)) current.title = `尽早确认酒店预订：${title}`.slice(0, 100);
      current.note = hotelNoteOf(current);
      filtered.push(current);
      return;
    }
    if (!experienceTicket.test(text) && !(scenicEntry.test(text) && /预约|购票|门票/.test(title))) return;
    filtered.push(current);
  });
  // 按出行日核对常见预售窗口。窗口已过就提醒现在查售票平台，不保留模型编出的未来抢票时刻。
  const today = tsToDateStr(Date.now());
  filtered.forEach((alarm, index) => {
    const dayIndex = Number(alarm.dayIndex);
  if (!Number.isInteger(dayIndex) || dayIndex < 0) return;
    const travelDate = p && p.startDate ? shiftDate(p.startDate, dayIndex) : '';
    const presaleDays = alarm.type === 'train' ? TRAIN_PRESALE_DAYS
      : alarm.type === 'ticket' ? TICKET_PRESALE_DAYS : null;
    if (!travelDate || presaleDays == null) return;
    const releaseDate = shiftDate(travelDate, -presaleDays);
    const isTicket = alarm.type === 'ticket';
    const cleanTitle = String(alarm.title || alarm.bookingInfo || (isTicket ? '景区门票/体验预约' : '车票'))
      .replace(/^(?:开抢|抢|开始盯|关注|查询|预约|购票|购买|立即查看并(?:预约|购买)[：:]?)+\s*/, '').trim();
    if (releaseDate <= today) {
      alarm.title = `${isTicket ? '立即查看并预约' : '立即查看并购买'}：${cleanTitle}`.slice(0, 100);
      alarm.note = `按常见预售规则预计 ${releaseDate} 开放，该日期已到或已过；请现在前往官方售票/预约渠道核实，若已放票请立即${isTicket ? '预约或购买' : '购买'}，不要等待下一次提醒。${String(alarm.note || '')}`.slice(0, 200);
      const now = Date.now();
      alarm.fireAt = now + 60 * 1000 + index * 30 * 1000;
      alarm.fireAtStr = tsToCnDateTimeStr(alarm.fireAt);
      alarm.source = alarm.source || 'rule-on-sale';
      return;
    }
    const openingAt = parseCnTime(`${releaseDate}T09:00:00`);
    if (!alarm.fireAt || tsToDateStr(alarm.fireAt) !== releaseDate) {
      alarm.fireAt = openingAt;
      alarm.fireAtStr = tsToCnDateTimeStr(openingAt);
    }
    alarm.title = `${isTicket ? '预计开放预约/购票' : '预计开售'}：${cleanTitle}`.slice(0, 100);
    alarm.note = `按常见预售规则估算 ${releaseDate} 开放；请在该日查看官方 App/景区渠道，具体时间以官方公告为准。${String(alarm.note || '')}`.slice(0, 200);
  });
  const seen = new Set();
  return filtered.filter((alarm) => {
    const key = alarm.linkedItemId
      ? `${alarm.type}|${alarm.linkedItemId}`
      : `${alarm.type}|${Number(alarm.dayIndex || 0)}|${String(alarm.bookingInfo || alarm.title || '').replace(/\s/g, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 同一购票/预约事项只保留一条记录，提前量由统一提醒设置负责。 */
function dedupeBookingAlarmRecords(alarms) {
  const groups = new Map();
  const clean = (value) => String(value || '')
    .replace(/(?:提前\s*\d+\s*分钟|提前准备|准备|即将到点|到点提醒|开抢|预计开售|预计开放预约\/购票|立即查看并(?:预约|购买)|开始盯|关注|查询|预约|购票|购买|预订)/g, '')
    .replace(/[\s\u3000：:（）()【】\[\]，,；;→⇒>—-]/g, '')
    .trim();
  asArray(alarms).forEach((alarm) => {
    const a = Object.assign({}, alarm);
    const identity = a.linkedItemId
      ? `linked|${a.linkedItemId}`
      : `text|${a.type}|${Number(a.dayIndex || 0)}|${clean(a.bookingInfo || a.title)}`;
    const old = groups.get(identity);
    if (!old) {
      groups.set(identity, a);
      return;
    }
    // 同一事项若模型给出“准备”和“正式办理”两个相邻时刻，保留较晚的实际办理时刻，
    // 前端/系统日历只会按 leadMinutes 生成一个提前提醒。
    const winner = Number(a.fireAt || 0) >= Number(old.fireAt || 0) ? a : old;
    const loser = winner === a ? old : a;
    winner.note = [winner.note, loser.note].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).join('；').slice(0, 500);
    winner.bookingInfo = winner.bookingInfo || loser.bookingInfo || '';
    winner.linkedItemId = winner.linkedItemId || loser.linkedItemId || '';
    groups.set(identity, winner);
  });
  return [...groups.values()];
}

function alarmUsageInfo(alarm, items, outline) {
  const a = alarm || {};
  const rows = asArray(items);
  const dayIndex = Number.isInteger(Number(a.dayIndex)) ? Number(a.dayIndex) : 0;
  const linked = a.linkedItemId
    ? rows.find((it) => String(it && it.itemId || '') === String(a.linkedItemId))
    : null;
  const item = linked || rows.find((it) => Number(it && it.dayIndex || 0) === dayIndex
    && String(it && it.bookingInfo || '').trim() === String(a.bookingInfo || '').trim()) || null;
  const day = asArray(outline && outline.days)[Number(item ? item.dayIndex : dayIndex)] || {};
  const date = String(day.date || '').trim();
  const start = item && item.startTime ? String(item.startTime) : '';
  const end = item && item.endTime ? String(item.endTime) : '';
  const time = start ? `${start}${end ? `-${end}` : ''}` : '时段待核实';
  const type = String(a.type || '');
  if (type === 'hotel') {
    const hotel = String((item && (item.bookingInfo || item.endLocation)) || a.bookingInfo || '酒店').trim();
    const tasks = hotelBookingTasks(outline);
    const task = tasks.find((row) => Number(row.dayIndex) === Number(item ? item.dayIndex : dayIndex)
      && (!row.hotel || !hotel || hotel.includes(row.hotel) || row.hotel.includes(hotel)));
    const nights = task ? Number(task.nights || 1) : 1;
    const checkout = date && typeof shiftDate === 'function' ? shiftDate(date, nights) : '';
    return `住宿：${date || '入住日期待核实'} 至 ${checkout || '退房日期待核实'}；${hotel}`.slice(0, 180);
  }
  if (type === 'train' || type === 'plane' || type === 'bus') {
    const route = item && [item.startLocation, item.endLocation].filter(Boolean).join('→');
    const code = item ? transportCodeOf(item) : '';
    const fallback = String(a.bookingInfo || '').trim();
    return `乘车日期：${date || '日期待核实'}；时间：${start ? time : '时刻待核实'}；${code || fallback || '班次待核实'}${route ? `；路线：${route}` : ''}`.slice(0, 180);
  }
  if (type === 'ticket') {
    const name = String((item && (item.activity || item.bookingInfo || item.endLocation)) || a.bookingInfo || a.title || '门票/体验').trim();
    return `使用时间：${date || '日期待核实'} ${time}；${name}`.slice(0, 180);
  }
  return date ? `关联日期：${date}${start ? ` ${time}` : ''}` : '';
}

function annotateAlarmUsage(alarms, items, outline) {
  return asArray(alarms).map((alarm) => {
    const usageInfo = alarmUsageInfo(alarm, items, outline);
    const notes = {
      train: '核对乘车日期、车站、车次及乘车人；购票后标记完成。',
      hotel: '尽早预订，核对住宿日期、酒店位置和退改规则；预订后标记完成。',
      ticket: '核对使用日期、入场时段及退改规则，以官方公告为准；购票后标记完成。',
      bus: '核对乘车日期、上下车点及运营公告；购票后标记完成。',
    };
    return Object.assign({}, alarm, usageInfo ? { usageInfo } : {}, notes[alarm.type] ? { note: notes[alarm.type] } : {});
  });
}

/** 详情生成和联网执行复核分轮进行，已通过日期绝不重复生成。 */
async function buildExecutionReview(rawInput, outlineData, opts) {
  const p = normalizeInput(rawInput);
  const outline = (outlineData && outlineData.outline) || outlineData || {};
  const days = asArray(outline.days);
  const all = asArray(opts.reviewItems);
  const pending = days.map((_, di) => di).filter((di) => {
    const rows = all.filter((row) => Number(row.dayIndex || 0) === di);
    return rows.length && rows.some((row) => row.executionReview !== REVIEW_VERSION);
  });
  const selected = pending.slice(0, 4);
  const attempts = Object.assign({}, opts.attempts || {});
  const deadline = Date.now() + Math.min(Number(opts.budgetMs) || 43000, 45000);
  const suggestionsPromise = outline.executionSuggestions
    ? Promise.resolve(outline.executionSuggestions)
    : pending.length <= 4 && new Set(all.map((row) => Number(row.dayIndex || 0))).size === days.length
      ? genSuggestions(p, outline, deadline).then((value) => {
      if (value && Object.keys(value).length) outline.executionSuggestions = value;
      return value;
    }).catch(() => ({})) : Promise.resolve({});
  const candidates = all.filter((row) => selected.includes(Number(row.dayIndex || 0)));
  const reviewed = await reviewExecutionItems(p, outline, candidates, deadline, {
    selfDriveAllowed: (row) => explicitSelfDriveSegment(p, row),
  });
  const combined = all.filter((row) => !selected.includes(Number(row.dayIndex || 0))).concat(reviewed);
  const mealChanged = invalidateRepeatedMeals(days, combined, p.extra);
  mealChanged.forEach((di) => {
    if (!selected.includes(di)) reviewed.push(...combined.filter((row) => Number(row.dayIndex || 0) === di));
  });
  const accepted = new Set(reviewed.filter((row) => row.executionReview === REVIEW_VERSION)
    .map((row) => Number(row.dayIndex || 0)));
  const ready = days.map((_, di) => di).filter((di) => accepted.has(di)
    || (all.some((row) => Number(row.dayIndex || 0) === di)
      && !mealChanged.has(di) && all.filter((row) => Number(row.dayIndex || 0) === di).every((row) => row.executionReview === REVIEW_VERSION)));
  selected.forEach((di) => {
    const key = `review-${di}`;
    if (accepted.has(di)) delete attempts[key];
    else if (days[di].executionReviewAttempted && asArray(days[di].executionReviewIssues).length) attempts[key] = Number(attempts[key] || 0) + 1;
  });
  // 独立运营检索占一轮，失败日期还需至少三次真正的重排机会。
  const exhausted = selected.filter((di) => Number(attempts[`review-${di}`] || 0) >= 5);
  // 本轮通过的日期也必须先返回/落库，不能因为另一日期耗尽重试而丢失成果。
  const reviewError = exhausted.length
    ? `第${exhausted.map((di) => di + 1).join('、')}天执行复核未通过，请续跑或调整需求；未将错误行程标记为完成` : '';
  const items = ensureStableItemIds(annotateHotelItems(reviewed, outline));
  const complete = ready.length === days.length;
  const returnedDays = new Set(items.map((row) => Number(row.dayIndex || 0)));
  const merged = all.filter((row) => !returnedDays.has(Number(row.dayIndex || 0))).concat(items);
  let alarms = [];
  if (complete) {
    days.forEach((day, di) => syncAcceptedMoves(day, merged.filter((row) => Number(row.dayIndex || 0) === di)));
    // 执行复核后的 moves 含市内接驳。只为需要购票/预订的交通建开售提醒，
    // 不能把地铁、公交或景区内部接驳全当成长途汽车票。
    days.forEach((day, di) => {
      day.moves = asArray(day.moves).map((move) => {
        const item = merged.find((row) => Number(row.dayIndex || 0) === di && row.category === 'transport'
          && samePlace(row.startLocation, move.from) && samePlace(row.endLocation, move.to));
        if (!item || move.mode !== 'bus') return move;
        const local = /地铁|轨道|公交|轨交|观光车|景区.*接驳/.test(`${item.activity} ${item.note}`);
        const bookable = !local && (/大巴|巴士|旅游专线|长途|直通车|班车|客车/.test(item.activity || '')
          || toMin(item.endTime) - toMin(item.startTime) >= 60);
        return Object.assign({}, move, { bookingRequired: bookable });
      });
    });
    alarms = fallbackAlarms(p, outline);
    alarms = alarms.concat(backfillDetailAlarms(p, outline, merged, alarms));
    alarms = annotateAlarmUsage(dedupeBookingAlarmRecords(normalizeBookingAlarmKinds(
      linkBookingAlarms(alarms, merged), merged, p,
    )), merged, outline).map((alarm) => Object.assign({}, alarm, {
      leadMinutes: p.leadMinutes, remindAt: Number(alarm.fireAt) - p.leadMinutes * 60000,
    }));
  }
  const dayCities = days.map((day) => [day.city, day.overnight].filter(Boolean).join(' '));
  const addrDay = new Map();
  items.forEach((row) => [row.startLocation, row.endLocation].filter(Boolean)
    .forEach((addr) => addrDay.set(addr, Number(row.dayIndex || 0))));
  return {
    title: String(outlineData.title || outline.title || '我的行程').slice(0, 60),
    summary: String(outlineData.summary || outline.summary || '').slice(0, 200),
    startDate: p.startDate, endDate: p.endDate, origin: p.origin,
    items, dayCities, addrDay, alarms,
    suggestions: complete ? await withTimeout(suggestionsPromise, Math.max(1000, deadline - Date.now()), {}) : {},
    partial: !complete,
    doneDayIndexes: [...new Set(all.map((row) => Number(row.dayIndex || 0)))], attempts,
    gaveUpDayIndexes: exhausted, reviewError, progress: { done: ready.length, total: days.length, stage: 'review' },
    meta: { days: days.length, reviewPendingDayIndexes: pending.filter((di) => !accepted.has(di)) },
  };
}

async function buildPlan(rawInput, outlineData, opts = {}) {
  if (Array.isArray(opts.reviewItems)) {
    const storedOutline = (outlineData && outlineData.outline) || outlineData || {};
    const days = asArray(storedOutline.days);
    const profile = normalizeInput(rawInput);
    const invalidated = invalidateUnsafeAcceptedDays(profile, storedOutline, opts.reviewItems, (row) => explicitSelfDriveSegment(profile, row));
    if (invalidated.size) {
      const attempts = Object.assign({}, opts.attempts || {});
      invalidated.forEach((di) => { delete attempts[`review-${di}`]; });
      opts = Object.assign({}, opts, { attempts });
    }
    const generated = new Set(opts.reviewItems.map((row) => Number(row.dayIndex || 0)));
    opts = Object.assign({}, opts, { doneDayIndexes: [...new Set([...(opts.doneDayIndexes || []), ...generated])] });
    if (generated.size >= days.length || opts.reviewItems.some((row) => row.executionReview !== REVIEW_VERSION)) {
      return buildExecutionReview(rawInput, outlineData, opts);
    }
  }
  const p = normalizeInput(rawInput);
  let normalizedOutline = (outlineData && outlineData.outline) || outlineData || {};
  const acceptedSnapshots = new Map();
  asArray(opts.reviewItems).forEach((row) => {
    const di = Number(row.dayIndex || 0);
    if (row.executionReview === REVIEW_VERSION && !acceptedSnapshots.has(di) && asArray(normalizedOutline.days)[di]) {
      acceptedSnapshots.set(di, JSON.parse(JSON.stringify(normalizedOutline.days[di])));
    }
  });
  const restoreAcceptedDays = (target) => acceptedSnapshots.forEach((snapshot, di) => {
    target.days[di] = JSON.parse(JSON.stringify(snapshot));
  });
  normalizedOutline = enforceOutlineTransportPreference(p, normalizedOutline);
  normalizeLijiangCruiseOutline(normalizedOutline);
  if (drivingAllowed(p)) normalizedOutline = applyTripEdgeTimes(p, normalizedOutline);
  normalizedOutline = alignOutlineMoveTimes(normalizedOutline);
  ensureOutlineMoveContinuity(normalizedOutline, p);
  alignOutlineMoveTimes(normalizedOutline);
  sanitizeOutlineLocalMoves(normalizedOutline);
  removeOutlineBacktracks(normalizedOutline);
  normalizeGeneratedOutlineMoveChains(normalizedOutline);
  const outline = normalizeRouteDayFocus(
    ensureOutlineHotelFallbacks(normalizeOutlineLodging(normalizedOutline), p), p,
  );
  ensureOutlineHighlightCoverage(outline, p);
  enforceLongjiSameDayRoute(outline, p);
  ensureLongjiSunriseSunset(outline);
  normalizeLijiangCruiseOutline(outline);
  restoreAcceptedDays(outline);
  if (!asArray(outline.days).length) throw new Error('缺少行程大纲，无法展开详情');

  const t1 = Date.now();
  // 时间预算：细化默认 38s；整轮硬上限 55s（云函数 60s，留 5s 给写库和返回）
  // 为什么是 38 而不是 42：这轮结束后还要做地理编码（几十个地址）和写库，
  // 实测最坏一轮细化 47s + 写库就贴着上限了，收紧一点让续跑多一轮更稳。
  const budget = opts.budgetMs || 38 * 1000;
  const hardDeadline = t1 + (opts.hardBudgetMs || 55 * 1000);
  const deadline = t1 + budget;

  // 闹钟 / 建议只依赖大纲，**不需要等细化跑完**。
  // 之前是细化完了才发起，结果最后一轮细化常常吃掉 30s+，留给闹钟只剩几秒，
  // 提名请求直接被超时掐断（实测 21.5s 超时）→ 只能走规则兜底，门票/体验类的
  // 提醒全靠代码补。现在跟细化同时发起，它们能用满整轮的时间预算。
  // 中途返回 partial 时这些 Promise 会被放弃（云函数进程随即回收），不影响结果。
  const sideDeadline = hardDeadline - 4 * 1000;
  // 闹钟/建议**只在「大概率是最后一轮」时才发起**：它们的结果只有最后一轮会落库，
  // 中间轮次提前跑纯属白烧（还跟细化抢模型的并发名额，让每轮能细化的天数变少 →
  // 轮数变多 → 整体更慢，8 天行程实测慢了一大截）。判据是通用的：剩余 ≤3 天
  // 就当最后一轮；预判失误（这轮提前跑完）就在收尾时用剩余时间补排一次。
  const totalDays = asArray(outline.days).length;
  const doneBefore = (opts.doneDayIndexes || []).length;
  const likelyFinal = !!opts.skipExecutionReview && totalDays - doneBefore <= 3;
  const alarmsPromise = likelyFinal
    ? genAlarms(p, outline, sideDeadline)
        .catch((e) => { console.error('[generatePlan] 闹钟生成失败:', e.message); return null; })
    : null;
  const suggPromise = likelyFinal
    ? genSuggestions(p, outline, sideDeadline)
        .catch((e) => { console.error('[generatePlan] 建议生成失败:', e.message); return {}; })
    : Promise.resolve({});

  const detail = await genDayItems(p, outline, {
    doneDayIndexes: opts.doneDayIndexes,
    attempts: opts.attempts,     // 上一轮回传的失败次数，决定哪些天还能再试
    deadline,
  });
  const progress = { done: detail.doneDayIndexes.length, total: asArray(outline.days).length };
  console.log('[generatePlan] 细化完成 %dms, 原始条目=%d, partial=%s',
    Date.now() - t1, detail.items.length, detail.partial);
  if (!detail.items.length && !opts.skipExecutionReview) {
    // 超时空返回不是“全程缺失”，不运行补景点/太阳窗口/大纲对齐等全局兜底。
    // 这些规则会修改已复核日期的 moves，并制造本轮根本没生成的条目。
    restoreAcceptedDays(outline);
    return { title: String((outlineData && outlineData.title) || outline.title || '我的行程'),
      summary: String((outlineData && outlineData.summary) || outline.summary || ''),
      startDate: p.startDate, endDate: p.endDate, origin: p.origin,
      items: [], dayCities: outline.days.map((day) => [day.city, day.overnight].filter(Boolean).join(' ')), addrDay: new Map(),
      partial: true, doneDayIndexes: detail.doneDayIndexes, attempts: detail.attempts,
      gaveUpDayIndexes: detail.gaveUpDayIndexes, progress,
      reviewError: detail.gaveUpDayIndexes.length ? `第${detail.gaveUpDayIndexes.map((di) => di + 1).join('、')}天生成暂未成功，请续跑；已完成日期保留` : '',
      meta: { days: p.days } };
  }

  // 行李规则放在 sanitize 之后：清洗会删条目（可能把"寄存行李"那条删掉，
  // 也可能把提醒取回的那条删掉），删完再看一遍才是最终要展示的结果。
  // 链路顺序（每一步都有存在的理由）：
  //   MovesAlignment  先把大交通拽回大纲既定时刻/车站（后面插接驳要按它算时刻）
  //   DayStartLocation补每天第一条的起点（昨晚住宿地）
  //   OriginAccess    第一天没有"从出发地→车站"接驳就补一条
  //   MorningRoutine  第 2 天起上午没吃饭补早餐（中午后才开始的补午餐）
  //   NoMiddayHotel   白天"回酒店休息/午休"删除（入住/放行李除外）
  //   EveningPlan     非末日 20:30 前就结束的补晚餐/夜逛
  //   fixMealLabels   餐次词按实际时刻纠偏（"早上吃晚饭"）
  //   DayClosure      收尾闭环（用大纲推荐酒店；末日补"回出发地"接驳）
  //   LuggageRules    行李 note 追加
  //   fixDayTimeOverlaps 最后顺延重叠/倒退（插入的条目可能造成重叠）
  // 用平铺变量代替俄罗斯套娃调用，括号错一层就是静默传错参数
  // 细化失败/残缺的天用大纲骨架重建（只在最后一轮做：partial 时剩余天下一轮还会来）
  const skeleton = detail.partial || !opts.skipExecutionReview
    ? { items: [], replaced: [] }
    : skeletonForEmptyDays(p, outline, detail.items, detail.doneDayIndexes);
  const baseItems = skeleton.replaced.length
    ? detail.items.filter((it) => !skeleton.replaced.includes(Number(it.dayIndex || 0)))
    : detail.items;
  // 本轮真正产出条目的天：跨天循环的兜底（MovesAlignment/OriginAccess）只处理
  // 这些天，之前轮次已完成的天不许再补（续跑每轮都会写库，重复补=条目翻倍）
  const roundDays = [...new Set(baseItems.concat(skeleton.items)
    .map((it) => Number(it.dayIndex || 0)))];
  let items = normalizeLijiangCruiseItems(sanitizeItems(baseItems.concat(skeleton.items)), outline);
  items = enforceMovesAlignment(items, outline, roundDays, p);
  items = enforceRealSchedule(items, outline);   // 车次不在联网检索结果里 → 拽回真实班次
  items = enforceOfficialRailItems(items, outline); // 官方候选存在时，铁路条目逐条锁定
  items = dedupeOfficialRailItems(items, outline); // 一段官方铁路移动只保留一趟车
  items = stripUnverifiedSchedules(items, outline); // 12306 无结果 → 不留模型臆造车次
  items = dedupeTransports(items);
  items = enforceOriginAccess(items, p, outline, roundDays);
  items = enforceMorningRoutine(items, outline);
  items = enforceNoMiddayHotel(items, outline);   // 白天不许回酒店睡觉
  items = enforceEveningPlan(items, outline, p);
  items = fixMealLabels(items, outline);          // 餐次词按实际时刻纠偏（"早上吃晚饭"）
  items = normalizeGeneratedLodging(items, outline, p); // 错误酒店不能进入闭环或跨日继承
  items = reconcileTransportOrigins(items, outline); // 已到下一城市后，不得再从上一晚酒店发第二次
  items = enforceDayClosure(items, outline, p);
  items = enforceDayStartLocation(items, outline, p); // 闭环补齐后再校验跨日首条起点
  items = enforceLuggageRules(items, outline, p);
  items = enforceTripEdgeOrder(items, p, outline, roundDays);
  items = enforceReturnDeparturePreparation(items, p, outline);
  items = enforceTransportPreference(items, p);
  items = removeOptionalRouteDetours(items);
  items = enforceScenicRouteTiming(items);
  items = ensureSelfDriveParking(items, p);
  items = removeZeroDistanceTransports(items);
  // 闭环、住宿和自驾校正可能移除或改写模型条目；最后再核一遍本轮的大纲移动，
  // 确保跨城/景区班车不会因此从最终时间线消失。
  items = enforceMovesAlignment(items, outline, roundDays, p);
  items = enforceScheduledMoveTimeline(items, outline, roundDays);
  items = enforceTransportChainOrder(items);
  items = removeCheckoutBacktracks(items);
  items = removeRedundantDirectTransports(items);
  items = removeOrphanStationWaitingItems(items, outline);
  // Alignment may add a missing leg after the earlier preference pass. Reapply
  // the user's drive policy at the final boundary, then add parking immediately
  // after each own-drive arrival so no generated row can slip between them.
  items = enforceTransportPreference(items, p);
  items = ensureSelfDriveParking(items, p);
  items = dedupeDuplicateHotelItems(items);
  items = removeZeroDistanceTransports(items);
  items = mergeOnboardMealsIntoTrain(items);
  items = fixDayTimeOverlaps(items);
  items = removeAfterHomeArrival(items, p, outline);
  items = enforceFinalTimelineIntegrity(items, p, outline, roundDays);
  items = ensureDetailHighlightCoverage(items, outline);
  items = normalizeLijiangCruiseItems(items, outline);
  items = fixDayTimeOverlaps(items);
  // 高亮补齐不改时间，但上一轮重叠修复可能把末日收尾重新推迟；在序列化前
  // 再锁一次用户填写的出发地和到家时刻，避免只剩“到金童路站”或 17:40。
  items = ensureFinalHomeArrival(items, p, outline);
  items = fixDayTimeOverlaps(items);
  items = normalizeLijiangCruiseItems(items, outline);
  syncLijiangCruiseOutlineFromItems(outline, items);
  items = ensureLongjiDetailRoute(items, outline);
  items = fixDayTimeOverlaps(items);
  // 前面的清洗可能删掉模型漏写的中间接驳或把游船起点留在旧码头；
  // 在最终景区回折审计前按大纲再对齐一次，并用 outlineMove 标记保护
  // 这些必需段不被“景区回折”误删。
  items = normalizeLijiangCruiseItems(items, outline);
  syncLijiangCruiseOutlineFromItems(outline, items);
  normalizeLijiangCruiseOutline(outline);
  items = enforceMovesAlignment(items, outline, roundDays, p);
  items = enforceScheduledMoveTimeline(items, outline, roundDays);
  items = fixDayTimeOverlaps(items);
  items = repairLijiangCruiseSequence(items, outline);
  items = fixDayTimeOverlaps(items);
  items = removeScenicReentryBacktracks(items);
  items = dedupeDirectedTransportRoutes(items);
  items = ensureLongjiSunriseDetail(items, outline);
  items = fixDayTimeOverlaps(items);
  items = removeOrphanStationWaitingItems(items, outline);
  items = normalizeLongjiCoreRoute(items, outline);
  items = fixDayTimeOverlaps(items);
  items = ensureLongjiSunsetDetail(items, outline);
  items = fixDayTimeOverlaps(items);
  // 景区回折清理可能删掉模型漏写/误写的金佛顶段；序列化前再补齐龙脊
  // 三处核心景点，并把金佛顶返程推到观景结束，清理次日重复上山。
  items = ensureLongjiDetailRoute(items, outline);
  items = fixDayTimeOverlaps(items);
  items = normalizeLongjiCoreRoute(items, outline);
  items = fixDayTimeOverlaps(items);
  items = ensureLongjiSunsetDetail(items, outline);
  items = fixDayTimeOverlaps(items);
  items = repairLongjiCoreTimeline(items, outline);
  items = fixDayTimeOverlaps(items);
  // 最后一轮景区/游船校正可能重新补了交通条目；在序列化前再审一次行李，
  // 确保“旧酒店寄存但不回去取”不会被后续对齐带回最终结果。
  items = enforceLuggageRules(items, outline, p);
  items = fixDayTimeOverlaps(items);
  // 时间重排可能把末日接驳顺延到用户要求的到家时间之后；最后一步重新
  // 锁定返程边界，后面不再调用会推迟它的重叠修复。
  items = ensureFinalHomeArrival(items, p, outline);
  items = enforceReturnDeparturePreparation(items, p, outline);
  items = fixDayTimeOverlaps(items);
  items = fitFinalReturnWindow(items, p, outline);
  items = enforceOvernightArrivalItems(items, outline, p);
  items = ensureOvernightHotelItems(items, outline, p);
  items = removeOrphanTransportRows(items, outline);
  items = removeRedundantDirectTransports(items);
  items = fixDayTimeOverlaps(items);
  // 最终时间/酒店同步阶段仍可能把模型原始的“同地点退房”带回结果；
  // 在序列化前按已核验住宿再收口一次，确保前端不展示住宿自环。
  items = normalizeGeneratedLodging(items, outline, p);
  items = dedupeDuplicateHotelItems(items);
  // normalizeGeneratedLodging 可能在上一轮清洗后重新整理出“抵达即 23:59”
  // 的入住条目；最后一次酒店审计必须放在它之后，保证落库前不存在零时长酒店。
  items = ensureOvernightHotelItems(items, outline, p);
  items = dedupeDuplicateHotelItems(items);
  // 最后一次住宿归一化之后，大纲对齐可能又补回同起终点的普通交通；
  // 船程应再次作为唯一的水上移动保留下来，避免同一时段出现船+大巴两条。
  items = normalizeLijiangCruiseItems(items, outline);
  syncLijiangCruiseOutlineFromItems(outline, items);
  normalizeLijiangCruiseOutline(outline);
  items = removeRedundantDirectTransports(items);
  items = fixDayTimeOverlaps(items);
  // 所有收尾规则都可能顺延普通活动，但 12306 已核验车次的路线和发到
  // 时刻是事实，必须在最终序列化前再锁一次，避免被重叠修复改成“参考时间”。
  items = enforceOfficialRailItems(items, outline);
  items = dedupeOfficialRailItems(items, outline);
  items = fixDayTimeOverlaps(items);
  items = removeUnplannedIntercityRows(items, outline);
  // 序列化前补一次最终景点覆盖，避免跨城错段清理误删了由规则兜底
  // 生成的必玩景点；后面不再调用会删除景点的清洗函数。
  items = ensureDetailHighlightCoverage(items, outline);
  items = fixDayTimeOverlaps(items);
  items = items.filter((item) => roundDays.includes(Number(item.dayIndex || 0)));
  items = stripUnverifiedSchedules(items, outline);
  items = finalizeExecutionEdges(items, outline, p);
  items = annotateHotelItems(items, outline);
  items = ensureStableItemIds(items);
  // sync 之后可能留下模型原始的同码头接驳；最终返回前再清一次，保证
  // 大纲和详细页都不会展示“竹江码头→桂林竹江码头”的无效移动。
  normalizeLijiangCruiseOutline(outline);

  restoreAcceptedDays(outline);

  // 地理编码消歧要用的每天城市 + 地址→天下标映射。
  // savePlan 的 cityOf 靠它们给高德传 city 参数——之前只消费不生产，
  // cityOf 永远拿不到每天的城市，同名地点照样可能定位到别的省去。
  // 同一天可能“白天在都江堰、晚上住古尔沟/理县”，两个范围都要留给
  // 地理编码和跨天闭环，不能只取 city 把 overnight 丢掉。
  const dayCities = asArray(outline.days).map((d) => [d.city, d.overnight]
    .map((x) => String(x || '').trim())
    .filter((x) => x && !/^(返程|回家|家中)$/.test(x))
    .filter((x, i, arr) => arr.indexOf(x) === i)
    .join(' '));
  const addrDay = new Map();
  items.forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (it.startLocation && !addrDay.has(it.startLocation)) addrDay.set(it.startLocation, di);
    if (it.endLocation && !addrDay.has(it.endLocation)) addrDay.set(it.endLocation, di);
  });

  // 还有天没生成完（撞时间预算）→ 只交回已完成的部分，闹钟/建议留到最后一次生成，
  // 前端拿到 partial=true 会立刻静默再调一次，用户全程只看到"正在细化…"
  // 即使详情已全量生成，也先落库再进入独立复核轮，不能在本轮硬挤第二次 LLM。
  if (detail.partial || !opts.skipExecutionReview) {
    return {
      title: String((outlineData && outlineData.title) || outline.title || '我的行程').slice(0, 60),
      summary: String((outlineData && outlineData.summary) || outline.summary || '').slice(0, 200),
      startDate: p.startDate,
      endDate: p.endDate,
      origin: p.origin,
      items,
      dayCities,
      addrDay,
      partial: true,
      doneDayIndexes: detail.doneDayIndexes,
      attempts: detail.attempts,
      gaveUpDayIndexes: detail.gaveUpDayIndexes,
      reviewError: detail.gaveUpDayIndexes.length ? `第${detail.gaveUpDayIndexes.map((di) => di + 1).join('、')}天生成暂未成功，请续跑；已完成日期保留` : '',
      progress: detail.partial ? progress : { done: 0, total: progress.total, stage: 'review' },
      meta: {
        days: p.days,
        failedDayIndexes: detail.failedDayIndexes,
        gaveUpDayIndexes: detail.gaveUpDayIndexes,
        elapsedMs: Date.now() - t1,
      },
    };
  }

  // 等闹钟/建议收尾（它们是和细化并行跑的，一般细化结束时也差不多了）。
  // 仍然留 5s 给写库；真没回来就降级走规则兜底 —— 总比整个调用超时失败强。
  const remain = hardDeadline - Date.now() - 5 * 1000; // 再留 5s 给写库
  let [a, s] = await Promise.all([
    alarmsPromise ? withTimeout(alarmsPromise, Math.max(1000, remain), null) : Promise.resolve(null),
    withTimeout(suggPromise, Math.max(1000, remain), null),
  ]);
  // 预判失误（这轮提前把剩余天跑完了、但之前没排闹钟）：用剩余时间补排一次，
  // 补不上再走规则兜底 —— 硬底线提醒（去程/返程票）都在，只是少了体验类提醒
  if (!a && hardDeadline - Date.now() > 9 * 1000) {
    a = await genAlarms(p, outline, hardDeadline - 5 * 1000)
      .catch((e) => { console.warn('[generatePlan] 补排闹钟失败，走规则兜底:', e.message); return null; });
  }
  // 规则兜底 = 硬底线（去程/返程票、行前准备）+ 查漏补齐（每段城际、每晚住宿）
  let alarms = a || fallbackAlarms(p, outline);
  const detailBackfill = backfillDetailAlarms(p, outline, items, alarms);
  if (detailBackfill.length) {
    alarms = alarms.concat(detailBackfill);
    console.log('[generatePlan] 详细行程规则查漏补齐 %d 条待办', detailBackfill.length);
  }
  alarms = linkBookingAlarms(alarms, items);
  alarms = normalizeBookingAlarmKinds(alarms, items, p);
  alarms = dedupeBookingAlarmRecords(alarms);
  alarms = annotateAlarmUsage(alarms, items, outline);
  alarms = alarms.map((alarm) => Object.assign({}, alarm, {
    leadMinutes: p.leadMinutes,
    remindAt: Number(alarm.fireAt) - p.leadMinutes * 60 * 1000,
  }));
  const suggestions = s || {};
  console.log('[generatePlan] 清洗后条目=%d, 闹钟=%d, 剩余预算=%dms', items.length, alarms.length, remain);

  return {
    title: String((outlineData && outlineData.title) || outline.title || '我的行程').slice(0, 60),
    summary: String((outlineData && outlineData.summary) || outline.summary || '').slice(0, 200),
    startDate: p.startDate,
    endDate: p.endDate,
    origin: p.origin,
    items,
    dayCities,
    addrDay,
    alarms: alarms.sort((a, b) => a.fireAt - b.fireAt),  // 待办按时间先后排，用户照着做就行
    suggestions,
    partial: false,
    doneDayIndexes: detail.doneDayIndexes,
    attempts: detail.attempts,
    gaveUpDayIndexes: detail.gaveUpDayIndexes,
    progress,
    meta: {
      days: p.days,
      failedDayIndexes: detail.failedDayIndexes,
      gaveUpDayIndexes: detail.gaveUpDayIndexes,
      elapsedMs: Date.now() - t1,
    },
  };
}

/**
 * 一次性生成（本地测试用；云端请拆成 generateOutline + buildPlan 两次调用，
 * 单次跑完会超过云函数 60s 上限）
 */
async function generate(rawInput) {
  const t0 = Date.now();
  const first = await generateOutline(rawInput);
  const outlineMs = Date.now() - t0;
  let plan;
  let items = [];
  for (let round = 0; round < 12; round++) {
    const previous = plan;
    plan = await buildPlan(rawInput, first, {
      doneDayIndexes: previous && previous.doneDayIndexes,
      attempts: previous && previous.attempts,
      reviewItems: items.length ? items : undefined,
    });
    const fresh = new Set(plan.items.map((row) => Number(row.dayIndex || 0)));
    items = auditMergedDetailItems(items.filter((row) => !fresh.has(Number(row.dayIndex || 0))).concat(plan.items), first.outline, rawInput);
    if (!plan.partial) break;
  }
  if (plan.partial) throw new Error('行程尚未完成执行复核');
  plan.items = items;
  plan.meta.outlineMs = outlineMs;
  plan.meta.elapsedMs = Date.now() - t0;
  return plan;
}

module.exports = {
  generate, generateOutline, buildPlan, genDayItems,
  normalizeInput, sanitizeAlarmCandidates, buildFallbackAlarms, fallbackAlarms, backfillDetailAlarms,
  shiftDate, dayDiff, isHolidayRange,
  parseDestList, missingMustVisit, placeStem, duplicateHighlights, ensureOutlineHighlightCoverage, enforceLongjiSameDayRoute,
  ensureLongjiSunriseSunset, ensureLongjiSunriseDetail, ensureLongjiSunsetDetail, normalizeLongjiCoreRoute, repairLongjiCoreTimeline, normalizeLijiangCruiseOutline, normalizeLijiangCruiseItems,
  syncLijiangCruiseOutlineFromItems, repairLijiangCruiseSequence, ensureLongjiDetailRoute, auditMergedDetailItems, finalizeExecutionEdges,
  applyTripEdgeTimes, snapScheduleMinutes, isTransportItem,
  enforceDayStartLocation, enforceDayClosure, enforceLuggageRules, enforceReturnDeparturePreparation, explicitCarryLuggagePreference, enforceMovesAlignment, reconcileTransportOrigins,
  enforceOvernightArrivalItems,
  ensureOvernightHotelItems, removeOrphanTransportRows,
  removeZeroDistanceTransports,
  removeAfterHomeArrival,
  normalizeOutlineLodging, normalizeGeneratedLodging, alignOutlineMoveTimes, ensureOutlineMoveContinuity, sanitizeOutlineLocalMoves, removeOutlineBacktracks, normalizeGeneratedOutlineMoveChains,
  ensureOvernightMoveContinuity,
  ensureItemLocationContinuity, ensureDetailHighlightCoverage, ensureFinalHomeArrival,
  removeScenicReentryBacktracks, dedupeDirectedTransportRoutes,
  enforceScheduledMoveTimeline,
  removeUnplannedIntercityRows,
  locationFitsScope, sameTravelArea,
  enforceOriginAccess, enforceMorningRoutine, enforceEveningPlan,
  fixMealLabels, removeOptionalRouteDetours, enforceScenicRouteTiming, enforceScenicRouteSeparation, enforceNoMiddayHotel, skeletonDayItems, skeletonForEmptyDays,
  transferMinutes, isCarTransfer, detourTransfers, prematureOriginDays, deferPrematureReturn, warnDetourTransfers,
  dedupeTransports, removeRedundantDirectTransports, removeCheckoutBacktracks,
  enforceTransportChainOrder,
  removeOrphanStationWaitingItems, dedupeDuplicateHotelItems, transportCodeOf, mergeOnboardMealsIntoTrain,
  isRealCode, moveActivityText, isScheduledMove,
  fixDayTimeOverlaps, enforceFinalTimelineIntegrity, samePlace, toMin, fmtMin, solarEventMinute, longjiSolarMinute,
  enforceTripEdgeOrder, enforceTransportPreference, drivingAllowed, taxiAllowed, taxiPreferred,
  explicitSelfDriveSegment, defaultTransferMode, ensureSelfDriveParking, enforceOutlineTransportPreference,
  hotelBookingTasks, hotelTaskNote, syncHotelReferences, annotateHotelItems, linkBookingAlarms, normalizeBookingAlarmKinds, dedupeBookingAlarmRecords, alarmUsageInfo, annotateAlarmUsage, bookingStatusMatches, ensureStableItemIds,
  collectSegments, applyRealSchedules, resolveOfficialRailTimeline,
  enforceRealSchedule, stripUnverifiedSchedules, enforceOfficialRailItems, dedupeOfficialRailItems,
  pickSchedule, shareStem,
};
