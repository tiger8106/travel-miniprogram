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
const { stripMeta, sanitizeItems } = require('../cloudfunctions/generatePlan/normalize.js');

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

// 5d-3. "只路过"不算覆盖（都江堰事件的防线）：出现在 mv 描述 / n 提示里的
// 「经过都江堰游客中心」不能当成"去玩了"——只认 城市/主题/必玩点 三个字段
const transitOutline = {
  days: [{
    date: '2026-10-01', city: '毕棚沟', theme: '直奔毕棚沟',
    moves: [{ from: '成都', to: '毕棚沟', m: 'car', c: '', s: '07:00', e: '12:00', n: '坐车经过都江堰游客中心' }],
    highlights: ['毕棚沟'], meals: [], overnight: '毕棚沟', note: '',
  }],
};
ok(P.missingMustVisit({ mustVisit: ['都江堰'] }, transitOutline).length === 1,
  '「途经都江堰」不算覆盖：只在交通描述里出现照样报缺',
  JSON.stringify(P.missingMustVisit({ mustVisit: ['都江堰'] }, transitOutline)));
ok(P.missingMustVisit({ mustVisit: ['成都市'] }, transitOutline).length === 1,
  '「成都市」按词干比对（成都）不被带"市"字卡住',
  JSON.stringify(P.missingMustVisit({ mustVisit: ['成都市'] }, transitOutline)));

// 5d-4. 跨天重复游玩检测（毕棚沟玩两次事件的防线）
const dupOutline = {
  days: [
    { date: '2026-10-01', city: '毕棚沟', theme: '毕棚沟', moves: [], highlights: ['毕棚沟', '娜姆湖'], meals: [], overnight: '毕棚沟', note: '' },
    { date: '2026-10-02', city: '成都', theme: '市区', moves: [], highlights: ['宽窄巷子'], meals: [], overnight: '成都', note: '' },
    { date: '2026-10-03', city: '毕棚沟', theme: '再玩一次', moves: [], highlights: ['晨拍毕棚沟', '红军沟'], meals: [], overnight: '成都', note: '' },
  ],
};
const dups = P.duplicateHighlights(dupOutline);
ok(dups.length === 1 && dups[0].name === '毕棚沟' && dups[0].days.join(',') === '0,2',
  '「毕棚沟」与「晨拍毕棚沟」算同一个，跨天报重', JSON.stringify(dups));
const cleanDups = P.duplicateHighlights({
  days: [
    { date: '2026-10-01', city: '成都', theme: 'x', moves: [], highlights: ['宽窄巷子', '锦里'], meals: [], overnight: '成都', note: '' },
    { date: '2026-10-02', city: '都江堰', theme: 'x', moves: [], highlights: ['青城山', '都江堰景区'], meals: [], overnight: '成都', note: '' },
  ],
});
ok(cleanDups.length === 0, '不同景点不误报', JSON.stringify(cleanDups));

// 5e. 去程开始时间 / 返程到家时间：代码兜底对齐（不靠 LLM 自觉）
//     语义（二次修正）：goTime = 离开出发地（家门口）的时刻 → 大交通发车
//     = goTime + 市内接驳 40 分 + 安检候车 45 分（火车）/2 小时（飞机）；
//     backTime = 到家时刻 → 大交通到站 = backTime - 40 分（市内返家接驳）
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
ok(edged.days[0].moves[0].startTime === '09:55',
  '去程：大交通发车 = 出发时间 08:30 + 接驳 40 分 + 安检候车 45 分 = 09:55',
  edged.days[0].moves[0].startTime);
ok(edged.days[0].moves[0].endTime === '14:49',
  '去程：运行时长保持不变（4h54m → 09:55-14:49）', edged.days[0].moves[0].endTime);
ok(edged.days[2].moves[0].endTime === '20:35',
  '返程：大交通到站 = 到家时间 21:15 - 市内返家 40 分 = 20:35',
  edged.days[2].moves[0].endTime);
ok(edged.days[2].moves[0].startTime === '15:41',
  '返程：发车时刻按到站时刻倒推（4h54m → 15:41 发）', edged.days[2].moves[0].startTime);
