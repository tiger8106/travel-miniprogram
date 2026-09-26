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
process.env.AMAP_MIN_GAP_MS = '0';   // 桩测试不需要限速
const G = require('../cloudfunctions/parseTravelPlan/geocode');

console.log('\n【1】纯函数：城市词挑选 / 后缀清理 / 城市校验');
ok(G.pickCity('广西 桂林 阳朔') === '桂林', '从「广西 桂林 阳朔」挑出城市词', G.pickCity('广西 桂林 阳朔'));
ok(G.pickCity('桂林市') === '桂林', '去掉行政后缀（桂林市 → 桂林）', G.pickCity('桂林市'));
ok(G.pickCity('') === '', '空输入不炸');
ok(G.pickCity('阳朔县城（西街附近）') === '阳朔', '住宿地脏值：括号补注 + 「县城」都能洗掉', G.pickCity('阳朔县城（西街附近）'));
ok(G.pickCity('桂林 阳朔县城（西街附近） 大新县明仕田园') === '桂林', '整行程 region 串挑第一个城市词', G.pickCity('桂林 阳朔县城（西街附近） 大新县明仕田园'));
ok(G.pickCity('广西壮族自治区 桂林') === '桂林', '省级全称归一后跳过（广西壮族自治区 → 广西）', G.pickCity('广西壮族自治区 桂林'));
ok(G.stripSuffix('象鼻山公园') === '象鼻山', '砍掉自造后缀：象鼻山公园 → 象鼻山', G.stripSuffix('象鼻山公园'));
ok(G.stripSuffix('龙脊梯田景区') === '龙脊梯田', '砍掉自造后缀：龙脊梯田景区 → 龙脊梯田');
ok(G.stripSuffix('中山公园') === '中山公园', '砍完不足 3 字就不砍（中山公园别变中山）', G.stripSuffix('中山公园'));
ok(G.stripSuffix('桂林北站') === '桂林北站', '车站名不动');
ok(G.cityHit('桂林', '广西壮族自治区|桂林市|秀峰区|民主路|象鼻山') === true, '桂林的结果算命中');
ok(G.cityHit('桂林', '江西省|南昌市|南昌县|象鼻山公园') === false, '南昌的结果不算命中');
ok(G.cityHit('桂林 阳朔 大新县 南宁', '广西壮族自治区|南宁市|青秀区|凤岭北路|南宁东站') === true,
  '多城市词表：行程里任一城市命中即可（跨城段不再被第一个城市卡死）');
ok(G.cityHit('阳朔县城（西街附近）', '广西壮族自治区|桂林市|阳朔县|十里画廊|遇龙河') === true,
  '脏城市值清洗后仍能校验（阳朔县城（西街附近） → 阳朔）');
ok(G.cityHit('龙脊梯田', '广西壮族自治区|桂林市|龙脊梯田景区') === true, '片区名靠详细地址也能命中');
ok(G.cityHit('', 'anything') === true, '没给城市时不校验（老行为）');
console.log('\n【1b】地点自身词根（selfTokens / selfMatch）');
ok(JSON.stringify(G.selfTokens('大新县硕龙镇')) === JSON.stringify([{ t: '大新', suf: '县' }, { t: '硕龙', suf: '镇' }]),
  '「大新县硕龙镇」提出 大新县/硕龙镇 两个词根', JSON.stringify(G.selfTokens('大新县硕龙镇')));
ok(JSON.stringify(G.selfTokens('象鼻山')) === '[]', '没有行政后缀就没有词根（象鼻山）', JSON.stringify(G.selfTokens('象鼻山')));
ok(JSON.stringify(G.selfTokens('成都市')) === JSON.stringify([{ t: '成都', suf: '市' }]), '「成都市」→ 成都+市', JSON.stringify(G.selfTokens('成都市')));
ok(G.selfMatch(G.selfTokens('大新县硕龙镇'), '广西壮族自治区|崇左市|大新县|硕龙镇XX村') === true, '正确结果的 hay 含「大新县」→ 命中');
ok(G.selfMatch(G.selfTokens('大新县硕龙镇'), '广西壮族自治区|桂林市|雁山区|桂林市大新水库') === false,
  '「桂林市大新水库」里的裸「大新」不算命中（必须带县后缀）');
