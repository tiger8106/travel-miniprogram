// cloudfunctions/parseTravelPlan/geocode.js
// 高德 Web 服务地理编码（服务端调用，不需要小程序端配置域名白名单）
// 文档: https://lbs.amap.com/api/webservice/guide/api/georegeo
//
// 需要在云函数环境变量配置 AMAP_KEY（类型：Web服务）
// 没有配置时静默跳过，行程项里就没有坐标，前端会走“复制路线”降级。

const https = require('https');

const AMAP_KEY = process.env.AMAP_KEY || '';
const GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/geo';
const REQUEST_TIMEOUT = 10 * 1000;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('geocode 响应解析失败: ' + data.slice(0, 120)));
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('geocode 超时')));
    req.on('error', reject);
  });
}

/**
 * 单个地点 → { lon, lat } | null
 * @param {string} address 地点名
 * @param {string} [city] 大地名（省/市/县），帮助消歧：全国同名地点太多
 *   （"龙脊梯田""西山""人民公园"），不带城市可能定位到别的省去。
 *   只加 city 参数做优先级提示，不加 citylimit——跨城交通（车站/机场在邻市）不会被误杀。
 */
async function geocodeOne(address, city) {
  if (!AMAP_KEY || !address) return null;
  try {
    let url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${AMAP_KEY}&output=json`;
    if (city) url += `&city=${encodeURIComponent(city)}`;
    const resp = await httpGet(url);
    if (resp.status === '1' && resp.geocodes && resp.geocodes.length) {
      const loc = resp.geocodes[0].location; // "lon,lat"
      const [lon, lat] = loc.split(',').map(Number);
      if (lon && lat) return { lon, lat };
    }
    return null;
  } catch (e) {
    console.error('[geocode] 失败:', address, e.message);
    return null;
  }
}

/**
 * 批量地理编码（并发），返回 Map: address -> {lon, lat}
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
  // 分批并发，每批 10 个，避免触发高德 QPS 限制
  const BATCH = 10;
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

module.exports = { geocodeOne, geocodeBatch };
