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

const { chatWithRetry, parseJSONFromText, asArray, SYS_PROMPT } = require('./llm');
const { sanitizeItems } = require('./normalize');
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('./cn-time');

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
  const transport = String(i.transport || '高铁优先');
  // 分钟级的去/返程时刻：用户指定后，首末两天的大交通必须落在这个时刻上
  const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()) ? String(s).trim() : '';

  return {
    origin: String(i.origin || i.fromCity || '').trim(),
    dest: String(i.dest || i.destCity || '').trim(),
    startDate,
    endDate: end,
    days,
    party, peopleNum, budget, pace, interests, transport,
    goTime: validTime(i.startTime || i.goTime),
    backTime: validTime(i.endTime || i.backTime),
    mustGo: String(i.mustGo || '').trim(),
    extra: String(i.extra || '').trim(),
    holiday: isHolidayRange(startDate, end),
  };
}

/** 给用户画像一句话摘要（喂给 LLM） */
function profileText(p) {
  const bits = [
    `${p.origin || '?'}出发 → ${p.dest || '?'}`,
    `${p.days}天（${p.startDate} 至 ${p.endDate}）`,
  ];
  // 去/返程时刻精确到分钟，LLM 必须照这个时刻排首末两天的大交通
  if (p.goTime) bits.push(`去程 ${p.goTime} 从${p.origin || '出发地'}出发`);
  if (p.backTime) bits.push(`返程 ${p.backTime} 从目的地启程返回`);
  bits.push(`${p.party} ${p.peopleNum}人`);
  bits.push(`预算${p.budget}`);
  bits.push(`节奏${p.pace}`);
  bits.push(p.transport);
  if (p.interests.length) bits.push('偏好：' + p.interests.join('、'));
  if (p.mustGo) bits.push('必去：' + p.mustGo);
  if (p.extra) bits.push('特殊要求：' + p.extra);
  if (p.holiday) bits.push('⚠️ 出行日期落在法定长假，必须考虑抢票/错峰');
  return bits.join('；');
}

// ============================================================
// ① 大纲
// ============================================================

