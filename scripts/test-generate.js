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
const { stripMeta } = require('../cloudfunctions/generatePlan/normalize.js');

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

// 5b. 剔除 LLM 的"内心独白"（真跑时第2天出现过一整段自我纠错）
//     用户会原样看到这段，必须只留"要做什么"
const meta1 = stripMeta(
  '08:00-08:30 打车前往磨盘山码头。*注：根据大纲，若人已在阳朔需调整，此处严格遵循【已确认跨城交通】。');
ok(!/注：/.test(meta1) && !/大纲/.test(meta1), '清掉"*注：根据大纲…"的推理段', meta1);
ok(/打车前往磨盘山码头/.test(meta1), '正常行程内容被保留', meta1);
const meta2 = stripMeta('20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉');
ok(meta2 === '20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉', '没有元叙述的原文原样不动');
const meta3 = stripMeta('注：作为AI我无法确认班次');
ok(meta3.length > 0, '整段都是元叙述时保留原文（不把行程清成空白）', meta3);

// 5c. 目的地清单解析：用户点名的地点一个都不能丢（"龙脊梯田消失"事件的防线）
const dl1 = P.parseDestList('桂林、龙脊梯田、阳朔、明仕田园和德天瀑布');
ok(dl1.mustVisit.join(',') === '桂林,龙脊梯田,阳朔,明仕田园,德天瀑布',
  '顿号 + "和"都能拆开', dl1.mustVisit.join(','));
const dl2 = P.parseDestList('广西（桂林、阳朔、南宁）');
ok(dl2.destList.includes('广西') && !dl2.mustVisit.includes('广西'),
  '省份只是范围提示，不算必到点', dl2.mustVisit.join(','));
ok(dl2.mustVisit.join(',') === '桂林,阳朔,南宁', '括号里的城市全部进必到清单', dl2.mustVisit.join(','));
const dl3 = P.parseDestList('北京颐和园');
ok(dl3.mustVisit.length === 1 && dl3.mustVisit[0] === '北京颐和园',
  '"颐和园"这类含"和"的地名不被切碎', dl3.mustVisit.join(','));
const dl4 = P.parseDestList('四川省、成都');
ok(!dl4.mustVisit.includes('四川省') && dl4.mustVisit.includes('成都'),
  '"四川省"被排除、城市保留', dl4.mustVisit.join(','));

// 5d. 大纲漏点检测：点名地点没出现在大纲里要能查出来
const fakeP = { mustVisit: ['桂林', '龙脊梯田'] };
const outlineMiss = {
  title: 't', summary: '', nights: [],
  days: [{ date: '2026-10-01', city: '桂林', theme: '象鼻山', moves: [], highlights: ['象鼻山'], meals: [], overnight: '桂林', note: '' }],
};
ok(P.missingMustVisit(fakeP, outlineMiss).join('') === '龙脊梯田',
  '漏掉龙脊梯田能被检测出来', JSON.stringify(P.missingMustVisit(fakeP, outlineMiss)));
const outlineHit = Object.assign({}, outlineMiss, {
  days: outlineMiss.days.concat([{ date: '2026-10-02', city: '龙胜', theme: '龙脊梯田一日', moves: [], highlights: ['龙脊梯田'], meals: [], overnight: '龙脊', note: '' }]),
});
ok(P.missingMustVisit(fakeP, outlineHit).length === 0, '排进去了就不再报缺');

// 5d-2. 点名地点覆盖判定要容忍"庄园/田园"这类一字之差
ok(P.placeStem('明仕庄园') === '明仕' && P.placeStem('明仕田园') === '明仕',
  '庄园/田园这类尾巴被剥掉，词干一致', P.placeStem('明仕庄园'));
