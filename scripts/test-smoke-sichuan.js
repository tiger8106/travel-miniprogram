// 真实 LLM 冒烟：重庆金童路 → 成都、都江堰、毕棚沟（多目的地、需换基地）
// 检查：① 成都市区逛/吃具体性 ② 都江堰/毕棚沟是否真展开 ③ 白天回酒店/餐次时间错乱
//      ④ 住宿是否跟着景点走（不许全程一家酒店）
// 用法：node scripts/test-smoke-sichuan.js [--nodetail]
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('❌ 缺少 .env.local');
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

const input = {
  dest: '成都、都江堰、毕棚沟',
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  transport: '高铁/动车优先',
  origin: '重庆市金童路',
  goTime: '08:00',
  backTime: '20:00',
  budget: '舒适',
  pace: '适中',
  interests: ['自然风光', '美食'],
};

(async () => {
  const t0 = Date.now();
  const out = await P.generateOutline(input);
  const outline = out.outline;
  console.log(`=== 大纲 ${Date.now() - t0}ms：${outline.title} ===`);
  console.log(`概览：${outline.summary}`);
  outline.days.forEach((d, i) => {
    console.log(`D${i + 1} ${d.date} [${d.city}] ${d.theme}`);
    console.log(`    必玩: ${(d.highlights || []).join('、') || '(空)'}`);
    console.log(`    餐饮: ${(d.meals || []).join('、') || '(空)'}`);
    console.log(`    住: ${d.overnight}  酒店: ${d.hotel || '-'}`);
    (d.moves || []).forEach((m) => console.log(`    交通: ${m.from}→${m.to} ${m.mode} ${m.code} ${m.startTime}-${m.endTime}`
      + (m.transfer ? ` ｜到站接驳: ${m.transfer}` : ' ｜到站接驳: (未报)')));
  });

  if (process.argv.includes('--nodetail')) return;
  // 模拟真实前端的续跑循环：partial=true 就带着 doneDayIndexes/attempts 再调，
  // 直到 partial=false（用户全程只看到"正在细化…"）
  const t1 = Date.now();
  let allItems = [];
  let done = [];
  let attempts = {};
  let plan = null;
  for (let round = 1; round <= 6; round++) {
    plan = await P.buildPlan(input, out, { doneDayIndexes: done, attempts });
    allItems = allItems.concat(plan.items);
    done = plan.doneDayIndexes || [];
    attempts = plan.attempts || {};
    console.log(`—— 第${round}轮：新增 ${plan.items.length} 条，partial=${plan.partial}，累计 ${allItems.length} 条 ——`);
    if (!plan.partial) break;
  }
  const planItems = allItems;
  console.log(`\n=== 细化 ${planItems.length} 条，总耗时 ${Date.now() - t0}ms ===`);
  const byDay = new Map();
  planItems.forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  [...byDay.keys()].sort((a, b) => a - b).forEach((di) => {
    console.log(`\n--- 第${di + 1}天 ---`);
    byDay.get(di).forEach((it) => {
      console.log(`  ${it.startTime}-${it.endTime} [${it.category}] ${it.activity}`
        + (it.startLocation || it.endLocation ? `  📍${it.startLocation || '?'}→${it.endLocation || '?'}` : ''));
    });
  });

  // 自动检查
  console.log('\n=== 检查 ===');
  let fail = 0;
  const bad = (msg) => { console.log('  ❌ ' + msg); fail++; };
  const good = (msg) => console.log('  ✅ ' + msg);

  // ① 住宿：非返程日的 ov 应该不止一个基地（多目的地长线必须换基地）
  const ovs = outline.days.slice(0, -1).map((d) => d.overnight || d.city);
  const uniqOv = [...new Set(ovs.map((s) => String(s).replace(/[（(].*?[)）]/g, '').trim()))];
  if (uniqOv.length >= 2) good(`住宿基地有 ${uniqOv.length} 个：${uniqOv.join(' / ')}`);
  else bad(`全部住在同一个基地：${uniqOv.join('/')}（都江堰/毕棚沟离成都远，应换基地）`);

  // ② 白天回酒店：非末日在 15:00 前出现 category=hotel（入住/放行李/寄存除外）
  planItems.forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (di === 4 - 1) return;
    const m = /^(\d{1,2}):/.exec(String(it.startTime || ''));
    const legit = /入住|办理|放(行李|下)|寄存|行李/.test(`${it.activity || ''}${it.note || ''}`);
    if (it.category === 'hotel' && !legit && m && +m[1] < 15) {
      bad(`第${di + 1}天 ${it.startTime} 白天回酒店：${it.activity}`);
    }
  });
  // ③ 餐次时间错乱：晚餐/晚饭排在 11 点前；早餐排在 11 点后
  planItems.forEach((it) => {
    if (it.category !== 'food') return;
    const m = /^(\d{1,2}):/.exec(String(it.startTime || ''));
    if (!m) return;
    const h = +m[1];
    if (/晚餐|晚饭/.test(it.activity) && h < 11) bad(`第${(it.dayIndex || 0) + 1}天 ${it.startTime} 排了「${it.activity}」`);
    if (/早餐|早饭/.test(it.activity) && h >= 11) bad(`第${(it.dayIndex || 0) + 1}天 ${it.startTime} 排了「${it.activity}」`);
  });
  // ④ 空话检查：hl/activity 里出现"逛逛市区/自由活动"这类
  outline.days.forEach((d, i) => {
    (d.highlights || []).forEach((h) => {
      if (/^(逛|市区|自由|成都市市区)/.test(String(h).trim())) bad(`D${i + 1} 必玩点太空泛：「${h}」`);
    });
  });
  const vagueFood = planItems.filter((it) => it.category === 'food'
    && /吃(晚饭|晚餐|午饭|早餐)|用餐/.test(it.activity) && !/[（(]|：|，/.test(it.activity));
  if (vagueFood.length) bad(`空话餐饮 ${vagueFood.length} 条：${vagueFood.slice(0, 3).map((x) => x.activity).join(' / ')}`);
  // ⑤ 都江堰/毕棚沟要有真正展开（sight 条目按词干匹配，容忍"伏龙观/磐羊湖"这类子景点写法）
  ['都江堰', '毕棚沟'].forEach((name) => {
    const hits = planItems.filter((it) => it.category === 'sight'
      && `${it.activity || ''}${it.endLocation || ''}`.includes(name));
    const subHits = planItems.filter((it) => it.category === 'sight'
      && /伏龙观|宝瓶口|飞沙堰|鱼嘴|安澜索桥|二王庙|离堆|南桥|磐羊湖|燕子岩窝|上海子|龙王海|红石滩/.test(`${it.activity || ''}${it.endLocation || ''}`));
    if (hits.length + subHits.length >= 2) good(`「${name}」有 ${hits.length + subHits.length} 条相关游览条目`);
    else bad(`「${name}」游览条目只有 ${hits.length + subHits.length} 条，没真正进去玩`);
  });

  // ⑥ 舍近求远（通用判定，不认具体站名）：
  //    a) 大纲里"到站后还要长途打车"的段
  const detours = P.detourTransfers(outline);
  if (detours.length) bad(`到站后仍需长途打车的段 ${detours.length} 处：${detours.map((x) => `第${x.dayIndex + 1}天 ${x.move.from}→${x.move.to}（${x.move.transfer}）`).join('；')}`);
  else good('没有"到站后还得长途打车"的段（选站没绕路）');
  //    b) 细化里实际排出来的"从某站打车 ≥25 分钟才到当天目的地"
  //       （终点是住宿地/家不算——到站回酒店本来就得坐车，不是站选错了）
  const isLodging = (s) => /酒店|宾馆|民宿|客栈|公寓|住所|家中|家里/.test(String(s || ''));
  const wasteful = planItems.filter((it) => it.category === 'transport'
    && String(it.transportType || '') === 'car'
    && /站$/.test(String(it.startLocation || ''))
    && !isLodging(it.endLocation) && !isLodging(it.activity)
    && (P.toMin(it.endTime) - P.toMin(it.startTime)) >= 25);
  if (wasteful.length) bad(`到站后长途打车 ${wasteful.length} 条：${wasteful[0].activity}`);
  else good('没有"下车后长距离打车才到目的地"的段');

  console.log(fail ? `\n共 ${fail} 项不通过` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