// 到达时刻太早（倒推会退到前一天）时只保证到达时刻，不硬挪起点
const weird = P.applyTripEdgeTimes(
  normalizeInput({ dest: '桂林', startDate: '2026-12-20', endDate: '2026-12-22', endTime: '03:00' }),
  JSON.parse(JSON.stringify(edgeOutline)));
ok(weird.days[2].moves[0].endTime === '02:20' && weird.days[2].moves[0].startTime === '09:12',
  '到达时刻倒推会退到前一天时：只锁到达时刻（到家 03:00 → 到站 02:20），发车时刻不乱改',
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

let r7 = lug([
  { dayIndex: 1, startTime: '08:00', endTime: '08:30', activity: '携带全部行李打车前往汽车站', category: 'transport', note: '行李随身带，不寄存' },
  { dayIndex: 1, startTime: '09:00', endTime: '12:00', activity: '前往明仕田园', category: 'transport', note: '严禁寄存回原酒店' },
]);
ok(!/取回寄存的行李/.test(r7[0].note || '') && !/取回寄存的行李/.test(r7[1].note || ''),
  '否定句里的"寄存"（不寄存/严禁寄存）不算寄存，不冒出取回提醒',
  JSON.stringify([r7[0].note, r7[1].note]));

let r8 = lug([
  { dayIndex: 0, startTime: '07:30', endTime: '08:00', activity: '大件行李留在酒店房间或寄存前台，轻装出发', category: 'hotel' },
  { dayIndex: 0, startTime: '09:00', endTime: '12:00', activity: '前往都江堰景区', category: 'transport' },
]);
ok(!/取回寄存的行李/.test(r8[1].note || ''),
  '行李寄在本家酒店且今晚回同一家 → 不多嘴喊"取回"（川西冒烟实锤）', r8[1].note);

// 5g. 同天时间重叠兜底：LLM 偶尔排出"上一条没结束下一条就开始了"
const overlapped = P.fixDayTimeOverlaps([
  { dayIndex: 0, startTime: '09:00', endTime: '10:00', activity: 'A' },
  { dayIndex: 0, startTime: '09:30', endTime: '11:00', activity: 'B' },
  { dayIndex: 0, startTime: '08:00', endTime: '08:40', activity: 'C' },
]);
ok(overlapped[0].activity === 'C' && overlapped[1].activity === 'A' && overlapped[2].activity === 'B',
  '同天条目按开始时间排序', JSON.stringify(overlapped.map((x) => x.activity)));
ok(overlapped[2].startTime === '10:00' && overlapped[2].endTime === '11:00',
  '重叠条目开始时间被顺延到上一条结束，结束时间保留', `${overlapped[2].startTime}-${overlapped[2].endTime}`);
const contained = P.fixDayTimeOverlaps([
  { dayIndex: 0, startTime: '09:00', endTime: '12:00', activity: 'A' },
  { dayIndex: 0, startTime: '10:00', endTime: '10:30', activity: 'B' },
]);
ok(contained[1].startTime === '12:00' && contained[1].endTime === '12:30',
  '完全被盖住的条目：顺延后至少给 30 分钟，不造零时长', `${contained[1].startTime}-${contained[1].endTime}`);

// 5h. 模型"内心独白"整条泄漏（川西实锤）：
//     activity 是对"必须原样执行"的论证独白，不是行程 —— stripMeta 逐句删
//     对整段独白无能为力（删光了会原样保留），必须在条目级抢救或丢弃
const metaGarbage = {
  dayIndex: 2, startTime: '17:15', endTime: '17:35',
  activity: '鉴于上游要求"必须原样执行"但给出了具体时刻 13:00-13:20，前序行程需大幅提前或此为错误约束。**修正正确**：如果严格执行13:00的交通，那么上午游览后必须立即离开。',
  category: 'transport', startLocation: '都江堰站', endLocation: '眉山站', transportType: 'train',
  note: '原样执行车使用的交通时刻：13:00-13:20',
};
const salvaged = sanitizeItems([metaGarbage]);
ok(salvaged.length === 1, '整段独白但带起终点 → 抢救成干净的交通条目',
  JSON.stringify(salvaged.map((x) => x.activity)));
ok(salvaged.length && salvaged[0].activity === '从都江堰站前往眉山站' && !salvaged[0].note,
  '独白剥干净，只留"从哪到哪"', salvaged.length ? `${salvaged[0].activity} / note=${salvaged[0].note}` : '（被丢了）');
ok(salvaged.length && salvaged[0].startTime === '17:15' && salvaged[0].endTime === '17:35',
  '抢救条目保留原时刻', salvaged.length ? `${salvaged[0].startTime}-${salvaged[0].endTime}` : '');
const droppedMeta = sanitizeItems([{
  dayIndex: 0, startTime: '10:00', endTime: '11:00',
  activity: '鉴于上游要求原样执行，此为错误约束，修正正确如下。',
  category: 'other',
}]);
ok(droppedMeta.length === 0, '没有起终点可抢救的独白条目 → 整条丢弃', JSON.stringify(droppedMeta));
const normalItem = sanitizeItems([{
  dayIndex: 0, startTime: '09:00', endTime: '10:00',
  activity: '乘 C6122 次列车从都江堰站前往眉山站',
  category: 'transport', startLocation: '都江堰站', endLocation: '眉山站',
}]);
ok(normalItem.length === 1 && normalItem[0].activity.includes('C6122'),
  '正常交通条目不受 META_HARD 误伤', normalItem.length ? normalItem[0].activity : '（被丢了）');

// 5i. 收尾闭环兜底：当天最后一条必须收在住宿地（返程日除外）
const closureOutline = { days: [{ overnight: '都江堰' }, { overnight: '眉山' }, { overnight: '返程' }] };
const closed = P.enforceDayClosure([
  { dayIndex: 1, startTime: '16:30', endTime: '17:15', activity: '候车休息，准备乘车', category: 'other', startLocation: '都江堰站', endLocation: '都江堰站' },
  { dayIndex: 1, startTime: '17:15', endTime: '17:35', activity: '从都江堰站前往眉山站', category: 'transport', startLocation: '都江堰站', endLocation: '眉山站', transportType: 'train' },
  { dayIndex: 2, startTime: '09:00', endTime: '11:00', activity: '逛宽窄巷子', category: 'sight' },
], closureOutline);
const appended = closed.filter((x) => x.dayIndex === 1 && x.category === 'hotel');
ok(appended.length === 1
  && /前往眉山/.test(appended[0].activity)
  && appended[0].startLocation === '眉山站' && appended[0].endLocation === '眉山',
  '没收在住宿地的天 → 补一条"前往住宿地办理入住"（带导航起终点）',
  JSON.stringify(appended));
ok(appended.length && appended[0].startTime === '17:45' && appended[0].endTime === '18:15',
  '补的酒店条目接在最后一条结束 +10 分钟，不与前面重叠',
  appended.length ? `${appended[0].startTime}-${appended[0].endTime}` : '');
ok(!closed.some((x) => x.dayIndex === 2 && x.category === 'hotel'),
  '返程日（ov=返程）不补"回酒店"');
const alreadyHome = P.enforceDayClosure([
  { dayIndex: 0, startTime: '21:00', endTime: '21:30', activity: '回酒店休息', category: 'hotel', endLocation: '' },
], closureOutline);
ok(alreadyHome.length === 1 && alreadyHome[0].endLocation === '都江堰',
  '已收在酒店：只补漏填的终点，不加条目', JSON.stringify(alreadyHome));
const homeByWord = P.enforceDayClosure([
  { dayIndex: 0, startTime: '21:00', endTime: '21:40', activity: '回民宿休息', category: 'other' },
], closureOutline);
ok(homeByWord.length === 1, '描述里写了回酒店/民宿 → 视为已收尾，不重复补',
  JSON.stringify(homeByWord.map((x) => x.activity)));

// 5i-2. 出发接驳 / 早餐 / 晚间安排 / 推荐酒店 / 到家接驳（确定性兜底）
//       场景来自实测：出发地"重庆市金童路 15:30"被生成成"15:30 乘高铁"，
//       从家去车站的接驳凭空消失；晚上 7 点到酒店后行程就断了。
const accP = normalizeInput({
  origin: '重庆市金童路', dest: '成都', startDate: '2026-09-26', endDate: '2026-09-28',
  startTime: '15:30', endTime: '20:00',
});
const accOutline = { days: [
  { date: '2026-09-26', city: '成都', overnight: '成都', hotel: '成都瑞城名人酒店',
    moves: [{ from: '重庆西站', to: '成都东站', mode: 'train', code: 'G8505', startTime: '16:55', endTime: '19:30' }] },
  { date: '2026-09-27', city: '成都', overnight: '成都', moves: [] },
  { date: '2026-09-28', city: '成都', overnight: '返程',
    moves: [{ from: '成都东站', to: '重庆北站', mode: 'train', code: 'G8506', startTime: '16:40', endTime: '19:20' }] },
] };

// a) 第一天没有从出发地出发的条目 → 补接驳
const accItems = P.enforceOriginAccess([
  { dayIndex: 0, startTime: '16:10', endTime: '16:55', activity: '在重庆西站安检候车', category: 'other' },
  { dayIndex: 0, startTime: '16:55', endTime: '19:30', activity: '乘 G8505 次列车从重庆西站前往成都东站', category: 'transport', startLocation: '重庆西站', endLocation: '成都东站', transportType: 'train' },
], accP, accOutline);
const acc = accItems.filter((x) => x.startLocation === '重庆市金童路');
ok(acc.length === 1 && acc[0].endLocation === '重庆西站' && acc[0].startTime === '15:30',
  '第一天没有出发接驳 → 补「15:30 从金童路去重庆西站」', JSON.stringify(acc));

// b) 已有接驳不重复插
const accItems2 = P.enforceOriginAccess([
  { dayIndex: 0, startTime: '15:30', endTime: '16:10', activity: '从重庆市金童路打车前往重庆西站', category: 'transport', startLocation: '重庆市金童路', endLocation: '重庆西站', transportType: 'car' },
], accP, accOutline);
ok(accItems2.length === 1, '已有出发接驳 → 不重复补');

// c) 第 2 天 10 点前没吃饭 → 补早餐（接在首条出发前）
const morning = P.enforceMorningRoutine([
  { dayIndex: 1, startTime: '09:30', endTime: '10:00', activity: '从酒店出发前往都江堰', category: 'transport', startLocation: '成都', endLocation: '都江堰', transportType: 'car' },
], accOutline);
const brk = morning.filter((x) => x.category === 'food');
ok(brk.length === 1 && brk[0].startTime === '08:50' && brk[0].endTime === '09:25',
  '第 2 天没有早餐 → 补一条（接在首条出发前）', JSON.stringify(brk));

// d) 已有早餐不补
const morning2 = P.enforceMorningRoutine([
  { dayIndex: 1, startTime: '08:00', endTime: '08:40', activity: '在酒店吃早餐', category: 'food' },
  { dayIndex: 1, startTime: '09:00', endTime: '10:00', activity: '出发去景区', category: 'transport' },
], accOutline);
ok(morning2.length === 2, '已有早餐 → 不重复补');

// e1) 人已回酒店但 19:00 就结束 → 补一条"再出门夜逛"（closure 随后补回酒店）
const evening1 = P.enforceEveningPlan([
  { dayIndex: 0, startTime: '17:00', endTime: '19:00', activity: '到酒店放行李', category: 'hotel', endLocation: '成都' },
], accOutline);
ok(evening1.filter((x) => x.category === 'sight').length === 1
  && evening1[evening1.length - 1].startTime === '19:30'
  && /夜生活|夜游|夜市/.test(evening1[evening1.length - 1].activity),
  '19:00 就回酒店的非末日 → 补夜逛', JSON.stringify(evening1));

// e2) 人还在外面 19:00 收尾 → 补晚餐 + 夜逛
const evening2 = P.enforceEveningPlan([
  { dayIndex: 0, startTime: '17:00', endTime: '19:00', activity: '逛春熙路', category: 'sight', endLocation: '春熙路' },
], accOutline);
ok(evening2.filter((x) => x.category === 'food').length === 1
  && evening2.length === 3
  && evening2[1].startTime === '19:15' && evening2[2].startTime === '20:50',
  '19:00 还在外的非末日 → 补晚餐 + 夜逛', JSON.stringify(evening2));

// f) 22:00 收尾 → 不补
const evening3 = P.enforceEveningPlan([
  { dayIndex: 0, startTime: '20:00', endTime: '22:00', activity: '夜游锦江', category: 'sight' },
], accOutline);
ok(evening3.length === 1, '22:00 收尾的天不再补晚间安排');

// g) closure 用大纲推荐酒店补入住；返程日已到家不重复补
const closedP = P.enforceDayClosure([
  { dayIndex: 0, startTime: '18:00', endTime: '19:00', activity: '逛春熙路', category: 'sight', endLocation: '春熙路' },
  { dayIndex: 2, startTime: '19:20', endTime: '20:00', activity: '从重庆北站打车返回重庆市金童路', category: 'transport', startLocation: '重庆北站', endLocation: '重庆市金童路', transportType: 'car' },
], accOutline, accP);
const hotelItem = closedP.filter((x) => x.dayIndex === 0 && x.category === 'hotel');
ok(hotelItem.length === 1 && hotelItem[0].endLocation === '成都瑞城名人酒店',
  '有推荐酒店 → 补的入住条目直接导航到酒店', JSON.stringify(hotelItem));
ok(closedP.filter((x) => x.dayIndex === 2).length === 1, '返程日已写到家的 → 不重复补接驳');

// h) 末日只到车站 → 补回家接驳
const closedP2 = P.enforceDayClosure([
  { dayIndex: 2, startTime: '16:40', endTime: '19:20', activity: '乘 G8506 抵达重庆北站', category: 'transport', startLocation: '成都东站', endLocation: '重庆北站', transportType: 'train' },
], accOutline, accP);
const home = closedP2.filter((x) => x.dayIndex === 2 && x.endLocation === '重庆市金童路');
ok(home.length === 1 && home[0].startTime === '19:30',
  '返程日只到车站 → 补「回家」接驳', JSON.stringify(home));

// 5j. 已确认大交通对齐兜底：车次错时刻/漏排/重复/起终点错都要被拽回
const alignOutline = { days: [
  { overnight: '成都', moves: [{ from: '重庆西站', to: '成都东站', mode: 'train', code: 'G8505', startTime: '08:30', endTime: '11:00' }] },
  { overnight: '都江堰', moves: [{ from: '成都东站', to: '重庆西站', mode: 'train', code: 'G8528', startTime: '15:00', endTime: '17:00' }] },
] };
// a) 15:00 的返程被模型写到 09:00、终点还串成了当天景区 → 拽回 15:00-17:00、起终点回车站
const aligned = P.enforceMovesAlignment([
  { dayIndex: 1, startTime: '09:00', endTime: '10:30', activity: '乘 G8528 从成都东站前往重庆西站（此处为倒叙，规划时间线以符合上游规定）', category: 'transport', startLocation: '成都东站', endLocation: '都江堰景区离堆公园', transportType: 'train' },
  { dayIndex: 1, startTime: '10:30', endTime: '12:30', activity: '游览都江堰景区', category: 'sight' },
], alignOutline);
const aTrain = aligned.find((x) => /G8528/.test(x.activity));
ok(aTrain && aTrain.startTime === '15:00' && aTrain.endTime === '17:00',
  '大交通时刻漂移超 60 分钟 → 拽回大纲既定时刻', aTrain && `${aTrain.startTime}-${aTrain.endTime}`);
ok(aTrain && aTrain.startLocation === '成都东站' && aTrain.endLocation === '重庆西站',
  '大交通起终点强制对齐大纲车站（导航 chip 不再串到景区）',
  aTrain && `${aTrain.startLocation}→${aTrain.endLocation}`);
ok(aTrain && !/倒叙|时间线|上游/.test(aTrain.activity),
  '带独白的大交通条目重写成干净版', aTrain && aTrain.activity);
// b) 大纲有这段大交通、模型全程没提 → 补一条
const filled = P.enforceMovesAlignment([
  { dayIndex: 0, startTime: '12:00', endTime: '13:00', activity: '午餐', category: 'food' },
], alignOutline);
const added = filled.find((x) => /G8505/.test(x.activity));
ok(added && added.startTime === '08:30' && added.startLocation === '重庆西站' && added.endLocation === '成都东站'
  && added.category === 'transport',
  '大纲大交通全天未安排 → 补一条干净交通条目', added && JSON.stringify(added));
// c) 同一车次出现两条 → 留时刻最接近大纲的，其余丢弃
const deduped = P.enforceMovesAlignment([
  { dayIndex: 1, startTime: '14:40', endTime: '17:00', activity: '乘 G8528 次列车从成都东站前往重庆西站', category: 'transport', startLocation: '成都东站', endLocation: '重庆西站', transportType: 'train' },
  { dayIndex: 1, startTime: '09:00', endTime: '10:30', activity: '乘 G8528 从成都东站前往重庆西站（倒叙）', category: 'transport', startLocation: '成都东站', endLocation: '重庆西站', transportType: 'train' },
], alignOutline);
ok(deduped.filter((x) => /G8528/.test(x.activity)).length === 1
  && deduped.find((x) => /G8528/.test(x.activity)).startTime === '14:40',
  '同一车次重复条目只留一条（时刻最接近大纲的）',
  JSON.stringify(deduped.filter((x) => /G8528/.test(x.activity)).map((x) => x.startTime)));
// d) sanitize 层：整条"倒叙"独白没起终点 → 丢弃
const droppedMono = sanitizeItems([
  { dayIndex: 0, startTime: '09:00', endTime: '10:30', activity: '实际行程将提前完成都江堰，此处为倒叙 bridge，规划时间线以符合上游规定的约束' },
]);
ok(droppedMono.length === 0, '"倒叙/规划时间线"独白条目（无起终点）整条丢弃',
  JSON.stringify(droppedMono));
const rescuedMono = sanitizeItems([
  { dayIndex: 0, startTime: '09:00', endTime: '10:30', activity: '乘 G8528 前往重庆西站（此处为倒叙 bridge）', startLocation: '成都东站', endLocation: '重庆西站' },
]);
ok(rescuedMono.length === 1 && rescuedMono[0].category === 'transport'
  && !/倒叙/.test(rescuedMono[0].activity),
  '"倒叙"独白条目有起终点 → 抢救成干净交通条目', JSON.stringify(rescuedMono));
const fixedMono = sanitizeItems([
  { dayIndex: 0, startTime: '16:15', endTime: '20:00', activity: '错误修正：此处应为乘车时间。根据既定路线' },
]);
ok(fixedMono.length === 0, '"错误修正/此处应为/既定路线"独白条目整条丢弃',
  JSON.stringify(fixedMono));

// 终点回填：餐饮标题式写法（广西攻略实测：「晚餐：刘姐啤酒鱼」没导航）
const backfill = sanitizeItems([
  { dayIndex: 0, startTime: '18:00', endTime: '20:00', activity: '晚餐：刘姐啤酒鱼' },
  { dayIndex: 0, startTime: '12:00', endTime: '13:00', activity: '在金童路一奥天地吃午饭' },
  { dayIndex: 0, startTime: '18:30', endTime: '20:30', activity: '吃特色小吃，喝糖水' },
]);
ok(backfill[0].endLocation === '刘姐啤酒鱼', '"晚餐：店名"回填终点为店名',
  backfill[0].endLocation);
ok(backfill[1].endLocation === '金童路一奥天地', '"在XX吃午饭"回填终点为XX',
  backfill[1].endLocation);
ok(!backfill[2].endLocation || backfill[2].endLocation === '', '泛词（特色小吃）不回填，宁缺毋滥',
  backfill[2].endLocation);

// 5k. 无起终点条目的终点回填（餐饮/游览条目经常全空，卡片连导航都没有）
const { inferDestination } = require('../cloudfunctions/generatePlan/normalize.js');
ok(inferDestination('在崇善米粉（依仁路总店）吃桂林米粉') === '崇善米粉（依仁路总店）',
  '「在…吃…」抽出门店全名', inferDestination('在崇善米粉（依仁路总店）吃桂林米粉'));
ok(inferDestination('前往鼎鼎香农家菜吃饭') === '鼎鼎香农家菜',
  '「前往…吃饭」砍掉句尾动词尾巴', inferDestination('前往鼎鼎香农家菜吃饭'));
ok(inferDestination('游览兴坪古镇、20元人民币背景观景点及老寨山（可选）') === '兴坪古镇',
  '「游览…」截到第一个顿号', inferDestination('游览兴坪古镇、20元人民币背景观景点及老寨山（可选）'));
ok(inferDestination('在酒店吃早餐') === '', '泛词不回填（酒店/附近不算目的地）',
  inferDestination('在酒店吃早餐'));
ok(inferDestination('回酒店休息') === '', '没有移动动词就不抽', inferDestination('回酒店休息'));
const backfilled = sanitizeItems([
  { dayIndex: 0, startTime: '20:20', endTime: '21:00', activity: '在崇善米粉（依仁路总店）吃桂林米粉', category: 'food' },
  { dayIndex: 0, startTime: '21:00', endTime: '21:10', activity: '步行前往杉湖', startLocation: '崇善米粉（依仁路总店）', endLocation: '杉湖', category: 'transport' },
]);
ok(backfilled[0].endLocation === '崇善米粉（依仁路总店）',
  '回填后餐饮条目有了导航终点', backfilled[0].endLocation);
ok(backfilled[1].endLocation === '杉湖' && backfilled[1].startLocation === '崇善米粉（依仁路总店）',
  '本来就有起终点的条目不受回填影响', `${backfilled[1].startLocation}→${backfilled[1].endLocation}`);

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
  // 漏点/重复的代码级检测（与云端修订用同一套判定）
  const playMissing = P.missingMustVisit({ mustVisit }, phase1.outline);
  ok(playMissing.length === 0, `大纲每个点名地点都有"真游玩"安排（不只是路过）`, playMissing.join('、'));
  const outlineDups = P.duplicateHighlights(phase1.outline);
  ok(outlineDups.length === 0, '大纲没有跨天重复游玩的景点',
    outlineDups.map((d) => `${d.name}(第${d.days.map((x) => x + 1).join(',')}天)`).join('；'));

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
    // 否定句里的"寄存"（"行李随身带，不寄存""严禁寄存回原酒店"）不算寄存
    const stripNeg = (s) => String(s || '').replace(/(不|勿|别|无需|无须|不用|避免|严禁|禁止|不要)(寄存|存放|存包|寄放)/g, '');
    const txt = dayItems.map((it) => `${it.activity || ''} ${it.note || ''}`).map(stripNeg).join(' ');
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

  // 查漏补齐后：每一晚住宿都该被预订提醒覆盖。LLM 会把连住合并成一条
  // （「10月4日-10月6日共2晚」），所以按标题里能对上的晚数算，不按条数算。
  // 临近出发时（提醒日已过去的晚）本来就不可能再提醒，只要求"可提醒的晚全覆盖"。
  const outlineNights = (phase1.outline.days || []).length - 1;
  const hotelAlarms = alarms.filter((a) => a.type === 'hotel');
  let coveredNights = 0;
  hotelAlarms.forEach((a) => {
    const m = /共(\d+)晚/.exec(a.title || '');
    coveredNights += m ? Number(m[1]) : 1;
  });
  const checkinDates = (phase1.outline.days || []).slice(0, -1).map((d) => d.date);
  const remindable = checkinDates.filter((ds) => {
    // 酒店提醒在入住日前 7 天的 20:00 触发，触发力在"现在"之前就算不可提醒
    const fire = new Date(`${ds}T20:00:00+08:00`).getTime() - 7 * 86400000;
    return fire >= Date.now();
  }).length;
  ok(coveredNights >= remindable,
    `酒店提醒覆盖住宿（覆盖 ${coveredNights} 晚 / 可提醒 ${remindable} 晚，共 ${outlineNights} 晚）`, coveredNights);

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
