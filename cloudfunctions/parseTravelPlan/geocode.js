// cloudfunctions/generatePlan/geocode.js
// 高德 Web 服务：地点名 → 经纬度（服务端调用，不需要小程序端配域名白名单）
// 文档: https://lbs.amap.com/api/webservice/guide/api/georegeo
//       https://lbs.amap.com/api/webservice/guide/api/search
//
// 需要在云函数环境变量配置 AMAP_KEY（类型：Web服务）
// 没有配置时静默跳过，行程项里就没有坐标，前端会走"复制目的地"降级。
//
// ⚠️ 2026-09-25 重写（v2）：以前只调 geocode/geo 并带一个 city 参数，
//    但高德的 city 只是"优先提示"，不是硬限制——
//    「象鼻山公园」在桂林其实叫「象鼻山/象山景区」，桂林搜不到这个词，
//    高德就全国兜底返回了江西省南昌县的象鼻山公园，导航直接把人导去了南昌。
//    现在改成：POI 搜索优先 + 逐条校验返回结果的行政区，
//    城市对不上宁可不给坐标（前端降级复制），也绝不返回一个错误城市的坐标。
//
// ⚠️ 2026-09-25 晚 v3（广西七日攻略实测翻车后的第三轮加固）：
//    ① geo 模糊结果也会张冠李戴：「德天跨国瀑布」被 geo 编到桂林象山区一个
//       叫"德天"的路牌、「大新明仕酒店」被编到全州县"大新村"——城市校验拦
//       不住（结果确实在候选城市里），geo 结果现在必须过**名称相关性**校验。
//    ② POI 名称锁升级出**类别尾缀**：「重庆北站」全国搜，第一名是阳朔的
//       「重庆鲜面店」（城市校验还真能过——阳朔在行程里），砍掉尾缀只拿
//       "重庆"匹配太松。现在查询尾巴是"站/码头/停车场/酒店/服务中心…"时，
//       POI 名里必须出现同类词，且主体词和类别词之间最多夹 1 个字
//       （「逸喆槿悦酒店」夹了"槿悦"两个字 → 拒，它崇左店就是这么混进来的）。
//    ③ 全国兜底（poi/last）：出发地/返程地（重庆金童路、重庆北站）不在行程
//       城市列表里，城市校验永远过不了 → 全部策略失败后，拿全国 POI 第一名
//       做**强名称匹配**（全词包含/反向包含/主体+类别），过了就给坐标。
//    ④ 「阳朔西街附近」「酒店一带」这类模糊尾巴搜前剥掉。
//    ⑤ 地点名自带的行政区（「重庆市金童路」→ 重庆）自动加进候选城市。
//    ⑥ QPS 限速保护：请求间隔 AMAP_MIN_GAP_MS（默认 120ms），失败且带
//       infocode（真 API 才有，桩测试没有）时重试一次——QPS 被限时返回空，
//       POI 步骤全空就会掉进 geo 模糊兜底，正是大批偏移的帮凶。

const https = require('https');

const AMAP_KEY = process.env.AMAP_KEY || '';
const GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/geo';
const POI_URL = 'https://restapi.amap.com/v3/place/text';
const REQUEST_TIMEOUT = 10 * 1000;
const MIN_GAP = Math.max(0, parseInt(process.env.AMAP_MIN_GAP_MS || '120', 10) || 0);

// 省级行政区（用来从「广西 桂林」里挑出真正的城市词）
const PROVINCE_NAMES = new Set([
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
  '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
]);

// LLM 爱给景点加后缀：把「象鼻山」写成「象鼻山公园」，
// 但当地官方叫法往往没这个后缀，带后缀反而匹配到外地的同名点。
// 搜不到时把后缀砍掉再试一次，命中率明显变高。
const SUFFIX_RE = /((国家|地质|森林|湿地|海洋|城市|矿山|水利)?(风景|名胜)?(景区|公园|游览区|保护区)|大门|正门|南门|北门|东门|西门|游客服务中心|游客中心|服务中心|售票处|观景台|停车场)$/;

// ---------------------------------------------------------------- 请求层

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
let lastAt = 0;

