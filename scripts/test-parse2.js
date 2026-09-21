// scripts/test-parse2.js —— 本地复现 parseTravelPlan 的 LLM 环节
// 输入：scripts/docx-raw.txt（mammoth 等价文本）
// 输出：控制台打印 + scripts/llm-out.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const rawText = fs.readFileSync(path.join(__dirname, 'docx-raw.txt'), 'utf-8');

// 读 .env.local
const envContent = fs.readFileSync(path.join(root, '.env.local'), 'utf-8');
envContent.split('\n').forEach((line) => {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m && m[1] && !m[1].startsWith('#') && !line.trim().startsWith('#')) {
    process.env[m[1]] = m[2].trim();
  }
});

const apiKey = process.env.LLM_API_KEY;
const model = process.argv[2] || process.env.LLM_MODEL || 'qwen-turbo';

// ====== 与 llm.js 完全一致的 prompt ======
const systemPrompt = `你是旅行攻略结构化助手。从用户提供的旅游攻略文档中提取信息。

# 严格输出要求（违反即失败）

- 必须输出一个单一、完整、可被 JSON.parse 解析的 JSON 对象
- 禁止输出 markdown 代码块
- 禁止输出任何解释、前缀、后缀、注释、emoji
- 禁止在 JSON 前后加任何文字（包括 "好的"、"以下是"、"Here is" 之类）
- 第一字符必须是 {，最后一字符必须是 }
- 字段缺失就用空字符串 "" 或空数组 []
- 字段名严格使用英文双引号包裹
- 字符串值严格使用英文双引号，不能用单引号
- 不要输出 Markdown 表格、列表、加粗等任何格式

# 内容要求

1. 仔细阅读原文，识别每一天的行程（按日期或第X天）
2. 每条行程项包括：时间、活动描述、涉及的地点、交通方式、备注
3. 提取所有抢票/订票/预订闹钟，标注时间（ISO 字符串，YYYY-MM-DDTHH:mm:ss）
4. 提取旅行建议：天气、装备、必吃、注意事项、交通贴士、预算
5. 时间统一转 24 小时制 HH:mm
6. 跨城移动的行程项必须标注 startLocation（起点名称）和 endLocation（终点名称），以及 transportType（car/walk/ride/train/plane）
7. 标题如 "10月1日｜桂林 → 龙脊梯田" 中的日期和地点需正确解析
`;

const userPrompt = `以下是一份旅游攻略原文，请解析为 JSON：

===攻略文档===
${rawText.slice(0, 8000)}
===结束===

请输出 JSON，字段如下：
{
  "title": "行程总标题",
  "summary": "行程总览 1-2 句",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "items": [
    {
      "dayIndex": 0,
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "activity": "行程描述",
      "category": "sight/food/hotel/transport/ticket/other",
      "startLocation": "起点名称(可空)",
      "endLocation": "终点名称(可空)",
      "transportType": "car/walk/ride/train/plane(可空)",
      "note": "备注(可空)"
    }
  ],
  "alarms": [
    {
      "title": "闹钟标题",
      "fireAt": "YYYY-MM-DDTHH:mm:ss",
      "type": "train/plane/ticket/hotel/bus/other",
      "note": "备注(可空)"
    }
  ],
  "suggestions": {
    "weather": "天气与穿着建议",
    "gear": "装备清单",
    "food": "必吃推荐",
    "tips": "注意事项",
    "transport": "交通贴士",
    "budget": "预算参考"
  }
}

如果某字段为空，给空字符串或空数组。不要编造数据，没有的字段留空。`;

const body = JSON.stringify({
  model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ],
  temperature: 0.1,
  max_tokens: 4000,
});

console.log('model =', model);
console.log('rawText len =', rawText.length, '| userPrompt len =', userPrompt.length);

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
    if (res.statusCode !== 200) {
      console.log('BODY:', data.slice(0, 800));
      return;
    }
    const resp = JSON.parse(data);
    const text = resp.choices?.[0]?.message?.content || '';
    const fr = resp.choices?.[0]?.finish_reason;
    console.log('finish_reason =', fr);
    console.log('usage =', JSON.stringify(resp.usage));
    console.log('content length =', text.length);
    fs.writeFileSync(path.join(__dirname, 'llm-out-raw.txt'), text, 'utf-8');

    // 复用 llm.js 的解析逻辑
    let json = text.trim();
    const md = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
    if (md) json = md[1];
    const f = json.indexOf('{');
    const l = json.lastIndexOf('}');
    if (f >= 0 && l > f) json = json.slice(f, l + 1);
    json = json.replace(/,(\s*[}\]])/g, '$1');

    try {
      const p = JSON.parse(json);
      console.log('\n===== 解析成功 =====');
      console.log('title      :', p.title);
      console.log('startDate  :', p.startDate, '| endDate:', p.endDate);
      console.log('items 数量 :', (p.items || []).length);
      console.log('alarms 数量:', (p.alarms || []).length);
      console.log('suggestions keys:', Object.keys(p.suggestions || {}));
      console.log('\nitems[0] =', JSON.stringify((p.items || [])[0], null, 2));
      console.log('items[last] =', JSON.stringify((p.items || []).slice(-1)[0], null, 2));
      fs.writeFileSync(path.join(__dirname, 'llm-out.json'), JSON.stringify(p, null, 2), 'utf-8');
    } catch (e) {
      console.log('\n===== JSON 解析失败 =====', e.message);
      console.log('前 600 字:', text.slice(0, 600));
      console.log('后 300 字:', text.slice(-300));
    }
  });
});
req.on('error', (e) => console.error('req error:', e.message));
req.write(body);
req.end();
