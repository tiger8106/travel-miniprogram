// 真实回归：重庆市金童路 → 成都、都江堰、毕棚沟
//
// 这个脚本会调用当前配置的模型生成大纲，再调用 12306 官方接口回写班次，
// 最后实际细化行程并断言每一条带车次的铁路交通都来自官方候选。
// 运行：node scripts/test-live-12306-sichuan.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (!fs.existsSync(envPath)) throw new Error('缺少 .env.local');
fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
  const l = line.trim();
  if (!l || l.startsWith('#')) return;
  const m = l.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (!m) return;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
});

const P = require('../cloudfunctions/generatePlan/plan');
const S = require('../cloudfunctions/generatePlan/schedule');

const input = {
  dest: '成都、都江堰、毕棚沟',
  startDate: '2026-09-28',
  endDate: '2026-09-30',
  transport: '高铁/动车优先',
  origin: '重庆市金童路',
  goTime: '08:00',
  backTime: '20:00',
  budget: '舒适',
  pace: '适中',
  interests: ['自然风光', '美食'],
};

function codeOf(item) {
  return P.transportCodeOf(item);
}

(async () => {
  const t0 = Date.now();
  const generated = await P.generateOutline(input);
  const outline = generated.outline;
  const segments = P.collectSegments(outline, { origin: input.origin });
  assert(segments.length > 0, '大纲没有产生铁路段，无法做班次核验');
  console.log('待核验段：', JSON.stringify(segments.map((s) => ({
    key: s.scheduleKey, from: s.from, to: s.to, date: s.date, dayCity: s.dayCity, mode: s.mode,
  }))));

  const found = await S.lookupSchedules(segments, 35000);
  const stat = P.applyRealSchedules(outline, found);
  assert(stat && stat.segments > 0, '12306 没有命中任何大纲铁路段');

  console.log(`大纲 ${outline.days.length} 天，12306 命中 ${stat.segments} 段，回写 ${stat.replaced} 段，用时 ${Date.now() - t0}ms`);
  outline.days.forEach((day, di) => {
    (day.moves || []).filter((m) => m.schedSource === '12306').forEach((m) => {
      assert(m.sched && m.sched.length, `第${di + 1}天官方段没有候选`);
      console.log(`D${di + 1} ${day.date} ${m.from}→${m.to} ${m.code} ${m.startTime}-${m.endTime}`);
    });
  });

  let allItems = [];
  let done = [];
  let attempts = {};
  let plan = null;
  for (let round = 1; round <= 6; round++) {
    plan = await P.buildPlan(input, generated, {
      doneDayIndexes: done,
      attempts,
    });
    allItems = allItems.concat(plan.items || []);
    done = plan.doneDayIndexes || [];
    attempts = plan.attempts || {};
    console.log(`细化第${round}轮：新增 ${plan.items.length} 条，partial=${plan.partial}`);
    if (!plan.partial) break;
  }
  assert(plan && !plan.partial, '细化未完成');

  const checked = [];
  const railItems = allItems.filter((it) => String(it.category || '') === 'transport'
    && /train|高铁|动车|火车|列车/.test(`${it.transportType || ''}${it.activity || ''}`));
  railItems.forEach((it) => {
    const code = codeOf(it);
    if (!code) {
      assert(it.schedSource === 'official-unavailable', `铁路条目没有官方来源：${it.activity}`);
      return;
    }
    const day = outline.days[Number(it.dayIndex || 0)];
    const match = (day && day.moves || []).some((m) => m.schedSource === '12306'
      && (m.sched || []).some((c) => c.code === code
        && c.s === it.startTime && c.e === it.endTime));
    assert(match, `第${Number(it.dayIndex || 0) + 1}天 ${code} ${it.startTime}-${it.endTime} 不在12306候选中`);
    checked.push(`${code} ${it.startTime}-${it.endTime}`);
  });
  const officialMoves = outline.days.flatMap((day) => (day.moves || [])
    .filter((m) => m.schedSource === '12306')
    .map((m) => ({ day, move: m })));
  officialMoves.forEach(({ day, move }) => {
    const covered = railItems.some((it) => Number(it.dayIndex || 0) === outline.days.indexOf(day)
      && (move.sched || []).some((c) => c.code === codeOf(it) && c.s === it.startTime && c.e === it.endTime));
    assert(covered, `第${outline.days.indexOf(day) + 1}天官方段没有落入最终细化：${move.from}→${move.to}`);
  });
  assert(checked.length > 0, '细化结果没有可核验铁路车次');
  console.log(`细化完成 ${allItems.length} 条；已核验：${checked.join('、')}`);
  console.log('LIVE_12306_SICHUAN_PASS');
})().catch((e) => {
  console.error('LIVE_12306_SICHUAN_FAIL:', e.message);
  process.exit(1);
});
