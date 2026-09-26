/**
 * 班次时刻真实性：代码不许改写模型给的真实班次
 *
 * 起因（2026-09-26）：用户反馈"生成的每班高铁车次和时间都和当天真实车次对不上"。
 * 排查下来不是模型记不住（图定列车是长期稳定的公开信息），而是我们自己的兜底
 * 把班次整体平移了：车次号还是模型给的，时刻却成了算出来的。
 *
 * 三条铁律：
 *   1. 用户填的出发/到家时间与真实班次冲突时，保留班次时刻，改提示人几点出门
 *   2. 时间线重叠时，交通条目不让路也不顺延，让景点/用餐条目先收尾
 *   3. 班次时刻必须落在 5 分钟刻度上（真实运行图没有 08:37 发车）
 */

const P = require('../cloudfunctions/generatePlan/plan.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra || ''); }
}

// ---------- 1. 冲突时保留真实班次时刻，不平移 ----------
{
  const p = { goTime: '15:30', backTime: '23:00' };
  const outline = {
    days: [
      {
        city: 'A市',
        moves: [{ from: 'A站', to: 'B站', mode: 'train', code: 'G1234', startTime: '08:30', endTime: '13:20' }],
      },
      {
        city: 'B市',
        moves: [{ from: 'B站', to: 'A站', mode: 'train', code: 'G5678', startTime: '18:00', endTime: '23:30' }],
      },
    ],
  };
  const r = P.applyTripEdgeTimes(p, outline);
  const go = r.days[0].moves[0];
  const back = r.days[1].moves[0];
  ok('去程：真实发车时刻不被平移', go.startTime === '08:30' && go.endTime === '13:20', `${go.startTime}-${go.endTime}`);
  ok('返程：真实到站时刻不被平移', back.startTime === '18:00' && back.endTime === '23:30', `${back.startTime}-${back.endTime}`);
  ok('去程：冲突时提示建议几点出发', /建议 \d{2}:\d{2} 前出发/.test(r.days[0].note || ''), r.days[0].note);
  ok('返程：冲突时提示预计几点到家', /预计 \d{2}:\d{2} 到家/.test(r.days[1].note || ''), r.days[1].note);
}

// ---------- 2. 不冲突时不加提示（别啰嗦） ----------
{
  // backTime 20:00 到家 → 期望到站 19:20，与模型给的 19:20 正好对上
  const p = { goTime: '07:00', backTime: '20:00' };
  const outline = {
    days: [
      { city: 'A市', moves: [{ from: 'A站', to: 'B站', mode: 'train', code: 'G1', startTime: '08:25', endTime: '10:10' }] },
      { city: 'B市', moves: [{ from: 'B站', to: 'A站', mode: 'train', code: 'G2', startTime: '17:30', endTime: '19:20' }] },
    ],
  };
  const r = P.applyTripEdgeTimes(p, outline);
  ok('对得上时不去动时刻', r.days[0].moves[0].startTime === '08:25');
  ok('对得上时不啰嗦提示', !/建议|预计/.test(`${r.days[0].note || ''}${r.days[1].note || ''}`));
}

// ---------- 3. 时刻规整到 5 分钟刻度 ----------
{
  const outline = {
    days: [
      { city: 'A市', moves: [{ from: 'A站', to: 'B站', mode: 'train', code: 'G1', startTime: '08:37', endTime: '14:23' }] },
      { city: 'B市', moves: [{ from: 'B站', to: 'C站', mode: 'car', code: '包车', startTime: '09:03', endTime: '11:08' }] },
    ],
  };
  const r = P.snapScheduleMinutes(outline);
  ok('火车发车规整到 5 分刻度', r.days[0].moves[0].startTime === '08:35', r.days[0].moves[0].startTime);
  ok('火车到达规整到 5 分刻度', r.days[0].moves[0].endTime === '14:25', r.days[0].moves[0].endTime);
  ok('包车/自驾不参与规整', r.days[1].moves[0].startTime === '09:03', r.days[1].moves[0].startTime);
}

// ---------- 4. 时间线重叠：交通不让路，让别的条目先收尾 ----------
{
  const items = [
    { dayIndex: 0, category: 'sight', activity: '逛博物馆', startTime: '10:00', endTime: '15:00' },
    { dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 G99 次列车从A站前往B站', startTime: '14:00', endTime: '17:00' },
  ];
  const out = P.fixDayTimeOverlaps(items);
  const train = out.find((x) => x.category === 'transport');
  const sight = out.find((x) => x.category === 'sight');
  ok('交通条目的发车时刻不被顺延', train.startTime === '14:00', train.startTime);
  ok('改为让前一条行程提前收尾', sight.endTime === '14:00', sight.endTime);
}

// ---------- 5. 交通 vs 交通：仍然顺延（否则全天时间线崩） ----------
{
  const items = [
    { dayIndex: 0, category: 'transport', transportType: 'car', activity: '打车去车站', startTime: '10:00', endTime: '14:30' },
    { dayIndex: 0, category: 'transport', transportType: 'train', activity: '乘 G88 次列车', startTime: '14:00', endTime: '17:00' },
  ];
  const out = P.fixDayTimeOverlaps(items);
  const train = out.find((x) => /G88/.test(x.activity));
  ok('同为交通时仍保底顺延（时间线不断）', train.startTime === '14:30', train.startTime);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
