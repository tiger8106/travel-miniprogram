// cloudfunctions/parseTravelPlan/normalize.js
// LLM 输出的行程项清洗：
//   1. 字段规范化（时间补零、dayIndex 修正、截断）
//   2. 缺失 startTime 的智能回填（杜绝 --:-- 沉底失真）
//   3. "同一点 → 同一点" 的假导航清除（如 在民宿吃饭：龙脊别院→龙脊别院）

const MAX_DAY = 64;

// "7:20" / "07:20" / "7点20" → 分钟数；解析失败返回 null
function toMin(t) {
  const m = String(t || '').match(/^(\d{1,2})[:：点](\d{1,2})?/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtMin(v) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${p(Math.floor(v / 60))}:${p(v % 60)}`;
}

// 时间归一化："7:20" → "07:20"；非法返回 ''
function normTime(t) {
  const v = toMin(t);
  return v === null ? '' : fmtMin(v);
}

// 各类安排的常识耗时（分钟），原文真没给时长线索时用
const DEFAULT_DUR = {
  food: 60,
  sight: 90,
  transport: 60,
  hotel: 45,
  ticket: 30,
  other: 30,
};
const MAX_MIN = 23 * 60 + 59;

// 从文本里抓时长（分钟）："2.5小时" "1小时30分" "约40分钟" "40 min" "半小时"
// 抓不到返回 0（LLM 没填 endTime 且原文也没写时长时才走分类默认值）
function parseDurationMin(text) {
  const s = String(text || '');
  if (/半小时/.test(s)) return 30;
  const hm = s.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*小时(?:\s*(\d{1,2})\s*分(?:钟)?)?/);
  if (hm) {
    const v = parseFloat(hm[1]) * 60 + (hm[2] ? parseInt(hm[2], 10) : 0);
    if (v > 0) return Math.round(v);
  }
  const mm = s.match(/(\d{1,3})\s*(?:分钟|分|min|mins|minutes)/i);
  if (mm) {
    const v = parseInt(mm[1], 10);
    if (v > 0) return v;
  }
  return 0;
}

// 地点归一化比较：去空格 + 去常见括号后缀差异仍视为相同的前提是主体一致
// 简单可靠版：去所有空白后全等
function samePlace(a, b) {
  const s = String(a || '').replace(/\s+/g, '');
  const e = String(b || '').replace(/\s+/g, '');
  return s !== '' && s === e;
}

// LLM 的"内心独白"特征：推理、假设、自我纠错、把 prompt 里的字段名说出来。
// 实测真跑时第 2 天出现了一整段：
//   "*注：根据大纲『桂林磨盘山码头→阳朔龙头山码头』，若人已在阳朔…此处严格遵循【已确认跨城交通】"
// 用户是会直接看到这段文字的，必须清掉。
const META_PAT = [
  /\*\s*注\s*[:：]/,
  /[（(]\s*注\s*[:：]/,
  /^\s*注\s*[:：]/,
  /根据大纲|鉴于大纲|遵循大纲|依据大纲/,
  /此处假设|此处严格|若用户|如果用户强制/,
  /【已确认|【已确认的跨城交通】|【今天】|【昨天】|【明天】/,
  /作为\s*(一个\s*)?(AI|人工智能|助手)|我无法|我需要|我将为你|让我/,
  // 实测新一轮漏网（川西行程）：模型对"必须原样执行"的班次时刻有异议，
  // 把论证过程整段写进了 activity —— 逐句剔除对整段独白无能为力，见 META_HARD
  /鉴于上游|上游要求|必须原样|错误约束|修正正确|严格执行/,
  // 实测又一轮漏网（重庆-都江堰行程）：模型把 15:00 的返程车次写到早上 09:00，
  // 自圆其说"实际行程将提前完成都江堰，此处为倒叙 bridge…此处特别规划时间线
  // 以符合'上游规定'的约束"——"倒叙""规划时间线""上游规定""既定交通"都是独白黑话
  /倒叙|逆序|插叙|桥接|bridge/i,
  /上游规定|既定交通|规划时间线|时间线以符合|此处特别/,
  // 冒烟实测第三轮：整条 activity 只有一句"错误修正：此处应为乘车时间。根据既定路线"
  /错误修正|错误更正|此处应为|应为乘车|根据既定|既定路线/,
];

// 整条条目都是"内心独白"的硬特征：命中即认为 activity 根本不是行程描述，
// 而是模型对约束冲突的自我论证（实测："鉴于上游要求'必须原样执行'但给出了
// 具体时刻 13:00-13:20，前序行程需大幅提前或此为错误约束。**修正正确**…"）。
// 这种条目要整条处理（有起终点的抢救成干净的交通条目，否则丢弃），
// 不能只靠 stripMeta 逐句删——整段都是独白时 stripMeta 会原样保留。
const META_HARD = [
  /鉴于上游|上游要求/,
  /原[样似]执行|必须原样|照抄大纲/,
  /错误约束|约束冲突|此为错误/,
  /修正正确|更正如下/,
  // 同上实测：整条都是"倒叙 bridge / 规划时间线"的自圆其说
  /倒叙|逆序|插叙|桥接|bridge/i,
  /上游规定|既定交通|规划时间线|时间线以符合|此处特别/,
  /错误修正|错误更正|此处应为|应为乘车|根据既定|既定路线/,
];

/**
 * 剔掉句子里的元叙述（推理/假设/自我纠错），只留"要做什么"
 * 逐句判断，整段都被判为元叙述时保留原文——宁可啰嗦，也不能把行程说成空白。
 */
function stripMeta(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const tokens = s.split(/([。；;！!？?\n])/);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const body = tokens[i] || '';
    const delim = tokens[i + 1] || '';
    if (!body.trim()) continue;
    if (META_PAT.some((re) => re.test(body))) continue;
    kept.push(body + delim);
  }
  const out = kept.join('').trim();
  return out || s;
}

/**
 * 从 activity 文本里抽一个目的地（确定性，仅在起终点全空时兜底用）：
 *   「在崇善米粉（依仁路总店）吃桂林米粉」→ 崇善米粉（依仁路总店）
 *   「前往鼎鼎香农家菜吃饭」             → 鼎鼎香农家菜
 *   「游览兴坪古镇、20元人民币背景观景点」→ 兴坪古镇（截到第一个顿号）
 * 实测（广西七日攻略）：餐饮/游览条目 LLM 经常不填 startLocation/endLocation，
 * 卡片上连导航按钮都没有。抽不出或抽出的是泛词（酒店/附近）就放弃，宁缺毋滥。
 */
const DEST_STOP_RE = /^(酒店|民宿|客栈|宾馆|饭店|旅馆|家|住宿地|出发地|酒店大堂|餐厅|景区|景区附近|附近|周边|目的地)$/;
function inferDestination(act) {
  const s = String(act || '').replace(/[。．.！!？?]+$/, '').trim();
  if (!s) return '';
  let m = s.match(/在(.{2,20}?)(?:吃|喝|用早|用午|用晚|用餐|办)/);
  let dest = m ? m[1] : '';
  if (!dest) {
    m = s.match(/(?:前往|开往|驶往|到达|抵达|打车去|开车去|乘车去|步行去|骑行去|坐船去|乘船去|坐车去|去|到)(.{2,20}?)(?:[，,、；;]|$)/);
    dest = m ? m[1] : '';
  }
  if (!dest) {
    m = s.match(/(?:游览|参观|逛|打卡)(.{2,20}?)(?:[，,、；;]|$)/);
    dest = m ? m[1] : '';
  }
  if (!dest) return '';
  // 砍掉句尾的动词尾巴（"…吃饭""…入住"）
  dest = dest.replace(/(吃|喝|饭|早餐|午餐|晚餐|晚饭|早饭|夜宵|游玩|游览|观光|打卡|拍照|办理入住|入住|休息|集合|候车|等车|购物|买东西|散步|排队|取票|看日落|看日出|买|点)+$/, '');
  dest = dest.trim();
  if (dest.length < 2 || dest.length > 20) return '';
  if (/附近|周边|旁边|路上|途中/.test(dest)) return '';
  if (DEST_STOP_RE.test(dest)) return '';
  return dest;
}

/**
 * 清洗 LLM 输出的行程项数组
 * @param {Array} rawItems LLM 返回的 items
 * @returns {Array} 清洗后的 items（不含经纬度，地理编码由主流程负责）
 */
function sanitizeItems(rawItems) {
  // ---------- Pass 1：基础字段清洗 ----------
  const items = (rawItems || [])
    .filter((it) => it && String(it.activity || '').trim())
    .map((it) => {
      let di = parseInt(it.dayIndex, 10);
      if (!(di >= 0 && di < MAX_DAY)) di = 0;
      const rawAct = String(it.activity || '');
      const start = String(it.startLocation || '').trim();
      const end = String(it.endLocation || '').trim();

      // ---------- Pass 0：整条"内心独白"抢救 ----------
      // 命中 META_HARD 说明这条 activity 是模型的自我论证，不是行程。
      // 有明确起终点的（多半是交通条目）→ 独白扔掉、动作保留；否则整条丢弃。
      if (META_HARD.some((re) => re.test(rawAct))) {
        if (start && end && !samePlace(start, end)) {
          return {
            dayIndex: di,
            startTime: normTime(it.startTime),
            endTime: normTime(it.endTime),
            activity: `从${start}前往${end}`.slice(0, 200),
            category: 'transport',
            startLocation: start,
            endLocation: end,
            transportType: it.transportType || '',
            note: '',
          };
        }
        return null;
      }

      return {
        dayIndex: di,
        startTime: normTime(it.startTime),
        endTime: normTime(it.endTime),
        activity: stripMeta(rawAct).slice(0, 200),
        category: ['sight', 'food', 'hotel', 'transport', 'ticket', 'other'].includes(it.category)
          ? it.category
          : 'other',
        startLocation: start.slice(0, 60),
        endLocation: end.slice(0, 60),
        transportType: it.transportType || '',
        note: stripMeta(it.note).slice(0, 300),
      };
    })
    .filter(Boolean);

  // ---------- Pass 1.5：无起终点条目的终点回填 ----------
  // 餐饮/游览条目经常两个字段全空 → 卡片连导航按钮都没有。
  // 从 activity 里确定性抽一个目的地当 endLocation；
  // startLocation 留给 Pass 2 按行程连续性继承（人上一站在哪就从哪出发）。
  items.forEach((it) => {
    if (it.startLocation || it.endLocation) return;
    const dest = inferDestination(it.activity);
    if (dest) it.endLocation = dest;
  });

  // ---------- Pass 2：跨天位置继承 ----------
  // 逐天解析时每天是独立请求，"当天第一条移动"常因原文没写出发点而缺失起点。
  // 行程是连续的：人昨晚在哪，今天早上就从哪出发。按天序全局遍历，维护"当前所在位置"。
  // 稳定排序：先按天，再按开始时间升序。LLM 偶尔会把某条排在前面却给了更晚的
  // 时刻（实测约 2 处/8 天），展示出来就是"时间倒退"。这里只理顺顺序，不改内容。
  // 缺时间的条目 (toMin → null) 排在当天最后，不打断正常条目。
  const tOf = (t) => {
    const v = toMin(t);
    return v == null ? Number.MAX_SAFE_INTEGER : v;
  };
  const sorted = items.slice().sort((a, b) =>
    (a.dayIndex - b.dayIndex) ||
    (tOf(a.startTime) - tOf(b.startTime)) ||
    (tOf(a.endTime) - tOf(b.endTime)));
  let lastKnown = ''; // 上一步结束时人所在的位置
  sorted.forEach((it) => {
    if (it.endLocation && !it.startLocation && lastKnown && lastKnown !== it.endLocation) {
      // 只写了目的地、原文没提前往哪 → 从上一步的位置出发
      it.startLocation = lastKnown;
    }
    if (it.endLocation) {
      lastKnown = it.endLocation;
    } else if (it.startLocation) {
      lastKnown = it.startLocation;
    }
    // 两者都空（吃饭/休息等未移动）→ 位置不变
  });

  // ---------- Pass 3：假导航清除 ----------
  // 起点与终点是同一个地方 = 没有发生移动，不允许出现导航信息
  // 注意：只填一头（如"到达重庆北站"没写从哪出发）要保留——前端支持"从我的位置导航到目的地"
  items.forEach((it) => {
    if (samePlace(it.startLocation, it.endLocation)) {
      it.startLocation = '';
      it.endLocation = '';
      it.transportType = '';
    }
  });

  // ---------- Pass 4：缺失 startTime 的智能回填 ----------
  // 按天分组，组内保持 LLM 输出顺序（即原文顺序）
  const byDay = new Map();
  items.forEach((it) => {
    if (!byDay.has(it.dayIndex)) byDay.set(it.dayIndex, []);
    byDay.get(it.dayIndex).push(it);
  });

  byDay.forEach((dayItems) => {
    // 先收集本天所有已知时间，供"天首项无时间"时向后参考
    const known = dayItems.map((it) => toMin(it.startTime));

    let lastMin = null; // 上一条已确定的时间（分钟）
    dayItems.forEach((it, i) => {
      if (it.startTime) {
        lastMin = toMin(it.startTime);
        return;
      }
      // 优先用上一条的 endTime（前一段动作的结束 = 本段开始）
      let fill = null;
      if (lastMin !== null) {
        const prev = dayItems[i - 1];
        const prevEnd = toMin(prev.endTime);
        fill = prevEnd !== null && prevEnd >= lastMin ? prevEnd : Math.min(lastMin + 30, 23 * 60 + 59);
      } else {
        // 本天第一条就没时间：参考后面最近的已知时间，往前推 30 分钟
        for (let j = i; j < known.length; j++) {
          if (known[j] !== null) {
            fill = Math.max(0, known[j] - 30);
            break;
          }
        }
        if (fill === null) fill = 8 * 60; // 全天无时间 → 08:00
      }
      it.startTime = fmtMin(fill);
      lastMin = fill;
    });
  });

  // ---------- Pass 5：结束时间修复（杜绝"零时长/缺结束时间"） ----------
  // LLM 经常把 startTime 原样抄进 endTime（"18:00 → 18:00"），这类条目前端会当成异常数据。
  // 这里按"原文时长线索 → 分类常识耗时 → 下一条开始时间"确定性补齐：
  //   · 原文写了"正常用时2.5小时""步行约40 min" → 直接用
  //   · 没写 → 用分类默认（吃饭 60 / 游览 90 / 交通 60 …）
  //   · 无论如何不得晚于下一条的 startTime（行程是连续的，不能时间重叠）
  // 注意：endTime < startTime 的条目（如 23:30 → 00:30 跨零点）是合法的，不动它。
  byDay.forEach((dayItems) => {
    const starts = dayItems.map((it) => toMin(it.startTime));
    // 找下一条有明确开始时间的位置（用于收敛本条 endTime）
    const nextStartOf = (i) => {
      for (let j = i + 1; j < starts.length; j++) {
        if (starts[j] !== null) return starts[j];
      }
      return null;
    };

    dayItems.forEach((it, i) => {
      const st = toMin(it.startTime);
      if (st === null) return;
      const et = toMin(it.endTime);
      const nextStart = nextStartOf(i);

      // 有结束时间且不等于开始时间 → 只做重叠收敛，原样保留（含跨零点 23:30 → 00:30）
      if (et !== null && et !== st) {
        if (nextStart !== null && nextStart > st && et > nextStart) {
          it.endTime = fmtMin(nextStart);
        }
        return;
      }

      // 缺失 或 等于开始时间（零时长）→ 推算
      const dur = parseDurationMin(`${it.note} ${it.activity}`) || DEFAULT_DUR[it.category] || 30;
      let cand = Math.min(st + dur, MAX_MIN);
      if (nextStart !== null && nextStart > st) cand = Math.min(cand, nextStart);
      if (cand <= st) cand = Math.min(st + 30, MAX_MIN);
      if (nextStart !== null && nextStart > st) cand = Math.min(cand, nextStart);
      if (cand <= st) cand = Math.min(st + 10, MAX_MIN);
      it.endTime = fmtMin(cand);
    });
  });

  return items;
}

module.exports = { normTime, samePlace, sanitizeItems, toMin, fmtMin, parseDurationMin, stripMeta, inferDestination, META_PAT, META_HARD };
