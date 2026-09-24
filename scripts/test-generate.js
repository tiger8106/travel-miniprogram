// scripts/test-generate.js
// 本地实跑 AI 制定攻略（generatePlan）
//   node scripts/test-generate.js          跑完整（真调 LLM）
//   node scripts/test-generate.js --unit   只跑确定性规则，不调 LLM
//
// 验证点：
//   1. 12306 预售规则兜底闹钟是否算对（参考攻略实写：9月16日 11:00 抢 9月30日 G2249）
//   2. 逐天细化条目数是否达到参考攻略的细致度（84 条 / 8 天 ≈ 10 条/天）
//   3. 时间连续性、零时长、缺结束时间是否达标
//   4. 闹钟时间合法性（不能是过去、不能晚于行程结束）

const fs = require('fs');
const path = require('path');

// ---------- 加载 .env.local ----------
const envPath = path.resolve(__dirname, '..', '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('❌ 缺少 .env.local（需 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL）');
  process.exit(1);
}
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  const l = line.trim();
  if (!l || l.startsWith('#')) return;
  const m = l.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (!m) return;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
});

const P = require('../cloudfunctions/generatePlan/plan.js');
const { normalizeInput, shiftDate, dayDiff, isHolidayRange, buildFallbackAlarms, sanitizeAlarmCandidates } = P;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra ? '  → ' + extra : '')); }
};

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? +m[1] * 60 + +m[2] : null;
};

console.log('============================================');
console.log('第一部分：确定性规则（不需要 LLM）');
console.log('============================================');

// 1. 天数计算：9-30 ~ 10-07 = 8 天（与参考攻略一致）
ok(dayDiff('2026-09-30', '2026-10-07') === 8, 'dayDiff 9-30~10-07 = 8 天', dayDiff('2026-09-30', '2026-10-07'));
ok(dayDiff('2026-10-01', '2026-10-01') === 1, '同一天 = 1 天');

// 2. 12306 预售：T-14 → 参考攻略实写"9月16日抢9月30日的票"
ok(shiftDate('2026-09-30', -14) === '2026-09-16', '12306 预售兜底：9-30 的车 → 9-16 开票', shiftDate('2026-09-30', -14));
ok(isHolidayRange('2026-09-30', '2026-10-07'), '识别国庆为法定长假');

// 3. 输入归一化：非法日期 / 超长天数兜底
const ni = normalizeInput({ dest: '广西', startDate: '2026-09-30', endDate: '2026-10-31', days: 33 });
ok(ni.days === 12, '超过 12 天的行程被收敛到 12 天', ni.days);
const nj = normalizeInput({ dest: '广西', startDate: 'bad', endDate: '' });
ok(/^\d{4}-\d{2}-\d{2}$/.test(nj.startDate), '非法日期兜底为今天', nj.startDate);

// 4. 规则兜底闹钟：用**未来行程**验证算法本身（今天是实时的，不能用过去日期测规则）
const mkOutline = (start, end) => ({
  days: [
    { date: start, theme: '出发', city: '桂林', overnight: '桂林', moves: [{ from: '重庆北', to: '桂林西', mode: 'train', code: 'G2249' }], highlights: ['日月双塔'] },
    { date: end, theme: '返程', city: '南宁', overnight: '返程', moves: [{ from: '南宁东', to: '重庆西', mode: 'train', code: 'G2244' }], highlights: [] },
  ],
  nights: [{ date: start, city: '桂林' }],
});
const fb = buildFallbackAlarms({ startDate: '2026-12-20', endDate: '2026-12-26' }, mkOutline('2026-12-20', '2026-12-26'));
const goAlarm = fb.find((a) => /去程/.test(a.title) && a.type === 'train');
ok(!!goAlarm && goAlarm.fireAtStr.startsWith('2026-12-06'), '去程抢票闹钟 = 出发日减 14 天（12-20 → 12-06）', goAlarm && goAlarm.fireAtStr);
ok(fb.some((a) => /返程/.test(a.title) && a.fireAtStr.startsWith('2026-12-12')), '返程抢票闹钟 = 返程日减 14 天（12-26 → 12-12）');
ok(fb.some((a) => a.type === 'hotel' && a.fireAtStr.startsWith('2026-12-13')), '酒店预订闹钟 = 出发前 7 天（12-13 20:00）');

