const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../cloudfunctions/generatePlan/route-evidence');
const R = require('../cloudfunctions/generatePlan/execution-review');
const rail = require('../cloudfunctions/generatePlan/rail12306');

async function main() {
  if (process.argv.includes('--live')) {
    const env = path.resolve(__dirname, '../.env.local');
    fs.readFileSync(env, 'utf8').split('\n').forEach((line) => {
      const match = /^([A-Z_]+)\s*=\s*(.+)$/.exec(line.trim());
      if (match) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    });
    const file = process.argv[process.argv.indexOf('--replay') + 1];
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (process.argv.includes('--probe')) {
      const name = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1]
        : saved.items.find((row) => row.category === 'transport' && row.endLocation).endLocation;
      const url = new URL('https://restapi.amap.com/v3/place/text');
      url.search = new URLSearchParams({ key: process.env.AMAP_KEY, keywords: name, offset: '5' }).toString();
      await new Promise((resolve) => {
        const req = require('https').get(url, (res) => {
          let data = ''; res.on('data', (chunk) => { data += chunk; }); res.on('end', () => {
            try { const r = JSON.parse(data); console.log({ status: r.status, info: r.info, count: r.count, names: (r.pois || []).map((p) => p.name) }); }
            catch (_) { console.log('地图响应不是JSON'); } resolve();
          });
        });
        req.setTimeout(5000, () => req.destroy());
        req.on('error', (error) => { console.log('地图连接错误', error.code); resolve(); });
      });
    }
    const selected = process.argv.includes('--days')
      ? process.argv[process.argv.indexOf('--days') + 1].split(',').map((n) => Number(n) - 1)
      : saved.outline.days.map((_, di) => di);
    for (const di of selected) {
      const day = saved.outline.days[di], rows = saved.items.filter((row) => Number(row.dayIndex || 0) === di);
      const regions = [saved.input.origin, saved.input.dest, day.city, day.overnight,
        (saved.outline.days[di - 1] || {}).overnight].join(' ');
      const points = await E.collectRoutePoints(rows, regions, Date.now() + 10000);
      const roads = await E.collectRoadTravelFacts(rows, points, Date.now() + 10000);
      const context = { date: day.date, points, routeFacts: roads, hotel: day.hotel, isLast: di === saved.outline.days.length - 1,
        origin: saved.input.origin, noDrive: true };
      console.log(JSON.stringify({ day: di + 1, points: Object.keys(points), roads, issues: R.executionIssues(rows, context) }, null, 2));
    }
    return;
  }
  const original = rail.lookupOfficial, apiKey = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = 'mock-only';
  const rows = [{ category: 'transport', transportType: 'train', startLocation: '甲站', endLocation: '乙站' }];
  try {
    rail.lookupOfficial = async (segments) => {
      assert(!segments[0].date.startsWith('2027'), '运行网络不能查询并伪造未来班次');
      const key = `甲站→乙站@${segments[0].date}`;
      const found = new Map([[key, []]]);
      found.routeMeta = new Map([[key, { querySucceeded: true, repaired: false }]]);
      return found;
    };
    const validEmpty = await E.collectRailTopology(rows, Date.now() + 10000);
    assert.equal(validEmpty[0].direct, false); assert(!validEmpty[0].code);
    rail.lookupOfficial = async () => Object.assign(new Map(), { routeMeta: new Map() });
    assert.deepEqual(await E.collectRailTopology(rows, Date.now() + 10000), [], '接口失败不能当成没有铁路');
    console.log('✓ 当前铁路网络与未来班次隔离；有效空结果和接口失败分开处理');
  } finally {
    rail.lookupOfficial = original;
    if (apiKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = apiKey;
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
