// cloudfunctions/generatePlan/schedule.js
// 联网检索真实班次（高铁/动车/航班）
//
// 为什么需要它：
//   车次号与时刻是**会实时变动**的公开信息（运行图调图、临客加开、季节调整），
//   模型的预训练知识里存的是"它训练那会儿"的时刻表，早就过期了 —— 这就是
//   "生成的车次和 12306 上对不上"的根因。让模型凭记忆写，再怎么改 prompt 都白搭。
//
//   铁路先走 12306 官方按日期查询；航班等没有统一官方接口的交通，再使用已明确支持
//   联网搜索的模型。程序拿到真实候选班次 → 把候选列表塞进细化阶段的 prompt → 模型只
//   负责"挑哪一班"，不再凭空编时刻。挑完还有确定性校验兜底（见 plan.js）。
//
// 设计原则（通用，不认任何具体地名/线路）：
//   · 只按"出发地 + 目的地 + 日期"去查，判据与具体城市无关；
//   · 查不到 / 超时 / 报错 → 记为"没查到"并清除模型车次，绝不把臆造信息硬塞给用户；
//   · 结果按 from|to|date 缓存短时（同一天反复生成不用重复烧检索，换日期不会串数据）。

const { chat, parseJSONFromText } = require('./llm');
const rail12306 = require('./rail12306');

const SYS = '你是时刻表查询助手。只能根据联网检索到的真实信息作答，绝不凭记忆编造。';

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
// 车次号：G/D/C/Z/T/K 字头 + 数字，或纯数字（普客）；航班是两位字母 + 数字
const CODE_RE = /^(?:[A-Za-z]{1,2})?\d{2,4}$/;

function norm(s) {
  return String(s || '').trim().replace(/\s+/g, '');
}

function segKey(from, to) {
  return `${norm(from)}→${norm(to)}`;
}

/**
 * 车站名称归一化：只去掉行政/枢纽写法差异，不把「北/南/东/西」去掉。
 * 「成都东站」和「成都东」可以视为同一站；「成都东」和「成都南」不能混用。
 */
function stationKey(name) {
  return norm(name)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(?:高铁|动车|火车|铁路)?站$/, '')
    .replace(/市$/, '');
}

function sameStation(a, b) {
  const x = stationKey(a);
  const y = stationKey(b);
  return !!x && !!y && x === y;
}

/**
 * 缓存键必须带日期：同一线路不同日期的开行方案不一样（临客、调图、
 * 不是每天都跑的车次），不带日期会把 A 日期查到的结果套给 B 日期，
 * 用户一对照 12306 就是"车次对不上"。TTL 也因此只有 36 小时。
 */
function cacheKeyOf(seg) {
  return `${segKey(seg.from, seg.to)}@${norm(seg.date) || '无日期'}`;
}

function padTime(t) {
  const m = TIME_RE.exec(String(t || '').trim());
  if (!m) return '';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** 把模型返回的条目洗成可信的样子：时刻不合法 / 车次号不成型的一律丢掉 */
function normalizeList(parsed, segment) {
  const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.list) ? parsed.list : null);
  if (!raw) return [];
  const out = [];
  raw.forEach((it) => {
    if (!it || typeof it !== 'object') return;
    const s = padTime(it.s || it.start || it.startTime);
    const e = padTime(it.e || it.end || it.endTime);
    if (!s || !e) return;                       // 时刻不对 → 这条不能信
    const code = String(it.code || it.c || '').trim().toUpperCase();
    if (!code || !CODE_RE.test(code)) return;   // 车次号不成型 → 宁可不要
    const from = String(it.from || it.f || '').trim();
    const to = String(it.to || it.t || '').trim();
    // 没有两端站名就无法证明这条候选属于当前路线，宁可降级为 AI 参考。
    if (!from || !to || from.length > 20 || to.length > 20) return;
    if (segment && (!sameStation(from, segment.from) || !sameStation(to, segment.to))) return;
    // 高铁/动车的跨日结果没有日期上下文，且 e<=s 时很容易是模型把路线串错；
    // 这里只收同日正向时刻，避免把错误候选写进攻略。
    if (e <= s) return;
    out.push({ code, from, to, s, e });
  });
  // 按出发时间从早到晚
  out.sort((a, b) => a.s.localeCompare(b.s));
  return out.slice(0, 8);
}

function promptOf(seg) {
  return [
    `请联网检索下面这段行程在指定日期的**真实班次**，只允许输出检索结果里出现过的信息。`,
    ``,
    `出发地：${seg.from}`,
    `目的地：${seg.to}`,
    `出行日期：${seg.date || '（未指定，按常态时刻表给）'}`,
    seg.modeHint ? `交通方式：${seg.modeHint}` : '',
    ``,
    `检索与核对步骤（缺一不可）：`,
    `1. 先搜「${seg.from} 到 ${seg.to} ${seg.date || ''} 时刻表」这类带日期的查询；`,
    `2. 优先采用标注了具体日期（${seg.date || '当天'}）的结果；只有常态时刻表时，只保留每天开行的车次，删掉你不确定当天是否开行的；`,
    `3. 每个候选都要核对：车次号、出发时刻、到达时刻必须能在检索结果里找到对应，对不上的直接丢弃。`,
    ``,
    `只输出 JSON，不要任何解释文字：`,
    `{"list":[{"code":"车次号","from":"出发站","to":"到达站","s":"HH:mm","e":"HH:mm"}]}`,
    ``,
    `要求：`,
    `1. 最多 8 条，按出发时间从早到晚排序。`,
    `2. 检索不到确凿结果就返回 {"list":[]} —— **严禁凭印象编造车次号或时刻**，编造比空缺更有害。`,
    `3. 时刻用 24 小时制 HH:mm；车次号保留原始字头。`,
  ].filter(Boolean).join('\n');
}