ok(G.selfMatch(G.selfTokens('大新县硕龙镇'), '桂林市临桂区某地') === false, '桂林方向的错坐标不命中');

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

async function caseE() {
  // 首页实际翻车的形态：整行程 region 串只有一个"桂林"在前面，
  // 但条目是跨城段「南宁东站」——挑出的 city=桂林 搜不到，
  // 全国搜回南宁的结果必须靠多城市词表放行（旧逻辑会白白拒掉）
  stubHttp([
    { match: (u) => u.includes('place/text') && u.includes('citylimit=true'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('place/text'),
      resp: { status: '1', pois: [poi('南宁东站', '108.42,22.82', '南宁市', '青秀区', '凤岭北路')] },
    },
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [] } },
  ]);
  return G.geocodeOne('南宁东站', '桂林 阳朔 大新县 南宁');
}

async function caseF() {
  // 脏城市值「阳朔县城（西街附近）」被洗成「阳朔」：桂林北站确实不在阳朔，
  // 应该坚持拒绝（宁缺毋错）；真正的补救在前端 fallbackRegion 二次重试
  stubHttp([
    { match: (u) => u.includes('place/text') && u.includes('citylimit=true'), resp: { status: '1', pois: [] } },
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('geocode/geo'),
      resp: { status: '1', geocodes: [geo('115.92,28.55', '江西省', '南昌市', '南昌县', '南昌县桂林北站')] },
    },
  ]);
  return G.geocodeOne('桂林北站', '阳朔县城（西街附近）');
}

async function caseG() {
  // 真实翻车场景（2026-09-25 硕龙镇）：条目挂在桂林那天，city=桂林，
  // 「大新县硕龙镇」在桂林搜不到。geo/city 返回桂林方向的错坐标 ——
  // hay 里含"桂林"，旧逻辑会放行（定位从桂西南跑到广西东北角）。
  // 新逻辑：地址自带词根 大新/硕龙，只认词根证据 → 错坐标被拒，
  // 不带 city 的自然查询返回崇左大新县的正确结果 → 放行。
  stubHttp([
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('geocode/geo') && u.includes('city=桂林'),
      resp: { status: '1', geocodes: [geo('110.29,25.27', '广西壮族自治区', '桂林市', '雁山区', '桂林市大新水库')] },
    },
    {
      match: (u) => u.includes('geocode/geo') && u.includes('address=桂林大新县硕龙镇'),
      resp: { status: '1', geocodes: [geo('110.10,25.30', '广西壮族自治区', '桂林市', '临桂区', '桂林大新县硕龙镇')] },
    },
    {
      match: (u) => u.includes('geocode/geo'),
      resp: { status: '1', geocodes: [geo('106.75,22.85', '广西壮族自治区', '崇左市', '大新县', '广西壮族自治区崇左市大新县硕龙镇')] },
    },
  ]);
  return G.geocodeOne('大新县硕龙镇', '桂林');
}

async function caseH() {
  // 拼接兜底（geo/prefixed）想蒙混过关：返回的结果 hay 里含"桂林"
  // 但不含词根「大新/硕龙」→ strict 校验必须拒掉，宁可不给坐标
  stubHttp([
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    { match: (u) => u.includes('geocode/geo') && u.includes('address=桂林大新县硕龙镇'),
      resp: { status: '1', geocodes: [geo('110.10,25.30', '广西壮族自治区', '桂林市', '临桂区', '桂林市临桂区某地')] } },
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [] } },
  ]);
  return G.geocodeOne('大新县硕龙镇', '桂林');
}

