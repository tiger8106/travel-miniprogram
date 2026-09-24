// cloudfunctions/suggestions/index.js
// 旅行建议：get / refresh（重新生成）
//
// ⚠️ 云函数部署时每个函数只打包自己文件夹里的文件，
//    之前 require('../parseTravelPlan/llm') 在云端根本找不到文件，导致整个函数崩溃。
//    现在自带完整的 LLM 调用逻辑，不依赖其他函数的代码。
//
// 环境变量（需要在本函数配置，和 parseTravelPlan 相同）：
//   LLM_PROVIDER / LLM_API_KEY / LLM_MODEL / LLM_BASE_URL(可选)

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const https = require('https');
const http = require('http');

const COL_SUG = 'suggestions';
const COL_TRIP = 'trips';

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const userOpenid = wxContext.OPENID;
  if (!userOpenid) return { code: -1, msg: '未登录' };

  const { action } = event || {};
  const db = cloud.database();

  try {
    switch (action) {
      case 'get':
        return await get(db, userOpenid, event.tripId);
      case 'refresh':
        return await refresh(db, userOpenid, event.tripId);
      case 'dayTips':
        return await dayTips(db, userOpenid, event.tripId, event.dayIndex, event.force);
      default:
        return { code: -1, msg: '未知 action: ' + action };
    }
  } catch (err) {
    console.error('[suggestions]', action, err);
    return { code: -1, msg: err.message || '操作失败' };
  }
};

async function get(db, openid, tripId) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const _ = db.command;
  // 排除按天的建议（kind='day'），只取总览建议
  const res = await db.collection(COL_SUG)
    .where({ _openid: openid, tripId, kind: _.neq('day') })
    .orderBy('generatedAt', 'desc')
    .limit(1)
    .get();
  return { code: 0, data: res.data[0] || null };
}

async function refresh(db, openid, tripId) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const tripRes = await db.collection(COL_TRIP).doc(tripId).get();
  const trip = tripRes.data;
  if (!trip || trip._openid !== openid) {
    return { code: -1, msg: '行程不存在' };
  }

  // 重建 prompt：行程摘要
  const itemsSummary = (trip.items || []).map((it) =>
    `[${it.startTime || ''}-${it.endTime || ''}] ${it.activity}${it.startLocation ? ' 起点:' + it.startLocation : ''}${it.endLocation ? ' 终点:' + it.endLocation : ''}`
  ).join('\n');

  const promptText = `行程标题：${trip.title}
日期：${trip.startDate} → ${trip.endDate}
行程项：
${itemsSummary.slice(0, 4000)}

请基于以上行程重新生成旅行建议，按 JSON 格式输出以下字段：
{
  "weather": "天气与穿着建议（结合目的地和时间）",
  "gear": "装备清单",
  "food": "必吃推荐",
  "tips": "注意事项（包含人流/天气/安全/文化）",
  "transport": "交通贴士",
  "budget": "预算参考，纯文本，每行一条「项目：金额元」，如「住宿：2500元」"
}
硬性要求：所有字段的值必须使用简体中文（包括预算里的项目名和总金额），禁止出现英文；budget 必须是纯文本字符串，不要输出嵌套对象或数组。
只输出 JSON，不要 markdown 代码块。`;

  const resp = await callLLMDirect(promptText);
  let json = resp.trim();
  const m = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (m) json = m[1];
  const first = json.indexOf('{');
  const last = json.lastIndexOf('}');
  if (first >= 0 && last > first) json = json.slice(first, last + 1);
  json = json.replace(/,(\s*[}\]])/g, '$1');

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.error('[suggestions] LLM 输出解析失败:', resp.slice(0, 300));
    return { code: -1, msg: 'LLM 输出解析失败' };
  }

  // LLM 偶尔把字段输出成对象/数组而非字符串（尤其 budget），
  // 入库前统一拍平成可读文本，否则前端会渲染成 [object Object]
  // 常见英文键名 → 中文（LLM 不听话输出英文键时兜底翻译）
  const KEY_ZH = {
    accommodation: '住宿', hotel: '住宿', lodging: '住宿',
    food: '餐饮', dining: '餐饮', meals: '餐饮', restaurant: '餐饮',
    transport: '交通', transportation: '交通', traffic: '交通',
    activities: '门票活动', activity: '门票活动', attractions: '门票活动',
    tickets: '门票', entertainment: '娱乐',
    shopping: '购物', total: '总计', sum: '总计', overall: '总计',
    misc: '其他', other: '其他', others: '其他', insurance: '保险',
    flight: '机票', flights: '机票', train: '火车', railway: '火车',
    daily: '每日', 'per day': '每日', budget: '预算', note: '说明', notes: '说明',
  };
  const keyZh = (k) => KEY_ZH[String(k).toLowerCase().trim()] || k;
  const flatten = (v, depth) => {
    depth = depth || 0;
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (depth > 3) return '';
    if (Array.isArray(v)) return v.map((x) => flatten(x, depth + 1)).filter(Boolean).join('\n');
    return Object.keys(v)
      .map((k) => {
        const raw = v[k];
        const val = flatten(raw, depth + 1);
        if (!val) return '';
        // 数值型金额补「元」
        const shown = typeof raw === 'number' ? `${raw} 元` : val;
        const lines = shown.split('\n');
        return lines.length === 1 ? `${keyZh(k)}：${lines[0]}` : `${keyZh(k)}：\n${lines.map((l) => (l ? '  ' + l : l)).join('\n')}`;
      })
      .filter(Boolean)
      .join('\n');
  };

  const now = Date.now();
  // LLM 直接输出纯文本时行首也可能是英文键，兜底翻译
  const zhify = (s) => String(s).split('\n').map((line) => {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]{1,24})\s*[:：]\s*/);
    if (m && KEY_ZH[m[1].toLowerCase().trim()]) return line.replace(m[0], `${KEY_ZH[m[1].toLowerCase().trim()]}：`);
    return line;
  }).join('\n');
  const data = {
    _openid: openid,
    tripId,
    weather: zhify(flatten(parsed.weather)),
    gear: zhify(flatten(parsed.gear)),
    food: zhify(flatten(parsed.food)),
    tips: zhify(flatten(parsed.tips)),
    transport: zhify(flatten(parsed.transport)),
    budget: zhify(flatten(parsed.budget)),
    generatedAt: now,
  };

  await db.collection(COL_SUG).add({ data });
  return { code: 0, data };
}

