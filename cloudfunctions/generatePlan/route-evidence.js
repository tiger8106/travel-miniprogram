// 距离证据只作物理下限，不把直线距离冒充实际导航时长。
// 名称与城市校验复用导航规则；查不到就保留未知，不制造坐标或站点答案。
const https = require('https');
const geo = require('./geocode');
const rail = require('./rail12306');
const { tsToDateStr } = require('./cn-time');
const cache = new Map();
const roadCache = new Map();
const reportedMapErrors = new Set();
let nextMapRequestAt = 0;

async function mapJSON(url, deadline, retry = true) {
  const delay = Math.max(0, nextMapRequestAt - Date.now());
  if (deadline - Date.now() < delay + 300) return null;
  nextMapRequestAt = Date.now() + delay + Math.max(500, Number(process.env.AMAP_MIN_GAP_MS) || 0);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const result = await new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(Math.max(300, Math.min(1800, deadline - Date.now())), () => req.destroy());
    req.on('error', () => resolve(null));
  });
  if (result && /QPS|TOO_FREQUENT/.test(result.info || '') && retry && deadline - Date.now() > 1000) {
    nextMapRequestAt = Math.max(nextMapRequestAt, Date.now() + 600);
    return mapJSON(url, deadline, false);
  }
  if (result && result.status !== '1' && !reportedMapErrors.has(result.info)) {
    reportedMapErrors.add(result.info);
    console.warn('[generatePlan.review] 地图核查不可用：%s', String(result.info || '未知接口状态'));
  }
  return result;
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  const rad = (n) => Number(n) * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function lookupPoint(name, region, deadline) {
  const key = `${name}|${region}`;
  if (cache.has(key)) return cache.get(key);
  if (!process.env.AMAP_KEY || !name || deadline - Date.now() < 500) return Promise.resolve(null);
  const city = geo.cityTokens(region).sort((a, b) => b.length - a.length)
    .find((token) => name.startsWith(token)
      && ['市', '县', '区'].some((suffix) => String(region).includes(token + suffix))) || '';
  const url = new URL('https://restapi.amap.com/v3/place/text');
  let queryName = name.replace(/(?:入口|出口)(?:附近)?$/, '');
  if (city && queryName.startsWith(city + '市')) queryName = queryName.slice(city.length + 1);
  const areaAnchor = queryName !== name;
  url.search = new URLSearchParams({ key: process.env.AMAP_KEY, keywords: queryName,
    city: city || '', citylimit: city ? 'true' : 'false', offset: '5', extensions: 'base' }).toString();
  const promise = mapJSON(url, deadline).then((parsed) => {
    const exactName = (value) => String(value || '').replace(/[\s（）()]/g, '');
    const hit = (parsed && parsed.pois || []).find((poi) => {
      const ownCity = String(poi.cityname || poi.pname || '').replace(/市$/, '');
      const explicitCity = ownCity.length >= 2 && name.startsWith(ownCity);
      return (exactName(poi.name) === exactName(queryName) || geo.nameOk(poi.name, queryName))
        && (explicitCity || geo.cityHit(region, [poi.name, poi.pname, poi.cityname, poi.adname, poi.address].join(' ')));
    });
    const [lon, lat] = String(hit && hit.location || '').split(',').map(Number);
    return hit && lon && lat ? { lon, lat, matchedName: hit.name,
      city: String(hit.cityname || hit.pname || ''), areaAnchor, source: 'amap-poi' } : null;
  });
  cache.set(key, promise);
  promise.then((value) => { if (!value) cache.delete(key); });
  return promise;
}

async function collectRoutePoints(rows, regions, deadline) {
  const names = [...new Set(rows.filter((row) => row.category === 'transport')
    .flatMap((row) => [row.startLocation, row.endLocation]).filter(Boolean))];
  const points = {};
  // 有限并发，避免大行程将地图 API 的 QPS 打满。
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, names.length) }, async () => {
    while (cursor < names.length && deadline - Date.now() > 500) {
      const name = names[cursor++];
      const point = await lookupPoint(name, regions, deadline);
      if (point) points[name] = point;
    }
  }));
  return points;
}

function geometryIssues(rows, points) {
  const issues = [];
  rows.forEach((row) => {
    if (row.category !== 'transport') return;
    const distance = distanceKm(points[row.startLocation], points[row.endLocation]);
    if (distance === null || distance < 0.4) return;
    const min = (value) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const duration = min(row.endTime) - min(row.startTime);
    const mode = row.transportType;
    // 宽松上限用于识别不可能值；山路/市区实际耗时由检索与导航确认。
    const speed = mode === 'walk' ? 6 : mode === 'train' ? 400 : /bus|ride|car/.test(mode) ? 120 : 0;
    if (speed && duration + 3 < distance / speed * 60) {
      issues.push(`${row.startLocation}→${row.endLocation}的${mode === 'walk' ? '步行' : '交通'}时长不足（地图直线距离约${distance.toFixed(1)}公里）`);
    }
  });
  return issues;
}

