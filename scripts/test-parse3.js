// scripts/test-parse3.js —— 改进版：先确定性按天切分，再让 LLM 逐天提取
const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const rawText = fs.readFileSync(path.join(__dirname, 'docx-raw.txt'), 'utf-8');

// 读 .env.local
fs.readFileSync(path.join(root, '.env.local'), 'utf-8').split('\n').forEach((line) => {
  if (line.trim().startsWith('#')) return;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m && m[2]) process.env[m[1]] = m[2].trim();
});
const apiKey = process.env.LLM_API_KEY;
const model = process.argv[2] || 'qwen-turbo';

// ========== 1. 确定性切分 ==========
const DAY_HEADER = /^\s*(\d{1,2})月(\d{1,2})日\s*[｜|]/;

function splitByDay(text) {
  const lines = text.split('\n');
  const days = [];
  const booking = [];
  let cur = null;
  let inBooking = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^3\.\s*预订安排/.test(line)) { inBooking = true; cur = null; continue; }
    if (inBooking) { if (line) booking.push(line); continue; }

    const m = line.match(DAY_HEADER);
    if (m) {
      cur = { month: +m[1], day: +m[2], title: line, lines: [] };
      days.push(cur);
      continue;
    }
    if (cur && line) cur.lines.push(line);
  }
  return { days, booking };
}

// 推断年份：取最早的那个「月日」，找到 >= 今天的最近年份
function inferYear(days) {
  const today = new Date();
  const cands = days.map((d) => new Date(today.getFullYear(), d.month - 1, d.day));
  // 用最早的一天作为锚点
  const anchorMD = days.reduce((a, b) => (a.month * 100 + a.day <= b.month * 100 + b.day ? a : b));
  let y = today.getFullYear();
  const mk = (yy) => new Date(yy, anchorMD.month - 1, anchorMD.day);
  if (mk(y) < new Date(today.getFullYear(), today.getMonth(), today.getDate())) y += 1;
  return y;
}

const { days, booking } = splitByDay(rawText);
const tripYear = inferYear(days);

console.log('=== 切分结果 ===');
console.log('tripYear =', tripYear);
console.log('days =', days.length);
days.forEach((d, i) => {
  console.log(`  [${i}] ${d.month}月${d.day}日 "${d.title.replace(/\s+/g, ' ').slice(0, 40)}" lines=${d.lines.length}`);
});
console.log('booking lines =', booking.length);

// ========== 2. 构造分段文本 ==========
function ymd(y, m, d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${y}-${p(m)}-${p(d)}`;
}

const dayBlocks = days.map((d, i) => {
  const date = ymd(tripYear, d.month, d.day);
  return `【第${i}天｜dayIndex=${i}｜${date}｜${d.title.replace(/^\s*[\d]+月[\d]+日\s*[｜|]\s*/, '')}】\n${d.lines.join('\n')}`;
}).join('\n\n');

const bookingText = booking.join('\n');

const userPrompt = `以下是一份旅游攻略，已按天切分好。请逐天提取行程，并为「预订安排」提取闹钟。

===按天切分的行程===
${dayBlocks}
===行程结束===

===预订安排（用于提取闹钟）===
${bookingText.slice(0, 4000)}
===预订安排结束===

输出要求：
- items 里的 dayIndex 必须严格等于上面【第N天｜dayIndex=N】中的 N，不允许所有条目都是 0
- 每一天都要提取，每个有明确时间或明确动作的句子都是一条 item，不要合并、不要只提取第一天
- 标题里的日期已确定，startDate 必须为 ${ymd(tripYear, days[0].month, days[0].day)}，endDate 必须为 ${ymd(tripYear, days[days.length - 1].month, days[days.length - 1].day)}
- 年份必须是 ${tripYear} 年，禁止使用其他年份

输出 JSON：
{
  "title": "行程总标题",
  "summary": "行程总览 1-2 句",
  "startDate": "${ymd(tripYear, days[0].month, days[0].day)}",
  "endDate": "${ymd(tripYear, days[days.length - 1].month, days[days.length - 1].day)}",
  "items": [
    { "dayIndex": 0, "startTime": "HH:mm", "endTime": "HH:mm", "activity": "行程描述",
      "category": "sight/food/hotel/transport/ticket/other",
      "startLocation": "", "endLocation": "", "transportType": "car/walk/ride/train/plane", "note": "" }
  ],
  "alarms": [
    { "title": "闹钟标题", "fireAt": "${tripYear}-MM-DDTHH:mm:ss", "type": "train/plane/ticket/hotel/bus/other", "note": "" }
  ],
  "suggestions": { "weather": "", "gear": "", "food": "", "tips": "", "transport": "", "budget": "" }
}
`;

const systemPrompt = `你是旅行攻略结构化助手。只输出一个可被 JSON.parse 解析的 JSON 对象。
禁止 markdown 代码块、禁止解释文字、禁止 emoji。第一个字符必须是 {，最后一个必须是 }。
字段缺失用 "" 或 []。字符串一律用英文双引号。
必须覆盖所有天，dayIndex 必须是给定的编号，绝不能全部为 0。`;

console.log('\nuserPrompt len =', userPrompt.length);

const body = JSON.stringify({
  model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ],
  temperature: 0.1,
  max_tokens: 8000,
});

const u = new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
const t0 = Date.now();
const req = https.request({
  hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${apiKey}`,
  },
}, (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => {
    console.log('HTTP', res.statusCode, '| 耗时', Date.now() - t0, 'ms');
    if (res.statusCode !== 200) { console.log(data.slice(0, 800)); return; }
    const resp = JSON.parse(data);
    const text = resp.choices?.[0]?.message?.content || '';
    console.log('finish_reason =', resp.choices?.[0]?.finish_reason, '| usage =', JSON.stringify(resp.usage));
    fs.writeFileSync(path.join(__dirname, 'llm-out3-raw.txt'), text, 'utf-8');

    let json = text.trim();
    const md = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
    if (md) json = md[1];
    const f = json.indexOf('{'), l = json.lastIndexOf('}');
    if (f >= 0 && l > f) json = json.slice(f, l + 1);
    json = json.replace(/,(\s*[}\]])/g, '$1');

    try {
      const p = JSON.parse(json);
      const items = p.items || [];
      console.log('\n===== 解析成功 =====');
      console.log('startDate:', p.startDate, '| endDate:', p.endDate);
      console.log('items 总数:', items.length);
      const byDay = {};
      items.forEach((it) => { const k = it.dayIndex ?? 'undefined'; byDay[k] = (byDay[k] || 0) + 1; });
      console.log('按天分布:', JSON.stringify(byDay));
      console.log('alarms:', (p.alarms || []).length);
      fs.writeFileSync(path.join(__dirname, 'llm-out3.json'), JSON.stringify(p, null, 2), 'utf-8');
    } catch (e) {
      console.log('\nJSON 解析失败:', e.message);
      console.log(text.slice(0, 500));
    }
  });
});
req.on('error', (e) => console.error('err', e.message));
req.write(body);
req.end();
