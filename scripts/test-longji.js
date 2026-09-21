#!/usr/bin/env node
/**
 * 端到端验证：龙脊梯田日（多段移动原文）
 * 流程：callLLM（新提示词）→ sanitizeItems（新清洗）→ 打印时间线
 * 用法：node scripts/test-longji.js
 */
const path = require('path');
const fs = require('fs');

// 读 .env.local
const envPath = path.resolve(__dirname, '..', '.env.local');
fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
});

const { callLLM } = require('../cloudfunctions/parseTravelPlan/llm');
const { sanitizeItems } = require('../cloudfunctions/parseTravelPlan/normalize');

const rawText = `国庆七天广西旅游攻略

10月1日｜桂林市区

08:00酒店出发，步行前往崇善米粉一号店吃早饭。
09:30游览象鼻山景区，拍照打卡。
12:00午餐后回酒店休息。
19:00去杉湖看日月双塔夜景。
22:30回梵泊美地酒店（桂林两江四湖象鼻山景区店）睡觉。

10月2日｜龙脊梯田

06:45起床，07:15早餐。
7:25打车前往锦江都城酒店（象山景区店），乘坐直通车。
8:00乘坐桂林站→金坑大寨的直通车，正常用时2.5小时到达金坑大寨停车场，微信联系“桂林龙脊梯田旅游车队”客服或者龙脊别院（西山韶乐店）客服。
10:30～11:00抵达金坑大寨停车场，下车后坐观光车前往田头寨（报酒店名字购票20元/人，不报50元/人），之后步行前往龙脊别院（西山韶乐店）。注：到停车场时可以先确定当天缆车末班车时间。
11:20左右去龙脊别院（西山韶乐店）放行李，11:30在民宿吃午饭，推荐竹筒鸡、竹筒饭、腊肉炒笋、禾花鱼。
13:00～14:30走千层天梯一带。 这里最适合看梯田密集的曲线和层层叠叠的结构。龙脊别院到千层天梯观景台1公里，步行约半小时。
14:30左右前往龙脊索道（出站口），步行1.6 km，约 40 min。
15:30左右乘缆车上金佛顶，重点等日落，日落大概在17:30-18:30之间。金佛顶视野最开阔，也是金坑比较经典的日落位置；具体当天缆车末班时间一定要在进景区后确认，以免错过末班。
19:00回龙脊别院（西山韶乐店），步行2.7公里，约1.5小时，中途可以看千层天梯夜景。
20:30吃饭、洗澡、在露台看看夜景，22:00左右休息。第二天要早起。

10月3日｜阳朔

09:00从龙脊别院（西山韶乐店）打车到龙脊梯田路口，再乘大巴前往阳朔，约2小时。
13:30租电动车骑十里画廊。路线：遇龙河→工农桥→大榕树附近→月亮山远眺→村道田园→返回酒店。不用每个景点都买票进去。十里画廊真正值得的是路上的喀斯特山峰、田野和河流。
`;

(async () => {
  console.log('调用 LLM（并行逐天模式）...');
  const t0 = Date.now();
  const r = await callLLM(rawText);
  console.log(`LLM 耗时 ${Date.now() - t0} ms，items ${r.items.length} 条\n`);

  const items = sanitizeItems(r.items);
  const day1 = items.filter((i) => i.dayIndex === 1); // 10月2日 → dayIndex 1

  console.log('=== 10月2日 龙脊梯田 清洗后时间线 ===');
  day1.forEach((it) => {
    const nav = it.startLocation && it.endLocation ? `  [导航 ${it.startLocation} → ${it.endLocation}]` : '';
    console.log(`${it.startTime}${it.endTime ? '~' + it.endTime : ''}  ${it.activity}${nav}${it.note ? '  (备注:' + it.note.slice(0, 30) + ')' : ''}`);
  });

  // 校验点
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✓' : '✗ FAIL'} ${name}`);
    if (!cond) failed++;
  };
  const find = (kw) => day1.filter((i) => i.activity.indexOf(kw) >= 0);

  check('全部条目都有 startTime（无 --:-- 沉底）', day1.every((i) => /^\d{2}:\d{2}$/.test(i.startTime)));
  const fake = day1.filter((i) => i.startLocation && i.startLocation === i.endLocation);
  check('无起点=终点的假导航', fake.length === 0);
  check('无空起点的半截导航', day1.every((i) => !i.startLocation === !i.endLocation));
  const shuttle = find('观光车');
  check('观光车→田头寨 已拆出并带导航', shuttle.length > 0 && shuttle[0].endLocation.indexOf('田头寨') >= 0);
  const lunch = find('午饭');
  check('午饭无导航（未移动）', lunch.length === 0 || (!lunch[0].startLocation && !lunch[0].endLocation));
  // 跨天继承：前一天 22:30 回梵泊美地酒店，次日 7:25 打车未写出发点
  const taxi = find('打车前往锦江都城酒店');
  if (taxi.length) {
    console.log(`  打车条目导航: "${taxi[0].startLocation}" → "${taxi[0].endLocation}"`);
    check('打车继承前一天终点（梵泊美地酒店）', taxi[0].startLocation.indexOf('梵泊美地') >= 0,
      `实际 "${taxi[0].startLocation}"`);
  } else {
    check('存在"打车前往锦江都城酒店"条目', false);
  }
  // 多段路线拆分：十里画廊骑行
  const gallery = items.filter((i) => i.dayIndex === 2 && (i.activity.indexOf('画廊') >= 0 || i.activity.indexOf('遇龙河') >= 0 || i.activity.indexOf('工农桥') >= 0 || i.activity.indexOf('月亮山') >= 0 || i.activity.indexOf('大榕树') >= 0));
  console.log('  十里画廊拆分段数:', gallery.length);
  gallery.forEach((g) => console.log(`    ${g.startTime} ${g.activity} [${g.startLocation || '?'} → ${g.endLocation || '?'}]`));
  check('骑行路线拆成多段（>=3）', gallery.length >= 3, `实际 ${gallery.length} 段`);
  check('每段都有确定时间', gallery.every((g) => /^\d{2}:\d{2}$/.test(g.startTime)));
  check('每段都有导航信息（起点或终点至少一头）',
    gallery.every((g) => g.startLocation || g.endLocation));
  check('备注"不用每个景点都买票"保留', gallery.some((g) => (g.note || '').indexOf('买票') >= 0));

  console.log(failed ? `\n${failed} 项校验失败` : '\n端到端校验全部通过 ✓');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