async function caseI() {
  // 实测翻车（广西七日攻略）：「锦江都城酒店（桂林两江四湖象山景区店）」
  // 全名 POI 搜不到 → 剥掉括号补注搜「锦江都城酒店」就命中
  stubHttp([
    { match: (u) => u.includes('keywords=锦江都城酒店（'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('keywords=锦江都城酒店') && u.includes('city=桂林'),
      resp: { status: '1', pois: [poi('锦江都城酒店(桂林两江四湖象山景区店)', '110.29,25.26', '桂林市', '象山区', '滨江路')] },
    },
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [] } },
  ]);
  return G.geocodeOne('锦江都城酒店（桂林两江四湖象山景区店）', '广西 桂林 阳朔 南宁 崇左');
}

async function caseJ() {
  // 实测翻车：「崇左南站」挂在桂林/南宁的行程里。候选城市逐个试——
  // 南宁搜不到，崇左命中；且必须回传 city=崇左 供前端下次直接用对城市
  stubHttp([
    { match: (u) => u.includes('place/text') && u.includes('city=南宁'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('place/text') && u.includes('city=崇左'),
      resp: { status: '1', pois: [poi('崇左南站', '107.36,22.38', '崇左市', '江州区', '太平街道')] },
    },
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [] } },
  ]);
  return G.geocodeOne('崇左南站', '广西 南宁 崇左 桂林');
}

