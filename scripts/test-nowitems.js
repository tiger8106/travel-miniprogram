// scripts/test-nowitems.js
// 首页「此刻行程」（正在进行 / 即将进行）筛选逻辑单测
//
// 思路：把小程序环境 stub 掉，直接 require index 页面配置，
// 再把 Date.now() 固定在「今天 12:00」，让所有时间断言完全可控。
//
// 运行：node scripts/test-nowitems.js

const path = require('path');

// ---------- 1. stub 掉依赖 wx 的模块 ----------
function stub(rel) {
  const p = require.resolve(rel);
  require.cache[p] = {
    id: p, filename: p, loaded: true, exports: {}, children: [], paths: [],
  };
}
stub('../miniprogram/services/api');
stub('../miniprogram/utils/alarm');
stub('../miniprogram/utils/trip');
stub('../miniprogram/utils/map');

global.getApp = () => ({ globalData: {} });
let pageCfg = null;
global.Page = (cfg) => { pageCfg = cfg; };

require('../miniprogram/pages/index/index.js');

// ---------- 2. 固定「现在」= 今天 12:00 ----------
const base = new Date();
base.setHours(12, 0, 0, 0);
const NOW = base.getTime();
Date.now = () => NOW;

const timeUtil = require('../miniprogram/utils/time');
const startDate = timeUtil.fmtDate(NOW); // 今天
const hhmm = (ts) => timeUtil.fmtTime(ts);

const page = Object.assign({}, pageCfg); // 直接用页面配置里的方法

// ---------- 3. 断言工具 ----------
let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra ? '  → ' + extra : '')); }
}

const trip = (items, start) => ({ startDate: start === undefined ? startDate : start, items });

// ---------- 4. 主用例 ----------
const items = [
  // 已结束（07:00-08:00），应被排除
  { dayIndex: 0, startTime: '07:00', endTime: '08:00', activity: '早就结束了' },
  // 正在进行（11:30-12:30 覆盖 12:00）
  {
    dayIndex: 0, startTime: '11:30', endTime: '12:30', activity: '正在景区间穿梭',
    startLocation: '龙脊别院', endLocation: '金坑大寨', transportType: 'walk',
  },
  // 20 分钟后
  { dayIndex: 0, startTime: '12:20', activity: '吃午饭', endLocation: '寨子餐厅' },
  // 没填结束时间 → 默认 1 小时窗口（13:00-14:00）
  { dayIndex: 0, startTime: '13:00', activity: '看梯田日落', startLocation: '观景台' },
  // 2 小时后（会被截断）
  { dayIndex: 0, startTime: '14:00', endTime: '15:00', activity: '两小时后' },
  // 明天 23:00（会被截断）
  { dayIndex: 1, startTime: '23:00', endTime: '23:40', activity: '明天的安排' },
  // 没填时间 → 跳过
  { dayIndex: 0, startTime: '', activity: '没写时间' },
];

const list = page.buildNowItems(trip(items), 3);

ok(list.length === 3, '最多返回 3 条', '实际 ' + list.length);
ok(list.every((x) => x.title !== '早就结束了'), '已结束的条目被排除');
ok(list.every((x) => x.title !== '没写时间'), '没填时间的条目被跳过');
ok(list[0].title === '正在景区间穿梭', '第一条是正在进行的安排', list[0] && list[0].title);
ok(list[0].ongoing === true, 'ongoing = true（11:30-12:30 覆盖 12:00）');
ok(list[0].statusText === '进行中', 'statusText = 进行中', list[0].statusText);
ok(list[1].statusText === '20 分钟后', 'statusText = 20 分钟后', list[1].statusText);
ok(list[2].statusText === '1 小时后', '无结束时间的条目按 1 小时窗口算', list[2].statusText);
ok(list[0].routeText === '龙脊别院 → 金坑大寨', '起终点都在 → A → B', list[0].routeText);
ok(list[1].routeText === '寨子餐厅', '只有终点 → 只显示终点', list[1].routeText);
ok(list[2].routeText === '观景台', '只有起点 → 只显示起点', list[2].routeText);
ok(list[1].hasNav === true && list[1].navTarget === '寨子餐厅', 'hasNav / navTarget 正确');
ok(list[1].navFrom === '', '只有终点时 navFrom 为空');
ok(list[0].transportType === 'walk', 'transportType 透传', list[0].transportType);
ok(list[0].dayIdx === 0, 'dayIdx = 原始 dayIndex', String(list[0].dayIdx));
ok(
  list.every((x, i) => i === 0 || x.title !== list[i - 1].title),
  '结果无重复条目'
);