async function genOutline(p) {
  // 用短键名：一份 8 天大纲能省 30%+ 的输出 token（时间就是成本，也直接决定会不会撞上 max_tokens）
  const prompt = `为以下旅行需求制定逐日路线大纲。

【需求】${profileText(p)}
${p.holiday ? '【重要】含法定节假日：首末两天通常是往返大交通日，热门项目要预留抢票/预约窗口。' : ''}

# 输出格式（严格 JSON，短键名）
{"t":"行程标题","s":"一句话路线概览","nt":[{"d":"MM-DD","c":"住宿城市"}],"ds":[
{"d":"YYYY-MM-DD","city":"城市","t":"当天主题短语","mv":[{"f":"出发站","to":"到达站","m":"train/plane/car/bus/ship","c":"车次/航班号","s":"HH:mm","e":"HH:mm"}],"hl":["必玩1","必玩2","必玩3"],"ml":["餐1","餐2"],"ov":"当晚住宿城市或片区","n":"关键提示（30字内）"}]}

# 硬性要求
0. **城市串联原则（最重要）**：把出发地和所有目的地按「总路程最短 + 换乘最少 + 单程耗时最短」串成一条线。
   - 先判断各城市间的交通方式：有高铁/动车直达的优先走高铁，没有直达高铁再看飞机，近距离（≤3 小时车程）优先高铁/直通车大巴。
   - 走法要单向推进，禁止来回折返（例：重庆→桂林→阳朔→南宁→重庆，不要 重庆→南宁→桂林→重庆 这种回头路）。
   - 相邻城市间移动尽量控制在 3 小时内；需要更久的，安排在整天里并给出具体班次与运行时长。
   - 同一城市的景点连片玩完再换下一城，避免同城反复往返。
1. ds 恰好 ${p.days} 天，日期从 ${p.startDate} 连续到 ${p.endDate}，每天一个元素，顺序递增。
2. 路线顺路：相邻两天不来回折返；同一城市连片玩完再换城。
3. 第一天从（或抵达）目的地${p.origin ? `（出发地 ${p.origin}）` : ''}，最后一天返回${p.origin || '出发地'}。
3.1 ${p.goTime ? `**去程时刻已由用户指定**：第一天的大交通必须在 ${p.goTime} 从${p.origin || '出发地'}出发（mv 里 s 字段写 ${p.goTime}，e 按实际运行时长推算）。` : '去程班次请给出一个具体、合理的发车/起飞时刻（s/e 都要精确到分钟）。'}
3.2 ${p.backTime ? `**返程时刻已由用户指定**：最后一天的大交通必须在 ${p.backTime} 从目的地启程返回${p.origin || '出发地'}（mv 里 s 字段写 ${p.backTime}）。` : '返程班次请给出合理的发车/起飞时刻（精确到分钟）。'}
4. mv 只写城际大交通：火车给参考车次走向（如 G2249）与运行时刻，飞机给航线；市内交通不写。
5. hl 每天 3-4 个**具体景点/片区名称**，别写"逛逛市区"这种废话；兼顾${p.pace}节奏${p.interests.length ? '和偏好' : ''}。
6. ${p.mustGo ? `用户必去：${p.mustGo}，必须排进合适的一天。` : ''}${p.extra ? `特殊要求：${p.extra}` : ''}
7. ${p.budget === '经济' ? '住性价比档，餐饮接地气；' : p.budget === '品质' ? '住高品质酒店/度假村，餐饮选口碑正餐；' : '住舒适型酒店，餐饮兼顾特色与性价比；'}推荐写类型/片区+代表菜，不要编造具体门牌地址。
8. ov 写住宿城市或片区（最后一天写"返程"）；nt 长度 = ${p.days - 1} 晚。
9. 所有文本简体中文，n 字段控制在 30 字以内。只输出 JSON 对象。`;

  const text = await chatWithRetry([
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: prompt },
  ], 3000);

  const raw = parseJSONFromText(text);
  const days = asArray(raw.ds).map((d, i) => ({
    date: validDate(d.d) ? d.d : shiftDate(p.startDate, i),
    city: String(d.city || '').trim(),
    theme: String(d.t || '').trim(),
    moves: asArray(d.mv).map((m) => ({
      from: m.f || '', to: m.to || '', mode: m.m || '', code: m.c || '',
      startTime: m.s || '', endTime: m.e || '',
    })),
    highlights: asArray(d.hl).map((x) => String(x || '').trim()).filter(Boolean),
    meals: asArray(d.ml).map((x) => String(x || '').trim()).filter(Boolean),
    overnight: String(d.ov || d.city || '').trim(),
    note: String(d.n || '').trim(),
  }));
  if (!days.length) throw new Error('大纲没有生成任何一天');

  const nights = asArray(raw.nt).map((n) => ({ date: n.d || '', city: String(n.c || '').trim() }));

  return {
    title: String(raw.t || `${p.dest}行程`).trim().slice(0, 60),
    summary: String(raw.s || '').trim().slice(0, 200),
    nights,
    days,
  };
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

  const block =
    `【旅行需求】${profileText(p)}\n\n` +
    `【今天】${day.date}（周${weekdayOf(day.date)}）｜${day.theme}\n` +
    `所在城市：${day.city}\n` +
    `大纲要点：${asArray(day.highlights).join('、')}\n` +
    (asArray(day.moves).length
      ? `跨城交通：${asArray(day.moves).map(
          (m) => `${m.from || '?'}→${m.to || '?'} ${m.mode || ''} ${m.code || ''} ${m.startTime || ''}-${m.endTime || ''}`
        ).join('；')}\n`
      : '') +
    (day.meals && asArray(day.meals).length ? `餐饮建议：${asArray(day.meals).join('、')}\n` : '') +
    (day.note ? `提示：${day.note}\n` : '') +
    `当晚住宿：${day.overnight || day.city}\n\n` +
    (prev ? `【昨天】${prev.date}｜${prev.theme}，昨晚住${prev.overnight || prev.city} —— 今天第一条行程从这里出发。\n` : '') +
    (next ? `【明天】${next.date}｜${next.theme}（今天的行程要为明天的移动留出余量）\n\n` : '\n');

  const rules =
    `请把"今天"展开为**详细到可以直接照着执行**的行程项 JSON 数组，每个元素格式：${ITEM_SCHEMA}
dayIndex 全部填 ${idx}。

# 细致度要求（核心）
1. 输出 ${isFirst || isLast ? '8' : '9'}～${isFirst || isLast ? '11' : '13'} 条，**覆盖一整天**：起床/早餐 → 上午安排 → 午餐 → 下午安排 → 傍晚（日落/夜景）→ 晚餐 → 夜间活动 → 回酒店休息。不要只列几个景点就结束。
2. 每条 startTime / endTime 必须具体且**首尾相接**：后一条的 startTime 等于前一条的 endTime（中间留间隔也算合理，如 转场/休息），全天从起床开始、到回酒店休息结束。禁止输出空时间、"--:--"、或 endTime 等于 startTime。
3. 时间分配要符合常识和${p.pace}节奏：早餐 07:00 前后；午餐 12:00-13:00；晚餐 18:30-20:00；景区游览至少 1-2 小时；晚上安排到 21:30-22:30 之间收尾回酒店。${p.pace === '轻松' ? '每天最多 2 个主景点，留出午休和慢逛时间。' : p.pace === '紧凑' ? '行程可以更满，但必须保证吃饭和必要的交通接驳时间。' : ''}
4. activity 要写得像真人行程："14:44 乘 G2249 前往桂林西（约 4 小时 54 分）"、"20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉"、"21:00 步行前往杉湖，看日月双塔夜景"。**要有具体名称**（店名/菜品/景点具体区域/观景台），不要写"吃晚饭""逛逛"这种空话。
5. 涉及移动的动作必须填 startLocation / endLocation（起点空着时，用上一条的位置或昨晚住宿地），并填 transportType：步行=walk，打车/包车=car，公交地铁/电动车=ride，火车=train，飞机=plane。没有移动（吃饭、休息、游览）三项都留空。
6. 备注写进 note：预约要求、末班车时间、门票信息、行李寄存、拍照机位、当地支付/语言提示等实用信息。
7. ${isFirst ? `第一天：从${p.origin || '出发地'}出发，先写前往车站/机场的集合与安检预留时间（国内高铁至少提前 45 分钟到站，飞机提前 2 小时）。${p.goTime ? `**大交通班次必须卡在 ${p.goTime} 发车/起飞**，请按这个时刻倒推集合、安检、候车时间，不要写成别的时刻。` : ''}` : ''}
8. ${isLast ? `最后一天：以返回${p.origin || '出发地'}结束，写到家/到站为止，并预留返程交通时间。${p.backTime ? `**返程班次必须卡在 ${p.backTime} 启程**，按这个时刻倒推退房、前往车站/机场的时间。` : ''}` : ''}
9. category 取值：景点游览=sight，餐饮=food，住宿/回酒店=hotel，交通=transport，门票预订/取票=ticket，其他=other。
10. 输出顺序按时间先后。只输出数组，不要任何解释。`;

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
 * @param {object} p 归一化输入
 * @param {object} outline 大纲
 * @param {object} opts { doneDayIndexes: 已完成的天（续跑时跳过）, deadline: 本次调用的截止时间戳 }
 */
