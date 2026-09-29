// cloudfunctions/parseTravelPlan/llm.js
// LLM 调用封装：兼容 OpenAI 格式（DeepSeek / 通义 / OpenAI / 腾讯混元 / MiniMax）
//
// 核心策略：并行逐天调用
//   一次大请求让 LLM 输出全部行程，耗时 >60s（超过云函数上限），且容易把 dayIndex 全写成 0。
//   改为：确定性按天切分文本 → 每天一个小请求 + 闹钟 + 建议，全部并行发出。
//   实测总耗时 ~11s（qwen-turbo），dayIndex 由代码强制写入，100% 正确。
//   切分失败（识别不到“X月X日｜”标题）时，退回旧的单次调用模式。
//
// 分步解析（step 模式，index.js）：同一天/闹钟/建议的解析逻辑抽成
// extractDay / extractAlarms / extractSuggestions 三个可复用函数，
// 一次只跑一个请求（25s 超时 + 一次重试 ≈ 最坏 50s），远小于 60s 上限。

const https = require('https');
const http = require('http');
const { buildDocMeta } = require('./docmeta');

// 单次 LLM 请求超时：云函数总上限 60s，留足余量；本地脚本可用 LLM_TIMEOUT_MS 放宽
const REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '', 10) || 40 * 1000;
// 分步解析的单请求超时：25s + 重试一次 25s = 最坏 50s，加上请求开销仍在 60s 内
const STEP_TIMEOUT_MS = parseInt(process.env.LLM_STEP_TIMEOUT_MS || '', 10) || 25 * 1000;

const LLM_CONFIG = {
  baseURL: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'deepseek-chat',
  provider: (process.env.LLM_PROVIDER || 'auto').toLowerCase(),
};

function getBaseURL() {
  if (LLM_CONFIG.baseURL) return LLM_CONFIG.baseURL;
  switch (LLM_CONFIG.provider) {
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'qwen':
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'hunyuan':
      return 'https://api.hunyuan.tencent.com/v1';
    case 'minimax':
      return 'https://api.minimaxi.com/v1';
    case 'openai':
    default:
      return 'https://api.openai.com/v1';
  }
}

function getModel() {
  if (LLM_CONFIG.model) return LLM_CONFIG.model;
  switch (LLM_CONFIG.provider) {
    case 'deepseek':
      return 'deepseek-chat';
    case 'qwen':
      return 'qwen-turbo';
    case 'hunyuan':
      return 'hunyuan-pro';
    case 'minimax':
      return 'MiniMax-M3';
    case 'openai':
    default:
      return 'gpt-4o-mini';
  }
}

/**
 * 原始 chat 调用，返回 content 字符串
 */
// 推理型模型（会先输出一大段思考链）单次请求可达 100s+，云函数 60s 上限必然超时，
// 表现为"某些天整段解析不出来"。这类模型必须显式关掉思考。
// 实测：qwen3.5-plus 开思考 106s → 关思考 2.9s（快 36 倍），结构化抽取质量不受影响。
const REASONING_MODEL = /qwen3|qwq|deepseek-r1|reasoner|o1|o3|m1|thinking/i;
function disableThinking() {
  if (process.env.LLM_ENABLE_THINKING === '1') return false; // 显式要思考才开
  return REASONING_MODEL.test(getModel());
}

