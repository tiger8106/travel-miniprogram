// cloudfunctions/generatePlan/geocode.js
// 高德 Web 服务（与 parseTravelPlan/geocode.js 同一份实现）：地点名 → 经纬度（服务端调用，不需要小程序端配域名白名单）
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
 * 从「广西 桂林 阳朔」这类大地名里挑出最适合给高德的城市词：
 * 第一个不是省份的词，并去掉「市/县/区」等行政后缀（桂林市 → 桂林）。
 * 挑不到就返回空（让高德自己猜，总比塞个错参数强）。
 */
function pickCity(region) {
  const tokens = String(region || '').split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean);
  const raw = tokens.find((t) => !PROVINCE_NAMES.has(t.replace(/(省|市|自治区|特别行政区)$/, ''))) || tokens[0] || '';
  return raw.replace(/(省|市|自治区|特别行政区|地区|自治州|县|区|旗|盟)$/, '') || raw;
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
 * 城市校验：返回结果是不是真的在期望的城市里。
 * 比对范围放宽到 省+市+区县+详细地址+POI 名，这样「龙脊梯田」这类
 * 片区名（不是行政区名）也能靠详细地址命中。
 * 没给城市时不校验（true），保持老行为。
 */
function cityHit(city, hay) {
  const c = pickCity(city);
  if (!c) return true;
  return String(hay || '').indexOf(c) >= 0;
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
    }).filter(Boolean);
  } catch (e) {
    console.error('[geocode] POI 搜索失败:', keywords, e.message);
    return [];
  }
}

/** 地理编码（v3/geocode/geo）。city 只是优先级提示，必须配合 cityHit 校验。 */
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
        hay: [g.province, g.city, g.district, g.formatted_address, g.building, g.neighborhood].join('|'),
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('[geocode] 地理编码失败:', address, e.message);
    return [];
  }
}

/**
 * 单个地点 → { lon, lat, matchedName } | null
 *
 * 多策略依次尝试，每条结果都要过城市校验，命中就返回：
 *   ① POI 搜索（限城市）            —— 最准，返回的是真实存在的 POI
 *   ② 砍掉自造后缀再搜（限城市）    —— 解决「象鼻山公园」搜不到的问题
 *   ③ 砍掉后缀全国搜，逐条挑城市    —— 城市名不标准（如片区名）时的兜底
 *   ④ 地理编码（带 city 提示）
 *   ⑤ 地理编码（城市名拼进地址）
 *
 * 全部对不上城市 → 返回 null。宁可让前端降级成"复制地名"，
 * 也不能给用户一个错误城市的坐标（导航导到外省比打不开更糟）。
 *
 * @param {string} address 地点名
 * @param {string} [city]  大地名（可以是「广西 桂林」整串，内部会自动挑城市词）
 */
async function geocodeOne(address, city) {
  if (!AMAP_KEY || !address) return null;
  const c = pickCity(city);
  const short = stripSuffix(address);

  const steps = [
    ['poi/city', () => searchPoi(address, c, true, 5)],
    short !== address ? ['poi/city-short', () => searchPoi(short, c, true, 5)] : null,
    ['poi/nation', () => searchPoi(short || address, '', false, 10)],
    ['geo/city', () => geoRaw(address, c)],
    c ? ['geo/prefixed', () => geoRaw(c + address, '')] : null,
  ].filter(Boolean);

  let fallback = null;
  for (let i = 0; i < steps.length; i++) {
    const tag = steps[i][0];
    const list = await steps[i][1]();
    const hit = list.find((x) => cityHit(c, x.hay));
    if (hit) {
      console.log('[geocode] 命中 %s → %s（%s）', address, hit.name, tag);
      return { lon: hit.lon, lat: hit.lat, matchedName: hit.name };
    }
    // 记下第一个"有结果但城市不对"的候选，便于排查是谁顶掉了正确结果
    if (!fallback && list.length) fallback = { name: list[0].name, tag };
  }

  // 全部对不上城市 → 坚决不给坐标：错坐标比没坐标更坑（会把人导航到外省）。
  // 没给城市时 cityHit 恒为 true，能走到这儿说明压根没查到任何候选。
  console.warn('[geocode] 放弃「%s」：在「%s」内没找到可靠结果%s',
    address, c || '未指定城市', fallback ? `（最接近的是「${fallback.name}」，来自 ${fallback.tag}，但城市对不上）` : '');
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

module.exports = { geocodeOne, geocodeBatch, pickCity, stripSuffix, cityHit };
