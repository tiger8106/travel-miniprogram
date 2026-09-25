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

const https = require('https');

const AMAP_KEY = process.env.AMAP_KEY || '';
const GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/geo';
const POI_URL = 'https://restapi.amap.com/v3/place/text';
const REQUEST_TIMEOUT = 10 * 1000;

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
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
  });
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
 * 从地点名自身提取行政区词根：「大新县硕龙镇」→ [{t:'大新',suf:'县'},{t:'硕龙',suf:'镇'}]。
 * 用途：结果校验的另一半证据。行程城市词是"当天住哪"，跨景区的条目
 * （如住在桂林那天写去大新县硕龙镇）经常对不上——但正确结果里一定
 * 含有「大新县」「硕龙镇」这些地点自带的行政区名。
 * ⚠️ 匹配时要求词根 + 原后缀（"大新县"而不是裸"大新"）：
 *    否则"桂林市大新水库"里的"大新"也会蒙混过关（桩测试实测踩过）。
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

/**
 * POI 名与搜索词是不是"同一件事"：
 * 高德 citylimit 内的模糊搜索会返回**同名结构的别家**——实测翻车：
 *   搜「崇左南站」（city=桂林）→ 返回「桂林南站」
 *   搜「崇左游客集散中心」→ 返回桂林荔浦的「游客集散中心」
 * 城市校验拦不住（结果确实在候选城市里），必须加名称相关性锁：
 *   · POI 名包含搜索词（「象鼻山」⊂「象鼻山景区」）→ 放行
 *   · 或搜索词砍掉通用尾缀后的核心词出现在 POI 名里
 *     （「崇左南站」核心「崇左」∉「桂林南站」→ 拒；「南宁东站」核心「南宁东」∈ 同名 → 放）
 * 比较前把「·」等装饰符抹掉（「印象刘三姐」vs「印象·刘三姐」）。
 * 拦错比放对更重要：错坐标会把人导航到错误城市。
 */
const GENERIC_TAIL = /(风景名胜区|游客集散中心|旅游集散中心|集散中心|游客中心|游客服务中心|服务中心|客运站|枢纽站|火车站|高铁站|候机楼|东站|南站|西站|北站|风景区|景区|度假区|大酒店|饭店|酒店|宾馆|公园|广场|中心|码头|渡口|机场|大桥|学校|大学|学院|医院|商场|市场|超市|大楼|大厦|站)+$/;
function nameOk(poiName, keyword) {
  const n = String(poiName || '').replace(/[·\s\-（）()【】\[\]]/g, '');
  const k = String(keyword || '').replace(/[·\s\-（）()【】\[\]]/g, '');
  if (!n || !k) return true;                       // 没名可比就不加这道锁
  if (n.indexOf(k) >= 0) return true;              // POI 名包含搜索词（更具体的全称）
  const core = k.replace(GENERIC_TAIL, '');
  return core.length >= 2 && n.indexOf(core) >= 0; // 核心词命中才算同一件事
}