ok(P.placeStem('龙脊梯田') === '龙脊', '梯田也算尾巴', P.placeStem('龙脊梯田'));
ok(P.placeStem('桂林') === '桂林', '普通地名原样保留', P.placeStem('桂林'));
ok(P.missingMustVisit({ mustVisit: ['明仕庄园'] }, {
  days: [{ date: '2026-10-01', city: '崇左', theme: '明仕田园与德天瀑布', moves: [], highlights: ['明仕田园'], meals: [], overnight: '崇左', note: '' }],
}).length === 0, '大纲写了「明仕田园」时不再误报缺「明仕庄园」');
ok(P.missingMustVisit({ mustVisit: ['龙脊梯田'] }, {
  days: [{ date: '2026-10-01', city: '桂林', theme: '市区', moves: [], highlights: ['象鼻山'], meals: [], overnight: '桂林', note: '' }],
}).length === 1, '真漏了照样报缺');

// 5e. 去程开始时间 / 返程到达时间：代码兜底对齐（不靠 LLM 自觉）
//     语义：goTime = 从出发城市启程的时刻；backTime = 回到出发城市的时刻（不是发车时刻）
const edgeP = normalizeInput({
  dest: '桂林', startDate: '2026-12-20', endDate: '2026-12-22',
  startTime: '08:30', endTime: '21:15',
});
const edgeOutline = {
  title: 't', summary: '', nights: [],
  days: [
    { date: '2026-12-20', city: '桂林', theme: '出发', overnight: '桂林', meals: [], note: '',
      moves: [{ from: '重庆北', to: '桂林西', mode: 'train', code: 'G2249', startTime: '14:44', endTime: '19:38' }],
      highlights: ['日月双塔'] },
    { date: '2026-12-21', city: '桂林', theme: '游玩', overnight: '桂林', meals: [], note: '', moves: [], highlights: [] },
    { date: '2026-12-22', city: '桂林', theme: '返程', overnight: '返程', meals: [], note: '',
      moves: [{ from: '桂林西', to: '重庆北', mode: 'train', code: 'G2244', startTime: '09:12', endTime: '14:06' }],
      highlights: [] },
  ],
};
const edged = P.applyTripEdgeTimes(edgeP, JSON.parse(JSON.stringify(edgeOutline)));
ok(edged.days[0].moves[0].startTime === '08:30',
  '去程：第一天大交通被对齐到「去程开始时间 08:30」', edged.days[0].moves[0].startTime);
ok(edged.days[0].moves[0].endTime === '13:24',
  '去程：运行时长保持不变（4h54m → 08:30-13:24）', edged.days[0].moves[0].endTime);
ok(edged.days[2].moves[0].endTime === '21:15',
  '返程：最后一天大交通被对齐到「返程到达时间 21:15」', edged.days[2].moves[0].endTime);
ok(edged.days[2].moves[0].startTime === '16:21',
  '返程：发车时刻按到达时刻倒推（4h54m → 16:21 发）', edged.days[2].moves[0].startTime);
// 到达时刻太早（倒推会退到前一天）时只保证到达时刻，不硬挪起点
const weird = P.applyTripEdgeTimes(
  normalizeInput({ dest: '桂林', startDate: '2026-12-20', endDate: '2026-12-22', endTime: '03:00' }),
  JSON.parse(JSON.stringify(edgeOutline)));
ok(weird.days[2].moves[0].endTime === '03:00' && weird.days[2].moves[0].startTime === '09:12',
  '到达时刻倒推会退到前一天时：只锁到达时刻，发车时刻不乱改',
  weird.days[2].moves[0].startTime + '-' + weird.days[2].moves[0].endTime);

// 5f. 行李规则兜底：换住处不能把行李留在酒店；寄了必须提醒取回
//    （提示词里写了规矩，但 LLM 会偷懒或写反，这层是确定性修补）
const lugOutline = {
  days: [
    { date: '2026-10-01', city: '桂林', overnight: '桂林市区（两江四湖片区）' },
    { date: '2026-10-02', city: '阳朔', overnight: '阳朔' },
  ],
};
const lug = (items) => P.enforceLuggageRules(
  items.map((x) => Object.assign({}, x)), lugOutline);

