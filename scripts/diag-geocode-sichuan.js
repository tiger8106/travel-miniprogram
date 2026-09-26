// 临时诊断：定位偏移问题（酒店/饭店名与实际不符、都江堰客运站偏移）
require('fs').readFileSync('.env.local', 'utf8').split('\n').forEach((l) => {
  const m = l.trim().match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
});
const L = require('../cloudfunctions/parseTravelPlan/geocode');

// 截图里那批生成结果的典型地点（阿坝四姑娘山行程 + 都江堰）
const cases = [
  ['都江堰客运站', '四川 成都 都江堰'],
  ['都江堰客运中心', '四川 成都 都江堰'],
  ['四姑娘山高原文化大酒店', '四川 阿坝 四姑娘山'],
  ['四姑娘山镇', '四川 阿坝 四姑娘山'],
  ['四姑娘山酒店', '四川 阿坝 四姑娘山'],
  ['长坪沟', '四川 阿坝 四姑娘山'],
  ['双桥沟', '四川 阿坝 四姑娘山'],
  ['猫鼻梁', '四川 阿坝 四姑娘山'],
];

(async () => {
  for (const [addr, city] of cases) {
    const t0 = Date.now();
    const r = await L.geocodeOne(addr, city);
    console.log(`${r ? 'OK ' : 'GIVEUP'} ${addr} @${city} → ${
      r ? `${r.matchedName} (${r.lon},${r.lat}) isGeo=${!!r.isGeo}` : '放弃'
    }  ${Date.now() - t0}ms`);
  }
})();