function httpGet(url) {
  return new Promise(async (resolve, reject) => {
    try {
      // 简易限速：请求之间至少隔 MIN_GAP 毫秒。高德被 QPS 限时返回 status=0，
      // POI 步骤全空就会掉进 geo 模糊兜底——这是大批定位偏移的隐形帮凶。
      if (MIN_GAP > 0) {
        const wait = lastAt + MIN_GAP - Date.now();
        if (wait > 0) await sleep(wait);
      }
      lastAt = Date.now();
      const req = https.get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('amap 响应解析失败: ' + String(data).slice(0, 120)));
          }
        });
      });
      req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('amap 请求超时')));
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

/** 带重试的请求：status!=='1' 且带 infocode（说明是真高德而非桩）→ 450ms 后重试一次 */
async function amapGet(url) {
  let resp = await httpGet(url);
  if (resp && resp.status !== '1' && resp.infocode) {
    await sleep(450);
    resp = await httpGet(url);
  }
  return resp;
}

/** "lon,lat" → { lon, lat } | null */
function parseLoc(str) {
  const parts = String(str || '').split(',');
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!lon || !lat || isNaN(lon) || isNaN(lat)) return null;
  return { lon, lat };
}

/**
 * 从「广西 桂林 阳朔县城（西街附近）」这类脏串里清洗出一组城市词：
 *   - 去掉括号补注（大纲里的住宿地常带「（两江四湖片区）」）
 *   - 「广西壮族自治区」归一成「广西」
 *   - 砍行政后缀：「桂林市」→「桂林」、「阳朔县城」→「阳朔」
 * 返回去重后的词表，供高德 city 参数与结果校验共用。
 */
function cityTokens(region) {
  const out = [];
  String(region || '').split(/[\s,，、]+/).forEach((raw) => {
    let t = String(raw || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s/g, '');
    if (!t) return;
    for (const p of PROVINCE_NAMES) {
      if (t.indexOf(p) === 0) { t = p; break; }
    }
    t = t.replace(/((特别)?行政区|自治州|自治县|各族自治县|地区|盟|县城|市区|市|县|区|旗|镇)+$/, '');
    if (t.length < 2 || out.includes(t)) return;
    out.push(t);
  });
  return out;
}

/**
 * 从城市词表里挑出最适合给高德 city 参数的那个：第一个不是省份的词。
 * 挑不到就返回空（让高德自己猜，总比塞个错参数强）。
 */
function pickCity(region) {
  const tokens = cityTokens(region);
  const nonProv = tokens.filter((t) => !PROVINCE_NAMES.has(t));
  return nonProv[0] || tokens[0] || '';
}

/** 砍掉 LLM 自造的景点后缀 */
function stripSuffix(name) {
  const s = String(name || '').trim();
  const out = s.replace(SUFFIX_RE, '').trim();
  // 砍完至少还得剩 3 个字：不然"中山公园"→"中山"、"象山公园"→"象山"
  // 这种本来就存在的名字会被砍成另一个地方，反而更不准
  return out.length >= 3 ? out : s;
}

/**
 * 从地点名自身提取行政区词根（证据用）：「大新县硕龙镇」→ [{t:'大新',suf:'县'},{t:'硕龙',suf:'镇'}]。
 * 用途：结果校验的另一半证据。行程城市词是"当天住哪"，跨景区的条目
 * （如住在桂林那天写去大新县硕龙镇）经常对不上——但正确结果里一定
 * 含有「大新县」「硕龙镇」这些地点自带的行政区名。
 * ⚠️ 匹配时要求词根 + 原后缀（"大新县"而不是裸"大新"）：
 *    否则"桂林市大新水库"里的"大新"也会蒙混过关（桩测试实测踩过）。
 * ⚠️ 省级词（重庆/广西…）在这里被过滤：证据必须是市县级才有区分度。
 */
function selfTokens(address) {
  const s = String(address || '').trim();
  const out = [];
  const re = /([\u4e00-\u9fa5]{1,8}?(?:省|自治州|地区|市|自治县|县|旗|区|镇|乡|村))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const full = m[1];
    const t = full.replace(/(省|自治州|地区|自治县|市|县|旗|区|镇|乡|村)$/, '');
    if (t.length >= 2 && !PROVINCE_NAMES.has(t) && !out.some((x) => x.t === t)) {
      out.push({ t, suf: full.slice(t.length) });
    }
  }
  return out;
}