// 4b. 开票日已过但行程未出发 → 降级成"赶紧去抢"的近期提醒（用户临时才规划的常见场景）
const late = buildFallbackAlarms({ startDate: '2026-09-30', endDate: '2026-10-07' }, mkOutline('2026-09-30', '2026-10-07'));
ok(late.every((a) => a.fireAt > Date.now()), '开票日已过时，闹钟被顺延到现在之后而不是消失', late.length);
ok(late.some((a) => /进入抢票期/.test(a.note || '')), '过期项在 note 里说明了原因');

// 5. 闹钟清洗：过去时间 / 瞎编日期一律丢弃
const clean = sanitizeAlarmCandidates([
  { title: '过去的票', fireAt: '2020-01-01 09:00', type: 'train' },
  { title: '行程结束后', fireAt: '2030-01-01 09:00', type: 'train' },
  { title: '未来的票', fireAt: '2026-10-06 09:00', type: 'train' },
  { title: '未来的票', fireAt: '2026-10-06 09:00', type: 'train' }, // 重复
], { startDate: '2026-09-30', endDate: '2026-10-07' });
ok(clean.length === 1 && clean[0].title === '未来的票', '闹钟清洗：过去/超期/重复各被拦掉', clean.length);

if (process.argv.includes('--unit')) {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

console.log('\n============================================');
console.log('第二部分：真实 LLM 生成（国庆广西场景）');
console.log('============================================');

const INPUT = {
  origin: '重庆',
  dest: '广西（桂林、龙脊梯田、阳朔、崇左、南宁）',
  startDate: '2026-09-30',
  endDate: '2026-10-07',
  people: 2,
  party: '情侣出行',
  budget: '舒适',
  pace: '适中',
  interests: ['自然山水', '古镇古村', '当地美食', '拍照打卡'],
  transport: '高铁优先',
  mustGo: '漓江游船、遇龙河竹筏',
  extra: '不想全程自驾，尽量公共交通+当地直通车',
};

(async () => {
  // 线上是两次云函数调用（大纲 / 展开），分别都不能超过 60s，这里分开计时验证
  const t0 = Date.now();
  const phase1 = await P.generateOutline(INPUT);
  const outlineSec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n阶段一（大纲）：%s（%s）', phase1.title, outlineSec + 's');
  console.log('  概览:', phase1.summary);
  (phase1.outline.days || []).forEach((d, i) => {
    console.log(`  第${i + 1}天 ${d.date}｜${d.theme}｜住${d.overnight || d.city}`);
  });
  ok((Date.now() - t0) / 1000 < 60, `阶段一耗时 ${outlineSec}s < 云函数 60s 上限`);

  // 阶段二：模拟云端续跑——一次跑不完（partial）就接着调，直到全部生成
  const t1 = Date.now();
  let plan = null;
  let slowest = 0;
  let rounds = 0;
  const allItems = [];
  for (let r = 0; r < 6; r++) {
    const rt = Date.now();
    plan = await P.buildPlan(INPUT, Object.assign({}, INPUT, phase1), { doneDayIndexes: plan && plan.doneDayIndexes });
    const cost = (Date.now() - rt) / 1000;
    slowest = Math.max(slowest, cost);
    rounds = r + 1;
    allItems.push(...plan.items);
    if (!plan.partial) break;
  }
  ok(slowest < 60, `阶段二单次最长耗时 ${slowest.toFixed(1)}s < 云函数 60s 上限（共 ${rounds} 轮续跑）`);
  // 续跑时每轮只返回新生成的天，这里合并成完整行程再校验
  if (allItems.length !== plan.items.length) plan.items = allItems;
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n生成结果：${plan.title}（${plan.startDate} ~ ${plan.endDate}）耗时 ${sec}s（${rounds} 轮）`);
  console.log('概览:', plan.summary);

  const byDay = new Map();
  plan.items.forEach((it) => byDay.set(it.dayIndex, (byDay.get(it.dayIndex) || 0) + 1));
  console.log('\n每天条目数：');
  [...byDay.keys()].sort((a, b) => a - b).forEach((k) => {
    console.log(`  第${k + 1}天: ${byDay.get(k)} 条`);
  });

  const zeroDur = plan.items.filter((it) => it.startTime && it.startTime === it.endTime);
  const noTime = plan.items.filter((it) => !it.startTime || !it.endTime);
  console.log(`\n总条目 ${plan.items.length}｜零时长 ${zeroDur.length}｜缺时间 ${noTime.length}`);

  ok(plan.items.length >= plan.meta.days * 6, `条目数达到 ${plan.meta.days * 6} 条以上（参考攻略 84 条/8 天）`, plan.items.length);
  ok(zeroDur.length === 0, '没有零时长条目', zeroDur.length);
  ok(noTime.length === 0, '没有缺失时间的条目', noTime.length);
  ok([...byDay.keys()].length === plan.meta.days, `每一天都有内容（${plan.meta.days} 天）`, [...byDay.keys()].length);

  // 时间连续性抽检：同一天内相邻条目时间不得倒退超过 0 分钟（允许间隔，但不允许倒退）
  let backward = 0;
  [...byDay.keys()].forEach((d) => {
    const dayItems = plan.items.filter((it) => it.dayIndex === d);
    for (let i = 1; i < dayItems.length; i++) {
      const prevEnd = toMin(dayItems[i - 1].endTime);
      const curStart = toMin(dayItems[i].startTime);
      if (prevEnd !== null && curStart !== null && curStart < prevEnd) backward++;
    }
  });
  ok(backward === 0, '同天内没有时间倒退的条目', backward);

  console.log('\n闹钟清单：');
  (plan.alarms || []).forEach((a) => {
    console.log(`  [${a.fireAtStr}] ${a.title}  (${a.type}${a.source ? '/' + a.source : ''})`);
    if (a.note) console.log(`      └ ${a.note.slice(0, 80)}`);
  });
  const alarms = plan.alarms || [];
  ok(alarms.length >= 5, '至少 5 条待办（车票/门票/酒店/准备）', alarms.length);
  const goA = alarms.find((a) => /去程/.test(a.title));
  ok(!!goA, '存在去程抢票闹钟');
  ok(alarms.every((a) => a.fireAt > Date.now()), '所有闹钟都在未来');
  // 待办必须按时间先后排好（用户照着做就行）
  let sortedOk = true;
  for (let i = 1; i < alarms.length; i++) if (alarms[i].fireAt < alarms[i - 1].fireAt) sortedOk = false;
  ok(sortedOk, '待办按时间从早到晚排序');
  const types = [...new Set(alarms.map((a) => a.type))];
  ok(types.length >= 3, `覆盖至少 3 类待办（${types.join('/')}）`, types.length);

  if (plan.suggestions && Object.keys(plan.suggestions).length) {
    console.log('\n建议字段:', Object.keys(plan.suggestions).join(', '));
    ok(!!(plan.suggestions.gear || plan.suggestions.tips), '生成了旅行建议');
  }

  console.log('\n示例行程（第2天）：');
  plan.items.filter((it) => it.dayIndex === 1).slice(0, 8).forEach((it) => {
    console.log(`  ${it.startTime}-${it.endTime} ${it.activity}` +
      (it.startLocation || it.endLocation ? `  📍${it.startLocation || ''}→${it.endLocation || ''}` : '') +
      (it.note ? `   · ${it.note.slice(0, 40)}` : ''));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('❌ 生成失败:', e.message);
  process.exit(1);
});