function chat(messages, maxTokens, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bodyObj = {
      model: getModel(),
      messages,
      temperature: 0.1,
      max_tokens: maxTokens || 4000,
    };
    if (disableThinking()) bodyObj.enable_thinking = false;
    const body = JSON.stringify(bodyObj);
    const url = `${getBaseURL()}/chat/completions`;
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${LLM_CONFIG.apiKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
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
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          }
        });
      }
    );
    const reqTimeout = timeoutMs || REQUEST_TIMEOUT_MS;
    req.setTimeout(reqTimeout, () => {
      req.destroy(new Error(`单次 LLM 请求超时(${reqTimeout / 1000}s)`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 把 LLM 的输出规范成数组：可能是纯数组，也可能是 {"alarms":[...]} / {"items":[...]} 包裹
 */
function asArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/**
 * 从 LLM 文本中解析 JSON（支持对象或数组，容忍 markdown 包裹/前后缀/尾逗号）
 */
function parseJSONFromText(text) {
  let json = (text || '').trim();
  const md = json.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (md) json = md[1];

  const arrFirst = json.indexOf('[');
  const objFirst = json.indexOf('{');
  let start, end;
  if (arrFirst >= 0 && (objFirst < 0 || arrFirst < objFirst)) {
    start = arrFirst;
    end = json.lastIndexOf(']');
  } else {
    start = objFirst;
    end = json.lastIndexOf('}');
  }
  if (start < 0 || end <= start) throw new Error('文本中没有 JSON 结构');
  json = json.slice(start, end + 1);
  json = json.replace(/,(\s*[}\]])/g, '$1'); // 去尾逗号
  try {
    return JSON.parse(json);
  } catch (e) {
    // 元素之间漏了逗号（LLM 常见："…}{…"）→ 补上再试。
    // 合法 JSON 里 `}`/`]` 后面绝不可能直接跟 `{`/`[`，所以补逗号是安全的。
    const glued = json.replace(/([}\]])\s*(?=[{\[])/g, '$1,');
    if (glued !== json) {
      console.warn('[parseTravelPlan.llm] JSON 元素间缺逗号，已自动补上');
      return JSON.parse(glued);
    }
    throw e;
  }
}

const SYS_PROMPT =
  '你是旅行攻略结构化助手。只输出 JSON，禁止 markdown 代码块、禁止任何解释文字、禁止 emoji。' +
  '字符串一律用英文双引号，缺失字段用空字符串。';

/**
 * 带一次重试的 chat
 */
async function chatWithRetry(messages, maxTokens, timeoutMs) {
  try {
    return await chat(messages, maxTokens, timeoutMs);
  } catch (e) {
    console.error('[llm] 调用失败，重试一次:', e.message);
    return chat(messages, maxTokens, timeoutMs);
  }
}

// ============ 三个可复用的解析单元（并行模式与分步模式共用） ============

// 逐天提取的拆分与时间规则（必须遵守）
const DAY_RULES = `# 拆分与时间规则（必须遵守）
1. 一句原文常包含多段连续动作/移动（例："10:30～11:00抵达金坑大寨停车场，下车后坐观光车前往田头寨，之后步行前往龙脊别院"）。要拆成多条行程项，但每条都必须有确定的 startTime，禁止输出空 startTime 或 "--:--"：
   - 第一段用原文的起始时间（10:30 抵达金坑大寨停车场）
   - 后续段按原文时间线索与常识耗时依次顺延（10:40 乘观光车前往田头寨 → 11:00 步行前往龙脊别院），区间终点、"步行约40分钟/1.5小时"这类时长提示都要用上
2. 路线型原文要逐段拆分并逐段给导航（例：note 或正文出现"路线：遇龙河→工农桥→大榕树→月亮山→返回酒店"），拆成多条行程项：每段一个 startTime（按骑行/步行常识依次顺延）、各自的 startLocation/endLocation/transportType（如 ride/car/walk）。原文里针对这一整段行程的提醒/说明（包括但不限于"不用每个景点都买票""沿途才是精华""某段路在修"）**必须原样保留**，写进第一段的 note；**禁止因为拆成多段就把这类整体提示丢掉**——它对用户是"要不要掏钱/值不值得走"的关键信息。
3. 输出顺序必须与原文一致，按时间先后排列。
4. 没有发生位置移动的安排（起床、吃饭、休息、洗澡、看夜景、拍照等），startLocation、endLocation、transportType 一律留空字符串；绝不允许出现起点和终点相同（如"民宿→民宿"）的条目。
5. 凡是"前往/去/回/逛/到达"类的移动动作，都必须填 startLocation 和 endLocation——哪怕原文没明说，也要根据上下文推断：起点=上一条安排的位置或背景里前一天结束的位置（如昨晚酒店），终点=动作指向的地点（"吃完步行逛东西巷"→ startLocation=上一条的餐厅，endLocation=东西巷；"到达重庆北站"→ endLocation=重庆北站，startLocation=此前所在位置）。
6. "X点左右/大概X点"直接取 X 作为时间。
7. 每个有明确时间或动作的句子都要提取，不要遗漏备注类信息（放进步 note）。

# 结束时间（endTime）必须由上下文推导，禁止照抄开始时间（关键）
8. 按以下优先级确定 endTime：
   - 原文给了区间（"13:00～14:30游览…""16:30～18:30""08:00～10:00"）→ 直接取区间两端作为 startTime / endTime
   - 原文给了时长（"正常用时2.5小时""约27分钟""步行约40 min""1.5小时""半小时""1小时30分"）→ endTime = startTime + 时长
   - 原文没给时长，但下一段有开始时间 → 本段 endTime 不得晚于下一段的 startTime
   - 都没有 → 按常识估算：吃饭 60 分钟、市内打车 30 分钟、景点游览 60～120 分钟、高铁/直通车按原文时长、休息洗漱 30 分钟
9. endTime 严禁等于 startTime（零时长会被系统判为异常条目）；实在推不出来就按 30 分钟填，绝不留空。
10. 行程是连续的：后一段的 startTime 不得早于前一段的 endTime。

# 覆盖度：宁可多拆，不许漏
11. 原文每一句含时间或动作的话都必须有对应条目。没写时间的句子（如"晚上可以看《印象刘三姐》""17:30左右回酒店洗澡休息"之后的安排）也要提取，startTime 按上一条 endTime 顺延。
12. 备注类信息（"注：…""建议…""务必确认…""终极哪一段开放以公告为准"）放进最近一条行程项的 note，不要单独成条。`;

/**
 * 解析"一天"：原文行 → 行程项数组。失败抛错（上层决定重试/跳过）。
 * @param {{index:number, date:string, title:string, lines:string[], prevText:string}} d
 */
async function extractDay(d) {
  const prevBlock = d.prevText
    ? `【背景：今天之前的行程原文，仅供理解上下文——特别是前一天结束时所在的位置/住宿，禁止从中提取行程项】\n${d.prevText}\n\n`
    : '';
  const body = `${prevBlock}【今天：${d.date}｜${d.title}，只提取这一天的行程】\n${d.lines.join('\n')}\n\n提取"今天"所有行程项为 JSON 数组，dayIndex 全部为 ${d.index}。每个元素格式：{"dayIndex":${d.index},"startTime":"HH:mm","endTime":"HH:mm","activity":"描述","category":"sight/food/hotel/transport/ticket/other","startLocation":"","endLocation":"","transportType":"car/walk/ride/train/plane","note":""}。只输出数组。\n\n${DAY_RULES}`;
  const text = await chatWithRetry(
    [
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: body },
    ],
    3500,
    STEP_TIMEOUT_MS
  );
  return asArray(parseJSONFromText(text));
}

/**
 * 解析"预订安排"章节 → 闹钟数组。失败抛错。
 */
async function extractAlarms(bookingLines, year) {
  const body = `以下是一份旅行攻略的"预订安排"章节（抢票时间表/门票预订/酒店预订/交通预约等表格）。提取需要设置闹钟提醒的事项为 JSON 数组。年份为 ${year}。每个元素：{"title":"...","fireAt":"YYYY-MM-DDTHH:mm:ss","type":"train/plane/ticket/hotel/bus/other","note":""}

# 严格规则（必须遵守）
1. title 一律用原文语言（中文攻略就输出中文标题，如"抢票：南宁东→崇左南高铁票"），禁止翻译成英文。
2. fireAt 的日期和时刻必须严格取自原文，禁止改动、禁止编造：
   - 表格里"抢票日期=9月21日、开抢时间=15:15" → "2026-09-21T15:15:00"
   - "9月16日 10:55进入12306准备；11:00抢票" → 只生成实际开抢时刻11:00这一条，不生成10:55独立闹钟。
   - "10月3日 19:55进入页面；20:00抢票" → 只生成20:00这一条；提前提醒由系统读取用户设置（默认5分钟）计算，不让模型另生成准备提醒。
3. 原文只写了日期没写具体时刻的：白天事项 fireAt 用当天 T09:00:00，"晚上/晚"事项用 T20:00:00，并在 note 注明"原文未给具体时刻，按惯例设置"。
4. 模糊日期一律跳过、不生成闹钟："X日起""X日前后""X日～X日""提前1～3天""开放即订"这类没有确定日期的，不要编造日期。
5. type 按性质选：高铁/火车=train，飞机=plane，门票/游船/竹筏/演出=ticket，酒店=hotel，包车/直通车/大巴=bus，其他=other。
6. 同一事项在多个表格重复出现时只保留一条（取信息最全的实际办理时刻）；title 写清车次/线路或景区名称，note 只写关键操作要点，不写长篇解释。
只输出数组。

${bookingLines.join('\n').slice(0, 4000)}`;
  const text = await chatWithRetry(
    [
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: body },
    ],
    2000,
    STEP_TIMEOUT_MS
  );
  return asArray(parseJSONFromText(text));
}