/**
 * 地点名自带的行政区（候选城市用）：「重庆市金童路」→ ['重庆']。
 * 与 selfTokens 的区别：省级词也收（出发地"重庆市金童路"就靠它定位），
 * 且不要求带后缀匹配——只用来扩大搜索候选，不当放行证据。
 */
function addrTokens(address) {
  const s = String(address || '').trim();
  const out = [];
  const re = /([\u4e00-\u9fa5]{1,8}?(?:省|自治州|地区|市|自治县|县|旗|区|镇|乡))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const full = m[1];
    const t = full.replace(/(省|自治州|地区|自治县|市|县|旗|区|镇|乡)$/, '');
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 词根命中：hay 里出现「大新县」「硕龙镇」这种带后缀的完整行政区名 */
function selfMatch(marks, hay) {
  const h = String(hay || '');
  return marks.some(({ t, suf }) => h.indexOf(t + suf) >= 0);
}

/**
 * 城市校验：返回结果是不是真的落在行程范围内。
 * region 可以是「广西 桂林 阳朔」整串——**词表里任意一个城市命中就算过**。
 * 为什么放宽成"任一命中"：跨城行程里「南宁东站」挂在桂林那天的条目上，
 * 只拿"桂林"校验会白白拒掉一个完全正确的坐标。
 * 没给城市时不校验（true），保持老行为。
 */
function cityHit(region, hay) {
  const tokens = cityTokens(region);
  if (!tokens.length) return true;
  const h = String(hay || '');
  return tokens.some((t) => h.indexOf(t) >= 0);
}

// ---------------------------------------------------------------- 名称相关性

/** 抹掉装饰符再比较（「印象刘三姐」vs「印象·刘三姐」） */
function normName(s) {
  return String(s || '').replace(/[·\s\-（）()【】\[\]]/g, '');
}

/** 最长公共子串长度（地名都很短，O(n·m) 足够） */
function lcsLen(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 类别尾缀分组：查询尾巴是"站/码头/停车场…"时，POI 名里也必须出现同类词。
 * 实测翻车：搜「重庆北站」全国第一名是阳朔「重庆鲜面店」（城市校验能过）；
 * 搜「德天瀑布服务中心」命中的是崇左「德天瀑布饮用纯净水」——都是只拿
 * 砍掉尾缀后的主体词匹配惹的祸。
 */
const TAIL_GROUPS = [
  /站|候机楼|航站楼/,                        // 车站/机场类（东站/南站/北站/客运站…）
  /码头|客运港|港口|渡口|游船/,               // 码头类
  /停车场|停车点|停车楼|泊车/,                // 停车场类
  /服务中心|集散中心|游客中心|接待中心|中心/,    // 中心类
  /酒店|宾馆|饭店|客栈|民宿|度假村|招待所/,     // 住宿类
  /景区|风景区|景点|名胜|公园|游览区/,          // 景区类
  /广场|步行街|商业街|街区/,                  // 街区类
  /机场/,                                    // 机场类
  /市场|商场|超市|购物中心|商城/,              // 商圈类
  /大桥|桥/,                                 // 桥类
];

/**
 * 交通枢纽类尾缀：关键词带这类尾缀时，POI 基础名里出现住宿/餐饮词
 * 几乎肯定是"XX客栈（某客运中心店）"这类分支店，不是枢纽本身。
 */
const HUB_TAIL = /(客运站|客运中心|火车站|高铁站|枢纽站|候机楼|机场|码头|渡口|游客中心|游客集散中心|旅游集散中心|集散中心|停车场|服务中心)$/;
const LODGE_FOOD_WORD = /酒店|宾馆|客栈|民宿|饭店|餐厅|酒楼|饭馆|火锅|烧烤|小吃|汤锅|招待所/;

/**
 * 枢纽等价匹配（通用结构判定，不认任何具体站名）：
 * 「XX客运站」vs「XX市客运中心」——差一个"站/中心"的叫法、中间还夹个
 * 行政区字，但明明是同一座站。判定：关键词剥掉枢纽尾缀 = 主体；
 * POI 名里主体出现（最多隔 1 个行政区字），剩余部分恰好是某种枢纽叫法。
 */
const HUB_REST = /^(客运中心|客运站|汽车客运中心|汽车客运站|汽车站|火车站|高铁站|枢纽站|站|候机楼|机场|码头|游客中心|游客集散中心|服务中心|停车场)$/;
function hubEquivalent(k, n) {
  if (!HUB_TAIL.test(k)) return false;
  const stem = k.replace(HUB_TAIL, '');
  if (stem.length < 2) return false;
  const si = n.indexOf(stem);
  if (si < 0) return false;
  let rest = n.slice(si + stem.length);
  rest = rest.replace(/^[市县区镇]/, '');
  return HUB_REST.test(rest);
}

/**
 * POI 名与搜索词的匹配强度（3 > 2 > 1）：
 *   3 POI 名包含完整搜索词
 *   2 主体词 + 同类尾缀（「德天瀑布服务中心」vs「…德天瀑布游客中心店」）
 *   1 只有核心词沾边
 * 一个搜索词常常回来四五条城市也对的候选——以前取第一条，
 * 结果「德天瀑布服务中心」被酒店 POI 顶掉。现在按强度择优。
 */
function nameScore(poiName, keyword) {
  // 剥掉 POI 名末尾的分支后缀（「XX客栈(某客运中心店)」）再比：
  // 否则"客运中心"这类词会靠分支后缀蹭进匹配
  const n = normName(String(poiName || '').replace(/[（(][^）)]*[）)]$/, ''));
  const k = normName(keyword);
  if (!n || !k) return 1;
  if (n.indexOf(k) >= 0) return 3;
  const tailM = k.match(GENERIC_TAIL);
  if (tailM && tailM.index > 0) {
    const grp = TAIL_GROUPS.find((g) => g.test(tailM[0]));
    const stem = k.slice(0, tailM.index);
    if (grp && stem.length >= 2) {
      const si = n.indexOf(stem);
      if (si >= 0 && grp.test(n)) {
        const tm = n.slice(si + stem.length).match(grp);
        if (tm && tm.index <= 1) return 2;
      }
    }
  }
  return 1;
}

/**
 * POI 名与搜索词是不是"同一件事"（v3）：
 *   · POI 名包含完整搜索词 → 放行（最稳）
 *   · 查询带类别尾缀 → 主体词必须出现 + POI 名含同类词 + 主体与类别之间
 *     最多夹 1 个字（「逸喆槿悦酒店」夹"槿悦"两字 → 拒）
 *   · 没有类别尾缀 → 砍掉通用尾缀后的核心词命中即放行（老规则）
 */
const GENERIC_TAIL = /(风景名胜区|游客集散中心|旅游集散中心|集散中心|游客中心|游客服务中心|服务中心|客运站|枢纽站|火车站|高铁站|候机楼|东站|南站|西站|北站|风景区|景区|度假区|大酒店|饭店|酒店|宾馆|公园|广场|中心|码头|渡口|机场|大桥|学校|大学|学院|医院|商场|市场|超市|大楼|大厦|停车场|站)+$/;
function nameOk(poiName, keyword) {
  // 同 nameScore：先剥分支后缀，再判"是不是同一件事"
  const n = normName(String(poiName || '').replace(/[（(][^）)]*[）)]$/, ''));
  const k = normName(keyword);
  if (!n || !k) return true;                       // 没名可比就不加这道锁
  // 枢纽词反查：搜车站/机场/游客中心，命中的却是"XX客栈/酒店" → 拒
  if (HUB_TAIL.test(k) && LODGE_FOOD_WORD.test(n)) return false;
  // 枢纽等价：「XX客运站」≈「XX市客运中心」（同一座站的不同叫法）
  if (hubEquivalent(k, n)) return true;
  if (n.indexOf(k) >= 0) return true;              // POI 名包含搜索词（更具体的全称）
  const tailM = k.match(GENERIC_TAIL);
  if (tailM && tailM.index > 0) {
    const grp = TAIL_GROUPS.find((g) => g.test(tailM[0]));
    const stem = k.slice(0, tailM.index);
    if (grp && stem.length >= 2) {
      const si = n.indexOf(stem);
      if (si < 0) return false;                    // 主体词都不在 → 拒
      if (!grp.test(n)) return false;              // 类别对不上（重庆鲜面店）→ 拒
      const rest = n.slice(si + stem.length);
      const tm = rest.match(grp);
      if (!tm || tm.index > 1) return false;       // 主体与类别夹字太多（逸喆槿悦酒店）→ 拒
      return true;
    }
  }
  const core = k.replace(GENERIC_TAIL, '');
  return core.length >= 2 && n.indexOf(core) >= 0; // 核心词命中才算同一件事
}

