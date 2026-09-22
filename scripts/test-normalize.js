// scripts/test-normalize.js
// 验证 normalize.sanitizeItems：
//   1. 同点假导航清除（龙脊别院→龙脊别院）
//   2. 缺失 startTime 回填（拆分后无时间项不再 --:-- 沉底）
// 运行：node scripts/test-normalize.js
const { sanitizeItems } = require('../cloudfunctions/parseTravelPlan/normalize');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ' → ' + detail : ''}`);
  }
}

// ---------- 案例 1：国庆广西攻略第 2 天（用户截图场景） ----------
console.log('\n[案例1] 龙脊梯田日（多段移动 + 同点假导航 + 无时间项）');
const day1 = [
  { dayIndex: 1, startTime: '06:45', endTime: '', activity: '起床', category: 'other' },
  { dayIndex: 1, startTime: '7:15', endTime: '', activity: '早餐', category: 'food' },
  {
    dayIndex: 1, startTime: '07:25', endTime: '08:00', activity: '打车前往锦江都城酒店（象山景区店），乘坐直通车',
    category: 'transport', startLocation: '崇善米粉一号店', endLocation: '锦江都城酒店（象山景区店）', transportType: 'car',
  },
  {
    dayIndex: 1, startTime: '08:00', endTime: '10:30', activity: '乘坐桂林站→金坑大寨的直通车',
    category: 'transport', startLocation: '桂林站', endLocation: '金坑大寨', transportType: 'car',
    note: '正常用时2.5小时到达金坑大寨停车场，微信联系"桂林龙脊梯田旅游车队"客服或者龙脊别院（西山韶乐店）客服',
  },
  {
    dayIndex: 1, startTime: '10:30', endTime: '11:00', activity: '抵达金坑大寨停车场',
    category: 'transport', startLocation: '桂林站', endLocation: '金坑大寨停车场', transportType: 'car',
  },
  // LLM 常见坏输出：拆出的后续段没有时间
  {
    dayIndex: 1, startTime: '', endTime: '', activity: '坐观光车前往田头寨',
    category: 'transport', startLocation: '金坑大寨停车场', endLocation: '田头寨', transportType: 'bus',
    note: '报酒店名字购票20元/人，不报50元/人',
  },
  {
    dayIndex: 1, startTime: '', endTime: '', activity: '步行前往龙脊别院（西山韶乐店）',
    category: 'transport', startLocation: '田头寨', endLocation: '龙脊别院（西山韶乐店）', transportType: 'walk',
  },
  {
    dayIndex: 1, startTime: '11:20', endTime: '', activity: '去龙脊别院（西山韶乐店）放行李',
    category: 'hotel', startLocation: '', endLocation: '龙脊别院（西山韶乐店）', transportType: 'walk',
  },
  // 假导航：在民宿吃饭，起终点相同
  {
    dayIndex: 1, startTime: '11:30', endTime: '13:00', activity: '在民宿吃午饭',
    category: 'food', startLocation: '龙脊别院（西山韶乐店）', endLocation: '龙脊别院（西山韶乐店）',
    note: '推荐竹筒鸡、竹筒饭、腊肉炒笋、禾花鱼',
  },
  {
    dayIndex: 1, startTime: '', endTime: '', activity: '休息',
    category: 'other', startLocation: '龙脊别院（西山韶乐店）', endLocation: '龙脊别院（西山韶乐店）',
  },
];

const out1 = sanitizeItems(day1);
const byAct = {};
out1.forEach((it) => (byAct[it.activity] = it));

console.log('  时间线:', out1.map((i) => `${i.startTime} ${i.activity}`).join(' | '));

check('观光车回填时间 = 11:00（上一条 endTime）', byAct['坐观光车前往田头寨'].startTime === '11:00',
  `实际 ${byAct['坐观光车前往田头寨'].startTime}`);
check('步行回填时间 = 11:30（观光车 11:00 + 30min 顺延）', byAct['步行前往龙脊别院（西山韶乐店）'].startTime === '11:30',
  `实际 ${byAct['步行前往龙脊别院（西山韶乐店）'].startTime}`);
check('休息回填时间（参考后面已知 13:00 往前推）', byAct['休息'].startTime !== '',
  `实际 ${byAct['休息'].startTime}`);
check('7:15 补零为 07:15', byAct['早餐'].startTime === '07:15');
check('午饭假导航已清除（同点→无导航）',
  byAct['在民宿吃午饭'].startLocation === '' && byAct['在民宿吃午饭'].endLocation === '');
check('午饭备注保留', byAct['在民宿吃午饭'].note.indexOf('竹筒鸡') >= 0);
check('休息假导航已清除', byAct['休息'].startLocation === '' && byAct['休息'].endLocation === '');
check('观光车导航保留（真实移动）',
  byAct['坐观光车前往田头寨'].startLocation === '金坑大寨停车场' && byAct['坐观光车前往田头寨'].endLocation === '田头寨');
check('只填终点的"放行李"单头保留（前端"导航到目的地"）',
  byAct['去龙脊别院（西山韶乐店）放行李'].startLocation === '' &&
  byAct['去龙脊别院（西山韶乐店）放行李'].endLocation === '龙脊别院（西山韶乐店）');
check('全部条目都有 startTime（无 --:--）', out1.every((i) => /^\d{2}:\d{2}$/.test(i.startTime)));

// ---------- 案例 2：全天无时间 ----------
console.log('\n[案例2] 全天无时间 → 首项兜底 08:00');
const day2 = [
  { dayIndex: 0, startTime: '', endTime: '', activity: '自由活动', category: 'other' },
  { dayIndex: 0, startTime: '', endTime: '', activity: '收拾行李', category: 'other' },
];
const out2 = sanitizeItems(day2);
check('首项 08:00', out2[0].startTime === '08:00', `实际 ${out2[0].startTime}`);
check('次项 08:30', out2[1].startTime === '08:30', `实际 ${out2[1].startTime}`);

// ---------- 案例 3：不移动的地点名相同但写法带空格差异 ----------
console.log('\n[案例3] 同点写法带空格差异');
const day3 = [
  {
    dayIndex: 0, startTime: '12:00', endTime: '', activity: '酒店休息',
    category: 'other', startLocation: '龙脊别院 (西山韶乐店)', endLocation: '龙脊别院(西山韶乐店)',
  },
];
const out3 = sanitizeItems(day3);
check('空格差异的同点导航也清除', out3[0].startLocation === '' && out3[0].endLocation === '');

// ---------- 案例 4：跨天位置继承（用户截图场景） ----------
console.log('\n[案例4] 跨天起点继承：前一天回酒店睡觉，次日第一条移动继承出发点');
const crossDay = [
  // 第 1 天（dayIndex 0）：晚上回酒店
  { dayIndex: 0, startTime: '21:00', endTime: '', activity: '去杉湖看日月双塔夜景', category: 'sight', startLocation: '东西巷', endLocation: '杉湖', transportType: 'walk' },
  { dayIndex: 0, startTime: '22:30', endTime: '', activity: '回梵泊美地酒店（桂林两江四湖象鼻山景区店）睡觉', category: 'hotel', startLocation: '杉湖', endLocation: '梵泊美地酒店（桂林两江四湖象鼻山景区店）', transportType: 'car' },
  // 第 2 天（dayIndex 1）：早上打车，原文没写出发点
  { dayIndex: 1, startTime: '06:45', endTime: '07:15', activity: '起床', category: 'other' },
  { dayIndex: 1, startTime: '07:15', endTime: '07:25', activity: '早餐', category: 'food' },
  { dayIndex: 1, startTime: '07:25', endTime: '08:00', activity: '打车前往锦江都城酒店（象山景区店）', category: 'transport', startLocation: '', endLocation: '锦江都城酒店（象山景区店）', transportType: 'car' },
  // 第 3 天（dayIndex 2）：昨晚住龙脊别院，早上出门看日出，原文没写出发点
  { dayIndex: 2, startTime: '19:00', endTime: '20:30', activity: '回龙脊别院（西山韶乐店）', category: 'other', startLocation: '金佛顶', endLocation: '龙脊别院（西山韶乐店）', transportType: 'walk' },
  { dayIndex: 2, startTime: '05:30', endTime: '06:00', activity: '起床', category: 'other' },
  { dayIndex: 2, startTime: '06:00', endTime: '06:30', activity: '出门前往西山韶乐观景点等日出', category: 'sight', startLocation: '', endLocation: '西山韶乐观景点', transportType: 'walk' },
];
const out4 = sanitizeItems(crossDay);
const taxi = out4.find((i) => i.activity === '打车前往锦江都城酒店（象山景区店）');
const sunrise = out4.find((i) => i.activity === '出门前往西山韶乐观景点等日出');
check('次日打车继承出发点 = 梵泊美地酒店（前一天终点）',
  taxi.startLocation === '梵泊美地酒店（桂林两江四湖象鼻山景区店）', `实际 "${taxi.startLocation}"`);
check('次日打车导航完整保留', taxi.endLocation === '锦江都城酒店（象山景区店）');
check('第三天看日出继承出发点 = 龙脊别院（隔天也生效）',
  sunrise.startLocation === '龙脊别院（西山韶乐店）', `实际 "${sunrise.startLocation}"`);
// 边界：前一天无任何地点信息时，不硬造起点
const noPrev = [
  { dayIndex: 0, startTime: '09:00', endTime: '', activity: '自由活动', category: 'other' },
  { dayIndex: 1, startTime: '08:00', endTime: '', activity: '前往车站', category: 'transport', startLocation: '', endLocation: '桂林北站', transportType: 'car' },
];
const out5 = sanitizeItems(noPrev);
check('无前文位置时不硬造起点（单头保留终点）',
  out5[1].startLocation === '' && out5[1].endLocation === '桂林北站');
// 边界：继承后起点==终点（人已在目的地）→ 假导航清除
const sameDay = [
  { dayIndex: 0, startTime: '18:00', endTime: '', activity: '抵达金坑大寨停车场', category: 'transport', startLocation: '桂林站', endLocation: '金坑大寨停车场', transportType: 'car' },
  { dayIndex: 1, startTime: '09:00', endTime: '', activity: '停车场集合', category: 'other', startLocation: '', endLocation: '金坑大寨停车场', transportType: 'car' },
];
const out6 = sanitizeItems(sameDay);
// 边界：继承后起点==终点（人已在目的地）
// 期望：不继承起点（避免出现 A→A 的假导航），但**保留终点**供前端"导航到目的地"。
// 注意：早期版本这里断言"起点终点一起清空"，会把目的地信息也抹掉，现按实现语义修正。
check('继承后起点=终点 → 不造 A→A 假导航（保留单头终点）',
  out6[1].startLocation === '' && out6[1].endLocation === '金坑大寨停车场',
  `实际 start="${out6[1].startLocation}" end="${out6[1].endLocation}"`);

console.log(failed ? `\n${failed} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
