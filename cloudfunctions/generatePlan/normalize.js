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
      return {
        dayIndex: di,
        startTime: normTime(it.startTime),
        endTime: normTime(it.endTime),
        activity: String(it.activity).trim().slice(0, 200),
        category: ['sight', 'food', 'hotel', 'transport', 'ticket', 'other'].includes(it.category)
          ? it.category
          : 'other',
        startLocation: String(it.startLocation || '').trim().slice(0, 60),
        endLocation: String(it.endLocation || '').trim().slice(0, 60),
        transportType: it.transportType || '',
        note: String(it.note || '').trim().slice(0, 300),
      };
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

module.exports = { normTime, samePlace, sanitizeItems, toMin, fmtMin, parseDurationMin };
