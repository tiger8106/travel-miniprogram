// scripts/probe-maxtokens.js
// 探针：验证"不传 max_tokens"时模型能输出多少（会不会还是被默认上限截断）
//   node scripts/probe-maxtokens.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const envPath = path.resolve(__dirname, '..', '.env.local');
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  const l = line.trim();
  if (!l || l.startsWith('#')) return;
  const m = l.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (!m) return;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
});

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = process.env.LLM_MODEL || 'qwen3.8-flash';
const KEY = process.env.LLM_API_KEY;

// 一个"内容天然很长"的任务：12 天行程逐条展开，正常肯定超过 3000 token
const PROMPT = `请把下面 12 天行程逐天展开为详细的行程项 JSON 数组，每天 12 条，每条包含 startTime/endTime/activity/note 四个字段，activity 写具体（含店名、景点具体区域、菜品）。只输出 JSON 数组。
行程：重庆出发，桂林 3 天（象鼻山、日月双塔、龙脊梯田），阳朔 3 天（漓江游船、遇龙河竹筏、十里画廊），崇左 3 天（明仕田园、德天瀑布），南宁 2 天（青秀山、老友粉），最后返回重庆。`;

function call(maxTokens) {
  return new Promise((resolve) => {
    const bodyObj = { model: MODEL, messages: [{ role: 'user', content: PROMPT }], temperature: 0.7 };
    if (maxTokens) bodyObj.max_tokens = maxTokens;
    if (!/qwen3|qwq|r1|reasoner|thinking/i.test(MODEL)) { /* noop */ } else { bodyObj.enable_thinking = false; }
    const body = JSON.stringify(bodyObj);
    const t0 = Date.now();
    const req = https.request({
      hostname: 'dashscope.aliyuncs.com',
      path: '/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: 'Bearer ' + KEY,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const msg = j.choices && j.choices[0];
          resolve({
            label: maxTokens ? 'max_tokens=' + maxTokens : '不传 max_tokens',
            status: res.statusCode,
            finish: msg && msg.finish_reason,
            usage: j.usage,
            chars: msg ? (msg.message.content || '').length : 0,
            ms: Date.now() - t0,
            tail: msg ? (msg.message.content || '').slice(-80) : d.slice(0, 200),
          });
        } catch (e) {
          resolve({ label: maxTokens ? 'max_tokens=' + maxTokens : '不传 max_tokens', status: res.statusCode, err: d.slice(0, 300), ms: Date.now() - t0 });
        }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ label: maxTokens || 'none', err: e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const cap of [null, 3000, 8000]) {
    const r = await call(cap);
    console.log('---');
    console.log(JSON.stringify(r, null, 2));
  }
})();
