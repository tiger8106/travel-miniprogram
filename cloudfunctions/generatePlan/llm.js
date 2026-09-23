// cloudfunctions/generatePlan/llm.js
// LLM 调用封装（自带，不跨函数引用 —— 云端每个函数只打包自己文件夹里的文件）
//
// 复用 parseTravelPlan 验证过的三条经验：
//   1. 推理型模型必须 enable_thinking:false（qwen3.5-plus 开思考 106s → 关 2.9s）
//   2. 没配 provider/baseURL 时别静默打到 api.openai.com（云函数连不上会卡到超时）
//   3. 单次请求超时 < 云函数上限 60s

const https = require('https');
const http = require('http');

const REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '', 10) || 45 * 1000;

function getBaseURL() {
  if (process.env.LLM_BASE_URL) return process.env.LLM_BASE_URL;
  switch ((process.env.LLM_PROVIDER || 'auto').toLowerCase()) {
    case 'deepseek': return 'https://api.deepseek.com/v1';
    case 'qwen': return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'hunyuan': return 'https://api.hunyuan.tencent.com/v1';
    case 'minimax': return 'https://api.minimaxi.com/v1';
    default: return null; // 没配 → 让 caller 报错，别偷偷打 OpenAI
  }
}

function getModel() {
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  switch ((process.env.LLM_PROVIDER || 'auto').toLowerCase()) {
    case 'deepseek': return 'deepseek-chat';
    case 'qwen': return 'qwen-turbo';
    case 'hunyuan': return 'hunyuan-pro';
    case 'minimax': return 'MiniMax-M3';
    default: return null;
  }
}

const REASONING_MODEL = /qwen3|qwq|deepseek-r1|reasoner|o1|o3|m1|thinking/i;

function getConfig() {
  const apiKey = process.env.LLM_API_KEY || '';
  const baseURL = getBaseURL();
  const model = getModel();
  if (!apiKey) throw new Error('云函数环境变量 LLM_API_KEY 未配置（需要在 generatePlan 函数配置一份）');
  if (!baseURL || !model) {
    throw new Error('未配置 LLM_PROVIDER（或 LLM_BASE_URL + LLM_MODEL），拒绝走默认 OpenAI 端点（云函数连不上会卡到超时）');
  }
  return { apiKey, baseURL, model };
}

/**
 * 原始 chat 调用
 * @param {Array} messages
 * @param {number} maxTokens
 * @returns {Promise<string>} content
 */
function chat(messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const { apiKey, baseURL, model } = getConfig();
    const bodyObj = {
      model,
      messages,
      temperature: 0.7, // 生成任务比抽取任务需要更多创意（抽取用 0.1）
      max_tokens: maxTokens || 4000,
    };
    if (REASONING_MODEL.test(model) && process.env.LLM_ENABLE_THINKING !== '1') {
      bodyObj.enable_thinking = false;
    }
    const body = JSON.stringify(bodyObj);
    const u = new URL(`${baseURL}/chat/completions`);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const started = Date.now();

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        console.log('[generatePlan.llm]', res.statusCode, Date.now() - started, 'ms');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const resp = JSON.parse(data);
            const text = resp?.choices?.[0]?.message?.content;
            if (!text) return reject(new Error('LLM 未返回内容'));
            resolve(text);
          } catch (e) {
            reject(new Error('响应 JSON 解析失败: ' + data.slice(0, 200)));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`单次 LLM 请求超时(${REQUEST_TIMEOUT_MS / 1000}s)：model=${model} baseURL=${baseURL}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 带一次重试 */
async function chatWithRetry(messages, maxTokens) {
  try {
    return await chat(messages, maxTokens);
  } catch (e) {
    console.error('[generatePlan.llm] 调用失败，重试一次:', e.message);
    return chat(messages, maxTokens);
  }
}

/**
 * 从 LLM 文本里抠出 JSON（容忍 markdown 包裹 / 前后缀 / 尾逗号 / 被 max_tokens 截断）
 *
 * ⚠️ 为什么要有"抢救"逻辑：生成型任务输出量大，很容易把 JSON 写到一半就撞上 max_tokens，
 *    直接 JSON.parse 会整体失败，8 天的活全白干。这里退而求其次：砍掉最后一个不完整的元素，
 *    把前面完整的部分救回来（丢一天总比全丢好）。
 */
function parseJSONFromText(text) {
  let json = (text || '').trim();
  const md = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (md) json = md[1];

  const arrFirst = json.indexOf('[');
  const objFirst = json.indexOf('{');
  let start, end, isArr;
  if (arrFirst >= 0 && (objFirst < 0 || arrFirst < objFirst)) {
    start = arrFirst; isArr = true;
    end = json.lastIndexOf(']');
  } else {
    start = objFirst; isArr = false;
    end = json.lastIndexOf('}');
  }
  if (start < 0) throw new Error('文本中没有 JSON 结构');

  const closeChar = isArr ? ']' : '}';
  let body = end > start ? json.slice(start, end + 1) : json.slice(start);
  json = body.replace(/,(\s*[}\]])/g, '$1'); // 去尾逗号

  try {
    return JSON.parse(json);
  } catch (e) {
    // 截断抢救：截到最后一个完整的 "}"（对象数组）或 "],"/"}"（对象）处
    const lastObjEnd = json.lastIndexOf('}');
    if (lastObjEnd > 0) {
      let salvaged = json.slice(0, lastObjEnd + 1).replace(/,\s*$/, '');
      if (!isArr) salvaged = salvaged.replace(/,\s*"[^"]*"\s*:\s*[^,}]*$/, ''); // 对象：丢掉半个键值对
      salvaged += closeChar;
      try {
        const parsed = JSON.parse(salvaged);
        console.warn('[generatePlan.llm] JSON 被截断，已抢救出部分结果:', salvaged.length, 'chars');
        return parsed;
      } catch (e2) { /* 抢救失败，落到下面抛错 */ }
    }
    throw new Error('JSON 解析失败: ' + e.message + ' | 前 200 字: ' + json.slice(0, 200));
  }
}

/** LLM 输出可能是数组，也可能是被对象裹着的数组 */
function asArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

const SYS_PROMPT =
  '你是资深旅行规划师兼本地通。只输出 JSON，禁止 markdown 代码块、禁止解释文字、禁止 emoji。' +
  '字符串一律用英文双引号，缺失字段用空字符串。所有文本内容用简体中文。';

module.exports = { chat, chatWithRetry, parseJSONFromText, asArray, SYS_PROMPT, getConfig };