/**
 * 解析全文 → 旅行建议对象（含 region 大地名）。失败抛错。
 */
async function extractSuggestions(rawHead) {
  const body = `以下是一份旅游攻略，提取旅行建议为 JSON 对象：{"weather":"天气与穿着","gear":"装备清单","food":"必吃推荐","tips":"注意事项","transport":"交通贴士","budget":"预算参考","region":"本攻略的主要目的地，格式「省 市」（如 广西 桂林）；涉及多个主要城市时空格分隔、最多 3 个，只写城市级，不要写景点名"}。只输出对象。\n\n${rawHead}`;
  const text = await chatWithRetry(
    [
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: body },
    ],
    800,
    STEP_TIMEOUT_MS
  );
  const obj = parseJSONFromText(text);
  return obj && typeof obj === 'object' ? obj : {};
}

/**
 * ============ 并行逐天方案（旧的单次调用全流程） ============
 */
async function callLLMParallel(rawText) {
  const meta = buildDocMeta(rawText);
  console.log('[llm] 并行模式: 天数=%d, 年份=%d, %s ~ %s%s',
    meta.days.length, meta.year, meta.startDate, meta.endDate, meta.pseudo ? '（伪单日）' : '');

  const tasks = meta.days.map((d) =>
    extractDay(d)
      .then((items) => ({ kind: 'day', i: d.index, items }))
      .catch((e) => ({ kind: 'day', i: d.index, error: e.message }))
  );

  // 闹钟（预订安排章节）
  if (meta.booking.length) {
    tasks.push(
      extractAlarms(meta.booking, meta.year)
        .then((alarms) => ({ kind: 'alarms', alarms }))
        .catch((e) => ({ kind: 'alarms', error: e.message }))
    );
  }

  // 建议
  tasks.push(
    extractSuggestions(meta.rawHead)
      .then((suggestions) => ({ kind: 'suggestions', suggestions }))
      .catch((e) => ({ kind: 'suggestions', error: e.message }))
  );

  const results = await Promise.all(tasks);

  const items = [];
  let alarms = [];
  let suggestions = {};
  let failedDays = 0;

  for (const r of results) {
    if (r.error) {
      console.error(`[llm] 子任务失败 kind=${r.kind} day=${r.i !== undefined ? r.i : '-'}:`, r.error);
      if (r.kind === 'day') failedDays++;
      continue;
    }
    if (r.kind === 'day') {
      r.items.forEach((it) => {
        // dayIndex 由代码强制写入，不信任 LLM
        items.push(Object.assign({}, it, { dayIndex: r.i }));
      });
    } else if (r.kind === 'alarms') {
      alarms = r.alarms;
    } else if (r.kind === 'suggestions') {
      suggestions = r.suggestions && typeof r.suggestions === 'object' ? r.suggestions : {};
    }
  }

  // region 是给地图定位消歧用的大地名（如"广西 桂林"），不是旅行建议，单独拎出来
  const region = String(suggestions.region || '').trim();
  delete suggestions.region;

  // 全部天都失败 → 交给上层走旧逻辑
  if (failedDays === meta.days.length) {
    console.error('[llm] 并行模式所有天均失败，退回单次调用模式');
    return null;
  }

  // ---------- 第二波：覆盖度复查（补漏，自适应） ----------
  // 第一波是"一次成文"，长段落/没写时间的句子最容易被整句吞掉。
  // 再发一轮请求：把原文和已提取清单一起给模型，只让它输出"漏掉的那几条"。
  // ⚠️ 云函数有 60s 总耗时上限，复查只对"条目数明显少于原文行数"的天发起，不做全量复查。
  const coverageOf = (metaD) => {
    const n = items.filter((it) => it.dayIndex === metaD.index).length;
    const srcLines = metaD.lines.filter((l) => l && !/^注[:：]/.test(l.trim())).length;
    return { n, srcLines };
  };
  const needFix = meta.days.filter((d) => {
    const { n, srcLines } = coverageOf(d);
    return srcLines > 0 && n < Math.max(2, Math.ceil(srcLines * 0.7));
  });
  if (needFix.length) {
    console.log('[llm] 覆盖度复查: 触发 %d/%d 天 → %s', needFix.length, meta.days.length,
      needFix.map((d) => `第${d.index + 1}天(${coverageOf(d).n}/${coverageOf(d).srcLines})`).join(', '));
  }

  try {
    const fixTasks = needFix.map((d) => {
      const got = items.filter((it) => it.dayIndex === d.index);
      const gotList = got.length
        ? got.map((it, k) => `${k + 1}. ${it.startTime || '--:--'}-${it.endTime || '--:--'} ${it.activity}`).join('\n')
        : '(这一天的条目一条都没提取出来)';
      const body =
        `【今天：${d.date}｜${d.title}，原始攻略正文】\n${d.lines.join('\n')}\n\n` +
        `【已经提取出来的行程项】\n${gotList}\n\n` +
        `逐句核对正文，找出**没有被上面覆盖**的动作或安排，输出补充条目的 JSON 数组，元素格式：{"dayIndex":${d.index},"startTime":"HH:mm","endTime":"HH:mm","activity":"描述","category":"sight/food/hotel/transport/ticket/other","startLocation":"","endLocation":"","transportType":"car/walk/ride/train/plane","note":""}。\n` +
        `# 规则\n` +
        `1. 只输出确实遗漏的条目；已覆盖的不要重复输出，也不要改写后重新输出。\n` +
        `2. 确实没有遗漏 → 只输出 []。\n` +
        `3. 没写时间的遗漏项，startTime 按上一条 endTime（或上下文）顺延，endTime 同样按耗时推算，禁止 endTime 等于 startTime。\n` +
        `4. 只输出数组。`;
      return chatWithRetry(
        [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: body },
        ],
        2000
      )
        .then((t) => ({ i: d.index, items: parseJSONFromText(t) }))
        .catch((e) => ({ i: d.index, error: e.message }));
    });

    const fixResults = await Promise.all(fixTasks);
    const sig = (it) => `${String(it.startTime || '')}|${String(it.activity || '').replace(/\s+/g, '')}`;
    const seen = new Set(items.map(sig));
    let added = 0;
    fixResults.forEach((r) => {
      if (r.error || !r.items) return;
      const arr = asArray(r.items).filter((it) => it && String(it.activity || '').trim());
      arr.forEach((it) => {
        const merged = Object.assign({}, it, { dayIndex: r.i });
        if (seen.has(sig(merged))) return; // 已存在 → 跳过
        seen.add(sig(merged));
        items.push(merged);
        added++;
      });
    });
    console.log('[llm] 覆盖度复查: 补充条目 %d 条（复查前 %d 条）', added, items.length - added);

    // 每天条目数 vs 原文有效行数，做个粗粒度的覆盖度告警（只打日志，不影响流程）
    meta.days.forEach((d) => {
      const n = items.filter((it) => it.dayIndex === d.index).length;
      const srcLines = d.lines.filter((l) => l && !/^注[:：]/.test(l.trim())).length;
      if (srcLines > 0 && n < Math.max(1, Math.ceil(srcLines / 3))) {
        console.warn(`[llm] 覆盖度告警 第${d.index + 1}天(${d.date}): 原文 ${srcLines} 行 → 只提取到 ${n} 条`);
      }
    });
  } catch (e) {
    console.error('[llm] 覆盖度复查异常（忽略，不影响主流程）:', e.message);
  }

  return {
    title: meta.title,
    summary: meta.summary,
    startDate: meta.startDate,
    endDate: meta.endDate,
    region,
    items,
    alarms,
    suggestions,
  };
}

