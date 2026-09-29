// 12306 官方班次查询
//
// 车次与时刻是按日期变化的事实数据，不能由大模型或搜索摘要代替。
// 本文件只依赖 Node 内置 https，云函数部署时不需要额外安装依赖。

const https = require('https');

const BASE = 'https://kyfw.12306.cn';
const STATION_URL = `${BASE}/otn/resources/js/framework/station_name.js`;
const INIT_URL = `${BASE}/otn/leftTicket/init`;
const QUERY_URL = `${BASE}/otn/leftTicket/queryG`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TRAIN_CODE_RE = /^(?:[A-Za-z]{1,3})?\d{1,5}$/;
const STATION_TTL_MS = 24 * 3600 * 1000;
const ROUTE_TTL_MS = 5 * 60 * 1000;

let stationCache = null;
const routeCache = new Map();

function now() { return Date.now(); }

function segmentKey(seg) {
  if (seg && seg.scheduleKey) return String(seg.scheduleKey);
  return `${String(seg && seg.from || '').trim().replace(/\s+/g, '')}→${String(seg && seg.to || '').trim().replace(/\s+/g, '')}@${String(seg && seg.date || '').trim() || '无日期'}`;
}

function requestText(url, headers, timeoutMs, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (compatible; TravelMiniProgram/1.0)',
        Accept: '*/*',
      }, headers || {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const location = res.headers.location;
        if (location && res.statusCode >= 300 && res.statusCode < 400 && redirects < 2) {
          requestText(new URL(location, url).toString(), headers, timeoutMs, redirects + 1)
            .then(resolve, reject);
          return;
        }
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body,
        });
      });
    });
    req.setTimeout(Math.max(2500, timeoutMs || 8000), () => {
      req.destroy(new Error(`12306 请求超时（${timeoutMs || 8000}ms）`));
    });
    req.on('error', reject);
  });
}

function stationKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(?:高铁|动车|火车|铁路)?站$/, '')
    .replace(/市$/, '');
}

function cityKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/(?:市|地区|自治州|盟)$/, '')
    .replace(/省$/, '');
}

function parseStations(text) {
  const m = /station_names\s*=\s*'([\s\S]*?)'/.exec(String(text || ''));
  if (!m) throw new Error('12306 站点字典格式变更');
  const out = [];
  m[1].split('@').forEach((raw) => {
    if (!raw) return;
    const p = raw.split('|');
    if (!p[1] || !p[2]) return;
    out.push({
      name: p[1],
      code: p[2],
      city: p[7] || '',
    });
  });
  if (!out.length) throw new Error('12306 站点字典为空');
  return out;
}

async function getStations(deadlineAt) {
  if (stationCache && stationCache.expireAt > now()) return stationCache.list;
  const left = Math.max(3000, Math.min(10000, (deadlineAt || now() + 10000) - now()));
  const res = await requestText(STATION_URL, {}, left);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`12306 站点字典 HTTP ${res.statusCode}`);
  }
  const list = parseStations(res.body);
  stationCache = { list, expireAt: now() + STATION_TTL_MS };
  return list;
}

function splitStationLabel(label) {
  return String(label || '')
    .split(/[\/／,，、;；|]/)
    .flatMap((x) => x.split(/(?:或者|或)/))
    .map((x) => x.trim())
    .filter(Boolean);
}

function resolveStationCandidates(label, stations, limit = 6) {
  const result = [];
  const seen = new Set();
  splitStationLabel(label).forEach((part) => {
    const key = stationKey(part);
    if (key.length < 2) return;
    const scored = stations.map((s) => {
      const sk = stationKey(s.name);
      let score = -1;
      if (sk === key) score = 100000 + sk.length;
      else if (key.endsWith(sk) && sk.length >= 2) score = 80000 + sk.length;
      else if (key.includes(sk) && sk.length >= 2) score = 60000 + sk.length;
      else if (sk.endsWith(key) && key.length >= 2) score = 40000 + key.length;
      return { s, score };
    }).filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
    scored.slice(0, limit).forEach(({ s }) => {
      if (!seen.has(s.code)) {
        seen.add(s.code);
        result.push(s);
      }
    });
  });
  return result;
}

function stationsInCity(city, stations, limit = 8) {
  // 大纲的 city 偶尔是“成都/都江堰/理县”这样的行程范围串，
  // 只取第一个城市作为当天站点修复的主城市，避免把三个城市的车站混查。
  const key = cityKey(splitStationLabel(city)[0] || city);
  if (key.length < 2) return [];
  return stations.filter((s) => cityKey(s.city) === key)
    .map((s) => {
      const nameKey = stationKey(s.name);
      const score = nameKey === key ? 100 : (nameKey.startsWith(key) ? 90 : 50);
      return { s, score };
    })
    .sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s)
    .slice(0, limit);
}

