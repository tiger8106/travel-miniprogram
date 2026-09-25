// scripts/test-geocode.js
// 地点定位（地理编码）回归：城市消歧到底拦不拦得住"导到外省"这种事故。
//
// 默认跑**离线桩测试**（不需要高德 Key，把 https.get 换成假响应）：
//   node scripts/test-geocode.js
// 想拿真实高德验一遍（需要 .env.local 里有 AMAP_KEY）：
//   node scripts/test-geocode.js --live
//
// 背景：高德的 city 参数只是"优先提示"，不是硬限制。
// 「象鼻山公园」在桂林其实叫「象鼻山」，桂林搜不到这个词，
// 高德就全国兜底返回江西省南昌县的象鼻山公园 —— 导航直接把人导去了南昌。

const EventEmitter = require('events').EventEmitter;
const https = require('https');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); } else {
    fail++;
    console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

// ---------------------------------------------------------------- 桩
/**
 * 把 https.get 换成假实现
 * @param {Array} routes [{ match: (raw:string)=>boolean, resp: object }]
 */
function stubHttp(routes) {
  https.get = function (url, cb) {
    const raw = decodeURIComponent(String(url));
    const r = routes.find((x) => x.match(raw));
    const payload = r ? r.resp : { status: '0' };
    const res = new EventEmitter();
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    process.nextTick(() => {
      cb(res);
      res.emit('data', JSON.stringify(payload));
      res.emit('end');
    });
    return req;
  };
}

const poi = (name, loc, city, ad, addr) => ({
  name, location: loc, cityname: city, adname: ad, address: addr, pname: '',
});
const geo = (loc, prov, city, dist, fmt) => ({
  location: loc, province: prov, city, district: dist, formatted_address: fmt,
});

// ---------------------------------------------------------------- 纯函数
process.env.AMAP_KEY = process.env.AMAP_KEY || 'TEST_KEY';
const G = require('../cloudfunctions/parseTravelPlan/geocode');

console.log('\n【1】纯函数：城市词挑选 / 后缀清理 / 城市校验');
ok(G.pickCity('广西 桂林 阳朔') === '桂林', '从「广西 桂林 阳朔」挑出城市词', G.pickCity('广西 桂林 阳朔'));
ok(G.pickCity('桂林市') === '桂林', '去掉行政后缀（桂林市 → 桂林）', G.pickCity('桂林市'));
ok(G.pickCity('') === '', '空输入不炸');
ok(G.stripSuffix('象鼻山公园') === '象鼻山', '砍掉自造后缀：象鼻山公园 → 象鼻山', G.stripSuffix('象鼻山公园'));
ok(G.stripSuffix('龙脊梯田景区') === '龙脊梯田', '砍掉自造后缀：龙脊梯田景区 → 龙脊梯田');
ok(G.stripSuffix('中山公园') === '中山公园', '砍完不足 3 字就不砍（中山公园别变中山）', G.stripSuffix('中山公园'));
ok(G.stripSuffix('桂林北站') === '桂林北站', '车站名不动');
ok(G.cityHit('桂林', '广西壮族自治区|桂林市|秀峰区|民主路|象鼻山') === true, '桂林的结果算命中');
ok(G.cityHit('桂林', '江西省|南昌市|南昌县|象鼻山公园') === false, '南昌的结果不算命中');
ok(G.cityHit('龙脊梯田', '广西壮族自治区|桂林市|龙脊梯田景区') === true, '片区名靠详细地址也能命中');
ok(G.cityHit('', 'anything') === true, '没给城市时不校验（老行为）');

// ---------------------------------------------------------------- 桩测试
const realGet = https.get;

async function caseA() {
  // 桂林市内搜「象鼻山公园」搜不到（当地叫「象鼻山」），
  // 砍掉后缀再搜就命中；同时高德全国兜底给的是南昌的象鼻山公园 —— 必须被拦掉
  stubHttp([
    {
      match: (u) => u.includes('place/text') && u.includes('keywords=象鼻山公园'),
      resp: { status: '1', pois: [] },
    },
    {
      match: (u) => u.includes('place/text') && u.includes('keywords=象鼻山'),
      resp: { status: '1', pois: [poi('象鼻山', '110.29,25.27', '桂林市', '秀峰区', '民主路1号')] },
    },
    {
      match: (u) => u.includes('geocode/geo'),
      resp: { status: '1', geocodes: [geo('115.92,28.55', '江西省', '南昌市', '南昌县', '江西省南昌县象鼻山公园')] },
    },
  ]);
  return G.geocodeOne('象鼻山公园', '广西 桂林');
}

async function caseB() {
  // 全城都搜不到，高德只给得出南昌那个 → 宁可不给坐标
  stubHttp([
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('geocode/geo'),
      resp: { status: '1', geocodes: [geo('115.92,28.55', '江西省', '南昌市', '南昌县', '江西省南昌县象鼻山公园')] },
    },
  ]);
  return G.geocodeOne('象鼻山公园', '广西 桂林');
}