/** 查一段：返回候选班次数组（查不到就是空数组，绝不抛错） */
async function lookupOne(seg, timeoutMs) {
  const text = await chat(
    [{ role: 'system', content: SYS }, { role: 'user', content: promptOf(seg) }],
    { maxTokens: 1200, timeoutMs: Math.max(6000, Math.min(25000, timeoutMs)), enableSearch: true },
  );
  const list = normalizeList(parseJSONFromText(text), seg);
  console.log('[generatePlan.schedule] 检索 %s→%s 得到 %d 个候选', seg.from, seg.to, list.length);
  return list;
}

/**
 * 只有明确支持 DashScope 联网搜索的端点才允许进入“已检索”链路。
 * 其他兼容 OpenAI 的端点会忽略 enable_search，继续用模型记忆作答，
 * 但旧代码会把这类结果误标成已核对，正是车次全错却看起来像联网的原因。
 */
function canSearch() {
  if (process.env.LLM_ENABLE_SEARCH === '0') return false;
  if (process.env.LLM_SEARCH_CAPABLE === '1') return true;
  const provider = String(process.env.LLM_PROVIDER || '').toLowerCase();
  const base = String(process.env.LLM_BASE_URL || '').toLowerCase();
  return (provider === 'qwen' && (!base || base.indexOf('dashscope') >= 0))
    || base.indexOf('dashscope') >= 0;
}

/**
 * 批量查（并发），整体受 deadline 约束。
 * @param {Array} segments  [{ from, to, date, modeHint }]
 * @param {number} deadlineMs 还剩多少毫秒可以用
 * @param {object} cache 可选 { get(key), set(key, list) }
 * @returns {Map<string, Array>} key = cacheKeyOf({ from, to, date })
 */
function isRailSegment(seg) {
  const mode = `${seg && seg.mode || ''}${seg && seg.code || ''}`.toLowerCase();
  return /train|高铁|动车|火车/.test(mode) && !/plane|航班|飞机/.test(mode);
}

function officialEnabled() {
  return process.env.RAIL12306_ENABLED !== '0';
}

function canLookupSchedules() {
  return officialEnabled() || canSearch();
}

/**
 * 批量查班次：铁路直接读 12306 官方结果，只有航班等非铁路段才走模型联网搜索。
 * 铁路官方查询即使返回空数组也写入 Map，plan.js 会清除模型臆造的车次，不能静默
 * 回退到“看起来像真实”的旧结果。
 */
async function lookupSchedules(segments, deadlineMs, cache) {
  const found = new Map();
  found.routeMeta = new Map();
  const uniq = new Map();
  (segments || []).forEach((s) => {
    if (!s || !norm(s.from) || !norm(s.to)) return;
    const k = cacheKeyOf(s);
    if (!uniq.has(k)) uniq.set(k, s);
  });
  if (!uniq.size) return found;

  const rail = [...uniq.values()].filter(isRailSegment);
  const other = [...uniq.entries()].filter(([, seg]) => !isRailSegment(seg));
  const budget = Math.max(5000, Number(deadlineMs) || 20000);

  if (rail.length && officialEnabled()) {
    try {
      const official = await rail12306.lookupOfficial(rail, budget);
      rail.forEach((seg) => {
        const k = cacheKeyOf(seg);
        found.set(k, official.get(k) || []);
        const meta = official.routeMeta && official.routeMeta.get(k);
        if (meta) found.routeMeta.set(k, meta);
      });
    } catch (e) {
      console.warn('[generatePlan.schedule] 12306 查询整体失败：%s', e.message);
      rail.forEach((seg) => {
        const k = cacheKeyOf(seg);
        found.set(k, []);
        found.routeMeta.set(k, { attempted: true, official: true, reason: e.message });
      });
    }
  }

  if (!other.length) return found;
  if (!canSearch()) {
    console.warn('[generatePlan.schedule] 非铁路段没有确认支持联网搜索的端点，跳过检索');
    return found;
  }

  const getter = cache && typeof cache.get === 'function' ? cache.get : null;
  const setter = cache && typeof cache.set === 'function' ? cache.set : null;
  const todo = [];
  const cacheResults = await Promise.all(other.map(async ([k, seg]) => {
    if (getter) {
      const hit = await getter(k).catch(() => null);
      const cleanHit = normalizeList(hit, seg);
      if (cleanHit.length) {
        found.set(k, cleanHit);
        return null;
      }
    }
    return [k, seg];
  }));
  cacheResults.forEach((x) => { if (x) todo.push(x); });
  if (!todo.length) return found;

  const each = Math.max(9000, Math.min(18000,
    Math.floor((budget - 1500) / Math.max(1, Math.min(todo.length, 2)))));
  await Promise.all(todo.map(async ([k, seg]) => {
    try {
      const list = await lookupOne(seg, each);
      if (list.length) {
        found.set(k, list);
        if (setter) setter(k, list).catch(() => {});
      }
    } catch (e) {
      console.warn('[generatePlan.schedule] %s 检索失败，本次不填未核实班次:', k, e.message);
    }
  }));
  return found;
}

module.exports = {
  lookupSchedules,
  normalizeList,
  segKey,
  cacheKeyOf,
  padTime,
  stationKey,
  sameStation,
  canSearch,
  canLookupSchedules,
  isRailSegment,
};