// ============================================================
// 按天建议：行程详情页底部展示的当天建议与注意事项
// 首次调用生成并缓存，之后直接读缓存；force=true 强制重新生成
// ============================================================
async function dayTips(db, openid, tripId, dayIndex, force) {
  if (!tripId) return { code: -1, msg: '缺少 tripId' };
  const dayIdx = Number(dayIndex);
  if (isNaN(dayIdx) || dayIdx < 0) return { code: -1, msg: 'dayIndex 不合法' };

  const tripRes = await db.collection(COL_TRIP).doc(tripId).get();
  const trip = tripRes.data;
  if (!trip || trip._openid !== openid) {
    return { code: -1, msg: '行程不存在' };
  }

  const where = { _openid: openid, tripId, kind: 'day', dayIndex: dayIdx };
  if (!force) {
    const cached = await db.collection(COL_SUG).where(where).limit(1).get();
    if (cached.data[0]) return { code: 0, data: cached.data[0] };
  }

  // 当天行程摘要
  const dayItems = (trip.items || []).filter((it) => (it.dayIndex || 0) === dayIdx);
  if (!dayItems.length) return { code: 0, data: { tips: [], notices: [] } };

  const dayDate = addDays(trip.startDate, dayIdx);
  const itemsSummary = dayItems.map((it) =>
    `[${it.startTime || '--'}] ${it.activity}${it.startLocation ? '，' + it.startLocation : ''}${it.endLocation ? ' → ' + it.endLocation : ''}${it.note ? '（' + it.note + '）' : ''}`
  ).join('\n');

  const promptText = `这是旅行第 ${dayIdx + 1} 天（${dayDate}）的行程：
${itemsSummary.slice(0, 3500)}

请针对这一天的具体安排，输出当天建议与注意事项，JSON 格式：
{
  "tips": ["建议1", "建议2", "建议3"],
  "notices": ["注意事项1", "注意事项2"]
}
要求：
- tips 2~4 条：结合当天具体行程给实操建议（如赶车余量、午餐安排、体力分配、拍照时机）
- notices 2~4 条：当天的风险提醒（如班次时间、天气、人流、证件/票据）
- 每条不超过 40 字，直说重点，不要空话
只输出 JSON，不要 markdown 代码块。`;

  const resp = await callLLMDirect(promptText);
  const parsed = parseJsonLoose(resp);
  if (!parsed) {
    console.error('[suggestions] dayTips LLM 输出解析失败:', resp.slice(0, 300));
    return { code: -1, msg: '当天建议生成失败，请重试' };
  }

  const data = {
    _openid: openid,
    tripId,
    kind: 'day',
    dayIndex: dayIdx,
    tips: (Array.isArray(parsed.tips) ? parsed.tips : []).map((s) => String(s).slice(0, 60)).slice(0, 6),
    notices: (Array.isArray(parsed.notices) ? parsed.notices : []).map((s) => String(s).slice(0, 60)).slice(0, 6),
    generatedAt: Date.now(),
  };

  // 替换旧缓存（remove + add）
  await db.collection(COL_SUG).where(where).remove().catch(() => {});
  await db.collection(COL_SUG).add({ data });
  return { code: 0, data };
}