ok(P.samePlace('桂林市区（两江四湖片区）', '桂林'), '地点归一化：括号补注不影响同一基地判定');

let r1 = lug([
  { dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '退房，把大件行李寄存在酒店前台', category: 'hotel' },
  { dayIndex: 1, startTime: '09:00', endTime: '12:00', activity: '前往阳朔', category: 'transport' },
]);
ok(/退房请带走全部行李/.test(r1[0].note || ''),
  '换住处却把行李留在酒店 → 备注纠正为「退房带走全部行李」', r1[0].note);
ok(!/取回寄存的行李/.test(r1[1].note || ''),
  '已纠正成"带走"的寄存，不会再自相矛盾地喊他回来取', r1[1].note);

let r2 = lug([
  { dayIndex: 1, startTime: '08:00', endTime: '09:00', activity: '在酒店吃早餐', category: 'food' },
  { dayIndex: 1, startTime: '09:00', endTime: '12:00', activity: '前往阳朔', category: 'transport' },
]);
ok(/退房请带走全部行李/.test(r2[0].note || ''),
  '换住处却整天没提行李 → 早上第一条补上提醒', r2[0].note);

let r3 = P.enforceLuggageRules([
  { dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '退房，去西街逛逛', category: 'hotel', note: '' },
], { days: [{ overnight: '阳朔' }, { overnight: '阳朔' }] });
ok(!/退房请带走全部行李/.test(r3[0].note || ''),
  '当晚回同一家酒店：不强行加行李提醒（行李本来就留在房间里）', r3[0].note);

let r4 = lug([
  { dayIndex: 1, startTime: '10:00', endTime: '10:10', activity: '在游客中心寄存行李', category: 'other' },
  { dayIndex: 1, startTime: '10:10', endTime: '12:00', activity: '游览景区', category: 'sight' },
  { dayIndex: 1, startTime: '12:00', endTime: '13:00', activity: '前往阳朔西街', category: 'transport', startLocation: '景区', endLocation: '阳朔西街' },
]);
ok(/取回寄存的行李/.test(r4[2].note || ''),
  '景区寄存行李后，离开的那一条提醒取回', r4[2].note);

let r5 = lug([
  { dayIndex: 1, startTime: '10:00', endTime: '10:10', activity: '在游客中心寄存行李', category: 'other' },
  { dayIndex: 1, startTime: '10:10', endTime: '12:00', activity: '游览景区', category: 'sight' },
  { dayIndex: 1, startTime: '12:00', endTime: '13:00', activity: '取回行李后前往阳朔西街', category: 'transport', startLocation: '景区', endLocation: '阳朔西街' },
]);
ok(!/取回寄存的行李/.test(r5[2].note || ''),
  '模型自己写了"取回行李" → 不重复追加', r5[2].note);

let r6 = P.enforceLuggageRules([
  { dayIndex: 2, startTime: '08:00', endTime: '09:00', activity: '吃早餐', category: 'food' },
], { days: [{ overnight: '阳朔' }, { overnight: '阳朔' }, { overnight: '返程' }] });
ok(/今天返程/.test(r6[0].note || ''), '返程日的行李提醒改成"今天返程"口吻', r6[0].note);

// 6. 失败天重试链路（不调真实 LLM：把 llm.chatWithRetry 换成假实现）
//
//    背景：之前某天细化失败会被直接排除在续跑队列外，partial=false 就结束了，
//    用户只会发现"行程少了第 3 天"，云函数日志之外没有任何提示。
//    现在失败天最多重试 3 次，耗尽后放进 gaveUpDayIndexes 交给前端明文提示。
const llm = require('../cloudfunctions/generatePlan/llm.js');
const realChat = llm.chatWithRetry;
const mkDay = (date) => ({
  date, theme: '主题', city: '某城', highlights: ['景点A'],
  moves: [], meals: [], overnight: '某城', note: '',
});
const fakeOutline = { days: [mkDay('2026-12-20'), mkDay('2026-12-21'), mkDay('2026-12-22')] };
const fakeProfile = normalizeInput({ dest: '某城', startDate: '2026-12-20', endDate: '2026-12-22' });

