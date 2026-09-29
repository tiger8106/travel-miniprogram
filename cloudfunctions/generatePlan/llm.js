// cloudfunctions/generatePlan/llm.js
// LLM 调用封装（自带，不跨函数引用 —— 云端每个函数只打包自己文件夹里的文件）
//
// 复用 parseTravelPlan 验证过的三条经验：
//   1. 推理型模型必须 enable_thinking:false（qwen3.5-plus 开思考 106s → 关 2.9s）
//   2. 没配 provider/baseURL 时别静默打到 api.openai.com（云函数连不上会卡到超时）
//   3. 单次请求超时 < 云函数上限 60s
//
// ⚠️ 2026-09-25 改：不再给输出设 max_tokens 上限（详见 chat() 里的说明）。
//    输出长度由"任务本身需要写多少"决定，安全网只保留"时间"这一道。

const https = require('https');
const http = require('http');

const REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '', 10) || 45 * 1000;

// 输出 token 上限：默认 0 = 不限制（让模型写到自然结束）。
// 只有确实想封顶（比如控成本 / 模型会跑飞）时才设 LLM_MAX_TOKENS=8192 之类。
const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '', 10) || 0;

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
 * 参数归一化：兼容老的「(messages, 3000, { deadline })」和新的「(messages, { deadline })」两种写法
 * @returns {{maxTokens:number, deadline:number|undefined, timeoutMs:number|undefined}}
 */
function normOpts(a, b) {
  let o = {};
  if (typeof a === 'number') { o.maxTokens = a; if (b && typeof b === 'object') o = Object.assign(o, b); }
  else if (a && typeof a === 'object') o = Object.assign({}, a);
  if (!o.maxTokens) o.maxTokens = DEFAULT_MAX_TOKENS;
  return o;
}

/**
 * 原始 chat 调用
 *
 * 关于 max_tokens：这里**默认不传**。
 *   实测（qwen3.8-flash，DashScope 兼容模式）：
 *     · 不传 max_tokens → finish_reason=stop，输出 6571 token，JSON 完整收尾
 *     · max_tokens=3000 → finish_reason=length，写一半被砍断，尾巴断在句子中间
 *   生成型任务的输出本来就随内容多少浮动（8 天行程的闹钟 20+ 条、一天细化 13 条），
 *   给一个固定上限，内容一多就把**正常输出**也截掉了，只能靠 parseJSONFromText 抢救，
 *   丢掉的条目用户根本不知道（之前 suggestions 的 budget 字段就是这么整段消失的）。
 *   所以：让模型按自己的节奏自然写完，安全网交给时间（REQUEST_TIMEOUT_MS / deadline）。
 *   真要封顶就配环境变量 LLM_MAX_TOKENS。
 *
 * @param {Array} messages
 * @param {object|number} [a] { maxTokens, timeoutMs } 或直接传老的数字 maxTokens
 * @param {object} [b] 老写法里的 { deadline }
 * @returns {Promise<string>} content
 */
