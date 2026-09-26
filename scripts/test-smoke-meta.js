// 真实 LLM 冒烟测试：验证两个修复
//   ① 中间天班次时刻允许静默微调后，模型不再把"内心独白"写进行程
//   ② 每天行程收尾闭环（最后一条回住宿地；返程日除外）
// 用法：node scripts/test-smoke-meta.js
const fs = require('fs');
const path = require('path');

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
const { sanitizeItems } = require('../cloudfunctions/generatePlan/normalize.js');
const META_HARD = require('../cloudfunctions/generatePlan/normalize.js').META_HARD;

// 冒烟检查的独白特征直接从 normalize.js 的 META_HARD 派生，永远跟生产清洗同频，
// 避免生产新增了黑话而冒烟脚本还在用旧词表（实测漏过"错误修正：此处应为乘车时间"）
const META_HINT = new RegExp(
  require('../cloudfunctions/generatePlan/normalize.js').META_HARD.map((r) => r.source).join('|'), 'i');

(async () => {
  console.log('生成 3 天川西小行程（真实 LLM）…');
  const t0 = Date.now();
  const input = {
    dest: '成都、都江堰',
    startDate: '2026-10-10',
    endDate: '2026-10-12',
    transport: '高铁/动车优先',
    origin: '重庆市金童路',
    goTime: '15:30',
    backTime: '20:00',
    budget: '舒适',
    pace: '适中',
    interests: ['美食', '夜景'],
  };
  const outlineRes = await P.generateOutline(input);
  const outline = outlineRes.outline;
  console.log(`大纲完成 ${Date.now() - t0}ms：${outlineRes.title}`);
  outline.days.forEach((d) => console.log(`  ${d.date} ${d.city}｜${d.theme}｜ov=${d.overnight}｜hotel=${d.hotel || '-'}｜mv=${(d.moves || []).map((m) => `${m.code} ${m.startTime}-${m.endTime}`).join(';')}`));

  // 细化有 60s 墙钟预算，3 天经常一轮跑不完（partial=true）。
  // 之前这里只调一次就拿结果去断言"末日收在出发地"——末日压根还没生成，
  // 脚本把"已生成的最后一天"当成末日查，必然失败（false positive）。
  // 与 test-generate 一致：续跑到全部完成为止，再合并每轮新生成的天。
  let plan = null;
  let rounds = 0;
  const allItems = [];
  for (let r = 0; r < 6; r++) {
    plan = await P.buildPlan(input, Object.assign({}, input, { outline }), {
      doneDayIndexes: plan && plan.doneDayIndexes,
      attempts: plan && plan.attempts,
    });
    rounds = r + 1;
    allItems.push(...plan.items);
    if (!plan.partial) break;
  }
  if (allItems.length !== plan.items.length) plan.items = allItems;
  console.log(`细化完成，共 ${plan.items.length} 条，${rounds} 轮，耗时 ${Date.now() - t0}ms\n`);

  let fail = 0;
  const ok = (cond, msg, extra) => {
    console.log((cond ? '  ✅ ' : '  ❌ ') + msg + (cond ? '' : `  → ${extra}`));
    if (!cond) fail++;
  };

  // ⓪ 新增：goTime 语义 = 离开出发地时刻（15:30 出门，大交通应在其后发车）
  const firstDay = plan.items.filter((it) => it.dayIndex === 0)
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const access = firstDay.find((it) => /金童路/.test(`${it.startLocation || ''}${it.activity || ''}`));
  ok(!!access, '第一天有「从金童路出发」的接驳条目（15:30 出门）',
    JSON.stringify(firstDay.slice(0, 2)));
  ok(access && access.startTime === '15:30', '接驳从 15:30（用户填的出发时间）开始',
    access && access.startTime);

  // ⓪.5 大纲给了推荐酒店，最后入住条目应落在具体酒店
  const hotels = outline.days.map((d) => d.hotel).filter(Boolean);
  ok(hotels.length > 0, '大纲有推荐酒店（h 字段生效）', String(hotels));

  // ① 无内心独白泄漏（清洗前后都不允许）
  const metaItems = plan.items.filter((it) => META_HINT.test(`${it.activity}${it.note}`));
  ok(metaItems.length === 0, '行程条目里没有模型内心独白',
    JSON.stringify(metaItems.map((x) => `${x.activity}|${x.note}`).slice(0, 2)));

  // ② 每天收尾闭环
  const days = [...new Set(plan.items.map((it) => it.dayIndex))].sort((a, b) => a - b);
  days.forEach((di) => {
    const list = plan.items.filter((it) => it.dayIndex === di)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    const last = list[list.length - 1];
    const ov = outline.days[di] && (outline.days[di].overnight || outline.days[di].city);
    const isReturn = /返程|回家/.test(ov || '');
    const closed = isReturn
      ? true
      : last.category === 'hotel' || /酒店|民宿|客栈|宾馆|青旅|住宿/.test(`${last.endLocation || ''}${last.activity || ''}`);
    ok(closed, `第${di + 1}天收尾闭环（最后一条：${String(last.activity).slice(0, 24)}…）`);
  });

  // 打印首日与中间天完整内容供人工核对
  console.log(`\n—— 第1天明细 ——`);
  firstDay.forEach((it) => console.log(`  ${it.startTime}-${it.endTime} ${it.activity}${it.note ? ' ｜ ' + it.note : ''}`));
  const mid = days.find((d) => d > 0 && d < days.length - 1);
  if (mid != null) {
    console.log(`\n—— 第${mid + 1}天明细 ——`);
    plan.items.filter((it) => it.dayIndex === mid)
      .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
      .forEach((it) => console.log(`  ${it.startTime}-${it.endTime} ${it.activity}${it.note ? ' ｜ ' + it.note : ''}`));
  }

  // ③ 末日必须收在出发地（到家，不是只到车站）
  const lastDi = days[days.length - 1];
  const lastDayItems = plan.items.filter((it) => it.dayIndex === lastDi)
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const lastItem = lastDayItems[lastDayItems.length - 1];
  ok(/金童路/.test(`${lastItem.endLocation || ''}${lastItem.activity || ''}`),
    '末日收在出发地（金童路到家）', `${lastItem.startTime}-${lastItem.endTime} ${lastItem.activity}`);

  console.log(fail ? `\n${fail} 项失败 ✗` : '\n冒烟通过 ✓');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟测试异常:', e.message); process.exit(1); });
