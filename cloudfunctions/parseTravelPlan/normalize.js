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
  const sorted = items.slice().sort((a, b) => a.dayIndex - b.dayIndex); // 稳定排序，同天内保持原顺序
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

  return items;
}

module.exports = { normTime, samePlace, sanitizeItems, toMin, fmtMin };
