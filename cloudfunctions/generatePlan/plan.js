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
  const mustGo = String(i.mustGo || '').trim();
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
    .replace(/中国|省|市|自治州|地区|盟|县|区|镇|乡|街道|站|景区|停车场/g, '');
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
      // “租电动车/租摩托车”常被模型藏在游览备注里，虽然主活动写的是
      // 步行或竹筏，前端仍会把它理解成用户自行驾驶；非自驾路线统一给出
      // 公共交通/景区接驳替代，不误伤普通的“骑行绿道”描述。
      it.note = String(it.note || '').replace(/[^。；;]*(?:租赁|租用|租|骑行|驾驶|驾车|自驾)[^。；;]*(?:电动车|电动摩托车|摩托车)[^。；;]*[。；;]?/g,
        '此段使用步行、公共交通或景区接驳。');
    }
    const from = String(it.startLocation || '').trim();
    const to = String(it.endLocation || '').trim();
    const isOwnDriveText = /自驾|开车|驾车|驾驶|驱车/.test(activity);
    const isChauffeured = /打车|网约车|出租车|巡游车|包车/.test(activity);
    const selfOperatedMotor = /(?:租赁|租用|租|骑行|骑|驾驶|开)(?:两辆|一辆|电动)?(?:电动摩托车|电动车|摩托车)|(?:电动摩托车|电动车|摩托车)(?:租赁|租用|租车|骑行)/.test(activity);
    const motorRentalStop = (value) => String(value || '')
      .replace(/电动摩托车租赁点|电动车租赁点|摩托车租赁点|电动车租车点|摩托车租车点/g, '公共交通接驳点');

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
      it.activity = activity.replace(/(?:骑行|骑|驾驶|开)(?:两辆|一辆|电动)?(?:电动摩托车|电动车|摩托车)[^，。；;]*/g,
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
  const ax = scopeWordsOf(a);
  const bx = scopeWordsOf(b);
  if (ax.some((x) => bx.some((y) => x === y || (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y))))) {
    return true;
  }
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
  const verified = day && day.hotelPoiVerified === true
    && String(day.hotelPoiVerifiedName || '').trim() === hotel
    && String(day.hotelPoiAddress || '').trim();
  return hotel && (verified || locationFitsScope(hotel, dayScope(day), day && day.hotelPoiAddress)) ? hotel : '';
}