/**
 * geo 结果的名称相关性校验：geo 是模糊匹配，不校验名称就会把
 * 「德天跨国瀑布」编到桂林象山区叫"德天"的路、「大新明仕酒店」编到
 * 全州县"大新村"。要求：hay 含完整查询词，或公共子串 ≥3 字
 * （「金童路一奥天地」vs「重庆市两江新区金童路1号」→ "金童路" 3 字 → 放）。
 */
function geoNameOk(keyword, hay) {
  const k = normName(keyword);
  const h = normName(hay);
  if (!k || !h) return false;
  if (h.indexOf(k) >= 0) return true;
  if (k.length < 3) return false;
  return lcsLen(k, h) >= Math.min(3, k.length);
}

/**
 * geo 结果是行政区划级（省/市/区县/乡镇）时的防线：结果名必须包含完整关键词。
 * 实测翻车：搜「都江堰客运站」，POI 没搜到（真实名叫"都江堰客运中心"），
 * geo 模糊兜底返回"四川省成都市都江堰市"——名称相关性过了（hay 含"都江堰"），
 * 定位却落在区划中心点（市政府一带）。行政区划结果是"范围"不是"地点"，
 * 只有关键词本身就是这个行政区名时才可信。
 */
const ADMIN_LEVEL_RE = /^(省|省份|城市|市|区县|县|乡镇|乡|镇|街道|商圈)$/;
function geoLevelOk(keyword, hay, level) {
  if (!ADMIN_LEVEL_RE.test(String(level || ''))) return true;
  const k = normName(keyword);
  const h = normName(hay);
  return !!k && !!h && h.indexOf(k) >= 0;
}