async function genDayItems(p, outline, opts = {}) {
  const days = outline.days;
  const done = new Set(asArray(opts.doneDayIndexes).map(Number));
  const pending = days.map((_, i) => i).filter((i) => !done.has(i));
  const deadline = opts.deadline || (Date.now() + 40 * 1000);
  // 一批 3 天：单次并行约 12-18s，既够快又留得出判断时间的余地
  const WAVE = 3;
  // 剩余时间不足以安全跑完下一批就收工（一批最坏约 20s，留 12s 余量给写库和返回）
  const WAVE_RESERVE = 12 * 1000;

  const items = [];
  const finished = [];
  const failed = [];

  for (let k = 0; k < pending.length; k += WAVE) {
    const batch = pending.slice(k, k + WAVE);
    if (Date.now() + WAVE_RESERVE > deadline) {
      console.log('[generatePlan] 时间预算不足，停止在已完成部分（续跑）: 已完成=%d 剩余=%d',
        finished.length, pending.length - finished.length - failed.length);
      break;
    }
    const rs = await Promise.all(batch.map((idx) =>
      chatWithRetry(dayDetailPrompt(p, days[idx], idx, outline), 3500)
        .then((t) => ({ i: idx, items: asArray(parseJSONFromText(t)) }))
        .catch((e) => ({ i: idx, error: e.message }))
    ));
    rs.forEach((r) => {
      if (r.error) { failed.push(r.i); console.error(`[generatePlan] 第${r.i + 1}天细化失败:`, r.error); return; }
      if (!r.items.length) { failed.push(r.i); return; }
      r.items.forEach((it) => {
        if (!it || !String(it.activity || '').trim()) return;
        items.push(Object.assign({}, it, { dayIndex: r.i })); // dayIndex 由代码强制写入，不信任 LLM
      });
      finished.push(r.i);
    });
  }

  const doneAll = Array.from(done).concat(finished);
  const stillTodo = days.map((_, i) => i).filter((i) => !doneAll.includes(i) && !failed.includes(i));

  if (!items.length && !stillTodo.length) throw new Error('逐天细化全部失败，未能生成任何行程项');
  if (!items.length && !done.size) throw new Error('逐天细化全部失败');

  return {
    items,                       // 本次新生成的条目（续跑时只含剩余天）
    doneDayIndexes: doneAll,     // 已完成（含之前轮次）
    failedDayIndexes: failed,
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
    });
  });
  return out;
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
  let overdueCount = 0; // 已经过了开票日的条数：错开提醒时间，别一堆闹钟挤在同一分钟
  const push = (title, dateStr, timeStr, type, note) => {
    let ts = parseCnTime(`${dateStr}T${timeStr}:00`);
    if (!ts || isNaN(ts)) return;
    let finalNote = note || '';
    if (ts < now) {
      // 算出来的开票日已经过去了：行程还没出发的话，降级成"赶紧去看"的近期提醒
      // （用户多半是临时才规划，这一步能救回大量"本该早就抢票"的场景）
      if (tripEndTs < now) return;          // 行程都结束了，不再打扰
      if (tripStartTs < now - DAY_MS) return; // 出发超过一天 → 购票窗口已过
      overdueCount += 1;
      ts = now + (1 + overdueCount) * 3600 * 1000;
      finalNote = `按常规 ${dateStr} 就该开票/预订了，现在已经进入抢票期：${finalNote}`;
    }
    list.push({
      title: title.slice(0, 100),
      note: finalNote,
      fireAt: ts,
      fireAtStr: tsToCnDateTimeStr(ts),
      type,
      source: 'ai-rule',
    });
  };

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
    const before = isTrain ? TRAIN_PRESALE_DAYS : 30; // 机票通常提前 30 天以上关注
    const d = shiftDate(firstDay.date, -before);
    push(
      `${isTrain ? '开抢去程火车票' : '关注去程机票'}：${go.from || ''}→${go.to || ''}${go.code ? '（参考车次 ' + go.code + '）' : ''}`,
      d, '09:00', isTrain ? 'train' : 'plane',
      `按${isTrain ? '12306 提前 15 天预售（含当日）' : '航司常见提前 30 天放票'}推算：${d} 开票。各站/各航司具体放票时刻不同，请在 App 内设置起售提醒并提前录入乘客信息。`
    );
  }
  if (back && outline.days.length > 1) {
    const isTrain = isTrainMove(back);
    const before = isTrain ? TRAIN_PRESALE_DAYS : 30;
    const d = shiftDate(lastDay.date, -before);
    push(
      `${isTrain ? '开抢返程火车票' : '关注返程机票'}：${back.from || ''}→${back.to || ''}${back.code ? '（参考车次 ' + back.code + '）' : ''}`,
      d, '09:00', isTrain ? 'train' : 'plane',
      `返程${lastDay.date}的${isTrain ? '火车票' : '机票'}，按提前 ${before + 1} 天（含当日）推算 ${d} 开票。长假返程务必当天卡点抢。`
    );
  }

  // 2. 酒店：出发前 7 天晚 8 点
  const hotelNight = outline.nights && outline.nights.length ? String(outline.nights[0].city || '') : String(firstDay.city || '');
  push(
    `预订${hotelNight || '目的地'}住宿（可免费取消房型）`,
    shiftDate(p.startDate, -7), '20:00', 'hotel',
    '长假房源紧张且价格波动大，优先选可免费取消房型先锁价，行程确定后再比价调整。'
  );

  // 3. 门票：挑一个最像"需要预约"的景点（有景区/瀑布/竹筏等特征词的优先）
  const TICKET_HINT = /景区|瀑布|梯田|竹筏|游船|漓江|岩洞|古镇|古镇|森林公园|国家公园|博物馆|观景台|漂流|温泉|号$|寨$/;
  const allHighlights = [];
  outline.days.forEach((d, i) => {
    if (i === outline.days.length - 1) return; // 返程日的景点不值得预约
    asArray(d.highlights).forEach((h) => h && allHighlights.push(String(h)));
  });
  // 门票：最多盯 3 个最像"需要预约"的景点，别只给一条
  const hotSpots = allHighlights.filter((h) => TICKET_HINT.test(h)).slice(0, 3);
  const spots = hotSpots.length ? hotSpots : allHighlights.slice(0, 1);
  spots.forEach((s, i) => {
    push(
      `开始盯${String(s).slice(0, 20)}门票/预约放票`,
      shiftDate(p.startDate, -TICKET_PRESALE_DAYS + i), '09:00', 'ticket',
      '热门景区多提前 1-7 天限额放票，假期需每天查看余票公告，具体规则以景区官方通知为准，下单前请核对。'
    );
  });

  // 4. 包车/租车：用户选了自驾或包车时，提前 7 天定车
  if (/自驾|包车/.test(p.transport)) {
    push(
      '预订包车/租车（含保险与取还车点）',
      shiftDate(p.startDate, -7), '10:00', 'other',
      '长假车辆紧张，提前锁定车型与取还车网点，确认是否支持异地还车，下单前请核对。'
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

async function genAlarms(p, outline) {
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
3. 酒店：行程涉及的每一晚住宿都要单独一条（type=hotel），注明城市和日期。
4. 门票/预约：每一个需要实名预约、限量放票或分时段入园的景区/项目（type=ticket）。
5. 体验项目：竹筏/游船/漂流/潜水/温泉/跟拍/演出等需提前预订的项目（type=ticket 或 other）。
6. 行前准备：证件（身份证/护照/签证/边境通行证）、租车驾照、宠物寄养、装备采购、药品、外币/流量卡等（type=other），按"出发前 N 天"排。

# 时间推算规则（按中国各平台实际能查到的开放时间）
- 火车票 12306 预售期 15 天（含乘车当日）：乘车日减 14 天 = 开票日，时刻取 09:00（各站起售时刻不同）。
- 机票：普遍提前 30 天以上放票/开卖，取 30 天前的 10:00 开始关注。
- 长途汽车票/直通车：一般提前 3-7 天开售，取 5 天前的 09:00。
- 酒店：出发前 7 天 20:00 锁定可免费取消房型（长假再提前 3 天复查一次价格）。
- 景区门票：按国内主流 OTA/景区公众号，普遍提前 1-7 天放票，热门景区取 7 天前 09:00 开始盯。
- 行前准备类：证件/装备取出发前 3-5 天，值机/选座取出发前 1 天。

# 输出要求
1. title 写清楚抢什么、对应哪一天（例："抢去程票：重庆北→桂林西 G2249（9月30日车次）"）。
2. fireAt 必须是**未来的具体日期+时刻**，且**按时间从早到晚排序**。
3. note 里写明推算依据，并以「具体放票/开放时间以官方 App 或景区公告为准，下单前请核对」结尾。
4. 需要"提前进 App 准备"的，另起一条准备闹钟（比正式开抢早 5 分钟）。
5. **拒绝编造**：只用上面的日期推算；算不准宁可不输出，不要输出模糊或已过去的日期。
6. ${p.holiday ? '这是法定长假行程，抢票/预约压力极大，宁多勿漏。' : ''}
7. 同一件事不要重复。只输出数组。`;

  let nominated = [];
  try {
    const text = await chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], 2000);
    nominated = sanitizeAlarmCandidates(asArray(parseJSONFromText(text)), p);
  } catch (e) {
    console.error('[generatePlan] 闹钟提名失败，只走规则兜底:', e.message);
  }

  // 规则兜底补上必需的几条（去重：同一天同类型已有 LLM 提名的就跳过）
  const fallback = buildFallbackAlarms(p, outline);
  const have = new Set(nominated.map((a) => `${tsToDateStr(a.fireAt)}|${a.type}`));
  fallback.forEach((a) => {
    if (!have.has(`${tsToDateStr(a.fireAt)}|${a.type}`)) {
      nominated.push(a);
      have.add(`${tsToDateStr(a.fireAt)}|${a.type}`);
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

async function genSuggestions(p, outline) {
  const brief = outline.days.map((d) => `${d.date} ${d.theme}`).join('\n');
  const prompt = `为以下${p.days}天行程生成旅行建议 JSON 对象：{"weather":"天气与穿着建议","gear":"装备清单","food":"必吃推荐","tips":"注意事项","transport":"交通贴士","budget":"预算参考，纯文本每行一条「项目：金额元」"}。

【旅行需求】${profileText(p)}
【逐日主题】
${brief}

要求：全部简体中文，结合目的地与出行季节给出具体建议（不要正确的废话）。budget 按 ${p.budget} 档、${p.peopleNum} 人估算。只输出对象。`;

  try {
    const text = await chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], 1200);
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
async function generateOutline(rawInput) {
  const p = normalizeInput(rawInput);
  if (!p.dest) throw new Error('请填写目的地');
  const t0 = Date.now();
  const outline = await genOutline(p);
  console.log('[generatePlan] 大纲完成 %dms, 天数=%d', Date.now() - t0, outline.days.length);
  return {
    profile: p,
    outline,
    title: outline.title,
    summary: outline.summary,
    startDate: p.startDate,
    endDate: p.endDate,
    days: p.days,
  };
}

/**
 * 第二阶段：把大纲展开为逐天详情 + 闹钟 + 建议
 * @param {object} rawInput 与第一阶段相同的用户输入
 * @param {object} outlineData 第一阶段返回的 outline（含 days / nights / title / summary）
 */
async function buildPlan(rawInput, outlineData, opts = {}) {
  const p = normalizeInput(rawInput);
  const outline = (outlineData && outlineData.outline) || outlineData || {};
  if (!asArray(outline.days).length) throw new Error('缺少行程大纲，无法展开详情');

  const t1 = Date.now();
  // 时间预算：默认 45s，留 15s 给写库和返回（云函数上限 60s）
  const budget = opts.budgetMs || 45 * 1000;
  const deadline = t1 + budget;

  const detail = await genDayItems(p, outline, {
    doneDayIndexes: opts.doneDayIndexes,
    deadline,
  });
  console.log('[generatePlan] 细化完成 %dms, 原始条目=%d, partial=%s',
    Date.now() - t1, detail.items.length, detail.partial);

  const items = sanitizeItems(detail.items);

  // 还有天没生成完（撞时间预算）→ 只交回已完成的部分，闹钟/建议留到最后一次生成，
  // 前端拿到 partial=true 会立刻静默再调一次，用户全程只看到"正在细化…"
  if (detail.partial) {
    return {
      title: String((outlineData && outlineData.title) || outline.title || '我的行程').slice(0, 60),
      summary: String((outlineData && outlineData.summary) || outline.summary || '').slice(0, 200),
      startDate: p.startDate,
      endDate: p.endDate,
      items,
      partial: true,
      doneDayIndexes: detail.doneDayIndexes,
      meta: {
        days: p.days,
        failedDayIndexes: detail.failedDayIndexes,
        elapsedMs: Date.now() - t1,
      },
    };
  }

  const [alarms, suggestions] = await Promise.all([
    genAlarms(p, outline),
    genSuggestions(p, outline),
  ]);
  console.log('[generatePlan] 清洗后条目=%d, 闹钟=%d', items.length, alarms.length);

  return {
    title: String((outlineData && outlineData.title) || outline.title || '我的行程').slice(0, 60),
    summary: String((outlineData && outlineData.summary) || outline.summary || '').slice(0, 200),
    startDate: p.startDate,
    endDate: p.endDate,
    items,
    alarms: alarms.sort((a, b) => a.fireAt - b.fireAt),  // 待办按时间先后排，用户照着做就行
    suggestions,
    partial: false,
    doneDayIndexes: detail.doneDayIndexes,
    meta: {
      days: p.days,
      failedDayIndexes: detail.failedDayIndexes,
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
  generate, generateOutline, buildPlan,
  normalizeInput, sanitizeAlarmCandidates, buildFallbackAlarms, shiftDate, dayDiff, isHolidayRange,
};