/** POI 关键词搜索（v3/place/text）。citylimit=true 时城市是硬限制，不会串到外省。 */
async function searchPoi(keywords, city, citylimit, size) {
  if (!AMAP_KEY || !keywords) return [];
  let url = `${POI_URL}?keywords=${encodeURIComponent(keywords)}&key=${AMAP_KEY}` +
    `&offset=${size || 10}&page=1&output=json&extensions=base`;
  if (city) url += `&city=${encodeURIComponent(city)}`;
  if (city && citylimit) url += '&citylimit=true';
  try {
    const resp = await httpGet(url);
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
    }).filter(Boolean)
      .filter((p) => nameOk(p.name, keywords));
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
    const resp = await httpGet(url);
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
 *   ③ 全国搜，逐条挑城市            —— 城市名不标准（如片区名）时的兜底
 *   ④ 地理编码（逐个候选城市提示）
 *   ⑤ 地理编码（不带 city）
 *   ⑥ 关键词放宽（砍掉开头 2 字）    —— 「大新明仕酒店」→「明仕酒店」
 *   ⑦ 地理编码（城市名拼进地址）    —— ⚠️ 只在地址自带行政区词根时启用，
 *      且结果必须命中词根才采纳
 *
 * 城市候选（2026-09-25 v2.2）：以前只拿 region 串里**第一个**城市词做 city，
 * 跨城行程（桂林那天的条目写「南宁东站」「崇左南站」「大新明仕酒店」）全部
 * 定位失败或乱定位。现在 region 串里每个城市词都当候选试一遍（最多 4 个），
 * 校验仍是"任一城市命中即放行"。
 *
 * 校验（两层证据）：
 *   a. 行程城市词（「广西 桂林 阳朔」整串，任一城市命中）
 *   b. 地点自身词根（「大新县硕龙镇」→ 大新/硕龙）——跨景区条目的
 *      当天城市常常对不上（住在桂林、去大新县玩）。地址带词根时
 *      **只认 b 不认 a**：错坐标的行政区里恰恰含着行程城市词，
 *      拿它放行等于自己验证自己。
 *
 * ⚠️ 为什么 ⑦ 这么严：曾经「大新县硕龙镇」在城市限定下搜不到，
 *    兜底把城市词拼成「桂林大新县硕龙镇」发给高德，返回桂林方向的
 *    错坐标，而校验用的又是同一个城市词——自己验证自己，直接放行，
 *    定位从桂西南的德天瀑布跑到了广西东北角。结果必须含有地点
 *    自身的词根（大新/硕龙）才可能是对的。
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
  const tokens = cityTokens(city);
  // 候选城市：region 串里每个非省份词都可能是本条所在城市，逐个试
  const candidates = tokens.filter((t) => !PROVINCE_NAMES.has(t)).slice(0, 4);
  // 括号补注（「锦江都城酒店（桂林两江四湖象山景区店）」）常拖垮 POI 搜索，
  // 且括号里的「…景区店」会给 selfTokens 造出垃圾词根——先剥掉
  const bare = String(address).replace(/[（(][^）)]*[）)]/g, '').trim() || String(address).trim();
  const short = stripSuffix(bare);
  const self = selfTokens(bare);

  // geo 结果的级别防线：地址自带行政区词根（县/镇级）时，
  // 级别还停在"省/市"说明高德只给了个片区中心点，多半是错的
  const levelOk = (r) => !self.length || !/^(省|城市|市)$/.test(r.level || '');

  // ⚠️ self 为空时绝不能走 selfHit —— 要把"没有词根"和"词根不命中"区分开：
  // 前者退回城市校验（老行为），后者必须拒绝
  const selfHit = (hay) => self.length > 0 && selfMatch(self, hay);
  // 地址自带行政区词根时（大新县硕龙镇），城市证据不能单独放行：
  // 桂林方向的错坐标 hay 里就含"桂林"，正是它把定位骗到广西东北角的。
  // 此时必须以地点自身词根为准；没有词根才退回老的城市校验。
  const soft = (r) => (self.length ? selfHit(r.hay) : cityHit(city, r.hay)) && levelOk(r);
  const strict = (r) => cityHit(city, r.hay) && selfHit(r.hay) && levelOk(r);
  // 命中的是哪个候选城市（回传给调用方记进 item.city，下次实时定位直接用对城市）
  const cityTagOf = (hay) => tokens.find((t) => String(hay || '').indexOf(t) >= 0) || '';

  const steps = [];
  const seen = new Set();
  const push = (tag, fn, check) => {
    if (seen.has(tag)) return;
    seen.add(tag);
    steps.push([tag, fn, check]);
  };
  candidates.forEach((c) => {
    push(`poi/city:${c}`, () => searchPoi(address, c, true, 5), soft);
    if (bare !== address) push(`poi/bare:${c}`, () => searchPoi(bare, c, true, 5), soft);
    if (short !== bare && short !== address) push(`poi/short:${c}`, () => searchPoi(short, c, true, 5), soft);
  });
  push('poi/nation', () => searchPoi(short || bare, '', false, 10), soft);
  candidates.forEach((c) => push(`geo/city:${c}`, () => geoRaw(address, c), soft));
  push('geo/nocity', () => geoRaw(address, ''), soft);
  // 关键词放宽：砍掉开头 2 字再搜（「大新明仕酒店」→「明仕酒店」）。
  // 只在前面全部失败后才会轮到，且结果照样过城市校验，不会因此放错行。
  if (bare.length >= 5 && bare.slice(2).length >= 3) {
    const relax = bare.slice(2);
    candidates.forEach((c) => push(`poi/relax:${c}`, () => searchPoi(relax, c, true, 5), soft));
  }
  if (self.length && candidates.length) {
    push('geo/prefixed', () => geoRaw(candidates[0] + bare, ''), strict);
  }

  let fallback = null;
  for (let i = 0; i < steps.length; i++) {
    const tag = steps[i][0];
    const list = await steps[i][1]();
    const hit = list.find(steps[i][2]);
    if (hit) {
      console.log('[geocode] 命中 %s → %s（%s）', address, hit.name, tag);
      return { lon: hit.lon, lat: hit.lat, matchedName: hit.name, city: cityTagOf(hit.hay) };
    }
    // 记下第一个"有结果但校验不过"的候选，便于排查是谁顶掉了正确结果
    if (!fallback && list.length) fallback = { name: list[0].name, tag };
  }

  // 全部对不上 → 坚决不给坐标：错坐标比没坐标更坑（会把人导航到外省）。
  // 没给任何可校验的词时 cityHit 恒为 true，能走到这儿说明压根没查到候选。
  console.warn('[geocode] 放弃「%s」：在「%s」内没找到可靠结果%s',
    address, candidates.join('/') || '未指定城市', fallback ? `（最接近的是「${fallback.name}」，来自 ${fallback.tag}，但校验不过）` : '');
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
  // 分批并发：每批 5 个。策略变多后单个地点可能发多次请求，
  // 批太大容易触发高德 QPS 限制。
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

module.exports = { geocodeOne, geocodeBatch, pickCity, cityTokens, stripSuffix, cityHit, selfTokens, selfMatch };