function cityFromLabel(label, stations) {
  const raw = String(label || '').replace(/\s+/g, '');
  if (!raw) return '';
  const cities = [...new Set(stations.map((s) => cityKey(s.city)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return cities.find((c) => c.length >= 2 && (raw.includes(`${c}市`) || raw.includes(c))) || '';
}

function sameCity(a, b) {
  const ak = cityKey(a);
  return !!ak && splitStationLabel(b).some((x) => cityKey(x) === ak);
}

/**
 * 将模型给出的站点名变成可查询的站点对。
 * 常规情况直接查；若一端是道路站名一类非铁路地点，则利用当天城市和另一端
 * 已识别的铁路站修复方向。规则只看站点字典和输入结构，不写具体城市特例。
 */
function routePairs(segment, stations) {
  let from = resolveStationCandidates(segment.from, stations);
  let to = resolveStationCandidates(segment.to, stations);
  let repaired = false;
  const dayCity = String(segment.dayCity || '').trim();

  if (from.length && !to.length && dayCity) {
    const knownCity = from[0].city;
    if (!sameCity(knownCity, dayCity)) {
      const dayStations = stationsInCity(dayCity, stations);
      if (dayStations.length) {
        // 已识别的一端是出发站、另一端是当天目的地区域里的非铁路地点：
        // 只把当天区域的铁路站补到“到达端”，不能把方向反过来。
        to = dayStations;
        repaired = true;
      }
    }
  }
  if (!from.length && to.length && dayCity) {
    const knownCity = to[0].city;
    if (!sameCity(knownCity, dayCity)) {
      const dayStations = stationsInCity(dayCity, stations);
      if (dayStations.length) {
        // 已识别的一端是到达站、另一端是当天出发地区域里的非铁路地点：
        // 补到“出发端”，保持用户/大纲原来的行进方向。
        from = dayStations;
        repaired = true;
      }
    }
  }
  if (!from.length && dayCity && segment.origin) {
    const originCity = cityFromLabel(segment.origin, stations);
    if (originCity) from = stationsInCity(originCity, stations);
  }
  if (!to.length && segment.destinationCity) {
    to = stationsInCity(segment.destinationCity, stations);
  }

  const pairs = [];
  from.slice(0, 8).forEach((f) => {
    to.slice(0, 8).forEach((t) => {
      if (f.code !== t.code) pairs.push({ from: f, to: t, repaired });
    });
  });
  return pairs;
}

function decodePart(value) {
  try { return decodeURIComponent(String(value || '')); } catch (e) { return String(value || ''); }
}

function parseResultRecord(raw, stationsByCode, requestedDate) {
  const fields = decodePart(raw).split('|');
  if (fields.length < 10) return null;
  const code = String(fields[3] || '').trim().toUpperCase();
  const fromCode = String(fields[6] || '').trim();
  const toCode = String(fields[7] || '').trim();
  const s = String(fields[8] || '').trim();
  const e = String(fields[9] || '').trim();
  if (!TRAIN_CODE_RE.test(code) || !fromCode || !toCode || !TIME_RE.test(s) || !TIME_RE.test(e)) return null;
  const compactDate = String(requestedDate || '').replace(/-/g, '');
  if (compactDate && fields[13] && fields[13] !== compactDate) return null;
  if (e <= s) return null;
  const from = stationsByCode.get(fromCode);
  const to = stationsByCode.get(toCode);
  if (!from || !to) return null;
  return {
    code,
    from: from.name,
    to: to.name,
    s,
    e,
    source: '12306',
    trainNo: fields[2] || '',
  };
}

async function initSession(deadlineAt) {
  const left = Math.max(3000, Math.min(9000, (deadlineAt || now() + 9000) - now()));
  const res = await requestText(INIT_URL, {
    Referer: `${BASE}/otn/leftTicket/init`,
  }, left);
  const raw = res.headers['set-cookie'] || [];
  const cookies = (Array.isArray(raw) ? raw : [raw])
    .map((x) => String(x).split(';')[0])
    .filter(Boolean)
    .join('; ');
  return cookies;
}

async function queryRoute(pair, date, cookie, stationsByCode, deadlineAt) {
  const key = `${date}|${pair.from.code}|${pair.to.code}`;
  const cached = routeCache.get(key);
  if (cached && cached.expireAt > now()) return cached.list;
  const left = Math.max(3000, Math.min(9000, (deadlineAt || now() + 9000) - now()));
  const u = new URL(QUERY_URL);
  u.searchParams.set('leftTicketDTO.train_date', date);
  u.searchParams.set('leftTicketDTO.from_station', pair.from.code);
  u.searchParams.set('leftTicketDTO.to_station', pair.to.code);
  u.searchParams.set('purpose_codes', 'ADULT');
  const res = await requestText(u.toString(), {
    Cookie: cookie,
    Referer: `${BASE}/otn/leftTicket/init`,
    Accept: 'application/json, text/plain, */*',
  }, left);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`12306 查询 HTTP ${res.statusCode}`);
  let data;
  try { data = JSON.parse(res.body); } catch (e) { throw new Error('12306 查询返回非 JSON'); }
  if (!data || data.status !== true || !data.data || !Array.isArray(data.data.result)) {
    throw new Error('12306 未返回有效查询结果，不能将接口失败当作无直达车');
  }
  const rows = data && data.data && Array.isArray(data.data.result) ? data.data.result : [];
  const list = [];
  const seen = new Set();
  rows.forEach((row) => {
    const item = parseResultRecord(row, stationsByCode, date);
    if (!item) return;
    if (item.from !== pair.from.name || item.to !== pair.to.name) return;
    const dedupe = `${item.code}|${item.s}|${item.e}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    list.push(item);
  });
  list.sort((a, b) => a.s.localeCompare(b.s));
  const limited = list.slice(0, 48);
  routeCache.set(key, { list: limited, expireAt: now() + ROUTE_TTL_MS });
  return limited;
}

function isRailSegment(segment) {
  return /train|高铁|动车|火车/.test(String(segment && segment.mode || '').toLowerCase());
}

/**
 * 按日期查所有铁路段。返回 Map，同时挂 routeMeta 保存因站名修复后的真实路线。
 * 即使查不到也写入空数组和 attempted=true，上层据此清掉模型臆造的车次。
 */
async function lookupOfficial(segments, deadlineMs) {
  const found = new Map();
  found.routeMeta = new Map();
  const rail = (segments || []).filter(isRailSegment);
  if (!rail.length) return found;
  const deadlineAt = now() + Math.max(3000, Number(deadlineMs) || 20000);
  let stations;
  try {
    stations = await getStations(deadlineAt);
  } catch (e) {
    rail.forEach((seg) => {
      const k = segmentKey(seg);
      found.set(k, []);
      found.routeMeta.set(k, { attempted: true, official: true, reason: e.message });
    });
    console.warn('[generatePlan.12306] 站点字典失败：%s', e.message);
    return found;
  }
  const byCode = new Map(stations.map((s) => [s.code, s]));
  let cookie = '';
  try { cookie = await initSession(deadlineAt); } catch (e) {
    console.warn('[generatePlan.12306] 查询会话失败：%s', e.message);
  }

  await Promise.all(rail.map(async (seg) => {
    const key = segmentKey(seg);
    const meta = { attempted: true, official: true, from: '', to: '', repaired: false };
    found.routeMeta.set(key, meta);
    const pairs = routePairs(seg, stations);
    if (!pairs.length) {
      meta.unresolvedStations = true;
      found.set(key, []);
      console.warn('[generatePlan.12306] 无法把站点解析为铁路站：%s→%s', seg.from, seg.to);
      return;
    }
    if (!cookie || !DATE_RE.test(String(seg.date || ''))) {
      found.set(key, []);
      return;
    }
    const results = await Promise.allSettled(pairs.map((pair) =>
      queryRoute(pair, seg.date, cookie, byCode, deadlineAt)));
    meta.querySucceeded = results.some((result) => result.status === 'fulfilled');
    meta.queriedDate = seg.date;
    let best = null;
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value.length) return;
      const pair = pairs[i];
      if (!best || r.value.length > best.list.length) best = { pair, list: r.value };
    });
    if (!best) {
      found.set(key, []);
      const firstError = results.find((r) => r.status === 'rejected');
      if (firstError && !meta.querySucceeded) meta.reason = firstError.reason.message;
      if (firstError) console.warn('[generatePlan.12306] %s→%s 查询失败：%s', seg.from, seg.to, firstError.reason.message);
      return;
    }
    meta.from = best.pair.from.name;
    meta.to = best.pair.to.name;
    meta.repaired = !!best.pair.repaired;
    found.set(key, best.list);
    console.log('[generatePlan.12306] %s→%s %s 命中 %d 班（实际路线 %s→%s）',
      seg.from, seg.to, seg.date, best.list.length, meta.from, meta.to);
  }));
  return found;
}

function resetCaches() {
  stationCache = null;
  routeCache.clear();
}

module.exports = {
  getStations,
  lookupOfficial,
  parseStations,
  resolveStationCandidates,
  routePairs,
  resetCaches,
};
