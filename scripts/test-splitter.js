// splitter 单元测试：验证切分和年份推断逻辑（不调用 LLM）
const { splitDocument, inferYear, ymd } = require('../cloudfunctions/parseTravelPlan/splitter');

function show(name, text) {
  const r = splitDocument(text);
  const days = r.days.map((d) => ({
    md: `${d.month}/${d.day}`,
    end: d.endMonth ? `${d.endMonth}/${d.endDay}` : null,
    title: d.title,
    lines: d.lines.length,
  }));
  const year = r.days.length ? inferYear(r.days) : new Date().getFullYear();
  console.log(`\n=== ${name} ===`);
  console.log('days:', JSON.stringify(days, null, 0));
  console.log('header:', JSON.stringify(r.header));
  console.log('booking:', r.booking.length, 'lines');
  console.log('推断年份:', year);
  if (r.days.length) {
    const last = r.days[r.days.length - 1];
    const end = (last.endMonth && last.endDay) ? ymd(year, last.endMonth, last.endDay) : ymd(year, last.month, last.day);
    console.log('行程范围:', ymd(year, r.days[0].month, r.days[0].day), '~', end);
  }
}

// 案例1：通勤文档（本次 bug 现场）
show('通勤文档（单日，无竖线）', `9月20日工作通勤
7:20起床
7:40坐地铁去金童路上班
7:15到达九柒饮品店吃早饭
8:30-18:00上班
18:00乘地铁回中央公园西`);

// 案例2：广西攻略格式（强匹配，不能被改坏）
show('广西攻略（竖线格式）', `国庆七天广西旅游攻略
路线概览：
重庆 - 桂林 - 阳朔 - 北海 - 涠洲岛
9月30日｜重庆出发抵达桂林
08:00 重庆西站集合
G2249 次高铁
10月1日｜桂林市区游
上午象鼻山
下午东西巷
三、预订安排
9月15日 8:00 抢涠洲岛船票`);

// 案例3：范围标题
show('范围标题', `1月1日至1月3日 海岛游
上午出海浮潜
下午环岛骑行`);

// 案例4：日期+时间的正文行（不应被识别为天标题）
show('日期开头但跟时间的正文行', `9月25日 7:30出发去机场
值机飞往三亚`);

// 断言
console.log('\n=== 断言 ===');
const t1 = splitDocument(`9月20日工作通勤\n7:20起床\n8:30-18:00上班`);
console.assert(t1.days.length === 1, '案例1 应识别 1 天, 实际 ' + t1.days.length);
console.assert(t1.days[0].month === 9 && t1.days[0].day === 20, '案例1 日期应为 9/20');
console.assert(inferYear(t1.days) === new Date().getFullYear(), '案例1 年份应为今年（昨天只差1天）');
console.assert(t1.days[0].lines.length === 2, '案例1 应有 2 行内容, 实际 ' + t1.days[0].lines.length);

const t2 = splitDocument(`9月30日｜重庆出发\n08:00 集合\n10月1日｜桂林\n象鼻山`);
console.assert(t2.days.length === 2, '案例2 应识别 2 天, 实际 ' + t2.days.length);
console.assert(t2.booking.length === 0, '案例2 预订章节为空才对（预订安排在三、后面）');

const t2b = splitDocument(`9月30日｜重庆出发\n08:00 集合\n三、预订安排\n9月15日 8:00 抢涠洲岛船票\n10月1日｜桂林\n象鼻山`);
console.assert(t2b.days.length === 2, '案例2b 预订章节后「10月1日｜」应回到行程模式成为第2天, 实际 ' + t2b.days.length);
console.assert(t2b.booking.length === 1, '案例2b 预订行应进 booking, 实际 ' + t2b.booking.length);

const t3 = splitDocument(`1月1日至1月3日 海岛游\n上午出海`);
console.assert(t3.days.length === 1 && t3.days[0].endMonth === 1 && t3.days[0].endDay === 3, '案例3 应识别范围 1/1~1/3');
// 90 天规则：从 9 月看明年 1 月 > 90 天前 → 应推断为明年
const expectY3 = inferYear(t3.days) === new Date().getFullYear() + 1;
console.assert(expectY3, '案例3 年份应为明年（1月距今 >90 天）');

const t4 = splitDocument(`9月25日 7:30出发去机场值机`);
console.assert(t4.days.length === 0, '案例4 不应把正文行当天标题, 实际 ' + t4.days.length);

console.log('全部断言通过 ✓');