async function collectRailTopology(rows, deadline) {
  if (!process.env.LLM_API_KEY || process.env.RAIL12306_ENABLED === '0' || deadline - Date.now() < 3000) return [];
  // 未来未开售不能查询当日班次；仅查询当前运行网络是否支持这对车站，
  // 绝不把当前车次号/发车时刻写成未来出行的已核验班次。
  const date = tsToDateStr(Date.now());
  const segments = rows.filter((row) => row.category === 'transport' && row.transportType === 'train'
    && row.startLocation && row.endLocation).map((row) => ({
    from: row.startLocation, to: row.endLocation, mode: 'train', date,
  }));
  if (!segments.length) return [];
  const found = await rail.lookupOfficial(segments, Math.min(12000, deadline - Date.now()));
  return segments.flatMap((segment) => {
    const key = `${segment.from.replace(/\s/g, '')}→${segment.to.replace(/\s/g, '')}@${date}`;
    const meta = found.routeMeta && found.routeMeta.get(key);
    if (!meta || !meta.querySucceeded || meta.repaired) return [];
    const list = found.get(key) || [];
    const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    return [{ from: segment.from, to: segment.to, mode: 'train', direct: !!list.length,
      minMinutes: list.length ? Math.min(...list.map((train) => (minutes(train.e) - minutes(train.s) + 1440) % 1440)) : 0,
      via: [], networkOnly: true, queriedDate: date, sourceUrl: 'https://kyfw.12306.cn/otn/leftTicket/init' }];
  });
}

async function collectRoadTravelFacts(rows, points, deadline) {
  if (!process.env.AMAP_KEY) return [];
  const segments = rows.filter((row) => row.category === 'transport' && /^(?:bus|ride|car)$/.test(row.transportType)
    && points[row.startLocation] && points[row.endLocation]);
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, segments.length) }, async () => {
    while (cursor < segments.length && deadline - Date.now() > 300) {
      const row = segments[cursor++], a = points[row.startLocation], b = points[row.endLocation];
      if (distanceKm(a, b) < 2) continue;
      const key = `${a.lon},${a.lat}>${b.lon},${b.lat}`;
      let promise = roadCache.get(key);
      if (!promise) {
        const url = new URL('https://restapi.amap.com/v3/direction/driving');
        url.search = new URLSearchParams({ key: process.env.AMAP_KEY, origin: `${a.lon},${a.lat}`,
          destination: `${b.lon},${b.lat}`, extensions: 'base', strategy: '0' }).toString();
        promise = mapJSON(url, deadline).then((parsed) => {
          const paths = parsed && parsed.status === '1' ? (parsed.route && parsed.route.paths || []) : [];
          const path = paths.filter((item) => Number(item.duration) > 0)
            .sort((x, y) => Number(x.duration) - Number(y.duration))[0];
          return path ? { minMinutes: Math.ceil(Number(path.duration) / 60),
            routeKm: Math.round(Number(path.distance) / 100) / 10 } : null;
        });
        roadCache.set(key, promise);
        promise.then((value) => { if (!value) roadCache.delete(key); });
      }
      const route = await promise;
      if (route) results.push(Object.assign({ from: row.startLocation, to: row.endLocation,
        mode: row.transportType, drivingEstimate: true, sourceUrl: 'https://restapi.amap.com/v3/direction/driving' }, route));
    }
  }));
  return results;
}

async function collectUrbanTransitFacts(rows, points, deadline) {
  const results = [];
  if (!process.env.AMAP_KEY) return results;
  for (const row of rows) {
    if (row.category !== 'transport' || !/地铁|轨道交通/.test(`${row.activity} ${row.note}`)) continue;
    const a = points[row.startLocation], b = points[row.endLocation];
    if (!a || !b || !a.city || a.city !== b.city || deadline - Date.now() < 500) continue;
    const url = new URL('https://restapi.amap.com/v3/direction/transit/integrated');
    url.search = new URLSearchParams({ key: process.env.AMAP_KEY, origin: `${a.lon},${a.lat}`,
      destination: `${b.lon},${b.lat}`, city: a.city, strategy: '0' }).toString();
    const parsed = await mapJSON(url, deadline);
    const paths = parsed && parsed.status === '1' ? (parsed.route && parsed.route.transits || []) : [];
    const route = paths.filter((item) => Number(item.duration) > 0).sort((x, y) => Number(x.duration) - Number(y.duration))[0];
    if (!route) continue;
    const lines = (route.segments || []).flatMap((segment) => {
      const line = (segment.bus && segment.bus.buslines || [])[0];
      return line ? [`${line.name}：${line.departure_stop.name}→${line.arrival_stop.name}`] : [];
    });
    results.push({ from: row.startLocation, to: row.endLocation, mode: 'bus',
      minMinutes: Math.ceil(Number(route.duration) / 60), transitEstimate: true,
      summary: lines.join('；').slice(0, 220), sourceUrl: 'https://restapi.amap.com/v3/direction/transit/integrated' });
  }
  return results;
}

module.exports = { distanceKm, lookupPoint, collectRoutePoints, geometryIssues, collectRailTopology, collectRoadTravelFacts, collectUrbanTransitFacts };
