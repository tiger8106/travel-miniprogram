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
  "budget": "预算参考"
}
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

  const now = Date.now();
  const data = {
    _openid: openid,
    tripId,
    weather: parsed.weather || '',
    gear: parsed.gear || '',
    food: parsed.food || '',
    tips: parsed.tips || '',
    transport: parsed.transport || '',
    budget: parsed.budget || '',
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

function callLLMDirect(prompt) {
  return new Promise((resolve, reject) => {
    const { baseURL, model, apiKey } = getLLMConfig();
    if (!apiKey) return reject(new Error('云函数环境变量 LLM_API_KEY 未配置（需要在 suggestions 函数也配置一份）'));

    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是旅行建议助手，根据用户提供的行程生成结构化建议。只输出严格 JSON，禁止 markdown 代码块和任何解释文字。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });
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
    req.setTimeout(40 * 1000, () => req.destroy(new Error('LLM 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
