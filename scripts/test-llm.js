#!/usr/bin/env node
/**
 * 本地验证 LLM Key 是否有效 —— 不需要部署云函数
 * 用法：node scripts/test-llm.js
 *
 * 读 .env.local 里的配置，直接调用 LLM API
 */
const path = require('path');
const fs = require('fs');

// 读 .env.local
const envPath = path.resolve(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach((line) => {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m) {
    let v = m[2].trim();
    // 去掉引号
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
});

const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
const apiKey = process.env.LLM_API_KEY || '';
const model = process.env.LLM_MODEL || 'auto';
const baseURL = process.env.LLM_BASE_URL || '';

console.log('================================');
console.log('LLM 连接测试');
console.log('================================');
console.log('Provider:', provider || '(未配置)');
console.log('Model:   ', model);
console.log('Base URL:', baseURL || '(自动推断)');
console.log('API Key: ', apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '(未配置)');
console.log('');

if (!provider || !apiKey) {
  console.error('❌ .env.local 里 LLM_PROVIDER 或 LLM_API_KEY 没填');
  process.exit(1);
}

// 加载 llm.js
const { callLLM } = require('../cloudfunctions/parseTravelPlan/llm.js');

// 一段简单测试文本
const testText = `
10月1日：早上 8 点从南宁出发，10 点到桂林，下午去象鼻山。
晚上在崇善米粉吃饭。

10月2日：坐漓江竹筏，从杨堤到兴坪。
下午去兴坪古镇打卡 20 元人民币背景。
`;

// 只测 chat 接口连通性 + 输出是否正常
const testPrompt = '用一句话回复"测试成功"';

const https = require('https');
const http = require('http');

const finalBase = baseURL || ({
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  minimax: 'https://api.minimaxi.com/v1',
  openai: 'https://api.openai.com/v1',
  hunyuan: 'https://api.hunyuan.tencent.com/v1',
}[provider] || 'https://api.openai.com/v1');

console.log(`📡 测试连接到 ${finalBase}/chat/completions ...`);
console.log('');

const body = JSON.stringify({
  model,
  messages: [{ role: 'user', content: testPrompt }],
  max_tokens: 50,
  temperature: 0,
});

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON parse fail: ' + data.slice(0, 200))); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
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
    const resp = await post(`${finalBase}/chat/completions`, body, {
      Authorization: `Bearer ${apiKey}`,
    });
    const ms = Date.now() - t0;
    const text = resp?.choices?.[0]?.message?.content;
    console.log(`✅ 连接成功！（${ms} ms）`);
    console.log('模型返回:', text || '(空)');
    console.log('');
    console.log('现在测一下完整解析能力...');
    const t1 = Date.now();
    const parsed = await callLLM(testText);
    console.log(`✅ 解析成功！（${Date.now() - t1} ms）`);
    console.log(JSON.stringify(parsed, null, 2).slice(0, 1000));
  } catch (e) {
    console.error('❌ 调用失败:', e.message);
    console.error('');
    console.error('常见原因：');
    console.error('1. API Key 无效或已过期');
    console.error('2. 模型名错误（确认 provider 对应的模型名正确）');
    console.error('3. Base URL 不通（试试在浏览器打开看看）');
    console.error('4. 余额不足（部分 LLM 需要先充值）');
    process.exit(1);
  }
})();