// "2026-09-30" + n 天 → "2026-10-01"（本地时区，避免 UTC 偏移）
function addDays(dateStr, n) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3] + (n || 0));
  const pad = (x) => (x < 10 ? '0' + x : '' + x);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 宽松 JSON 解析：容忍 markdown 包裹、前后缀、尾逗号
function parseJsonLoose(text) {
  if (!text) return null;
  let json = String(text).trim();
  const m = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (m) json = m[1];
  const first = json.indexOf('{');
  const last = json.lastIndexOf('}');
  if (first >= 0 && last > first) json = json.slice(first, last + 1);
  json = json.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(json);
  } catch (e) {
    // 截断抢救：模型偶尔写到一半（撞 max_tokens 或输出被截断），
    // 直接判失败用户就得点"重新生成"，其实前面大部分内容是可用的。
    const cut = json.lastIndexOf('}');
    if (cut > 0) {
      const salvaged = json.slice(0, cut + 1)
        .replace(/,\s*"[^"]*"\s*:\s*[^,}]*$/, '');  // 丢掉写到一半的键值对
      try {
        const o = JSON.parse(salvaged);
        console.warn('[suggestions] JSON 被截断，已抢救出部分结果');
        return o;
      } catch (e2) { /* 抢救失败，返回 null */ }
    }
    return null;
  }
}

// ============ LLM 调用（自带，不跨函数引用） ============

function getLLMConfig() {
  const provider = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  const baseURL = process.env.LLM_BASE_URL ||
    ({
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      deepseek: 'https://api.deepseek.com/v1',
      hunyuan: 'https://api.hunyuan.tencent.com/v1',
      minimax: 'https://api.minimaxi.com/v1',
    })[provider] || 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL ||
    ({
      qwen: 'qwen-turbo',
      deepseek: 'deepseek-chat',
      hunyuan: 'hunyuan-pro',
      minimax: 'MiniMax-M3',
    })[provider] || 'gpt-4o-mini';
  return { baseURL, model, apiKey: process.env.LLM_API_KEY || '' };
}

// 推理型模型（会先输出一大段思考链）单次请求可达 100s+，
// 云函数 60s 上限必然超时 —— 这类模型必须显式关掉思考
const REASONING_MODEL = /qwen3|qwq|deepseek-r1|reasoner|o1|o3|m1|thinking/i;

function callLLMDirect(prompt) {
  return new Promise((resolve, reject) => {
    const { baseURL, model, apiKey } = getLLMConfig();
    if (!apiKey) return reject(new Error('云函数环境变量 LLM_API_KEY 未配置（需要在 suggestions 函数也配置一份）'));
    // 没配 provider / baseURL 时会默认打到 api.openai.com，
    // 国内云函数连不上，会一直卡到超时 —— 直接拒绝并给明确提示
    if (!process.env.LLM_BASE_URL && !process.env.LLM_PROVIDER) {
      return reject(new Error('未配置 LLM_PROVIDER（或 LLM_BASE_URL），当前默认打到 api.openai.com，云函数连不上会一直卡到超时。请在 suggestions 环境变量里加 LLM_PROVIDER=qwen'));
    }

    const bodyObj = {
      model,
      messages: [
        { role: 'system', content: '你是旅行建议助手，根据用户提供的行程生成结构化建议。只输出严格 JSON，禁止 markdown 代码块和任何解释文字。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    };
    if (REASONING_MODEL.test(model) && process.env.LLM_ENABLE_THINKING !== '1') {
      bodyObj.enable_thinking = false;
    }
    const body = JSON.stringify(bodyObj);
    const started = Date.now();
    console.log('[suggestions] LLM 请求开始', { baseURL, model, thinking: !!bodyObj.enable_thinking, promptChars: prompt.length });
    const u = new URL(`${baseURL}/chat/completions`);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        console.log('[suggestions] LLM 返回', res.statusCode, Date.now() - started, 'ms');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const obj = JSON.parse(data);
            const content = obj.choices && obj.choices[0] && obj.choices[0].message.content;
            if (!content) return reject(new Error('LLM 未返回内容'));
            resolve(content);
          } catch (e) {
            reject(new Error('LLM 响应解析失败'));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    // 云函数上限 60s，这里留 50s：超时信息带上 model/baseURL，一眼看出连的是谁
    req.setTimeout(50 * 1000, () => req.destroy(
      new Error(`LLM 请求超时（50s）：model=${model} baseURL=${baseURL}。若模型是推理型（qwen3.5-plus 等），请换成 qwen3.8-flash`)
    ));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
