// scripts/test-parse.js
// 在本地完整模拟 parseTravelPlan 云函数的逻辑
// 跑通后就知道 Qwen 返回什么 + 哪些字段有问题

const fs = require('fs');
const path = require('path');
const https = require('https');

// ====== 1. 读 docx + mammoth 提取文本 ======
const mammothPath = path.resolve(__dirname, '..', 'cloudfunctions', 'parseTravelPlan', 'node_modules', 'mammoth');
let mammoth;
try {
  mammoth = require(mammothPath);
  console.log('mammoth: OK');
} catch (e) {
  console.log('mammoth 未装，尝试备用路径...');
  try {
    mammoth = require('mammoth');
    console.log('mammoth (备用): OK');
  } catch (e2) {
    console.log('mammoth 完全不可用，将用 zip 提取方式:', e2.message);
  }
}

const docxPath = 'D:/Tige-yyds/个人资料/个人/国庆七天广西旅游攻略.docx';
const zipBuf = fs.readFileSync(docxPath);
console.log('docx size:', zipBuf.length);

// 找 word/document.xml
function findDocumentXml(buf) {
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) === 0x04034b50) {
      const method = buf.readUInt16LE(offset + 8);
      const compSize = buf.readUInt32LE(offset + 18);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      let name = '';
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(buf[offset + 30 + i]);
      if (name === 'word/document.xml') {
        return { method, data: buf.slice(offset + 30 + nameLen + extraLen, offset + 30 + nameLen + extraLen + compSize) };
      }
      offset += 30 + nameLen + extraLen + compSize;
    } else {
      offset++;
    }
  }
  return null;
}

const zlib = require('zlib');
const found = findDocumentXml(zipBuf);
if (!found) {
  console.error('没找到 word/document.xml');
  process.exit(1);
}
console.log('document.xml: method=' + found.method + ', size=' + found.data.length);

const xmlStr = zlib.inflateRawSync(found.data).toString('utf-8');
console.log('xml length:', xmlStr.length);

// 提取所有 <w:t> 文本（mammoth 内部就是这么做的）
const textMatches = xmlStr.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
const allText = textMatches.map(t => t.replace(/<[^>]+>/g, '')).join('');
console.log('extracted text length:', allText.length);
console.log('First 500 chars:');
console.log(allText.slice(0, 500));
console.log('---');
console.log('---');

// ====== 2. 调用 Qwen API ======
const envFile = path.resolve(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envFile, 'utf-8');
envContent.split('\n').forEach(line => {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m && m[2] && !m[2].startsWith('#')) {
    process.env[m[1]] = m[2].trim();
  }
});

const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL || 'qwen-turbo';
console.log('\n--- 调用 Qwen ---');
console.log('Model:', model);
console.log('Key:', apiKey ? apiKey.slice(0, 8) + '...' : '(none)');

// 完整 prompt（跟 llm.js 一致）
const systemPrompt = '你是旅行攻略结构化助手。从用户提供的旅游攻略文档中提取信息。\n\n# 严格输出要求（违反即失败）\n\n- 必须输出一个单一、完整、可被 JSON.parse 解析的 JSON 对象\n- 禁止输出 markdown 代码块\n- 禁止输出任何解释、前缀、后缀、注释、emoji\n- 禁止在 JSON 前后加任何文字（包括 "好的"、"以下是"、"Here is" 之类）\n- 第一字符必须是 {，最后一字符必须是 }\n- 字段缺失就用空字符串 "" 或空数组 []\n- 字段名严格使用英文双引号包裹\n- 字符串值严格使用英文双引号，不能用单引号\n- 不要输出 Markdown 表格、列表、加粗等任何格式\n\n# 内容要求\n\n1. 仔细阅读原文，识别每一天的行程（按日期或第X天）\n2. 每条行程项包括：时间、活动描述、涉及的地点、交通方式、备注\n3. 提取所有抢票/订票/预订闹钟，标注时间（ISO 字符串，YYYY-MM-DDTHH:mm:ss）\n4. 提取旅行建议：天气、装备、必吃、注意事项、交通贴士、预算\n5. 时间统一转 24 小时制 HH:mm\n6. 跨城移动的行程项必须标注 startLocation（起点名称）和 endLocation（终点名称），以及 transportType（car/walk/ride/train/plane）\n7. 标题如 "10月1日｜桂林 → 龙脊梯田" 中的日期和地点需正确解析';

const userPrompt = `以下是一份旅游攻略原文，请解析为 JSON：

===攻略文档===
${allText.slice(0, 8000)}
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

function callQwen(prompt, sysPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });

    const u = new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse fail: ' + data.slice(0, 200))); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const t0 = Date.now();
    const resp = await callQwen(userPrompt, systemPrompt);
    const ms = Date.now() - t0;
    console.log('调用耗时:', ms, 'ms');
    const text = resp.choices?.[0]?.message?.content;
    console.log('返回内容长度:', text?.length);
    console.log('\n=== Qwen 返回的前 2000 字符 ===');
    console.log(text.slice(0, 2000));
    console.log('\n=== 末 500 字符 ===');
    console.log(text.slice(-500));

    // 尝试解析
    let json = text.trim();
    const mdMatch = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
    if (mdMatch) json = mdMatch[1];
    const first = json.indexOf('{');
    const last = json.lastIndexOf('}');
    if (first >= 0 && last > first) json = json.slice(first, last + 1);
    json = json.replace(/,(\s*[}\]])/g, '$1');

    try {
      const parsed = JSON.parse(json);
      console.log('\n=== 解析成功 ===');
      console.log('title:', parsed.title);
      console.log('startDate:', parsed.startDate);
      console.log('endDate:', parsed.endDate);
      console.log('items count:', (parsed.items || []).length);
      console.log('alarms count:', (parsed.alarms || []).length);
      console.log('\n=== 第 1 个 item ===');
      console.log(JSON.stringify(parsed.items?.[0], null, 2));
      console.log('\n=== 所有 alarms ===');
      console.log(JSON.stringify(parsed.alarms, null, 2));
    } catch (e) {
      console.log('\n=== JSON 解析失败 ===');
      console.log('错误:', e.message);
    }
  } catch (e) {
    console.error('Qwen 调用失败:', e.message);
  }
})();