function normalizeOutlineLodging(outline) {
  asArray(outline && outline.days).forEach((day, di) => {
    const hotel = String((day && day.hotel) || '').trim();
    if (hotel && day.hotelPoiVerified === true
      && String(day.hotelPoiVerifiedName || '').trim() === hotel
      && String(day.hotelPoiAddress || '').trim()
      && locationFitsScope(hotel, dayScope(day), day.hotelPoiAddress)) return;
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
          const start = previousEnd + 10;
          const end = Math.min(currentStart - 10, start + preferredDuration);
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
function sanitizeOutlineLocalMoves(outline) {
  const days = asArray(outline && outline.days);
  const localMode = (move) => /subway|metro|地铁|公交|步行|walk|tram|轻轨/.test(
    `${move && move.mode || ''} ${move && move.code || ''}`.toLowerCase());
  days.forEach((day, dayIndex) => {
    const moves = asArray(day && day.moves);
    if (moves.length < 2) return;
    const kept = moves.filter((move) => {
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

/** 细化结果再次校正住宿条目，防止错误酒店被闭环兜底和下一天继承。 */
function normalizeGeneratedLodging(items, outline, p) {
  const days = asArray(outline && outline.days);
  let out = asArray(items).slice();
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
0. **城市串联原则（最重要）**：把出发地和所有目的地按「总路程最短 + 换乘最少 + 单程耗时最短」串成一条线。
   - 交通方式判定：${modeRule}
   - 走法要单向推进，禁止来回折返（例：重庆→桂林→阳朔→南宁→重庆，不要 重庆→南宁→桂林→重庆 这种回头路）。
   - 相邻城市间移动尽量控制在 3 小时内；需要更久的，安排在整天里并给出具体班次与运行时长。
   - 同一城市的景点连片玩完再换下一城，避免同城反复往返。
0.1 **按真实地理方位聚类，绝不南北来回跑**：先按实际地理位置把目的地分组（例：龙脊梯田在桂林北面约 2.5 小时车程，阳朔/兴坪在桂林南面，明仕田园/德天瀑布在桂西南崇左），**同一方位的景点连片玩完再去下一方位**。一般规律：先去离主基地最远的一端玩（如先去北面的龙脊），回到主基地后再顺着返程方向一路玩过去（南面的阳朔→更南的崇左/德天），让整条线只有"前进"没有"回头"。
0.2 **住宿闭环（铁律）**：每一天的 ov（当晚住宿地）就是**第二天早上出发的地方**，两天之间不许断链。同一片区的多天写**同一个 ov**（同一家酒店连住，如"桂林市区（两江四湖片区）"连住两晚），一个基地辐射周边景点，别天天换酒店搬行李。禁止出现"昨晚住 A，第二天一早却从 B 出发"的安排。
   **反过来：相邻两天核心游玩片区相距超过约 1 小时车程时，必须换基地**——今晚 ov 要写到离明天景点最近的片区（例：今天玩成都市区、明天一早进毕棚沟，今晚就住理县/古尔沟，绝不允许住成都市、来回通勤 4 小时）；"同一 ov 连住"只适用于同一片区的多天，全称行程只用一家酒店是不允许的。
   0.2.1 **行李随人走（铁律，为游客的方便着想）**：**只要当晚不回昨晚那家酒店（ov 与前一天不同），大件行李就必须随身走**，绝不允许"把大件行李寄存在 A 酒店、人去 B 住"——那等于逼游客折返取件。换住处那天的正确走法：退房带走行李 → 抵达新住宿地后**先到酒店放行李/寄存前台，再轻装出门玩**；若当天先去景区，行李随身带到景区，用游客中心的寄存处/存包柜，并在当天提示里写明"离开时取回行李"。
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
          return warnDetourTransfers(normalizeOutlineLodging(repaired));
        }
        // 原大纲仍有提前返程时，即使其他问题让模型补丁不能整体采纳，也先兜住路线闭环。
        if (earlyReturns.length) {
          deferPrematureReturn(p, outline, earlyReturns);
          sanitizeOutlineLocalMoves(outline);
          return warnDetourTransfers(normalizeOutlineLodging(outline));
        }
        sanitizeOutlineLocalMoves(outline);
        return warnDetourTransfers(normalizeOutlineLodging(outline));
      }
    } else {
      console.warn('[generatePlan] 剩余时间不足，跳过修订，保留原大纲');
    }
  }
  const remainingEarlyReturns = prematureOriginDays(p, outline);
  if (remainingEarlyReturns.length) deferPrematureReturn(p, outline, remainingEarlyReturns);
  sanitizeOutlineLocalMoves(outline);
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
  days.forEach((day, di) => {
    if (di <= 0) return;                       // 第一天本来就是从出发地启程
    const list = byDay.get(di) || [];
    if (!list.length) return;
    const prevDay = days[di - 1] || {};
    const prevList = byDay.get(di - 1) || [];
    const prevLocation = lastKnownOf(prevList, prevDay);
    if (!prevLocation) return;
    const first = ordered(list)[0];
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
  return out;
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
  return asArray(items).filter((item) => {
    if (!item || item.category !== 'transport') return true;
    const start = String(item.startLocation || '').trim();
    const end = String(item.endLocation || '').trim();
    if (!start || !end || !samePlace(start, end) || loopLike.test(String(item.activity || ''))) return true;
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
  if (/train|高铁|动车|火车/.test(mode)) return code ? `乘 ${code} 次列车从${m.from}前往${m.to}` : `乘火车从${m.from}前往${m.to}`;
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
    let s = start;
    let e = end;
    if (s === null && e === null && targetDepartures.length) {
      e = targetDepartures[0].time;
      s = e - duration;
    } else if (s === null && originArrivals.length) {
      s = originArrivals[0].time;
      e = s + duration;
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
          const contextOrigins = [
            days[di - 1] && (days[di - 1].overnight || days[di - 1].city),
            day && day.overnight,
            day && day.city,
          ].map((x) => String(x || '').trim()).filter(Boolean);
          if (!contextOrigins.length) return null;
          const reachableFromContext = (target, excluded) => {
            const queue = contextOrigins.map((place) => ({ place, end: null }));
            const visited = new Set();
            while (queue.length) {
              const current = queue.shift();
              const key = normalizeRoutePlace(current.place);
              if (!key || visited.has(key)) continue;
              visited.add(key);
              if (sameRouteArea(current.place, target)) return true;
              transportRows.forEach((row) => {
                if (row === excluded || !sameRouteArea(row.startLocation, current.place)) return;
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
        const loose = inDay.filter((it) => it.category === 'transport'
          && ((sameRouteArea(it.startLocation, m.from) && sameRouteArea(it.endLocation, m.to))
            || (toStem.length >= 2 && fromStem.length >= 2
              && /前往|乘车|乘坐|打车|包车|大巴|班车|专线|抵达|出发|接驳/.test(activity(it))
              && activity(it).includes(toStem) && activity(it).includes(fromStem))));
        if (loose.length) {
          const matchedMove = loose.sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440))[0];
          const routeMismatch = !sameRouteArea(matchedMove.startLocation, m.from)
            || !sameRouteArea(matchedMove.endLocation, m.to);
          if (routeMismatch) {
            matchedMove.startLocation = String(m.from).trim();
            matchedMove.endLocation = String(m.to).trim();
            matchedMove.startLon = matchedMove.startLat = '';
            matchedMove.endLon = matchedMove.endLat = '';
            matchedMove.activity = moveActivity(m);
            console.warn('[generatePlan] 第%d天交通文案命中但地点字段串线，按大纲校正：%s→%s',
              di + 1, m.from, m.to);
          }
          matchedMove.category = 'transport';
          if (!matchedMove.transportType) matchedMove.transportType = transportTypeOf(m);
          if (m.timingEstimated && toMin(m.startTime) !== null && toMin(m.endTime) !== null) {
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
      it.activity = `乘列车从${from}前往${to}`;
      it.startLocation = from;
      it.endLocation = to;
      append(it, '班次与时刻暂未从12306查询到，购票前请核实');
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
  byDay.forEach((list) => {
    const sorted = list.slice().sort((a, b) => (toMin(a.startTime) ?? 1440) - (toMin(b.startTime) ?? 1440));
    sorted.forEach((direct) => {
      if (direct.schedSource === '12306') return;
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
            last.activity = `${transferText(from, origin, defaultTransferMode(p))}，到家休息`;
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
            ? `${transferText(from, origin, defaultTransferMode(p))}，到家休息`
            : `${transferText(from, origin, defaultTransferMode(p))}，到家休息（返程大交通班次请另行查询）`,
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
function enforceLuggageRules(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;

  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });

  const TIP_PICKUP = '离开前记得取回寄存的行李';

  byDay.forEach((list, di) => {
    if (!list.length) return;
    const today = days[di] || {};
    const prevDay = di > 0 ? days[di - 1] : null;
    const tonight = String(today.overnight || today.city || '');
    const lastNight = prevDay ? String(prevDay.overnight || prevDay.city || '') : '';
    const changedBase = !!lastNight && !samePlace(lastNight, tonight);
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
      .replace(/(不可|不能|不得|不该|不宜|切记不要|不要|不|勿|别|无需|无须|不用|避免|严禁|禁止)(寄存|存放|存包|寄放)/g, '');
    // 只把"真的把行李存下了"当成寄存：activity 里写了寄存动作，或备注里明确写了"寄存行李"。
    // 「码头有行李寄存柜」这种顺口一提不算——否则会莫名其妙冒出一条"记得取回行李"。
    const isStore = (it) => (/寄存|存放|存包/.test(stripNegation(String(it.activity || ''))) && hasLuggage(it))
      || /寄存(大件)?行李|存放(大件)?行李|行李寄存/.test(stripNegation(String(it.note || '')));
    const isPickup = (it) => /取回|取件|拿回|领回/.test(textOf(it)) && hasLuggage(it);
    const appendNote = (it, tip) => {
      if (!it) return false;
      const cur = String(it.note || '');
      if (cur.includes(tip)) return false;
      it.note = cur ? `${cur.replace(/[；;]\s*$/, '')}；${tip}` : tip;
      return true;
    };

    // ①② 换住处：行李必须随人走
    if (changedBase) {
      list.forEach((it) => {
        if (!isStore(it)) return;
        // 景区/车站/机场的临时寄存是合理操作，别误伤
        if (/景区|景点|游客中心|寄存柜|存包|车站|机场|码头/.test(textOf(it))) return;
        appendNote(it, TIP_TAKE);
      });
      if (!list.some(hasLuggage)) {
        const first = list.slice().sort((a, b) =>
          String(a.startTime || '').localeCompare(String(b.startTime || '')))[0];
        appendNote(first, TIP_TAKE);
      }
    }

    // ③ 寄存了就得有人喊你取回
    const storeIdx = list.findIndex(isStore);
    if (storeIdx < 0) return;
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
    // 找寄存之后第一条"要离开这儿"的条目：有移动、或终点不在寄存地
    const storePlace = String(list[storeIdx].endLocation || list[storeIdx].startLocation || '');
    let target = null;
    for (let i = storeIdx + 1; i < list.length; i++) {
      const it = list[i];
      const moved = String(it.endLocation || '').trim()
        && String(it.endLocation).trim() !== storePlace
        && String(it.endLocation).trim() !== String(it.startLocation || '').trim();
      if (it.category === 'transport' || moved) { target = it; break; }
    }
    if (!target) target = list[list.length - 1];
    if (target === list[storeIdx]) return;   // 全天就这一条，别自言自语
    appendNote(target, TIP_PICKUP);
  });

  return items;
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
    if (!visitRows.length) return;
    // note 里的“毕棚沟很适合拍照”只是说明，不代表用户真的到过毕棚沟。
    // 覆盖审计只认可执行的 activity 和结构化起终点，避免把景点名称藏在备注
    // 中就误判为已游览。
    const textOf = (item) => `${item.activity || ''} ${item.startLocation || ''} ${item.endLocation || ''}`;
    highlights.forEach((highlight) => {
      const stem = placeStem(highlight);
      const normalized = normalizeRoutePlace(highlight);
      const covered = dayRows.some((item) => {
        if (!['sight', 'other'].includes(String(item && item.category || ''))) return false;
        const text = textOf(item);
        const compact = normalizeRoutePlace(text);
        return (stem.length >= 2 && text.includes(stem))
          || (normalized.length >= 2 && compact.includes(normalized));
      });
      if (covered) return;
      const target = visitRows.find((item) => {
        const location = `${item.startLocation || ''} ${item.endLocation || ''}`;
        return sameTravelArea(location, highlight)
          || normalizeRoutePlace(location).includes(normalized)
          || normalized.includes(normalizeRoutePlace(location));
      }) || visitRows[0];
      const old = String(target.activity || '').trim();
      target.activity = `在${highlight}内，${old || `游览${highlight}`}`.slice(0, 200);
      console.warn('[generatePlan] 第%d天详细游览补落地要点：%s', dayIndex + 1, highlight);
    });
  });
  return rows;
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
    : `${transferText(from, origin, mode)}，到家休息`;
  if (late) {
    const msg = `返程到站时间已晚于计划接驳起点，预计 ${fmtMin(end)} 到家；请按实际班次核实`;
    transfer.note = String(transfer.note || '').includes(msg)
      ? transfer.note : [transfer.note, msg].filter(Boolean).join('；');
  }
  if (!kept.includes(transfer)) kept.push(transfer);

  const daySet = new Set(dayRows);
  const rebuilt = rows.filter((item) => !daySet.has(item)).concat(kept);
  console.warn('[generatePlan] 末日收口到出发地：%s→%s，%s-%s', from, origin, transfer.startTime, transfer.endTime);
  return rebuilt;
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
      if (row.category === 'transport' && row.startLocation && row.endLocation && !purposeful(row)) {
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
      if (dropped.has(first) || first.schedSource === '12306') continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const second = sorted[j];
        if (dropped.has(second) || !sameRoute(first, second)) continue;
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
  const accessFrom = String((oldReturn && !matchesOriginCity(oldReturn.from, p.origin)
    ? oldReturn.from : priorExternal && priorExternal.to) || '').trim();
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
      const context = `${day && day.city || ''} ${day && day.theme || ''} ${day && day.overnight || ''}`;
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

/** hl 里不算景点的泛化词（按天重复是正常的） */
const GENERIC_HL = /^(自由活动|自由行|自由探索|酒店休息|休整|集合|出发|到达|抵达|返程|返程回家|逛逛|市区漫游|市区自由活动)$/;

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
    if (s && !GENERIC_HL.test(s)) items.push({ s, stem: placeStem(s), day: i });
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
    (day.note ? `提示：${day.note}\n` : '') +
    `当晚住宿：${day.overnight || day.city}${day.hotel ? `（推荐酒店：${day.hotel}${day.hotelPoiAddress ? `；核验地址：${day.hotelPoiAddress}` : ''}，已按用户预算「${p.budget}」档挑选，最后的入住条目用它）` : ''}\n\n` +
    (prev ? `【昨天】${prev.date}｜${prev.theme}，昨晚住${prev.overnight || prev.city} —— 今天第一条行程从这里出发。\n` : '') +
    (next ? `【明天】${next.date}｜${next.theme}（今天的行程要为明天的移动留出余量）\n\n` : '\n');

  const rules =
    `请把"今天"展开为**详细到可以直接照着执行**的行程项 JSON 数组，每个元素格式：${ITEM_SCHEMA}
${longjiDetailRule ? `\n【龙脊路线约束】${longjiDetailRule}\n` : ''}
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
14. **住宿闭环（铁律）**：昨晚住哪，今天第 1 条就从哪出发——${prev ? `昨晚住「${prev.overnight || prev.city}」，第 1 条应写成"从该住宿地出发"，startLocation 填它` : '今天从出发地启程'}；${isLast ? '返程日以回到出发地结束，禁止安排回酒店或虚构返程日晚住宿。' : `当天最后 1 条必须是"回到${day.overnight || day.city}住宿地休息"（category=hotel，endLocation 填住宿地）。`}绝不允许昨晚住 A 今早却凭空从 B 出发、或晚上收在 C 但住宿地是 D。${sameBase ? '当晚回同一家酒店时，早上可加一条"大件行李留在房间/寄存前台，轻装出发"（note 写明回来续住）。' : '**今晚不回昨晚这家酒店，行李必须随身走**（见第 16 条）。'}
15. **地点名要用地图搜得到的通用叫法**：startLocation / endLocation 只写地点真名，别自造"XX公园""XX景区大门"这种后缀（"象鼻山"不要写成"象鼻山公园"——地图上真有另一个"象鼻山公园"在别的省，导航会导错）；也不要带括号补注、不要写"附近/周边"这类模糊词。车站写标准站名（如"桂林北站""南宁东站"）。` +
    `\n16. **行李处理（铁律，为游客方便着想，必须落实到今天的行程条目里）**：昨晚「${lastNight || '出发地'}」→ 今晚「${tonight || '返程'}」——${sameBase
      ? '**今晚回同一家酒店**：大件行李留在房间或寄存在前台，轻装出门，晚上回来续住同一家。'
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
    const end = String(item.endLocation || '').trim();
    const activity = String(item.activity || '');
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
    if (String(item.category || '') === 'hotel' && currentTarget) {
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
    if (String(item.category || '') === 'hotel' && currentTarget) {
      out.bookingInfo = currentTarget;
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
    const day = days[Number(item.dayIndex || 0)] || {};
    const hotel = String(day.hotel || item.endLocation || '').trim();
    if (!hotel) return item;
    const out = Object.assign({}, item, { bookingInfo: hotel });
    const note = hotelRecommendationNote(day);
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
      const type = isTrain ? 'train' : isPlane ? 'plane' : isBoat ? 'ticket' : 'bus';
      const presale = isTrain ? TRAIN_PRESALE_DAYS : isPlane ? 30 : isBoat ? TICKET_PRESALE_DAYS : 5;
      const target = `${m.from || ''}→${m.to || ''}${m.code ? ` ${m.code}` : ''}`;
      if (alreadyBooked(`${target} ${isBoat ? '游船/船票' : type === 'train' ? '火车票' : type === 'plane' ? '机票' : '汽车票'}`, type)) return;
      const buyDate = shiftDate(d.date, -presale);
      // 该乘车日前后 1 天内已有同类型闹钟 → 视为已覆盖
      const covered = nominated.some((a) => a.type === type
        && Math.abs(parseCnTime(`${dayKey(a.fireAt)}T00:00:00`) - parseCnTime(`${buyDate}T00:00:00`)) <= DAY_MS);
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
    const day = days[Number(it.dayIndex || 0)] || {};
    const date = validDate(day.date) ? day.date : shiftDate(p.startDate, Number(it.dayIndex || 0));
    const titleText = String(it.activity || it.endLocation || it.startLocation || '该项目').slice(0, 28);
    const statusType = it.category === 'transport' ? bookingKindOf(text) : it.category === 'ticket' ? 'ticket' : '';
    if (BOOKING_DONE_RE.test(text)
      || (statusType && bookingStatusMatches(p, `${titleText} ${text}`, statusType))) return;
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
    const prepLike = /身份证|护照|签证|通行证|驾照|药品|充电宝|装备|行李|宠物|外币|流量卡|保险|值机|选座|租车|包车|接送机/.test(text);
    if (prepLike && !covered('other', shiftDate(date, -3), titleText)) {
      push(
        `准备${date} ${titleText}`,
        shiftDate(date, -3), '20:00', 'other',
        '根据最终详细行程自动补齐，出发前检查材料、装备或服务是否已经准备好。'
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
4. 需要"提前进 App 准备"的，另起一条准备闹钟（比正式开抢早 5 分钟）。
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
        // 官方查询失败/当天没有可售结果时，必须清除模型给的车次和精确时刻。
        // 留着 Gxxxx + 一个看似精确的时间会让用户误以为已核对，反而比空缺更危险。
        if (data.present && data.meta && data.meta.official && data.meta.attempted) {
          m.sched = [];
          m.schedSource = 'official-unavailable';
          m.scheduleRequired = true;
          m.code = '';
          m.startTime = '';
          m.endTime = '';
          if (data.meta.unresolvedStations) {
            m.mode = 'bus';
            m.schedSource = '';
            m.scheduleRequired = false;
            m.timingEstimated = true;
            m.transfer = '未能在铁路站点字典中确认此路段，不安排虚构列车；改查旅游专线/大巴，运营与耗时待核实。';
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
  enforceLongjiSameDayRoute(outline, p);
  alignOutlineMoveTimes(outline);
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
    const query = `${a.bookingInfo || ''} ${a.title || ''}`
      .replace(/\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?/g, '')
      .replace(/立即查看并(?:预约|购买)|开始盯|开抢|预约|预订|购票|购买/g, '')
      .replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
    const exact = dayRows.find((it) => {
      const activity = String(it.activity || '').replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
      const route = [it.startLocation, it.endLocation].filter(Boolean).join('→')
        .replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
      const activityHead = activity.slice(0, Math.min(16, activity.length));
      return (activityHead.length >= 8 && query.includes(activityHead)) || (route.length >= 4 && query.includes(route));
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
        return (route && matchQuery.includes(route)) || (it.activity && matchQuery.includes(String(it.activity).slice(0, 6)));
      }) || candidates[0];
      a.dayIndex = Number(match.dayIndex || 0);
      a.linkedItemId = String(match.itemId || '');
      a.bookingInfo = String(a.bookingInfo || bookingInfoFromItem(match)).slice(0, 160);
    }
    return a;
  });
  return out;
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
      || /^(walk|ride|bus|train|plane|car)$/.test(linkedMode)
      || /步行|打车|网约车|乘车|乘坐|前往|接驳/.test(linkedActivity));
    const linkedTicketEvidence = /门票|购票|放票|入园预约|实名预约|船票|游船|竹筏|漂流|演出|缆车|索道|温泉票|跟拍/.test(linkedActivity);
    const titleTicketEvidence = /门票|购票|放票|船票|游船|竹筏|漂流|演出|缆车|索道|温泉票/.test(title);
    // “打车到游客中心，顺便购买门票”仍是一条交通条目：地点或动作里
    // 提到“购买门票”不能把普通接驳变成门票放票提醒。只有门票类条目，
    // 或明确的船票/竹筏/漂流/缆车等体验本身，才保留 ticket 闹钟。
    const startsAsTransfer = /^(?:打车|前往|抵达|到达|步行|乘坐|乘|从|搭乘)/.test(linkedActivity.trim());
    const bookingExperience = /船票|游船|竹筏|漂流|缆车|索道|温泉|演出|跟拍/.test(linkedActivity)
      && !startsAsTransfer;
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

async function buildPlan(rawInput, outlineData, opts = {}) {
  const p = normalizeInput(rawInput);
  let normalizedOutline = (outlineData && outlineData.outline) || outlineData || {};
  normalizedOutline = enforceOutlineTransportPreference(p, normalizedOutline);
  if (drivingAllowed(p)) normalizedOutline = applyTripEdgeTimes(p, normalizedOutline);
  normalizedOutline = alignOutlineMoveTimes(normalizedOutline);
  ensureOutlineMoveContinuity(normalizedOutline, p);
  alignOutlineMoveTimes(normalizedOutline);
  sanitizeOutlineLocalMoves(normalizedOutline);
  removeOutlineBacktracks(normalizedOutline);
  const outline = normalizeRouteDayFocus(
    ensureOutlineHotelFallbacks(normalizeOutlineLodging(normalizedOutline), p), p,
  );
  ensureOutlineHighlightCoverage(outline, p);
  enforceLongjiSameDayRoute(outline, p);
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
  const likelyFinal = totalDays - doneBefore <= 3;
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
  const skeleton = detail.partial
    ? { items: [], replaced: [] }
    : skeletonForEmptyDays(p, outline, detail.items, detail.doneDayIndexes);
  const baseItems = skeleton.replaced.length
    ? detail.items.filter((it) => !skeleton.replaced.includes(Number(it.dayIndex || 0)))
    : detail.items;
  // 本轮真正产出条目的天：跨天循环的兜底（MovesAlignment/OriginAccess）只处理
  // 这些天，之前轮次已完成的天不许再补（续跑每轮都会写库，重复补=条目翻倍）
  const roundDays = [...new Set(baseItems.concat(skeleton.items)
    .map((it) => Number(it.dayIndex || 0)))];
  let items = enforceMovesAlignment(sanitizeItems(baseItems.concat(skeleton.items)), outline, roundDays, p);
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
  items = enforceLuggageRules(items, outline);
  items = enforceTripEdgeOrder(items, p, outline, roundDays);
  items = enforceTransportPreference(items, p);
  items = removeOptionalRouteDetours(items);
  items = enforceScenicRouteTiming(items);
  items = ensureSelfDriveParking(items, p);
  items = removeZeroDistanceTransports(items);
  // 闭环、住宿和自驾校正可能移除或改写模型条目；最后再核一遍本轮的大纲移动，
  // 确保跨城/景区班车不会因此从最终时间线消失。
  items = enforceMovesAlignment(items, outline, roundDays, p);
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
  items = fixDayTimeOverlaps(items);
  // 高亮补齐不改时间，但上一轮重叠修复可能把末日收尾重新推迟；在序列化前
  // 再锁一次用户填写的出发地和到家时刻，避免只剩“到金童路站”或 17:40。
  items = ensureFinalHomeArrival(items, p, outline);
  items = fixDayTimeOverlaps(items);
  items = removeScenicReentryBacktracks(items);
  items = dedupeDirectedTransportRoutes(items);
  items = ensureFinalHomeArrival(items, p, outline);
  items = annotateHotelItems(items, outline);
  items = ensureStableItemIds(items);

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
  if (detail.partial) {
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
      progress,
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
  const plan = await buildPlan(rawInput, first);
  plan.meta.outlineMs = plan.meta.elapsedMs;
  plan.meta.elapsedMs = Date.now() - t0;
  return plan;
}

module.exports = {
  generate, generateOutline, buildPlan, genDayItems,
  normalizeInput, sanitizeAlarmCandidates, buildFallbackAlarms, fallbackAlarms, backfillDetailAlarms,
  shiftDate, dayDiff, isHolidayRange,
  parseDestList, missingMustVisit, placeStem, duplicateHighlights, ensureOutlineHighlightCoverage, enforceLongjiSameDayRoute,
  applyTripEdgeTimes, snapScheduleMinutes, isTransportItem,
  enforceDayStartLocation, enforceDayClosure, enforceLuggageRules, enforceMovesAlignment, reconcileTransportOrigins,
  removeZeroDistanceTransports,
  removeAfterHomeArrival,
  normalizeOutlineLodging, normalizeGeneratedLodging, alignOutlineMoveTimes, ensureOutlineMoveContinuity, sanitizeOutlineLocalMoves, removeOutlineBacktracks,
  ensureItemLocationContinuity, ensureDetailHighlightCoverage, ensureFinalHomeArrival,
  removeScenicReentryBacktracks, dedupeDirectedTransportRoutes,
  locationFitsScope, sameTravelArea,
  enforceOriginAccess, enforceMorningRoutine, enforceEveningPlan,
  fixMealLabels, removeOptionalRouteDetours, enforceScenicRouteTiming, enforceScenicRouteSeparation, enforceNoMiddayHotel, skeletonDayItems, skeletonForEmptyDays,
  transferMinutes, isCarTransfer, detourTransfers, prematureOriginDays, deferPrematureReturn, warnDetourTransfers,
  dedupeTransports, removeRedundantDirectTransports, removeCheckoutBacktracks,
  enforceTransportChainOrder,
  removeOrphanStationWaitingItems, dedupeDuplicateHotelItems, transportCodeOf, mergeOnboardMealsIntoTrain,
  isRealCode, moveActivityText, isScheduledMove,
  fixDayTimeOverlaps, enforceFinalTimelineIntegrity, samePlace, toMin, fmtMin,
  enforceTripEdgeOrder, enforceTransportPreference, drivingAllowed, taxiAllowed, taxiPreferred,
  explicitSelfDriveSegment, defaultTransferMode, ensureSelfDriveParking, enforceOutlineTransportPreference,
  hotelBookingTasks, hotelTaskNote, syncHotelReferences, annotateHotelItems, linkBookingAlarms, normalizeBookingAlarmKinds, bookingStatusMatches, ensureStableItemIds,
  collectSegments, applyRealSchedules, resolveOfficialRailTimeline,
  enforceRealSchedule, enforceOfficialRailItems, dedupeOfficialRailItems,
  pickSchedule, shareStem,
};
