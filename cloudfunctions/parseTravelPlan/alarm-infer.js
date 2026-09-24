// cloudfunctions/parseTravelPlan/alarm-infer.js
// ============ 攻略没写抢票时间时，由 AI 反推「待办日历」 ============
//
// 现实问题：绝大多数攻略文档只写"9月30日 重庆北→桂林西 G2249"，压根不写
// "9月16日开票去抢票"。解析出来 alarms 为空 → 闹钟页一片空白，用户以为没这功能。
// 所以：当文档抽取到的闹钟太少（< INFER_THRESHOLD）时，用行程本身反推一份
// 「什么时候该去抢票 / 预订 / 准备」的待办清单，补进闹钟页。
//
// 时间仍然由代码按国内各平台真实规则兜底校验，AI 只负责提名事项。

const { chatWithRetry, parseJSONFromText } = require('./llm');
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('./cn-time');

const DAY_MS = 86400000;
const INFER_THRESHOLD = 3;   // 抽取到的闹钟少于这个数就反推

function asArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function shiftDate(dateStr, days) {
  return tsToDateStr(parseCnTime(`${dateStr}T00:00:00`) + days * DAY_MS);
}

/** 把行程压缩成给 LLM 看的逐日摘要（控制 token：每天最多 6 条） */
function dayBrief(items, startDate) {
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = it.dayIndex || 0;
    if (!byDay.has(di)) byDay.set(di, []);
    const arr = byDay.get(di);
    if (arr.length < 6) {
      arr.push(`${it.startTime || ''}${it.endTime ? '-' + it.endTime : ''} ${String(it.activity || '').slice(0, 40)}`);
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

    const prompt = `这份攻略文档里没有写清"什么时候去抢票/预订"，请根据行程内容反推一份待办日历。
今天是 ${today}（北京时间）。

【行程】${c.startDate} ~ ${c.endDate}｜${c.title || '我的行程'}
${brief}

请穷举所有需要提前预订、抢购、预约或准备的事项，输出 JSON 数组：
[{"title":"...","fireAt":"YYYY-MM-DD HH:mm","type":"train/plane/bus/ticket/hotel/other","note":"..."}]

# 覆盖类别
去程/返程火车票(train)、机票(plane)、长途汽车票(bus)、行程内每段城际交通、
每一晚住宿(hotel)、需预约的景区门票与体验项目(ticket)、证件与装备等行前准备(other)。

# 时间推算（按国内各平台可查的实际开放时间）
- 火车票 12306 预售 15 天（含乘车当日）：乘车日减 14 天 = 开票日，取 09:00。
- 机票：提前 30 天起关注，取 10:00。
- 长途汽车票：提前 5 天，取 09:00。
- 酒店：出发前 7 天 20:00 锁定可免费取消房型。
- 景区门票：热门提前 7 天开始盯，取 09:00。
- 行前准备：出发前 2-5 天。

# 要求
1. fireAt 必须是未来时刻，按时间从早到晚排序。
2. note 写明推算依据，并以「具体放票/开放时间以官方 App 或景区公告为准，下单前请核对」结尾。
3. 算不准宁可不输出，不要编造模糊日期。只输出数组。`;

    const text = await chatWithRetry([
      { role: 'system', content: '你是行程待办助手，只输出严格 JSON，禁止 markdown 代码块和解释文字。' },
      { role: 'user', content: prompt },
    ], 2000);
    const list = sanitize(asArray(parseJSONFromText(text)), c.endDate);
    console.log('[parseTravelPlan] AI 反推待办 %d 条', list.length);
    return list;
  } catch (e) {
    console.error('[parseTravelPlan] 待办反推失败（不影响主流程）:', e.message);
    return [];
  }
}

module.exports = { inferAlarms, INFER_THRESHOLD, dayBrief, sanitize };
