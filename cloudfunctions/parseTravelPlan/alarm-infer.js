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

function dateOf(ts) {
  return tsToDateStr(Number(ts) || 0);
}

function textOf(item) {
  return `${item && item.activity || ''} ${item && item.note || ''} ${item && item.startLocation || ''} ${item && item.endLocation || ''}`;
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
  const items = asArray(c.items);
  const dayDate = (it) => shiftDate(c.startDate, Number(it && it.dayIndex) || 0);
  const normalized = (s) => String(s || '').replace(/[\s\u3000→（）()：:，,。；;]/g, '').toLowerCase();
  const already = (candidate, text) => {
    const keyText = normalized(text);
    const head = keyText.slice(0, 8);
    return base.concat(out).some((a) => {
      if (a.type !== candidate.type || dateOf(a.fireAt) !== dateOf(candidate.fireAt)) return false;
      const oldText = normalized(a.title);
      return oldText === head || (head.length >= 4 && oldText.indexOf(head.slice(0, 4)) >= 0)
        || (oldText.length >= 4 && keyText.indexOf(oldText.slice(0, 4)) >= 0);
    });
  };
  const add = (a, text) => {
    if (a && !already(a, text)) out.push(a);
  };

  items.forEach((it) => {
    const text = textOf(it);
    if (/已(经)?(购买|预订|预约|订好)|无需(购买|预约|预订)|不需要(购买|预约|预订)/.test(text)) return;
    const date = dayDate(it);
    const activity = String(it.activity || it.endLocation || it.startLocation || '该事项').slice(0, 28);
    const mode = String(it.transportType || '').toLowerCase();
    const rail = /train|高铁|动车|火车/.test(mode + text);
    const plane = /plane|航班|飞机/.test(mode + text);
    const bus = /bus|大巴|直通车|班车/.test(mode + text);
    if (rail || plane || bus) {
      const type = rail ? 'train' : plane ? 'plane' : 'bus';
      const before = rail ? 14 : plane ? 30 : 5;
      const clock = actionClockOf(text, rail ? '09:00' : '10:00');
      const candidate = ruleAlarm(
        `准备${date} ${activity}（${rail ? '车票' : plane ? '机票' : '车票'}）`,
        shiftDate(date, -before),
        clock,
        type,
        `根据详细行程自动补齐，按提前 ${before} 天开始关注放票/购票。具体放票时间以官方 App 为准，下单前请核对。`
      );
      add(candidate, `${activity}${it.startLocation || ''}${it.endLocation || ''}`);
      return;
    }

    const ticketLike = it.category === 'ticket'
      || /门票|预约|船票|游船|竹筏|漂流|演出|缆车|索道|温泉|跟拍/.test(text);
    if (ticketLike) {
      const clock = actionClockOf(text, '09:00');
      const candidate = ruleAlarm(
        `预约${date} ${activity}`,
        shiftDate(date, -7),
        clock,
        'ticket',
        '根据详细行程自动补齐，热门项目通常提前 1-7 天放票或预约。具体开放时间以景区官方公告为准，下单前请核对。'
      );
      add(candidate, activity);
      return;
    }

    if (it.category === 'hotel' || /入住|酒店|民宿|住宿/.test(text)) {
      const candidate = ruleAlarm(
        `预订${date} ${activity}住宿`,
        shiftDate(date, -7),
        '20:00',
        'hotel',
        '根据详细行程自动补齐，优先锁定可免费取消房型。具体房态和价格以下单平台为准。'
      );
      add(candidate, activity);
      return;
    }

    // 详细攻略里如果明确写了证件、药品、装备、租车等行前准备，也单独落一条待办；
    // 不能只靠一条笼统的“核对订单”提醒，否则用户容易漏掉需要提前办理的事项。
    const prepLike = /身份证|护照|签证|通行证|驾照|药品|充电宝|装备|行李|宠物|外币|流量卡|保险|值机|选座|租车|包车|接送机/.test(text);
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

module.exports = { inferAlarms, backfillRuleAlarms, INFER_THRESHOLD, dayBrief, sanitize };
