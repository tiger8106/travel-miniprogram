// 从真实 Word 提取的文本经 stdin 输入，回归分步解析的定位续跑与入库。
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const { buildDocMeta } = require('../cloudfunctions/parseTravelPlan/docmeta');

const raw = fs.readFileSync(0, 'utf8');
const meta = buildDocMeta(raw);
assert(meta.days.length >= 2, 'Word 应识别出多天行程');
const places = ['重庆北站', '象鼻山', '德天跨国瀑布'];
places.forEach((place) => assert(raw.includes(place), `Word 中缺少 ${place}`));

const rows = {
  parse_tasks: [{ _id: 'task', _openid: 'user', title: meta.title,
    startDate: meta.startDate, endDate: meta.endDate, fileID: 'word-file',
    items: places.map((place, dayIndex) => ({ dayIndex, activity: `前往${place}`, endLocation: place })),
    addrList: places, coords: {}, alarms: [], suggestions: {}, region: '广西 桂林 崇左' }],
  trips: [],
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const db = { collection(name) {
  const list = rows[name] || (rows[name] = []);
  return {
    doc(id) { return {
      async get() { return { data: clone(list.find((row) => row._id === id) || null) }; },
      async update({ data }) { Object.assign(list.find((row) => row._id === id), clone(data)); },
    }; },
    async add({ data }) {
      const _id = `${name}-${list.length + 1}`;
      list.push(Object.assign({ _id }, clone(data)));
      return { _id };
    },
  };
} };
const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext: () => ({ OPENID: 'user' }), database: () => db,
  callFunction: async () => ({ result: { code: 0, data: {} } }) };
const calls = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloud;
  if (request === 'mammoth') return {};
  if (parent && /parseTravelPlan\/index\.js$/.test(parent.filename)) {
    if (request === './cloudCfg') return { apply: async () => {} };
    if (request === './geocode') return {
      geocodeOne: async (place) => {
        calls.push(place);
        return place === '象鼻山' ? null : { lon: 106.7, lat: 29.5, matchedName: place, city: '桂林' };
      },
      geocodeBatch: async () => ({}), pickCity: () => '桂林',
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const parser = require('../cloudfunctions/parseTravelPlan/index');
Module._load = originalLoad;

(async () => {
  const first = await parser.main({ step: 'geocode', taskId: 'task' }, {});
  assert.equal(first.code, 0);
  assert.equal(first.data.remaining, 0, '未命中坐标也应完成本轮清单');
  assert.equal(rows.parse_tasks[0].geoNextIndex, places.length);
  assert.deepEqual(calls, places);
  const again = await parser.main({ step: 'geocode', taskId: 'task' }, {});
  assert.equal(again.data.remaining, 0);
  assert.deepEqual(calls, places, '续跑不能重复查失败地点');
  const committed = await parser.main({ step: 'commit', taskId: 'task' }, {});
  assert.equal(committed.code, 0);
  assert.equal(rows.trips.length, 1);
  assert.equal(rows.trips[0].title, meta.title);
  assert.equal(rows.trips[0].items[1].endLon, undefined, '未核验的地点不能写错坐标');
  assert.equal(rows.trips[0].items[2].endLon, 106.7);
  console.log(`Word「${meta.title}」识别 ${meta.days.length} 天；地理校验 ${calls.length} 个地点，未命中也可完成并入库`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