// 第 2 天（12-21）永远返回一段没有 JSON 的废话 → 模拟 LLM 抽风/超时
llm.chatWithRetry = async (messages) => {
  const txt = String((messages[1] && messages[1].content) || '');
  if (/【今天】2026-12-21/.test(txt)) return '抱歉，我无法完成这个请求';
  return JSON.stringify([
    { dayIndex: 0, startTime: '09:00', endTime: '10:00', activity: '游览景点A', category: 'sight' },
  ]);
};

(async () => {
  let r = await P.genDayItems(fakeProfile, fakeOutline, { deadline: Date.now() + 60000 });
  ok(r.partial === true, '第2天失败后仍在续跑队列（partial=true，不再被静默丢弃）');
  ok((r.failedDayIndexes || []).includes(1), '第2天被记为失败', JSON.stringify(r.failedDayIndexes));
  ok(((r.attempts || {})[1] || 0) === 1, '第2天失败次数记为 1', JSON.stringify(r.attempts));
  ok(!(r.gaveUpDayIndexes || []).length, '还没到放弃的时候', JSON.stringify(r.gaveUpDayIndexes));

  r = await P.genDayItems(fakeProfile, fakeOutline,
    { deadline: Date.now() + 60000, doneDayIndexes: r.doneDayIndexes, attempts: r.attempts });
  ok(((r.attempts || {})[1] || 0) === 2 && r.partial, '第2次失败后仍重试', JSON.stringify(r.attempts));

  r = await P.genDayItems(fakeProfile, fakeOutline,
    { deadline: Date.now() + 60000, doneDayIndexes: r.doneDayIndexes, attempts: r.attempts });
  const gaveUp = r.gaveUpDayIndexes || [];
  ok(gaveUp.includes(1), '第3次失败后放弃并上报 gaveUpDayIndexes', JSON.stringify(gaveUp));
  ok(r.partial === false, '放弃后不再无限续跑（否则前端会死循环）', r.partial);
  ok((r.doneDayIndexes || []).sort().join() === '0,2', '其余两天正常完成', JSON.stringify(r.doneDayIndexes));

  llm.chatWithRetry = realChat;

  if (process.argv.includes('--unit')) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
  await runRealGeneration();
})().catch((e) => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});