// ---------- 5. 边界用例 ----------
// 行程还没开始：所有项都在未来（现在才 12:00，行程 15:00 才开始）→ 仍返回，ongoing = false
const future = page.buildNowItems(trip([
  { dayIndex: 0, startTime: '15:00', endTime: '16:00', activity: '集合出发' },
  { dayIndex: 0, startTime: '17:00', endTime: '18:00', activity: '到达酒店' },
]), 3);
ok(future.length === 2, '行程还没开始时也能给出即将进行的安排', '实际 ' + future.length);
ok(future[0].ongoing === false, '未来的安排 ongoing = false');

// 行程已结束：所有项都在过去 → 空
const ended = page.buildNowItems(trip([
  { dayIndex: 0, startTime: '08:00', endTime: '09:00', activity: '昨天的事' },
]), 3);
ok(ended.length === 0, '行程已结束时返回空（卡片自动隐藏）', '实际 ' + ended.length);

// 没有有效起始日期 → 空（绝不瞎猜）
ok(page.buildNowItems(trip([{ dayIndex: 0, startTime: '08:00', activity: 'x' }], null), 3).length === 0,
  '无有效 startDate 时返回空');
ok(page.buildNowItems(trip([{ dayIndex: 0, startTime: '08:00', activity: 'x' }], 'null'), 3).length === 0,
  'startDate 为 "null" 字符串时返回空');

// 跨零点：23:00 → 次日 00:30
const midnight = page.buildNowItems(trip([
  { dayIndex: 0, startTime: '23:00', endTime: '00:30', activity: '跨零点班次' },
]), 3);
ok(midnight.length === 1, '跨零点的班次不会被误判成已结束', '实际 ' + midnight.length);

// 相对时间文案
const rel = page.buildNowItems(trip([
  { dayIndex: 1, startTime: '23:00', activity: '明天的安排' },
]), 3);
ok(/明天/.test(rel[0].statusText), '跨天显示「明天 HH:mm」', rel[0].statusText);

// 1 分钟后 → 「马上开始」（行程时间只到分钟精度，所以是 <= 60000）
const rel2 = page.buildNowItems(trip([
  { dayIndex: 0, startTime: hhmm(NOW + 60000), activity: '马上' },
]), 3);
ok(rel2[0].statusText === '马上开始', '1 分钟内显示「马上开始」', rel2[0].statusText);

// 2 分钟后 → 「2 分钟后」
const rel3 = page.buildNowItems(trip([
  { dayIndex: 0, startTime: hhmm(NOW + 120000), activity: '两分钟后' },
]), 3);
ok(rel3[0].statusText === '2 分钟后', '超过 1 分钟显示「N 分钟后」', rel3[0].statusText);

// dayLabel
ok(/^第1天 · \d{2}-\d{2}$/.test(list[0].dayLabel), 'dayLabel 形如「第1天 · 09-21」', list[0].dayLabel);

// onTapDay 必须用 dayIndex，而不是重排后的数组下标
const days = [{ dayIndex: 3, label: 'x' }, { dayIndex: 0, label: 'y' }];
let navUrl = '';
global.wx = { navigateTo: (o) => { navUrl = o.url; } };
page.gotoDay(5);
ok(navUrl === '/pages/itinerary/itinerary?dayIdx=5', 'gotoDay 拼接正确的 dayIdx', navUrl);

// ---------- 6. 汇总 ----------
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
