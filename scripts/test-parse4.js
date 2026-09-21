// scripts/test-parse4.js —— 并行逐天调用方案（解决 60s 云函数超时）
const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const rawText = fs.readFileSync(path.join(__dirname, 'docx-raw.txt'), 'utf-8');

fs.readFileSync(path.join(root, '.env.local'), 'utf-8').split('\n').forEach((line) => {
  if (line.trim().startsWith('#')) return;
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m && m[2]) process.env[m[1]] = m[2].trim();
});
const apiKey = process.env.LLM_API_KEY;
const model = process.argv[2] || 'qwen-turbo';

// ===== 切分（与 test-parse3 相同）=====
const DAY_HEADER = /^\s*(\d{1,2})月(\d{1,2})日\s*[｜|]/;
function splitByDay(text) {
  const lines = text.split('\n');
  const days = [], booking = [];
  let cur = null, inBooking = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^3\.\s*预订安排/.test(line)) { inBooking = true; cur = null; continue; }
    if (inBooking) { if (line) booking.push(line); continue; }
    const m = line.match(DAY_HEADER);
    if (m) { cur = { month: +m[1], day: +m[2], title: line, lines: [] }; days.push(cur); continue; }
    if (cur && line) cur.lines.push(line);
  }
  return { days, booking };
}
function inferYear(days) {
  const today = new Date();
  const anchorMD = days.reduce((a, b) => (a.month * 100 + a.day <= b.month * 100 + b.day ? a : b));
  let y = today.getFullYear();
  const mk = (yy) => new Date(yy, anchorMD.month - 1, anchorMD.day);
  if (mk(y) < new Date(today.getFullYear(), today.getMonth(), today.getDate())) y += 1;
  return y;
}
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const { days, booking } = splitByDay(rawText);
const tripYear = inferYear(days);
console.log(`切分: ${days.length} 天, year=${tripYear}, booking=${booking.length} 行`);

// ===== HTTP 调用 =====
function chat(messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens });
    const u = new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${apiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content || ''); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(45000, () => { req.destroy(new Error('单次调用超时 45s')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function parseJSON(text) {
  let json = text.trim();
  const md = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (md) json = md[1];
  const f = json.indexOf('['), fe = json.indexOf('{');
  let start, end;
  if (f >= 0 && (fe < 0 || f < fe)) { start = f; end = json.lastIndexOf(']'); }
  else { start = fe; end = json.lastIndexOf('}'); }
  if (start >= 0 && end > start) json = json.slice(start, end + 1);
  json = json.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json);
}

const SYS = '你是旅行攻略结构化助手。只输出 JSON，禁止 markdown 代码块、禁止解释、禁止 emoji。字符串一律用英文双引号。';

// ===== 并行任务 =====
const tasks = [];

days.forEach((d, i) => {
  const date = ymd(tripYear, d.month, d.day);
  const body = `【${date}｜${d.title}】\n${d.lines.join('\n')}\n\n提取这一天所有行程项为 JSON 数组，dayIndex 全部为 ${i}。每条: {"dayIndex":${i},"startTime":"HH:mm","endTime":"HH:mm","activity":"...","category":"sight/food/hotel/transport/ticket/other","startLocation":"","endLocation":"","transportType":"car/walk/ride/train/plane","note":""}。只输出数组。`;
  tasks.push(
    chat([{ role: 'system', content: SYS }, { role: 'user', content: body }], 3000)
      .then((t) => ({ type: 'day', i, items: parseJSON(t) }))
      .catch((e) => ({ type: 'day', i, error: e.message }))
  );
});

// 闹钟
tasks.push(
  chat([{ role: 'system', content: SYS }, { role: 'user', content: `以下是一份旅行预订安排，提取所有需要提醒的抢票/预订事项为 JSON 数组。年份为 ${tripYear}。每条: {"title":"...","fireAt":"${tripYear}-MM-DDTHH:mm:ss","type":"train/plane/ticket/hotel/bus/other","note":""}。只输出数组。\n\n${booking.join('\n').slice(0, 4000)}` }], 2000)
    .then((t) => ({ type: 'alarms', alarms: parseJSON(t) }))
    .catch((e) => ({ type: 'alarms', error: e.message }))
);

// 建议
tasks.push(
  chat([{ role: 'system', content: SYS }, { role: 'user', content: `以下是一份旅游攻略，提取旅行建议为 JSON 对象：{"weather":"","gear":"","food":"","tips":"","transport":"","budget":""}。只输出对象。\n\n${rawText.slice(0, 3000)}` }], 800)
    .then((t) => ({ type: 'suggestions', suggestions: parseJSON(t) }))
    .catch((e) => ({ type: 'suggestions', error: e.message }))
);

(async () => {
  const t0 = Date.now();
  const results = await Promise.all(tasks);
  const total = Date.now() - t0;
  console.log(`\n总耗时: ${total} ms (${(total / 1000).toFixed(1)}s) —— 云函数上限 60s`);

  const items = [];
  let alarms = [], suggestions = null;
  for (const r of results) {
    if (r.error) { console.log(`  [${r.type}${r.i ?? ''}] 失败: ${r.error}`); continue; }
    if (r.type === 'day') {
      const arr = Array.isArray(r.items) ? r.items : [];
      arr.forEach((it) => (it.dayIndex = r.i)); // 强制纠正
      items.push(...arr);
      console.log(`  [day ${r.i}] ${arr.length} 条`);
    } else if (r.type === 'alarms') {
      alarms = Array.isArray(r.alarms) ? r.alarms : [];
      console.log(`  [alarms] ${alarms.length} 条`);
    } else if (r.type === 'suggestions') {
      suggestions = r.suggestions;
      console.log(`  [suggestions] keys=${Object.keys(r.suggestions || {}).length}`);
    }
  }

  const byDay = {};
  items.forEach((it) => { byDay[it.dayIndex] = (byDay[it.dayIndex] || 0) + 1; });
  console.log('\nitems 总数:', items.length, '| 按天分布:', JSON.stringify(byDay));
  console.log('alarms:', alarms.length);

  fs.writeFileSync(path.join(__dirname, 'llm-out4.json'), JSON.stringify({
    title: rawText.split('\n')[0].trim(),
    summary: '',
    startDate: ymd(tripYear, days[0].month, days[0].day),
    endDate: ymd(tripYear, days[days.length - 1].month, days[days.length - 1].day),
    items, alarms, suggestions,
  }, null, 2), 'utf-8');
  console.log('saved -> llm-out4.json');
})();