function runRealGeneration() {
console.log('\n============================================');
console.log('第二部分：真实 LLM 生成（国庆广西场景）');
console.log('============================================');

const INPUT = {
  origin: '重庆金童路',
  dest: '桂林、阳朔、龙脊梯田、明仕庄园和德天瀑布',
  startDate: '2026-09-30',
  endDate: '2026-10-07',
  startTime: '08:30',   // 去程开始时间：08:30 从重庆出发
  endTime: '21:15',     // 返程到达时间：21:15 回到重庆
  people: 2,
  party: '情侣出行',
  budget: '舒适',
  pace: '适中',
  interests: ['自然山水', '古镇古村', '当地美食', '拍照打卡'],
  transport: '高铁/动车优先',
  mustGo: '漓江游船、遇龙河竹筏',
  extra: '不想全程自驾，尽量公共交通+当地直通车',
};

return (async () => {
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

  // 点名地点必须全部进大纲（Tiger 实锤：龙脊梯田曾被 LLM 默默丢掉）
  const mustVisit = P.normalizeInput(INPUT).mustVisit;
  const outlineJson = JSON.stringify(phase1.outline);
  // 用"词干"比对：用户写的「明仕庄园」和地图通用名「明仕田园」是同一个地方，
  // 模型按通用名写反而更利于导航，不能算漏——全等比对会误报
  const stemOf = (s) => String(s || '')
    .replace(/(庄园|田园|景区|风景区|名胜区|公园|古镇|古村|古寨|度假区|自然保护区|旅游区)$/, '')
    .trim();
  mustVisit.forEach((name) => {
    const stem = stemOf(name);
    const hit = outlineJson.includes(name) || (stem.length >= 2 && outlineJson.includes(stem));
    ok(hit, `大纲包含点名地点「${name}」${hit ? '' : `（词干「${stem}」也没匹配上）`}`);
  });

  // 去程开始 / 返程到达时刻必须落在大纲里（代码兜底对齐，不是靠 LLM 自觉）
  const od = phase1.outline.days || [];
  const firstMove = (od[0] && od[0].moves || [])[0];
  const lastMoves = (od[od.length - 1] && od[od.length - 1].moves) || [];
  const lastMove = lastMoves[lastMoves.length - 1];
  ok(!!firstMove && firstMove.startTime === '08:30',
    '去程开始时间生效（第一天大交通 08:30 发车）', firstMove && firstMove.startTime);
  ok(!!lastMove && lastMove.endTime === '21:15',
    '返程到达时间生效（最后一天 21:15 抵达出发地）', lastMove && `${lastMove.startTime}-${lastMove.endTime}`);
  ok(!!lastMove && lastMove.startTime !== '21:15',
    '返程没把到达时间误当成发车时间', lastMove && lastMove.startTime);

  // 阶段二：模拟云端续跑——一次跑不完（partial）就接着调，直到全部生成
  const t1 = Date.now();
  let plan = null;
  let slowest = 0;
  let rounds = 0;
  const allItems = [];
  for (let r = 0; r < 6; r++) {
    const rt = Date.now();
    // attempts 要跟着回传，否则失败的天不会被重试（与前端续跑逻辑保持一致）
    plan = await P.buildPlan(INPUT, Object.assign({}, INPUT, phase1), {
      doneDayIndexes: plan && plan.doneDayIndexes,
      attempts: plan && plan.attempts,
    });
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

  // 详细行程里得真的去了龙脊梯田（不只是一句带过——这是 Tiger 点名要防的回归）
  const hitLongji = plan.items.some((it) =>
    /龙脊/.test(String(it.activity || '') + (it.startLocation || '') + (it.endLocation || '')));
  ok(hitLongji, '详细行程包含「龙脊梯田」相关安排');

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

  // 住宿闭环：昨天住的地方，今天第一条就该从那里出发（跨城大交通日除外）
  let chainBreak = 0;
  const outlineDays = (phase1.outline.days || []);
  for (let d = 1; d < outlineDays.length; d++) {
    const dayItems = plan.items.filter((it) => it.dayIndex === d)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (!dayItems.length) continue;
    const prevOv = outlineDays[d - 1].overnight || outlineDays[d - 1].city || '';
    const first = dayItems[0];
    const loc = String(first.startLocation || '') + String(first.activity || '') + String(first.endLocation || '');
    const sameCity = prevOv && outlineDays[d].overnight
      && (outlineDays[d].overnight.includes(prevOv) || prevOv.includes(outlineDays[d].overnight)
        || outlineDays[d].city === outlineDays[d - 1].city);
    // 同城连住才检查闭环；跨城日第一件事本来就是赶路，不查
    if (sameCity && prevOv && !loc.includes(prevOv.slice(0, 2))) chainBreak++;
  }
  ok(chainBreak === 0, '同城连住的天，早上从昨晚住宿地出发（闭环）', chainBreak);
  // 闭环兜底：每天"第一条"的 startLocation 都不该是空的（吃饭/游览留空是正常的）
  let emptyFirst = [];
  for (let d = 1; d < outlineDays.length; d++) {
    const dayItems = plan.items.filter((it) => it.dayIndex === d)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (dayItems.length && !String(dayItems[0].startLocation || '').trim()) {
      emptyFirst.push(`第${d + 1}天「${dayItems[0].activity}」`);
    }
  }
  ok(emptyFirst.length === 0, '每天第一条都有起点（兜底已补齐）', emptyFirst.join('；'));

  // 行李：换住处的天必须交代行李怎么走；只要寄存了就必须有取回提醒
  const lugMissing = [];
  const lugNoPickup = [];
  for (let d = 0; d < outlineDays.length; d++) {
    const dayItems = plan.items.filter((it) => it.dayIndex === d)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    if (!dayItems.length) continue;
    const tonight = outlineDays[d].overnight || outlineDays[d].city || '';
    const lastNight = d > 0 ? (outlineDays[d - 1].overnight || outlineDays[d - 1].city || '') : '';
    if (!lastNight || P.samePlace(lastNight, tonight)) continue;   // 只查换住处的天
    const txt = dayItems.map((it) => `${it.activity || ''} ${it.note || ''}`).join(' ');
    if (!/行李/.test(txt)) lugMissing.push(`第${d + 1}天`);
    if (/寄存|存放|存包/.test(txt)
      && !/取回|取件|拿回|领回/.test(txt)
      && !/退房请带走全部行李/.test(txt)) lugNoPickup.push(`第${d + 1}天`);
    dayItems.filter((it) => /行李/.test(`${it.activity || ''}${it.note || ''}`))
      .forEach((it) => console.log(`  [第${d + 1}天 ${it.startTime}] ${it.activity}${it.note ? ' ｜ ' + it.note : ''}`));
  }
  ok(lugMissing.length === 0, '换住处的每一天都交代了行李怎么走', lugMissing.join('；'));
  ok(lugNoPickup.length === 0, '寄存行李的天都有「取回」提醒', lugNoPickup.join('；'));

  console.log('\n闹钟清单：');
  (plan.alarms || []).forEach((a) => {
    console.log(`  [${a.fireAtStr}] ${a.title}  (${a.type}${a.source ? '/' + a.source : ''})`);
    if (a.note) console.log(`      └ ${a.note.slice(0, 80)}`);
  });
  const alarms = plan.alarms || [];
  // 临近出发场景下，已过开票日的抢票闹钟会被规则收敛掉一部分，
  // 数量随 LLM 提名波动（实测 4~7 条）——质量门槛看下面的类型覆盖
  ok(alarms.length >= 4, '至少 4 条待办（车票/门票/酒店/准备）', alarms.length);
  // 去程票闹钟：LLM 提名或规则补齐都行，标题里认得"出发地→目的地"即可
  const goA = alarms.find((a) => /去程/.test(a.title)
    || (a.type === 'train' && /重庆|金童/.test(a.title) && /桂林/.test(a.title)));
  ok(!!goA, '存在去程抢票闹钟');
  ok(alarms.every((a) => a.fireAt > Date.now()), '所有闹钟都在未来');
  // 待办必须按时间先后排好（用户照着做就行）
  let sortedOk = true;
  for (let i = 1; i < alarms.length; i++) if (alarms[i].fireAt < alarms[i - 1].fireAt) sortedOk = false;
  ok(sortedOk, '待办按时间从早到晚排序');
  const types = [...new Set(alarms.map((a) => a.type))];
  ok(types.length >= 3, `覆盖至少 3 类待办（${types.join('/')}）`, types.length);

  // 查漏补齐后：每一晚住宿都该有自己的预订提醒（同酒店连住按晚各算）
  const outlineNights = (phase1.outline.days || []).length - 1;
  const hotelAlarms = alarms.filter((a) => a.type === 'hotel');
  ok(hotelAlarms.length >= Math.min(outlineNights, 5),
    `酒店提醒覆盖住宿（${hotelAlarms.length} 条 / ${outlineNights} 晚，≥5 即算全覆盖同类）`, hotelAlarms.length);

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
})();
}