async function caseC() {
  // 老行程没有城市信息：沿用高德给的第一个结果（不能因为校验而全丢）
  stubHttp([
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('geocode/geo'),
      resp: { status: '1', geocodes: [geo('110.29,25.27', '广西壮族自治区', '桂林市', '秀峰区', '广西壮族自治区桂林市象鼻山')] },
    },
  ]);
  return G.geocodeOne('象鼻山', '');
}

async function caseD() {
  // 跨城交通：终点「南宁东站」不在当天城市（桂林）里，
  // 但 cityOf 已经按地址里的城市名修正成南宁 → 应该能正常定位
  stubHttp([
    {
      match: (u) => u.includes('place/text') && u.includes('city=南宁'),
      resp: { status: '1', pois: [poi('南宁东站', '108.42,22.82', '南宁市', '青秀区', '凤岭北路')] },
    },
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [] } },
  ]);
  return G.geocodeOne('南宁东站', '南宁');
}

(async () => {
  console.log('\n【2】策略链路（桩模拟高德响应）');
  const a = await caseA();
  ok(a && a.lon === 110.29 && a.lat === 25.27, '「象鼻山公园」@桂林 → 定位到桂林的象鼻山（不是南昌那个）', a);

  const b = await caseB();
  ok(b === null, '桂林里确实搜不到时：宁可不给坐标，也不返回南昌的', b);

  const c = await caseC();
  ok(c && c.lon === 110.29, '没城市信息时仍按老行为返回第一个结果', c);

  const d = await caseD();
  ok(d && d.lon === 108.42, '跨城终点「南宁东站」能定位（城市已按地址修正）', d);

  https.get = realGet;

  // ---------------------------------------------------------------- 真跑
  if (process.argv.includes('--live')) {
    console.log('\n【3】真实高德验证');
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '..', '.env.local');
    if (fs.existsSync(envPath)) {
      fs.readFileSync(envPath, 'utf8').split('\n').forEach((l) => {
        const m = l.trim().match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      });
    }
    if (!process.env.AMAP_KEY) {
      console.log('  ⚠️ 没有 AMAP_KEY，跳过（在 .env.local 里配上再跑 --live）');
    } else {
      delete require.cache[require.resolve('../cloudfunctions/parseTravelPlan/geocode')];
      const L = require('../cloudfunctions/parseTravelPlan/geocode');
      const cases = [
        ['象鼻山公园', '广西 桂林'],
        ['象鼻山', '广西 桂林'],
        ['龙脊梯田', '广西 桂林'],
        ['德天跨国瀑布', '广西 崇左'],
        ['南宁东站', '南宁'],
        ['桂林北站', '桂林'],
        ['明仕田园', '广西 崇左'],
      ];
      for (const [addr, city] of cases) {
        const r = await L.geocodeOne(addr, city);
        console.log(`  ${r ? '✅' : '⚠️ '} ${addr} @${city} → ${r ? r.matchedName + ' (' + r.lon + ',' + r.lat + ')' : '放弃（不给错坐标）'}`);
      }
    }
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