function chat(messages, a, b) {
  const opts = normOpts(a, b);
  const limit = opts.timeoutMs || REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const { apiKey, baseURL, model } = getConfig();
    const bodyObj = {
      model,
      messages,
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.7,
    };
    // 只有显式给了上限才带这个字段；不传 = 交给模型自己的输出上限
    if (opts.maxTokens > 0) bodyObj.max_tokens = opts.maxTokens;
    if (REASONING_MODEL.test(model) && process.env.LLM_ENABLE_THINKING !== '1') {
      bodyObj.enable_thinking = false;
    }
    // 联网检索（DashScope 的 enable_search）：车次/航班时刻这类**会实时变动**的信息，
    // 模型的预训练知识根本靠不住（它记的是训练时的运行图，可能早就调过了）。
    // 开了这个开关，模型在回答前会先去检索一遍，给出的是当下公开信息而不是记忆。
    // 注意：非 DashScope 的端点不认这两个字段会被忽略/报错，所以只有显式开启时才带，
    // 且调用方必须能容忍失败（见 schedule.js 的降级处理）。
    if (opts.enableSearch) {
      bodyObj.enable_search = true;
      bodyObj.search_options = Object.assign({
        forced_search: true,      // 强制走检索，别用"我觉得是"糊弄
        search_strategy: 'turbo', // 速度与质量均衡（agent 策略会多轮检索，太慢）
      }, opts.searchOptions || {});
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
            const choice = resp?.choices?.[0];
            const text = choice?.message?.content;
            if (!text) return reject(new Error('LLM 未返回内容'));
            // 被上限截断时留个证据：日志里搜 "finish=length" 就能定位是哪种截断
            console.log('[generatePlan.llm] finish=%s usage=%s',
              choice?.finish_reason, JSON.stringify(resp?.usage || {}));
            if (choice?.finish_reason === 'length') {
              console.warn('[generatePlan.llm] ⚠️ 输出被 token 上限截断（finish_reason=length），内容不完整');
            }
            resolve(text);
          } catch (e) {
            reject(new Error('响应 JSON 解析失败: ' + data.slice(0, 200)));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.setTimeout(limit, () => {
      req.destroy(new Error(`单次 LLM 请求超时(${limit / 1000}s)：model=${model} baseURL=${baseURL}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 带一次重试，但**重试要看时间够不够**。
 *
 * ⚠️ 血泪教训：之前每次请求固定 45s 超时、失败必然重试一次 ——
 *    实测一次 45s 超时 + 重试 = 69.2s，直接顶穿云函数 60s 硬上限，
 *    整轮被系统杀掉，已生成的天虽然入库了，用户却只看到"执行超时"。
 *    现在按调用方给的 deadline 动态算：
 *      · 单次超时 = min(45s, 剩余时间 - 3s 安全边际)
 *      · 只有"剩下的时间还够再来一次"才重试，否则宁可让这一天失败进入下轮续跑
 *        （续跑只是慢一点，总好过整轮超时被杀）
 *
 * @param {Array} messages
 * @param {object|number} [a] { deadline, maxTokens }（兼容老的数字 maxTokens 写法）
 * @param {object} [b] 老写法里的 { deadline }
 */
async function chatWithRetry(messages, a, b) {
  const opts = normOpts(a, b);
  const maxTokens = opts.maxTokens;
  const deadline = opts.deadline;
  const enableSearch = !!opts.enableSearch;
  const searchOptions = opts.searchOptions;
  const temperature = opts.temperature;
  const budget = () => (deadline ? deadline - Date.now() : Infinity);
  const single = Math.max(8000, Math.min(REQUEST_TIMEOUT_MS, deadline ? budget() - 3000 : REQUEST_TIMEOUT_MS));
  try {
    return await chat(messages, { maxTokens, timeoutMs: single, enableSearch, searchOptions, temperature });
  } catch (e) {
    const left = budget();
    // 重试至少还要留 12s，否则这一轮大概率整体超时
    if (deadline && left < 12000) {
      console.error('[generatePlan.llm] 调用失败且剩余时间不足，不重试:', e.message, `剩余=${left}ms`);
      throw e;
    }
    console.error('[generatePlan.llm] 调用失败，重试一次:', e.message, `剩余=${deadline ? left + 'ms' : '不限'}`);
    const again = Math.max(8000, Math.min(single, deadline ? budget() - 3000 : REQUEST_TIMEOUT_MS));
    return chat(messages, { maxTokens, timeoutMs: again, enableSearch, searchOptions, temperature });
  }
}

/**
 * 从 LLM 文本里抠出 JSON（容忍 markdown 包裹 / 前后缀 / 尾逗号 / 被 max_tokens 截断）
 *
 * ⚠️ 为什么还要保留"抢救"逻辑：虽然已经不设 max_tokens 了，但**请求超时**一样会把
 *    输出砍在半句（单次 LLM 有硬超时），JSON.parse 会整体失败，8 天的活全白干。
 *    这里退而求其次：砍掉最后一个不完整的元素，把前面完整的部分救回来（丢一天总比全丢好）。
 */
function parseJSONFromText(text) {
  let json = (text || '').trim();
  // 模型偶尔把换行/制表等原始控制字符直接塞进 JSON 字符串，
  // JSON.parse 会报 “Bad control character”。这些字符不承载行程语义，
  // 统一替为空格即可保留内容并继续做后面的截断/逗号抢救。
  json = json.replace(/[\u0000-\u001F]/g, ' ');
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

  const repairMissingCommas = (source) => {
    let result = '';
    const stack = [];
    let changed = false;
    const addSeparatorIfMissing = (context, next) => {
      if (!context) return;
      const afterValue = context.state === 'afterValue';
      if (!afterValue || next === ',' || next === ']' || next === '}') return;
      if (context.kind === 'array' && /["[{\-0-9tfn]/.test(next)) {
        result += ',';
        context.state = 'valueOrEnd';
        changed = true;
      } else if (context.kind === 'object' && next === '"') {
        result += ',';
        context.state = 'keyOrEnd';
        changed = true;
      }
    };
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      const context = stack[stack.length - 1];
      if (/\s/.test(ch)) { result += ch; continue; }
      if (ch === '"') {
        addSeparatorIfMissing(context, ch);
        const active = stack[stack.length - 1];
        if (active && active.kind === 'object') {
          if (active.state === 'keyOrEnd') active.state = 'colon';
          else if (active.state === 'value') active.state = 'afterValue';
        } else if (active && active.kind === 'array') active.state = 'afterValue';
        let escaped = false;
        result += ch;
        for (i++; i < source.length; i++) {
          const part = source[i];
          result += part;
          if (escaped) escaped = false;
          else if (part === '\\') escaped = true;
          else if (part === '"') break;
        }
        continue;
      }
      if (ch === '{' || ch === '[') {
        addSeparatorIfMissing(context, ch);
        result += ch;
        stack.push({ kind: ch === '{' ? 'object' : 'array', state: ch === '{' ? 'keyOrEnd' : 'valueOrEnd' });
        continue;
      }
      if (ch === '}' || ch === ']') {
        result += ch;
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.state = 'afterValue';
        continue;
      }
      if (ch === ',') {
        result += ch;
        const active = stack[stack.length - 1];
        if (active) active.state = active.kind === 'object' ? 'keyOrEnd' : 'valueOrEnd';
        continue;
      }
      if (ch === ':') {
        result += ch;
        const active = stack[stack.length - 1];
        if (active && active.kind === 'object') active.state = 'value';
        continue;
      }
      if (/[\-0-9tfn]/.test(ch)) {
        addSeparatorIfMissing(context, ch);
        const active = stack[stack.length - 1];
        if (active) active.state = 'afterValue';
      }
      result += ch;
    }
    return changed ? result : source;
  };

  // LLM 有时会在完整 JSON 后追加一句解释或第二段内容。只截取第一个完整
  // 顶层结构，避免 lastIndexOf 把尾部文字一并塞进 JSON.parse。
  const stack = [];
  let inString = false;
  let escaped = false;
  let firstEnd = -1;
  for (let i = start; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] === expected) stack.pop();
      else break;
      if (!stack.length) { firstEnd = i; break; }
    }
  }
  if (firstEnd >= start) {
    const first = json.slice(start, firstEnd + 1).replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(first); } catch (firstError) {
      const repaired = repairMissingCommas(first);
      if (repaired !== first) {
        try {
          console.warn('[generatePlan.llm] JSON 字段间缺逗号，已自动补上');
          return JSON.parse(repaired);
        } catch (e0) { /* 继续尝试轻量粘连修复与截断抢救 */ }
      }
      const gluedFirst = first.replace(/([}\]])\s*(?=[{\[])/g, '$1,');
      if (gluedFirst !== first) {
        try {
          console.warn('[generatePlan.llm] JSON 元素间缺逗号，已自动补上');
          return JSON.parse(gluedFirst);
        } catch (e0) { /* 继续使用下面针对截断的抢救逻辑 */ }
      }
    }
  }

  const closeChar = isArr ? ']' : '}';
  let body = end > start ? json.slice(start, end + 1) : json.slice(start);
  json = body.replace(/,(\s*[}\]])/g, '$1'); // 去尾逗号

  try {
    return JSON.parse(json);
  } catch (e) {
    // 抢救一：元素之间漏了逗号（LLM 常见写法："…}{…"「…}] […」）。
    // 合法 JSON 里 `}`/`]` 后面绝不可能直接跟 `{`/`[`，所以补逗号是安全的。
    const glued = json.replace(/([}\]])\s*(?=[{\[])/g, '$1,');
    if (glued !== json) {
      try {
        console.warn('[generatePlan.llm] JSON 元素间缺逗号，已自动补上');
        return JSON.parse(glued);
      } catch (e0) { /* 补逗号也不行，继续下面的截断抢救 */ }
    }
    // 抢救二：截断——截到最后一个完整的 "}"（对象数组）或 "],"/"}"（对象）处
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