async function caseK() {
  // 实测翻车：「大新明仕酒店」直接搜不到 → 关键词放宽砍开头两字
  // 变「明仕酒店」在崇左命中（结果照样过城市校验）
  stubHttp([
    { match: (u) => u.includes('keywords=大新明仕酒店'), resp: { status: '1', pois: [] } },
    {
      match: (u) => u.includes('keywords=明仕酒店') && u.includes('city=崇左'),
      resp: { status: '1', pois: [poi('大新明仕酒店', '106.86,22.93', '崇左市', '大新县', '堪圩乡明仕村')] },
    },
    { match: (u) => u.includes('place/text'), resp: { status: '1', pois: [] } },
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [] } },
  ]);
  return G.geocodeOne('大新明仕酒店', '广西 崇左 桂林');
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

  const e = await caseE();
  ok(e && e.lon === 108.42, '整行程 region 串：跨城段靠多城市词表命中（首页翻车场景）', e);

  const f = await caseF();
  ok(f === null, '脏城市值洗成「阳朔」后仍坚持拒绝错城坐标（宁缺毋错）', f);

  const g = await caseG();
  ok(g && g.lon === 106.75 && g.lat === 22.85,
    '「大新县硕龙镇」@桂林那天 → 定位到崇左大新县（桂林方向的错坐标被词根拒掉）', g);

  const h = await caseH();
  ok(h === null, '拼接兜底返回的桂林结果不含词根 → 拒绝，不给坐标', h);

  const i = await caseI();
  ok(i && i.lon === 110.29,
    '「锦江都城酒店（…景区店）」→ 剥掉括号后命中桂林分店', i);

  const j = await caseJ();
  ok(j && j.lon === 107.36 && j.city === '崇左',
    '「崇左南站」跨城候选逐个试 → 命中崇左并回传城市', j);

  console.log('\n【2.5】2026-09-26 定位偏移三连（桩）');
  // ① 枢纽词命中分支客栈：POI 名靠分支后缀"（…客运中心店）"蹭匹配 → 必须拒
  ok(!G.nameOk('都江堰青之堰客栈(都江堰客运中心店)', '都江堰客运中心'),
    '搜「客运中心」命中"客栈(客运中心店)" → 拒（剥分支后缀+枢纽反查）');
  ok(G.nameOk('都江堰客运中心', '都江堰客运中心'),
    '同名 POI 照常放行');
  ok(!G.nameOk('重庆鲜面店', '重庆北站'),
    '枢纽词反查不误伤原有类别锁用例');
  // ② geo 行政区级兜底：区划中心点不是具体地点
  ok(!G.geoLevelOk('都江堰客运站', '四川省成都市都江堰市', '市'),
    '「都江堰客运站」geo 落到都江堰市（市级）→ 拒');
  ok(G.geoLevelOk('四姑娘山', '四川省阿坝州小金县四姑娘山', '兴趣点'),
    '非行政区级不受影响');
  ok(G.geoLevelOk('都江堰市', '四川省成都市都江堰市', '市'),
    '关键词本身是行政区名 → 区划中心就是答案，放行');
  // ③ 编造的酒店名 geo 落到镇域点 → 拒
  ok(!G.geoClassOk('四姑娘山高原文化大酒店', '四川省阿坝藏族羌族自治州小金县四姑娘山'),
    '住宿词关键词 geo 结果里没住宿词 → 拒（宁缺毋错）');
  ok(G.geoClassOk('悦来客栈', '小金县四姑娘山镇悦来客栈'),
    'geo 结果确实是个客栈 → 放行');
  ok(G.geoClassOk('象鼻山', '广西桂林象山区象鼻山'),
    '非住宿餐饮词不受影响');

  console.log('\n【2.6】链路级桩：编造酒店名 + 客运站 geo 区划兜底必须给出「放弃」');
  const realGet2 = https.get;
  stubHttp([
    // POI 全部空手而归（这个名字高德搜不到 = 多半是编的）
    { match: (u) => u.includes('/v3/place/text'), resp: { status: '1', pois: [] } },
    // geo 只给到区划/镇域点
    { match: (u) => u.includes('geocode/geo'), resp: { status: '1', geocodes: [{
      formatted_address: '四川省阿坝藏族羌族自治州小金县四姑娘山镇',
      location: '102.901969,31.11045', level: '乡镇',
      province: '四川省', city: '阿坝藏族羌族自治州', district: '小金县', adcode: '513227',
    }] } },
  ]);
  const fakeHotel = await G.geocodeOne('四姑娘山高原文化大酒店', '四川 阿坝 四姑娘山');
  https.get = realGet2;
  ok(fakeHotel === null, '查无此店的酒店名：geo 落到镇级区划 → 放弃坐标（宁缺毋错）', fakeHotel);
  ok(fakeHotel !== undefined && fakeHotel === null, '桩确实生效（不是请求报错导致的假通过）');

  const k = await caseK();
  ok(k && k.lon === 106.86,
    '「大新明仕酒店」关键词放宽（砍开头两字）后命中', k);

  https.get = realGet;

  // ---------------------------------------------------------------- 真跑
  if (process.argv.includes('--live')) {
    console.log('\n【3】真实高德验证');
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '..', '.env.local');
    if (fs.existsSync(envPath)) {
      const envVals = {};
      fs.readFileSync(envPath, 'utf8').split('\n').forEach((l) => {
        const m = l.trim().match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
        if (m) envVals[m[1]] = m[2].trim();
      });
      // ⚠️ 脚本顶部已把 AMAP_KEY 兜底成 'TEST_KEY'（桩测试用），这里必须覆盖回真 Key，
      // 否则真跑全部请求都被高德以无效 Key 拒掉，表现为"所有地址都放弃"
      Object.keys(envVals).forEach((k) => {
        if (!process.env[k] || process.env[k] === 'TEST_KEY') process.env[k] = envVals[k];
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
        // 2026-09-25 广西七日攻略实测翻车的地址
        ['南宁东站', '广西 桂林 阳朔 南宁 崇左'],
        ['崇左南站', '广西 桂林 阳朔 南宁 崇左'],
        ['崇左游客集散中心', '广西 桂林 阳朔 南宁 崇左'],
        ['大新明仕酒店', '广西 桂林 阳朔 南宁 崇左'],
        ['锦江都城酒店（桂林两江四湖象山景区店）', '广西 桂林 阳朔 南宁 崇左'],
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