/**
 * ============ 旧版单次调用（兜底） ============
 */
async function callLLMSingle(rawText) {
  // 服务器是 UTC，"今天"必须按北京时间算，否则北京时间 0-8 点会算成昨天
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const todayStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;

  const systemPrompt = `你是旅行攻略结构化助手。从用户提供的旅游攻略文档中提取信息。
今天是 ${todayStr}。

# 严格输出要求（违反即失败）

- 必须输出一个单一、完整、可被 JSON.parse 解析的 JSON 对象
- 禁止输出 markdown 代码块
- 禁止输出任何解释、前缀、后缀、注释、emoji
- 第一字符必须是 {，最后一字符必须是 }
- 字段缺失就用空字符串 "" 或空数组 []
- 字符串值严格使用英文双引号

# 内容要求

1. 识别每一天的行程（按“X月X日”或“第X天”标题）
2. 日期以文档中明确写的“X月X日”为准，禁止改动：文档写 9月20日 就必须是 09-20，哪怕已经过去
3. 文档只写月日没写年份时：过去不超过 90 天的取今年，更早的取明年
4. 每天的行程项 dayIndex 依次为 0,1,2…，禁止全部为 0
5. 提取所有抢票/订票闹钟，时间为 ISO 字符串 YYYY-MM-DDTHH:mm:ss；闹钟标题用原文语言（中文攻略输出中文标题）；fireAt 的日期和时刻严格取自原文，禁止编造；只写日期没写时刻的白天事项用 T09:00:00、晚间事项用 T20:00:00 并在 note 注明；"X日起/前后/区间"等模糊日期不生成闹钟
6. 提取旅行建议：天气、装备、必吃、注意事项、交通贴士、预算
7. 时间统一 24 小时制 HH:mm（不足两位补零，如 07:20）
8. 一句原文包含多段连续动作/移动时拆成多条，但每条都必须有确定的 startTime：第一段用原文起始时间，后续段按原文时间线索与常识耗时依次顺延，禁止输出空 startTime
9. 没有位置移动的安排（吃饭、休息等）startLocation/endLocation/transportType 留空，禁止出现起点=终点的条目
10. 行程跨天连续：某天第一条移动若原文没写出发点，用前一天结束时的位置（昨晚住宿/最后一站）作为 startLocation
11. "前往/去/回/逛/到达"类移动动作必须填起终点，原文没明说就从上下文推断（起点=上一条位置/昨晚住宿，终点=动作指向的地点）；路线型原文（A→B→C）逐段拆成多条并各自给时间与起终点`;

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
  "region": "本攻略的主要目的地，格式「省 市」（如 广西 桂林）；多个主要城市空格分隔、最多 3 个，只写城市级，不要写景点名",
  "items": [
    { "dayIndex": 0, "startTime": "HH:mm", "endTime": "HH:mm", "activity": "行程描述",
      "category": "sight/food/hotel/transport/ticket/other",
      "startLocation": "起点(可空)", "endLocation": "终点(可空)",
      "transportType": "car/walk/ride/train/plane(可空)", "note": "备注(可空)" }
  ],
  "alarms": [
    { "title": "闹钟标题", "fireAt": "YYYY-MM-DDTHH:mm:ss",
      "type": "train/plane/ticket/hotel/bus/other", "note": "备注(可空)" }
  ],
  "suggestions": { "weather": "", "gear": "", "food": "", "tips": "", "transport": "", "budget": "" }
}

不要编造数据，没有的字段留空。`;

  const text = await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    4000
  );
  return parseJSONFromText(text);
}

/**
 * 主入口：优先并行逐天方案，失败退回单次调用
 */
async function callLLM(rawText) {
  if (!LLM_CONFIG.apiKey) {
    throw new Error('云函数环境变量 LLM_API_KEY 未配置');
  }

  try {
    const r = await callLLMParallel(rawText);
    if (r && (r.items || []).length) return r;
  } catch (e) {
    console.error('[llm] 并行模式异常，退回单次调用:', e.message);
  }

  console.log('[llm] 使用单次调用模式');
  return callLLMSingle(rawText);
}

// chatWithRetry / parseJSONFromText 也导出：供 alarm-infer.js 做「攻略没写抢票时间时
// 由 AI 反推待办事项」这类独立的小请求复用，不用再写一份 HTTP 调用。
// extractDay/extractAlarms/extractSuggestions 供 index.js 的分步解析模式复用。
module.exports = {
  callLLM, LLM_CONFIG, chatWithRetry, parseJSONFromText, asArray,
  extractDay, extractAlarms, extractSuggestions, STEP_TIMEOUT_MS,
};