/**
 * 住宿/餐饮类关键词的 geo 兜底防线：geo 结果里也必须带同类词。
 * 实测翻车：模型推荐了查无此店的"XX高原文化大酒店"，POI 搜不到，
 * geo 兜底落到"XX镇"的镇域点——看着"在附近"，实际导去的是镇中心，
 * 用户按推荐名也搜不到这家店。编造的名索性不给坐标（宁缺毋错）。
 */
const LODGE_FOOD_TAIL = /(酒店|大酒店|饭店|宾馆|民宿|客栈|公寓|招待所|度假村|餐厅|酒楼|饭馆|火锅|烧烤|小吃|汤锅|米粉|米线|面馆)$/;
function geoClassOk(keyword, hay) {
  const k = String(keyword || '').replace(/[（(][^）)]*[）)]/g, '');
  if (!LODGE_FOOD_TAIL.test(k)) return true;
  return LODGE_FOOD_TAIL.test(String(hay || ''));
}

// ---------------------------------------------------------------- 高德 API

/** POI 关键词搜索（v3/place/text）。citylimit=true 时城市是硬限制，不会串到外省。 */
async function searchPoi(keywords, city, citylimit, size) {
  if (!AMAP_KEY || !keywords) return [];
  let url = `${POI_URL}?keywords=${encodeURIComponent(keywords)}&key=${AMAP_KEY}` +
    `&offset=${size || 10}&page=1&output=json&extensions=base`;
  if (city) url += `&city=${encodeURIComponent(city)}`;
  if (city && citylimit) url += '&citylimit=true';
  try {
    const resp = await amapGet(url);
    if (resp.status !== '1' || !Array.isArray(resp.pois)) return [];
    return resp.pois.map((p) => {
      const loc = parseLoc(p.location);
      if (!loc) return null;
      return {
        lon: loc.lon,
        lat: loc.lat,
        name: String(p.name || ''),
        hay: [p.pname, p.cityname, p.adname, p.address, p.name].join('|'),
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('[geocode] POI 搜索失败:', keywords, e.message);
    return [];
  }
}

/** 地理编码（v3/geocode/geo）。city 只是优先级提示，必须配合城市校验。 */
async function geoRaw(address, city) {
  if (!AMAP_KEY || !address) return [];
  let url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${AMAP_KEY}&output=json`;
  if (city) url += `&city=${encodeURIComponent(city)}`;
  try {
    const resp = await amapGet(url);
    if (resp.status !== '1' || !Array.isArray(resp.geocodes)) return [];
    return resp.geocodes.map((g) => {
      const loc = parseLoc(g.location);
      if (!loc) return null;
      return {
        lon: loc.lon,
        lat: loc.lat,
        name: String(g.formatted_address || ''),
        // level：区县/乡镇/兴趣点… 级别太粗（省/市）说明高德只是把整片区的中心点
        // 扔了回来，对"XX县XX镇"这种精细地址就是错的
        level: String(g.level || ''),
        isGeo: true,   // 提醒校验方：geo 结果必须过名称相关性（geoNameOk）
        hay: [g.province, g.city, g.district, g.formatted_address, g.building, g.neighborhood].join('|'),
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('[geocode] 地理编码失败:', address, e.message);
    return [];
  }
}

/**
 * 单个地点 → { lon, lat, matchedName, city } | null
 *
 * 多策略依次尝试，每条结果都要过校验，命中就返回：
 *   ① POI 搜索（逐个候选城市）      —— 最准，返回的是真实存在的 POI
 *   ② 砍掉自造后缀/括号补注再搜     —— 解决「象鼻山公园」「XX酒店（XX景区店）」搜不到的问题
 *   ③ 全国搜（完整名/砍后缀名）      —— 城市名不标准（如片区名）时的兜底
 *   ④ 地理编码（逐个候选城市提示）
 *   ⑤ 地理编码（不带 city）
 *   ⑥ 关键词放宽（砍掉开头 2 字）    —— 「大新明仕酒店」→「明仕酒店」
 *   ⑦ 地理编码（城市名拼进地址）    —— ⚠️ 只在地址自带行政区词根时启用，
 *      且结果必须命中词根才采纳
 *   ⑧ 全国强名兜底                  —— 出发地/返程地（重庆金童路、重庆北站）
 *      不在行程城市列表里，城市校验永远过不了；前面全部失败后，全国 POI
 *      第一名与搜索词强名称匹配（全词/反向包含/主体+类别）才给坐标
 *
 * 校验（两层证据 + 名称相关性）：
 *   a. 行程城市词（「广西 桂林 阳朔」整串，任一城市命中）
 *   b. 地点自身词根（「大新县硕龙镇」→ 大新/硕龙）——地址带词根时只认 b
 *   c. geo 结果额外过 geoNameOk；POI 结果过 nameOk（含类别尾缀锁）
 *
 * 全部对不上 → 返回 null。宁可让前端降级成"复制地名"，
 * 也不能给用户一个错误城市的坐标（导航导到外省比打不开更糟）。
 *
 * @param {string} address 地点名
 * @param {string} [city]  大地名（可以是「广西 桂林 阳朔 南宁 崇左」整串，
 *                          内部拆成候选城市逐个试）
 */
async function geocodeOne(address, city) {
  if (!AMAP_KEY || !address) return null;
  const raw = String(address).trim();
  // 括号补注（「锦江都城酒店（桂林两江四湖象山景区店）」）常拖垮 POI 搜索，
  // 且括号里的「…景区店」会给词根提取造出垃圾——先剥掉
  let bare = String(address).replace(/[（(][^）)]*[）)]/g, '').trim() || raw;
  // 「阳朔西街附近」「酒店一带」这类模糊尾巴也会让 POI 搜索直接失败 → 剥掉
  bare = bare.replace(/(附近|周边|一带)+$/, '').trim() || bare;
  const short = stripSuffix(bare);
  const self = selfTokens(bare);

  // 候选城市：region 串里的城市词 + 地点名自带的行政区（「重庆市金童路」→ 重庆）
  const tokens = cityTokens(city);
  const regionCities = tokens.filter((t) => !PROVINCE_NAMES.has(t)).slice(0, 4);
  const addrCities = addrTokens(bare).slice(0, 2);
  const candidates = [...new Set([...regionCities, ...addrCities])].slice(0, 6);
  // 校验用城市串（含地点自带行政区，「南宁市」这类省级词也在内）
  const fullCity = city + ' ' + addrCities.join(' ');

  // geo 结果的级别防线：地址自带行政区词根（县/镇级）时，
  // 级别还停在"省/市"说明高德只给了个片区中心点，多半是错的
  const levelOk = (r) => !self.length || !/^(省|城市|市)$/.test(r.level || '');

  // ⚠️ self 为空时绝不能走 selfHit —— 要把"没有词根"和"词根不命中"区分开：
  // 前者退回城市校验（老行为），后者必须拒绝
  const selfHit = (hay) => self.length > 0 && selfMatch(self, hay);
  // 基础证据：地址自带行政区词根时只认词根；没有词根才退回城市校验
  const baseOk = (r) => (self.length ? selfHit(r.hay) : cityHit(fullCity, r.hay)) && levelOk(r);
  // POI 步骤：基础证据 + 名称相关性（含类别尾缀锁）
  const poiOk = (kw) => (r) => baseOk(r) && nameOk(r.name, kw);
  // geo 步骤：基础证据 + 名称相关性（geo 模糊结果最容易张冠李戴）
  //   + 行政区级别防线（区划中心点不是具体地点）
  //   + 住宿餐饮类防线（编造的店名 geo 会落到镇域点，宁可不给）
  const geoOk = (r) => geoNameOk(bare, r.hay)
    && geoLevelOk(bare, r.hay, r.level)
    && geoClassOk(bare, r.hay);
  const soft = (r) => baseOk(r) && geoOk(r);
  const strict = (r) => cityHit(fullCity, r.hay) && selfHit(r.hay) && levelOk(r) && geoOk(r);
  // 命中的是哪个候选城市（回传给调用方记进 item.city，下次实时定位直接用对城市）
  const tagTokens = [...tokens, ...addrCities];
  const cityTagOf = (hay) => tagTokens.find((t) => String(hay || '').indexOf(t) >= 0) || '';

  // 最后兜底的强名称匹配（不校验城市，见函数头注释 ⑧）。
  // ⚠️ 门槛：只对「无类别尾缀的独特地名」（金童路一奥天地）或
  // 「省级城市名+车站」（重庆北站）开放——「象鼻山公园」这类
  // "地标+通用尾缀"全国一堆同名，绝不全国捞，宁缺毋错（桩测试钉死）。
  const kNorm = normName(bare);
  const tailM0 = kNorm.match(GENERIC_TAIL);
  const noTail = !tailM0;
  const stemIsProvince = !!tailM0 && tailM0.index > 0
    && PROVINCE_NAMES.has(kNorm.slice(0, tailM0.index));
  const lastResortEligible = noTail || stemIsProvince;
  const strongName = (r) => {
    if (!lastResortEligible) return false;
    if (self.length && !selfHit(r.hay)) return false;  // 词根冲突照样拒
    const n = normName(r.name);
    if (!n || !kNorm) return false;
    if (n.indexOf(kNorm) >= 0) return true;            // POI 名包含完整搜索词
    if (kNorm.indexOf(n) >= 0 && n.length >= 4) return true; // 搜索词是 POI 名的更全称（金童路一奥天地 ⊇ 一奥天地）
    if (stemIsProvince) {
      const grp = TAIL_GROUPS.find((g) => g.test(tailM0[0]));
      const stem = kNorm.slice(0, tailM0.index);
      if (grp && stem.length >= 2) {
        const si = n.indexOf(stem);
        if (si >= 0 && grp.test(n)) {
          const tm = n.slice(si + stem.length).match(grp);
          if (tm && tm.index <= 1) return true;        // 重庆北站 ≈ 重庆北站(江北)
        }
      }
    }
    return false;
  };

  const steps = [];
  const seen = new Set();
  const push = (tag, fn, check) => {
    if (seen.has(tag)) return;
    seen.add(tag);
    steps.push([tag, fn, check]);
  };
  const poiStep = (tag, kw, c) => push(tag, () => searchPoi(kw, c, !!c, 5), poiOk(kw));
  candidates.forEach((c) => {
    poiStep(`poi/city:${c}`, raw, c);
    if (bare !== raw) poiStep(`poi/bare:${c}`, bare, c);
    if (short !== bare && short !== raw) poiStep(`poi/short:${c}`, short, c);
  });
  push('poi/nation-full', () => searchPoi(raw, '', false, 10), poiOk(raw));
  push('poi/nation', () => searchPoi(short || bare, '', false, 10), poiOk(short || bare));
  candidates.forEach((c) => push(`geo/city:${c}`, () => geoRaw(raw, c), soft));
  push('geo/nocity', () => geoRaw(raw, ''), soft);
  // 关键词放宽：砍掉开头 2 字再搜（「大新明仕酒店」→「明仕酒店」）。
  // 只在前面全部失败后才会轮到，且结果照样过全套校验，不会因此放错行。
  if (bare.length >= 5 && bare.slice(2).length >= 3) {
    const relax = bare.slice(2);
    candidates.forEach((c) => poiStep(`poi/relax:${c}`, relax, c));
  }
  if (self.length && candidates.length) {
    push('geo/prefixed', () => geoRaw(candidates[0] + bare, ''), strict);
  }
  push('poi/last', () => searchPoi(raw, '', false, 5), strongName);
  // geo 终极兜底：出发地「金童路一奥天地」全国 POI 都不叫这个名（高德只给
  // "重庆市两江新区金童路1号"这种地址编码），POI 强名匹配也救不了它。
  // 全国 geo + 名称相关性（公共子串 ≥3 字）做最后一搏，仍不给就放弃。
  // ⚠️ 同样受 lastResortEligible 门槛约束：「象鼻山公园」这类通用 landmark
  // 全国一堆同名，绝不全国捞（桩测试钉死「宁可不给坐标」）。
  if (lastResortEligible && kNorm.length >= 4) {
    push('geo/last', () => geoRaw(raw, ''), (r) => {
      if (self.length && !selfHit(r.hay)) return false;
      return geoNameOk(bare, r.hay) && geoLevelOk(bare, r.hay, r.level) && geoClassOk(bare, r.hay);
    });
  }

  let fallback = null;
  for (let i = 0; i < steps.length; i++) {
    const tag = steps[i][0];
    const list = await steps[i][1]();
    // 同一步可能回来多条城市也对的候选：按名称匹配强度择优，不取第一条
    const scored = list
      .map((r) => ({ r, s: nameScore(r.name, raw) }))
      .sort((a, b) => b.s - a.s);
    const hit = (scored.find((x) => steps[i][2](x.r)) || {}).r;
    if (hit) {
      console.log('[geocode] 命中 %s → %s（%s）', raw, hit.name, tag);
      return { lon: hit.lon, lat: hit.lat, matchedName: hit.name, city: cityTagOf(hit.hay) };
    }
    // 记下第一个"有结果但校验不过"的候选，便于排查是谁顶掉了正确结果
    if (!fallback && list.length) fallback = { name: list[0].name, tag };
  }

  // 全部对不上 → 坚决不给坐标：错坐标比没坐标更坑（会把人导航到外省）。
  console.warn('[geocode] 放弃「%s」：在「%s」内没找到可靠结果%s',
    raw, candidates.join('/') || '未指定城市', fallback ? `（最接近的是「${fallback.name}」，来自 ${fallback.tag}，但校验不过）` : '');
  return null;
}

/**
 * 批量地理编码（并发），返回 Map: address -> {lon, lat, matchedName}
 * @param {Array} addresses 地点名列表
 * @param {Function} [cityOf] address -> 大地名（省/市/县），可为空
 */
async function geocodeBatch(addresses, cityOf) {
  const result = new Map();
  if (!AMAP_KEY) {
    console.log('[geocode] 未配置 AMAP_KEY，跳过地理编码');
    return result;
  }
  const unique = [...new Set((addresses || []).filter(Boolean))];
  if (!unique.length) return result;

  console.log('[geocode] 开始编码 %d 个地点', unique.length);
  // 分批并发：每批 5 个。请求层有 MIN_GAP 限速，批太大也只会在队列里排队。
  const BATCH = 5;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const coords = await Promise.all(batch.map((addr) => geocodeOne(addr, cityOf ? cityOf(addr) : '')));
    batch.forEach((addr, j) => {
      if (coords[j]) result.set(addr, coords[j]);
    });
  }
  console.log('[geocode] 成功 %d/%d', result.size, unique.length);
  return result;
}

module.exports = { geocodeOne, geocodeBatch, pickCity, cityTokens, stripSuffix, cityHit, selfTokens, selfMatch, addrTokens, nameOk, geoNameOk, geoLevelOk, geoClassOk };
