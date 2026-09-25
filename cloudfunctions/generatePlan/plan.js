// cloudfunctions/generatePlan/plan.js
// ============ AI 制定攻略：多阶段生成流水线 ============
//
// 为什么要多阶段而不是"一次全吐出来"：
//   一份 7 天的高质量攻略 ≈ 80+ 条行程项（参考用户提供的《国庆七天广西旅游攻略》实解析出 84 条）。
//   单次请求要么超时（云函数 60s 硬上限），要么后几天质量崩塌（LLM 越写越敷衍）。
//   所以拆成：① 先出全局大纲（保证整体路线合理、不绕路、住宿连得上）
//            ② 再按天并行展开细节（每天一个小请求，质量稳定、总耗时可控）
//            ③ 闹钟用「LLM 提名 + 代码按规则算时间」，不让 LLM 瞎编抢票时刻
//            ④ 建议单独一个请求（失败了也不影响主流程）
//
// 本文件是纯逻辑：只在内存里生成数据，不碰数据库（写库在 index.js）。
// 本地可以直接 require 跑测试（见 scripts/test-generate.js）。

// 走 llm.chatWithRetry（而不是解构出来的局部引用）是为了让测试能替换成假实现，
// 这样"某天失败 → 重试 → 耗尽放弃"这条链路可以脱离真实 LLM 确定性验证。
const llm = require('./llm');
const { parseJSONFromText, asArray, SYS_PROMPT } = require('./llm');
const { sanitizeItems, META_PAT, META_HARD } = require('./normalize');
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('./cn-time');

const MAX_DAYS = 12;
const DAY_MS = 86400000;

// ============================================================
// 0. 输入处理（确定性，不交给 LLM）
// ============================================================

/** "2026-09-30" 是否合法 */
function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(parseCnTime(`${s}T00:00:00`));
}

/** 两个日期相差天数（含首尾）：9-30 ~ 10-07 → 8 */
function dayDiff(start, end) {
  return Math.round((parseCnTime(`${end}T00:00:00`) - parseCnTime(`${start}T00:00:00`)) / DAY_MS) + 1;
}

/** 北京时间日期加减天数 → "YYYY-MM-DD" */
function shiftDate(dateStr, days) {
  return tsToDateStr(parseCnTime(`${dateStr}T00:00:00`) + days * DAY_MS);
}

/** 星期几（北京时间） */
function weekdayOf(dateStr) {
  const d = new Date(parseCnTime(`${dateStr}T00:00:00`) + 8 * 3600 * 1000);
  return '日一二三四五六'[d.getUTCDay()];
}

/** 出行日期是不是法定长假（国庆 / 春节 / 五一）—— 决定要不要加抢票 / 错峰提醒 */
function isHolidayRange(start, end) {
  const md = [];
  for (let i = 0; i <= dayDiff(start, end); i++) md.push(shiftDate(start, i).slice(5));
  const inNation = md.some((d) => d >= '10-01' && d <= '10-07');
  const inLabor = md.some((d) => d >= '05-01' && d <= '05-05');
  const inSpring = md.some((d) => d >= '01-20' && d <= '02-15');
  return inNation || inLabor || inSpring;
}

// 省级地名：用户写"广西（桂林、阳朔）"时，"广西"只是范围提示，不算必到点
// （北京/上海/天津/重庆/香港/澳门本身是城市级目的地，不在此列）
const PROVINCE_NAMES = new Set([
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西',
  '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西',
  '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆',
]);

/**
 * 目的地清单解析："广西（桂林、龙脊梯田、阳朔、明仕田园和德天瀑布）"
 *   → destList:  ['广西','桂林','龙脊梯田','阳朔','明仕田园','德天瀑布']（进 prompt）
 *   → mustVisit: 去掉省份后的清单（大纲必须逐个覆盖，漏了代码会发起修订）
 * "和"也当分隔符（用户习惯连写）；但像"颐和园"这种切成单字碎片的保留原词，不误伤。
 */
function parseDestList(dest) {
  const cleaned = String(dest || '').replace(/[（）()【】[\]]/g, '、');
  const raw = cleaned.split(/[、，,；;\/|\s]+/).map((s) => s.trim()).filter(Boolean);
  const list = [];
  raw.forEach((tok) => {
    if (tok.includes('和')) {
      const parts = tok.split('和').map((x) => x.trim());
      if (parts.every((x) => x.length >= 2)) { list.push(...parts); return; }
    }
    list.push(tok);
  });
  const uniq = [...new Set(list)];
  return {
    destList: uniq,
    mustVisit: uniq.filter((t) =>
      t.length >= 2 && !t.endsWith('省') && !PROVINCE_NAMES.has(t)),
  };
}

function normalizeInput(input) {
  const i = input || {};
  const startDate = validDate(i.startDate) ? i.startDate : tsToDateStr(Date.now());
  let endDate = validDate(i.endDate) ? i.endDate : startDate;
  let days = dayDiff(startDate, endDate);
  if (days <= 0) { endDate = startDate; days = 1; }
  if (days > MAX_DAYS) { days = MAX_DAYS; }
  const end = days > 1 ? shiftDate(startDate, days - 1) : endDate;

  const party = String(i.party || '朋友同行');
  const peopleNum = parseInt(i.people, 10) || 2;
  const budget = String(i.budget || '舒适');
  const pace = String(i.pace || '适中');
  const interests = Array.isArray(i.interests) ? i.interests.slice(0, 8) : [];
  const transport = String(i.transport || '高铁/动车优先');
  // 分钟级的去/返程时刻：用户指定后，首末两天的大交通必须落在这个时刻上。
  // ⚠️ 语义（2026-09-25 二次修正）：
  //   goTime   = **离开出发地（家门口/酒店）的时刻**——第一天第 1 条就是
  //              「goTime 从出发地出发前往车站」的接驳，大交通在其后发车
  //              （applyTripEdgeTimes 按 goTime+接驳/安检预留推算发车时刻）
  //   backTime = **回到出发地（到家）的时刻**——大交通到站 = backTime-40 分钟
  //              （市内返家接驳），到家那条由细化/DayClosure 兜底生成
  const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()) ? String(s).trim() : '';
  const dest = String(i.dest || i.destCity || '').trim();
  const { destList, mustVisit } = parseDestList(dest);

  return {
    origin: String(i.origin || i.fromCity || '').trim(),
    dest,
    destList,      // 目的地清单（含省份提示词），进 prompt 让 LLM 逐个安排
    mustVisit,     // 用户点名必到的地点（去省份），大纲漏了会触发修订
    startDate,
    endDate: end,
    days,
    party, peopleNum, budget, pace, interests, transport,
    goTime: validTime(i.startTime || i.goTime),
    backTime: validTime(i.endTime || i.backTime),
    mustGo: String(i.mustGo || '').trim(),
    extra: String(i.extra || '').trim(),
    holiday: isHolidayRange(startDate, end),
  };
}

/** 给用户画像一句话摘要（喂给 LLM） */
function profileText(p) {
  const bits = [
    `${p.origin || '?'}出发 → ${p.dest || '?'}`,
    `${p.days}天（${p.startDate} 至 ${p.endDate}）`,
  ];
  // 去/返程时刻精确到分钟。语义（2026-09-25 二次修正）：
  //   goTime = **离开出发地（家门口/酒店）的时刻**——第一天行程第 1 条就是
  //            「goTime 从出发地出发，前往车站/机场」的接驳，大交通在其之后发车；
  //   backTime = **回到出发地的时刻**（到家），不是发车也不是到站。
  if (p.goTime) bits.push(`去程 ${p.goTime} 从${p.origin || '出发地'}启程（离开家/酒店的时刻）`);
  if (p.backTime) bits.push(`返程 ${p.backTime} 回到${p.origin || '出发地'}（到家时刻）`);
  bits.push(`${p.party} ${p.peopleNum}人`);
  bits.push(`预算${p.budget}`);
  bits.push(`节奏${p.pace}`);
  bits.push(p.transport);
  if (p.destList && p.destList.length > 1) bits.push('目的地清单：' + p.destList.join('、'));
  if (p.interests.length) bits.push('偏好：' + p.interests.join('、'));
  if (p.mustGo) bits.push('必去：' + p.mustGo);
  if (p.extra) bits.push('特殊要求：' + p.extra);
  if (p.holiday) bits.push('⚠️ 出行日期落在法定长假，必须考虑抢票/错峰');
  return bits.join('；');
}

// ============================================================
// ① 大纲
// ============================================================

/**
 * 大纲体检：到站后还要长途打车的段（通用判定，不涉及任何具体城市/车站）。
 * 只告警——改站交给模型的复核请求，代码不写死车站知识（写死了换个城市就失效）。
 */
function warnDetourTransfers(outline) {
  const detours = detourTransfers(outline);
  if (detours.length) {
    console.warn('[generatePlan] 到站后仍需长途打车的段 %d 处：%s',
      detours.length,
      detours.map((x) => `第${x.dayIndex + 1}天 ${x.move.from}→${x.move.to}（${x.move.transfer}）`).join('；'));
  }
  return outline;
}

async function genOutline(p) {
  // 交通偏好的硬约束：用户选了「高铁/动车优先」就全程不许飞（长距离也一样），
  // 改走近目的地的高铁站 + 短途接驳；选了自驾/包车就别排航班。
  const railFirst = /高铁|动车/.test(p.transport);
  const driveFirst = /自驾|包车/.test(p.transport);
  const planeFirst = /飞机/.test(p.transport);
  const modeRule = railFirst
    ? '**用户已选「高铁/动车优先」：全程禁止安排飞机（含长距离路段）**。优先高铁（G 字头）；两地之间没有合适的高铁（班次太少、耗时过长、需要深夜中转）时，可以走动车（D 字头）或城际列车，仍然不许排航班。实在没有铁路直达，就走到离目的地最近的高铁站/动车站（允许一次中转），再衔接直通车/大巴/打车接驳（接驳时长写进 n 提示）。'
    : driveFirst
      ? '**用户已选「自驾/包车」：城际段一律按自驾或包车安排**（给出大致里程与驾驶时长），不要安排飞机或高铁。'
      : planeFirst
        ? '**用户已选「飞机优先」：单程超过 6 小时的跨城段优先飞机**，但同城/近郊仍走地面交通。'
        : '有高铁/动车直达的优先走高铁，没有直达高铁再看飞机；近距离（≤3 小时车程）走高铁/直通车大巴。';

  // 用短键名：一份 8 天大纲能省 30%+ 的输出 token。虽然不再设 max_tokens，
  // 但云函数只有 60s，输出越短写得越快，留出余量给"漏点修订"那一次请求。
  const prompt = `为以下旅行需求制定逐日路线大纲。

【需求】${profileText(p)}
${p.holiday ? '【重要】含法定节假日：首末两天通常是往返大交通日，热门项目要预留抢票/预约窗口。' : ''}

# 输出格式（严格 JSON，短键名）
{"t":"行程标题","s":"一句话路线概览","nt":[{"d":"MM-DD","c":"住宿城市"}],"ds":[
{"d":"YYYY-MM-DD","city":"城市","t":"当天主题短语","mv":[{"f":"出发站","to":"到达站","m":"train/plane/car/bus/ship","c":"车次/航班号","s":"HH:mm","e":"HH:mm","st":"到站后到当天首个目的地的接驳方式与耗时"}],"hl":["必玩1","必玩2","必玩3"],"ml":["餐1","餐2"],"ov":"当晚住宿城市或片区","h":"推荐酒店","n":"关键提示（30字内）"}]}

# 硬性要求
0. **城市串联原则（最重要）**：把出发地和所有目的地按「总路程最短 + 换乘最少 + 单程耗时最短」串成一条线。
   - 交通方式判定：${modeRule}
   - 走法要单向推进，禁止来回折返（例：重庆→桂林→阳朔→南宁→重庆，不要 重庆→南宁→桂林→重庆 这种回头路）。
   - 相邻城市间移动尽量控制在 3 小时内；需要更久的，安排在整天里并给出具体班次与运行时长。
   - 同一城市的景点连片玩完再换下一城，避免同城反复往返。
0.1 **按真实地理方位聚类，绝不南北来回跑**：先按实际地理位置把目的地分组（例：龙脊梯田在桂林北面约 2.5 小时车程，阳朔/兴坪在桂林南面，明仕田园/德天瀑布在桂西南崇左），**同一方位的景点连片玩完再去下一方位**。一般规律：先去离主基地最远的一端玩（如先去北面的龙脊），回到主基地后再顺着返程方向一路玩过去（南面的阳朔→更南的崇左/德天），让整条线只有"前进"没有"回头"。
0.2 **住宿闭环（铁律）**：每一天的 ov（当晚住宿地）就是**第二天早上出发的地方**，两天之间不许断链。同一片区的多天写**同一个 ov**（同一家酒店连住，如"桂林市区（两江四湖片区）"连住两晚），一个基地辐射周边景点，别天天换酒店搬行李。禁止出现"昨晚住 A，第二天一早却从 B 出发"的安排。
   **反过来：相邻两天核心游玩片区相距超过约 1 小时车程时，必须换基地**——今晚 ov 要写到离明天景点最近的片区（例：今天玩成都市区、明天一早进毕棚沟，今晚就住理县/古尔沟，绝不允许住成都市、来回通勤 4 小时）；"同一 ov 连住"只适用于同一片区的多天，全称行程只用一家酒店是不允许的。
   0.2.1 **行李随人走（铁律，为游客的方便着想）**：**只要当晚不回昨晚那家酒店（ov 与前一天不同），大件行李就必须随身走**，绝不允许"把大件行李寄存在 A 酒店、人去 B 住"——那等于逼游客折返取件。换住处那天的正确走法：退房带走行李 → 抵达新住宿地后**先到酒店放行李/寄存前台，再轻装出门玩**；若当天先去景区，行李随身带到景区，用游客中心的寄存处/存包柜，并在当天提示里写明"离开时取回行李"。
0.3 **一个基地管一片**：同一片景点（如阳朔的西街/遇龙河/十里画廊/兴坪）住在同一个基地辐射游览，不要每天换酒店搬行李；能当天往返的远景点就当天往返。
0.4 **交通+游览二合一的段优先这样串**：游船/观光列车这类"坐上去本身就是游览"的交通（如漓江游船桂林→阳朔），直接作为当天的转移方式（mv 的 m 填 ship，同时写进 hl），下船即开始玩，**不要"游完再原路坐车回来、再重新坐车过去"**。
0.5 **目的地全覆盖（铁律）**：目的地清单里的每一个地点都必须作为**游玩目的地**安排（成为某天的 city / 当天主题 / 必玩点），绝不能只当成过路走廊。哪怕它恰好在两站之间（例：都江堰在成都与毕棚沟之间），也要安排半天到一天**真正进去游玩**，禁止只写"途经都江堰""车览都江堰"。用户点名要去的地方，没有"顺路看一眼"这个说法。
0.6 **同一个景点只玩一次**：每个具体景点（hl 里的名字）在整个行程**只出现在一天**，禁止跨天重复游玩；也禁止"玩完 A 过两天又回头玩 A"。相邻目的地按地理顺序串成一条线，一趟走完。
1. ds 恰好 ${p.days} 天，日期从 ${p.startDate} 连续到 ${p.endDate}，每天一个元素，顺序递增。
2. 路线顺路：相邻两天不来回折返；同一城市连片玩完再换城。
3. 第一天从（或抵达）目的地${p.origin ? `（出发地 ${p.origin}）` : ''}，最后一天返回${p.origin || '出发地'}。
3.1 ${p.goTime ? `**去程开始时间已由用户指定**：${p.goTime} 是用户**离开${p.origin || '出发地'}（家门口）的时刻**，不是发车时刻！第一天的大交通发车时刻 = ${p.goTime} + 市内接驳约 40 分钟 + 安检候车（高铁提前 45 分 / 飞机提前 2 小时），把推算出的发车/起飞时刻写进 mv.s（e 按实际运行时长推算）。` : '去程班次请给出一个具体、合理的发车/起飞时刻（s/e 都要精确到分钟）。'}
3.2 ${p.backTime ? `**返程到家时间已由用户指定**：${p.backTime} 是用户**回到${p.origin || '出发地'}（到家）的时刻**，不是发车也不是到站！最后一天的大交通 mv.e = ${p.backTime} 减去市内返家接驳约 40 分钟（到站时刻），s 按实际运行时长往前倒推。` : '返程班次请给出合理的发车/起飞时刻与到达时刻（精确到分钟）。'}
4. mv 只写城际大交通：**s = 发车/起飞时刻，e = 到达时刻**；火车给参考车次走向（如 G2249），飞机给航线；市内交通不写。
   4.1 **大交通到发站选「下车后接驳最短」的站（铁律）**：同一目的地常有多个车站/码头/机场，选站标准是"**下车（机）后到当天最终景点或今晚住宿地的接驳距离最短**"，不是"车次最多、站名最大、和城市同名就选它"。
   判断顺序：① 先定当天最终要去的景点在哪个片区、今晚住哪；② 倒推哪个车站离它最近、有轨道交通或能步行直达；③ 同城/都市圈内的市域铁路、城际线、机场快线优先——班次密、票价低、不堵车，比"坐到远站再打车折回来"又快又省。
   **禁止舍近求远**：如果某个站下车后还要长距离打车折返才能到当天目的地，就是选错了站，必须换成更近的站（哪怕车次少一点）。
   4.2 **每段 mv 都要给 st（到站/下机后到当天首个目的地的接驳方式与耗时，如"地铁30分钟""步行8分钟""打车20分钟"）**：st 是你自己检验选站是否合格的尺子。
   判据：**st 里写"打车/网约车 ≥25 分钟"就说明这个站选在了反方向**（下车还得花钱绕回目的地），必须重选更近的站，或改成"同城轨道交通/市域铁路 + 短驳"的组合，把 st 变成步行或地铁；轨交/步行 1 小时以内都算合格（大城市坐地铁 40 分钟到酒店很正常，不算绕路）。确实没有更近的站才保留，并在当天 n 里说明原因。
5. hl 每天 3-4 个**具体景点/片区名称**，别写"逛逛市区"这种废话；城市漫游日（如"成都市区"）也要点名具体街区/景点（例：宽窄巷子、人民公园、武侯祠、太古里），兼顾${p.pace}节奏${p.interests.length ? '和偏好' : ''}。
   5.1 **地名用地图搜得到的通用叫法**：写"象鼻山"就别写成"象鼻山公园"（外省真有同名公园，导航会导过去），不要自造"XX景区大门""XX游客中心"这类后缀，也不要带括号补注。
6. ${p.mustGo ? `用户必去：${p.mustGo}，必须排进合适的一天。` : ''}${p.extra ? `特殊要求：${p.extra}` : ''}
6.1 ${p.mustVisit && p.mustVisit.length ? `**用户点名的目的地一个都不许漏**：${p.mustVisit.join('、')} —— 每一个都必须在大纲里占到实实在在的行程（成为某天的城市、当天主题或必玩点之一）。觉得不顺路的，安排当天往返或顺路串联，宁可调整路线也绝不许默默丢掉任何一个。` : ''}
7. ${p.budget === '经济' ? '住性价比档，餐饮接地气；' : p.budget === '品质' ? '住高品质酒店/度假村，餐饮选口碑正餐；' : '住舒适型酒店，餐饮兼顾特色与性价比；'}推荐写类型/片区+代表菜，不要编造具体门牌地址。
   7.1 **每晚推荐一家具体酒店（h 字段，按用户预算「${p.budget}」档挑选）**：写真实存在、地图能搜到的连锁或口碑酒店名（如"桂林漓江大瀑布饭店"），并符合用户的节奏与兴趣（亲子选带泳池/家庭房，情侣选江景/设计感，美食偏好选近夜市）。同一 ov 连住多晚就写同一家；确实没有把握的就写「片区+档次」（如"两江四湖片区舒适型酒店"），**不要编造不存在的酒店名**。最后一天（返程日）h 留空。
   7.2 **ml 一日三餐都要点名**：写具体店名或"片区/景区+代表菜"（例："午餐：陈麻婆豆腐（青羊店）""晚餐：南桥附近尤兔头"），不要只写"午餐""晚餐"；没有把握的店名就写"片区+招牌菜"（如"晚餐：古尔沟片区藏式汤锅"）。
   7.4 **全程体验要差异化（铁律）**：同一类餐饮（如火锅、烧烤、米粉、小吃）全程**最多安排 2 次**，同一类游览体验（如古镇老街、博物馆、夜市、山岳徒步、主题乐园）也**最多 2 次**。多天行程时每天换花样：逛了老街就换个公园/展馆，吃了火锅就换家常菜/地方菜，让用户每天有新鲜感，而不是换了个地方重复同一种玩法。
   7.3 **市内/短途交通按预算选型**：预算「经济」→ 3km 内步行、中长途地铁/公交优先，打车只留给轨道交通到不了的地方；「舒适」→ 地铁优先，2~6km 跨区、赶时间或夜间打车；「品质」→ 以打车为主。选定的基调写进当天 n 提示（如"市内地铁出行为主"）。
8. ov 写住宿城市或片区（最后一天写"返程"）；h 每晚一家；nt 长度 = ${p.days - 1} 晚。
9. 所有文本简体中文，n 字段控制在 30 字以内。只输出 JSON 对象。`;

  // 大纲是单独一次云函数调用（60s 上限），留 8s 给返回，单次最多等 52s
  // 注意：不传 max_tokens —— 天数多的时候大纲本来就长，封顶会把后面几天从中间掐断
  const outlineDeadline = Date.now() + 52 * 1000;
  const text = await llm.chatWithRetry([
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: prompt },
  ], { deadline: outlineDeadline });

  // 去程开始 / 返程到达时刻由代码兜底对齐（LLM 自己常常不照办）
  const outline = applyTripEdgeTimes(p, normalizeOutlineJson(parseJSONFromText(text), p));
  if (!outline.days.length) throw new Error('大纲没有生成任何一天');

  // 点名地点兜底：LLM 偶尔会"自作主张"丢掉它认为不顺路的点
  // （用户点名"桂林、龙脊梯田、阳朔…"，结果整份大纲没有龙脊梯田——实锤踩过）。
  // 生成后对照清单逐个查，漏了且时间还够就发一次修订请求补回来。
  // 同一条修订链路也管"跨天重复游玩"（毕棚沟被排了两天——实锤踩过），
  // 以及"到站后还得长途打车"（站选在反方向、舍近求远——实测踩过）。
  // 这三类都用同一套通用判据，代码里不写任何具体城市/车站的知识。
  const missing = missingMustVisit(p, outline);
  const dups = duplicateHighlights(outline);
  const detours = detourTransfers(outline);
  if (missing.length || dups.length || detours.length) {
    if (missing.length) console.warn('[generatePlan] 大纲漏掉用户点名地点: %s', missing.join('、'));
    if (dups.length) console.warn('[generatePlan] 大纲跨天重复游玩: %s',
      dups.map((d) => `${d.name}(第${d.days.map((x) => x + 1).join(',')}天)`).join('、'));
    if (detours.length) console.warn('[generatePlan] 大纲有到站后仍需长途打车的段: %s',
      detours.map((x) => `第${x.dayIndex + 1}天 ${x.move.from}→${x.move.to}（${x.move.transfer}）`).join('；'));
    // 修订现在只吐"改动的那几天"，几百 token 就够，12s 足够跑完
    if (outlineDeadline - Date.now() > 12 * 1000) {
      const repaired = await repairOutline(p, outline, missing, dups, detours, outlineDeadline);
      if (repaired) {
        const stillMissing = missingMustVisit(p, repaired);
        const stillDups = duplicateHighlights(repaired);
        const stillDetours = detourTransfers(repaired);
        // 绕路段只要求"不恶化"：这条体检是概率性的（模型自报耗时不准），
        // 不能因为它没改善就把"漏点补齐/去重"这些确定性修复一起否掉
        const okDetour = stillDetours.length <= detours.length;
        if (!stillMissing.length && stillDups.length < Math.max(1, dups.length) && okDetour) {
          console.log('[generatePlan] 修订成功（剩余：漏点 %d，重复 %d，绕路段 %d）',
            stillMissing.length, stillDups.length, stillDetours.length);
          return warnDetourTransfers(repaired);
        }
        console.warn('[generatePlan] 修订后仍有问题（漏 %d，重复 %d，绕路段 %d），保留原大纲',
          stillMissing.length, stillDups.length, stillDetours.length);
      }
    } else {
      console.warn('[generatePlan] 剩余时间不足，跳过修订，保留原大纲');
    }
  }
  return warnDetourTransfers(outline);
}

// ---- 时刻工具（分钟制，用于把大交通对齐到用户指定的去/返程时刻）----
function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function fmtMin(v) {
  const t = ((v % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * 把首末两天的大交通对齐到用户指定的时刻（确定性兜底，不靠提示词）
 *
 * 为什么不写在 prompt 里就算了：LLM 看见"去程 08:30 出发"，照样按它认为合理的
 * 14:44 写（提示词加再多硬约束也只是提高概率，还会让输出变啰嗦、更慢）。
 * 与其跟模型较劲，不如生成完用代码把整段班次**整体平移**——运行时长保持不变，
 * 只挪时刻。这样"去程开始时间 / 返程到达时间"是 100% 生效的硬保证。
 *
 * @param {object} p 归一化输入（goTime = 去程开始，backTime = 返程到达）
 * @param {object} outline 归一化后的大纲（会被就地修改）
 */
/**
 * 清洗之后再兜一次「每天第一条的起点」
 *
 * 为什么不在 genDayItems 里做完就算了：sanitizeItems 的"假导航清除"（Pass 3）
 * 会把"起点=终点"的条目成对清掉（如「在酒店吃早餐」被填成 酒店→酒店），
 * 恰好每天第一条经常就是这种"没移动"的条目 —— 前面补的起点被清了个干净。
 * 所以放到 sanitize 之后再做一次，才是真的闭环。
 */
function enforceDayStartLocation(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  byDay.forEach((list, di) => {
    if (di <= 0) return;                       // 第一天本来就是从出发地启程
    const prevOv = String((days[di - 1] && (days[di - 1].overnight || days[di - 1].city)) || '').trim();
    if (!prevOv) return;
    const first = list.slice().sort((a, b) =>
      String(a.startTime || '').localeCompare(String(b.startTime || '')))[0];
    if (first && !String(first.startLocation || '').trim()) first.startLocation = prevOv;
  });
  return items;
}

/**
 * 已确认大交通对齐兜底（确定性，不靠模型自觉）
 *
 * 实测踩过：大纲里"成都东→重庆西 G8528 15:00-17:00"被细化模型写到早上 09:00，
 * 还在 activity 里自圆其说"实际行程将提前完成都江堰，此处为倒叙 bridge…此处特别
 * 规划时间线以符合'上游规定'的约束"——用户看到的是"标的去重庆西，实际先玩都江堰"，
 * 外加一整段内心戏。这里按车次码把大交通硬拽回既定的时刻和起终点：
 *   · 全天没提这段大交通 → 补一条干净的交通条目（时刻/起终点取大纲）
 *   · 同一车次码出现多条 → 留一条，其余丢弃（同一天不可能坐两次同一班车）
 *   · 条目时刻漂移超 60 分钟 → 拽回大纲时刻（15:00 的车不许排在 09:00）
 *   · 起终点强制对齐大纲车站（导航 chip 直接吃这两个字段，错一个字导去对面省）
 *   · activity 还带着独白或串了别的地名 → 重写成干净版
 */
/** 真班次码（G8515/CA4123 这类）；"包车/租车""顺风车"是写法不是码 */
function isRealCode(code) {
  const c = String(code || '').trim();
  return !!c && /^[A-Za-z]{0,2}\d{2,}/.test(c) && !/包车|租车|顺风|大巴|直通|专线|索道/.test(c);
}

/** 大纲 move → 干净的交通条目文案（补条目与骨架兜底共用） */
function moveActivityText(m) {
  const mode = String(m.mode || '').toLowerCase();
  const code = String(m.code || '').trim();
  if (/plane|航班|飞机/.test(mode)) return code ? `乘 ${code} 航班从${m.from}前往${m.to}` : `乘飞机从${m.from}前往${m.to}`;
  if (/train|高铁|动车|火车/.test(mode)) return code ? `乘 ${code} 次列车从${m.from}前往${m.to}` : `乘火车从${m.from}前往${m.to}`;
  if (/ship|游船/.test(mode)) return code ? `乘 ${code} 从${m.from}前往${m.to}` : `乘船从${m.from}前往${m.to}`;
  return isRealCode(code) ? `乘 ${code} 从${m.from}前往${m.to}` : `乘大巴/包车从${m.from}前往${m.to}`;
}

/** 班次类大交通（火车/飞机/船或真车次码）：按码严格对齐；包车/自驾类只做宽松匹配防重复补 */
function isScheduledMove(m) {
  const mode = String(m.mode || '').toLowerCase();
  return /train|plane|ship/.test(mode) || isRealCode(m.code);
}

/**
 * @param {number[]} [activeDays] 续跑时本轮真正产出条目的天。
 *   不传 = 全量处理（首轮/单次生成）。
 *   ⚠️ 续跑必须传：本轮 items 只包含这一轮新生成的天，而本函数原本按整个大纲
 *      循环，会把之前轮次已生成好的天再补一遍大交通（实测第 1 天凭空多出
 *      "接驳 + 高铁 + 回酒店"3 条），每轮都往库里合并 → 行程里一堆重复条目。
 */
function enforceMovesAlignment(items, outline, activeDays) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const active = new Set(asArray(activeDays).map(Number));
  const railLike = (m) => /train|plane|高铁|动车|火车|航班|飞机|ship|游船/
    .test(`${m.mode || ''}${m.code || ''}`.toLowerCase());
  const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moveActivity = moveActivityText;
  const transportTypeOf = (m) => {
    const mode = String(m.mode || '').toLowerCase();
    if (/plane|航班|飞机/.test(mode)) return 'plane';
    if (/train|高铁|动车|火车/.test(mode)) return 'train';
    return '';
  };

  const out = items.slice();
  days.forEach((day, di) => {
    if (active.size && !active.has(di)) return;   // 本轮没产出这一天的条目 → 不碰它
    const moves = asArray(day && day.moves)
      .filter((m) => m && m.from && m.to && (String(m.code || '').trim() || railLike(m)));
    if (!moves.length) return;
    moves.forEach((m) => {
      const code = String(m.code || '').trim();
      // 包车/自驾/大巴（没有真车次码）不参与"按码去重"：实测同一天两段不同方向的
      // 包车（都江堰→古尔沟、古尔沟→毕棚沟）都写了"包车"二字，被当成同一班车删掉一条
      const scheduled = isScheduledMove(m);
      const codeRe = scheduled && code ? new RegExp(escapeRe(code)) : null;
      const fStem = placeStem(m.from);
      const tStem = placeStem(m.to);
      const inDay = out.filter((it) => Number(it.dayIndex || 0) === di);
      const matched = scheduled
        ? inDay.filter((it) =>
            (codeRe ? codeRe.test(`${it.activity || ''}${it.note || ''}`) : false) ||
            (!code && it.category === 'transport'
              && String(it.activity || '').includes(fStem)
              && String(it.activity || '').includes(tStem)))
        : [];

      // 包车/自驾/大巴段没有车次码可对：只要当天已有"同方向"的交通条目
      // （终点或起点地名对得上），就视为模型已安排，绝不重复补 ——
      // 实测踩过：细化写了"乘车沿 G317 前往理县县城"，兜底又补一条
      // "乘包车/租车 从都江堰景区前往理县县城"，一天两段重复的车。
      if (!scheduled) {
        const hay = (it) => `${it.activity || ''}${it.note || ''}${it.startLocation || ''}${it.endLocation || ''}`;
        const toStem = placeStem(m.to);
        const fromStem = placeStem(m.from);
        const loose = inDay.filter((it) => it.category === 'transport'
          && ((toStem.length >= 2 && hay(it).includes(toStem))
            || (fromStem.length >= 2 && hay(it).includes(fromStem))));
        if (loose.length) {
          console.log('[generatePlan] 第%d天包车段 %s→%s 已由细化安排（宽松匹配），不补', di + 1, m.from, m.to);
          return;
        }
      }

      if (!matched.length) {
        // 大纲有这段大交通、模型全程没提 → 补一条
        const st = toMin(m.startTime);
        const et = toMin(m.endTime);
        out.push({
          dayIndex: di,
          startTime: st != null ? fmtMin(st) : '',
          endTime: et != null ? fmtMin(et) : '',
          activity: moveActivity(m),
          category: 'transport',
          startLocation: String(m.from || '').trim(),
          endLocation: String(m.to || '').trim(),
          transportType: transportTypeOf(m),
          note: '',
        });
        console.warn('[generatePlan] 第%d天大纲大交通 %s 全天未安排，补一条', di + 1, `${m.from}→${m.to} ${code}`);
        return;
      }

      // 同一车次多条：留时刻最接近大纲的那条，其余丢弃
      const wantS = toMin(m.startTime);
      const driftOf = (it) => {
        const v = toMin(it.startTime);
        return wantS != null && v != null ? Math.abs(v - wantS) : 24 * 60;
      };
      matched.sort((a, b) => driftOf(a) - driftOf(b));
      matched.slice(1).forEach((extra) => {
        const idx = out.indexOf(extra);
        if (idx >= 0) out.splice(idx, 1);
        console.warn('[generatePlan] 第%d天车次 %s 出现多条，丢弃一条', di + 1, code || `${m.from}→${m.to}`);
      });
      const it = matched[0];

      // 起终点强制对齐大纲车站
      it.startLocation = String(m.from || '').trim();
      it.endLocation = String(m.to || '').trim();
      it.category = 'transport';
      if (!it.transportType) it.transportType = transportTypeOf(m);

      // 时刻漂移超 60 分钟 → 拽回大纲时刻（中间天模型按真实班次微调的半小时内不动）
      const drift = driftOf(it);
      if (drift > 60) {
        it.startTime = fmtMin(wantS);
        const wantE = toMin(m.endTime);
        if (wantE != null) it.endTime = fmtMin(wantE);
        console.warn('[generatePlan] 第%d天大交通 %s 时刻漂移 %d 分钟，拽回 %s',
          di + 1, code || `${m.from}→${m.to}`, drift, it.startTime);
      }

      // activity 带独白 / 车次码或目的地被写丢 → 重写成干净版
      const act = String(it.activity || '');
      const contaminated = META_HARD.some((re) => re.test(act)) || META_PAT.some((re) => re.test(act));
      const wrongDest = (code && !act.includes(code)) || (tStem && !act.includes(tStem));
      if (contaminated || wrongDest) it.activity = moveActivity(m);
    });
  });
  return out;
}

/** 从交通条目文案里读班次码（G8540/CA4123 这类）；"T2航站楼""2号线"不算 */
function transportCodeOf(it) {
  if (String(it.category || '') !== 'transport') return '';
  const m = /\b([A-Za-z]{1,2}\d{2,4})\b(?!\s*(?:号线|航站楼|号航站楼|站台))/
    .exec(`${it.activity || ''}${it.note || ''}`);
  return m ? m[1].toUpperCase() : '';
}

/**
 * 同一天重复交通条目清理（兜底，通用判定不认地名）。
 *
 * 实测踩过：模型写了"乘坐C6101次城际动车前往X站"（没提出发站，
 * enforceMovesAlignment 匹配不上）→ 又留/补一条"乘 C6101(参考) 次列车从
 * Y东站前往X站"，用户看到同一趟车排了两遍；更离谱的一条还排在
 * 到站之后。规则：
 *   · 同一天出现同一个班次码 → 只留最早一条（同一天不可能坐两次同一班车）；
 *   · 同一天同方向（起点、终点词干都相同）且发车时刻相近（≤90 分钟）
 *     的两条 → 视为同一段路，留最早一条。
 */
function dedupeTransports(items) {
  if (!asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const drop = new Set();
  byDay.forEach((list) => {
    const trans = list.filter((it) => String(it.category || '') === 'transport')
      .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
    // ① 同班次码只留最早
    const seenCode = new Map();
    trans.forEach((it) => {
      const code = transportCodeOf(it);
      if (!code) return;
      if (seenCode.has(code)) drop.add(it);
      else seenCode.set(code, it);
    });
    // ② 同方向且时刻相近只留最早（词干互相包含算同地："酒店"⊂"酒店门口"）
    const sameSpot = (a, b) => a === b
      || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b));
    for (let i = 0; i < trans.length; i++) {
      if (drop.has(trans[i])) continue;
      const fs = placeStem(trans[i].startLocation);
      const ts = placeStem(trans[i].endLocation);
      if (fs.length < 2 || ts.length < 2) continue;
      for (let j = i + 1; j < trans.length; j++) {
        if (drop.has(trans[j])) continue;
        if (!sameSpot(placeStem(trans[j].startLocation), fs)
          || !sameSpot(placeStem(trans[j].endLocation), ts)) continue;
        const gap = (toMin(trans[j].startTime) || 0) - (toMin(trans[i].startTime) || 0);
        if (gap >= 0 && gap <= 90) drop.add(trans[j]);
      }
    }
  });
  if (!drop.size) return items;
  console.warn('[generatePlan] 清理同天重复交通条目 %d 条', drop.size);
  return items.filter((it) => !drop.has(it));
}

/**
 * 收尾闭环兜底：当天最后一条必须"回到今晚住宿地"（返程日除外）
 *
 * 实测踩过：某天模型把大交通时刻冲突写成一段自我论证的独白，收拾残局时
 * 只写到"17:35 到站"就结束了——晚上和回酒店凭空消失，第二天也从别处开始，
 * 两天之间断链。提示词第 14 条写了"最后 1 条必须是回住宿地休息"，但模型
 * 一旦前面跑偏就顾不上；这里用代码补最后一条 hotel，不指望 LLM 自觉。
 */
function enforceDayClosure(items, outline, p) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const out = items.slice();
  byDay.forEach((list, di) => {
    if (!list.length || di < 0 || di >= days.length) return;
    const today = days[di] || {};
    const tonight = String(today.overnight || today.city || '').trim();
    // 最后一天 ov 应写"返程"；就算模型写漏了，最后一天也绝不能补"回酒店"
    if (!tonight || /返程|回家/.test(tonight) || di === days.length - 1) {
      // 返程日兜底：大交通到站后必须还有一条"回出发地（家）"的接驳，
      // 到站不算到家——用户填的 origin 是具体地址（如"重庆市金童路"）
      const origin = String((p && p.origin) || '').trim();
      if (!origin) return;
      const sorted = list.slice().sort((a, b) =>
        String(a.startTime || '').localeCompare(String(b.startTime || '')));
      const last = sorted[sorted.length - 1];
      if (!last) return;
      // "返程/家中/回家"也算到家：模型常把最后一条的 endLocation 写成「返程」，
      // 认不出就会再补一条"从返程返回XX家"，末尾凭空多一段
      const backHome = samePlace(last.endLocation || '', origin)
        || String(last.endLocation || '').includes(origin)
        || /^(返程|回家|家中|家)$|回家|到家/.test(String(last.endLocation || ''))
        || String(last.activity || '').includes(origin)
        || /回家|到家/.test(String(last.activity || ''));
      if (backHome) return;
      const from = String(last.endLocation || last.startLocation || '').trim();
      const endMin = toMin(last.endTime);
      const st = (endMin != null ? endMin : 19 * 60) + 10;
      if (!from) return;
      out.push({
        dayIndex: di,
        startTime: fmtMin(Math.min(st, 23 * 60 + 30)),
        endTime: fmtMin(Math.min(st + 40, 23 * 60 + 59)),
        activity: `从${from}返回${origin}，到家休息`,
        category: 'transport',
        startLocation: from,
        endLocation: origin,
        transportType: 'car',
        note: '',
      });
      console.warn('[generatePlan] 返程日最后一条只到「%s」，补一条回家接驳', from.slice(0, 16));
      return;
    }
    const sorted = list.slice().sort((a, b) =>
      String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const last = sorted[sorted.length - 1];
    // 已经收在住宿地：hotel 条目，或终点/描述明确是酒店民宿类。
    // 注意别用 samePlace(终点, ov) 判——"眉山站"包含"眉山"会被误判成已到家，
    // 人明明还拎着行李站在火车站。描述类只认"回/到/入住 + 住宿词"的动宾搭配，
    // "去酒店附近的夜市"这种不算。
    const lodgingWord = /酒店|民宿|客栈|宾馆|青旅|住宿/;
    const atLodging = lodgingWord.test(String(last.endLocation || ''))
      || /(回|回到|抵达|入住|办理入住)[^。，；]{0,8}(酒店|民宿|客栈|宾馆|青旅|住宿)/
        .test(String(last.activity || ''));
    if (last.category === 'hotel' || atLodging) {
      if (last.category === 'hotel' && !String(last.endLocation || '').trim()) {
        last.endLocation = String(today.hotel || '').trim() || tonight;
      }
      return;
    }
    const from = String(last.endLocation || last.startLocation || '').trim();
    const endMin = toMin(last.endTime);
    const st = (endMin != null ? endMin : 21 * 60) + 10;
    // 不用 samePlace 判断要不要导航：'眉山站'包含'眉山'会被判成同地，
    // 人明明还拎着行李在火车站，却连"从哪去酒店"的导航都不给了
    const moved = !!from && from !== tonight;
    // 大纲给了具体推荐酒店就用它（可导航到真酒店），没给就退回住宿片区
    const hotel = String(today.hotel || '').trim();
    const destName = hotel || tonight;
    out.push({
      dayIndex: di,
      startTime: fmtMin(Math.min(st, 23 * 60 + 30)),
      endTime: fmtMin(Math.min(st + 30, 23 * 60 + 59)),
      activity: moved
        ? `前往${destName}办理入住，放下行李休息`
        : `回${destName}休息`,
      category: 'hotel',
      startLocation: moved ? from : '',
      endLocation: moved ? destName : '',
      transportType: moved ? 'car' : '',
      note: hotel ? `今晚住${tonight}` : '',
    });
    console.warn('[generatePlan] 第%d天没有收在住宿地（最后一条：%s…），补一条回酒店',
      di + 1, String(last.activity || '').slice(0, 20));
  });
  return out;
}

/**
 * 第一天出发接驳兜底：必须有「从出发地（家门口）→ 车站/机场」这一条
 *
 * 实测踩过：用户填"出发地 重庆市金童路、出发时间 15:30"，生成的行程第 1 条
 * 直接是"15:30 乘高铁"——从金童路去重庆西站的接驳凭空消失。
 * prompt 规则 7 已要求第 1 条就是接驳，但模型偶尔仍直接从大交通写起；
 * 这里确定性补：第 0 天若没有任何"从出发地出发"的条目，就在大交通之前
 * 插一条打车接驳（时刻按 goTime 与安检预留推算）。
 */
function enforceOriginAccess(items, p, outline, activeDays) {
  const origin = String((p && p.origin) || '').trim();
  if (!origin || !asArray(items).length) return items;
  // 续跑轮次：本轮没有第 1 天的条目就不碰（否则会重复补接驳，见 MovesAlignment 注释）
  const active = new Set(asArray(activeDays).map(Number));
  if (active.size && !active.has(0)) return items;
  const goMin = toMin(p && p.goTime);
  const days = asArray(outline && outline.days);
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  const list = byDay.get(0) || [];
  if (!list.length) return items;

  // 已经有"从出发地出发"的条目（模型写了接驳）→ 不重复插
  const fromOrigin = (it) => samePlace(it.startLocation || '', origin)
    || String(it.activity || '').includes(origin);
  if (list.some(fromOrigin)) return items;

  // 首段大交通：transportType 与 activity 双重识别
  const isBigMove = (it) => /train|plane/.test(String(it.transportType || ''))
    || /乘[^，。;；]*(列车|航班)|飞机|高铁|动车/.test(String(it.activity || ''));
  const sorted = list.slice().sort((a, b) =>
    String(a.startTime || '').localeCompare(String(b.startTime || '')));
  const big = sorted.find(isBigMove);
  if (!big) return items;

  const plane = String(big.transportType || '') === 'plane'
    || /航班|飞机/.test(String(big.activity || ''));
  const station = String(big.startLocation
    || (days[0] && asArray(days[0].moves)[0] && asArray(days[0].moves)[0].from) || '').trim();
  if (!station) return items;

  const checkIn = plane ? 120 : 45;   // 到站需提前：安检候车
  const drive = 40;                   // 市内门到门
  const trainS = toMin(big.startTime);
  const s = goMin != null ? goMin : (trainS != null ? trainS - checkIn - drive : null);
  if (s == null) return items;
  let e = trainS != null ? trainS - checkIn : s + drive;
  if (e <= s + 15) e = s + drive;     // 时间紧也保底给一段完整的接驳
  const st = Math.min(s, 23 * 60 + 50);
  const en = Math.max(Math.min(e, 23 * 60 + 59), st + 15);
  items.push({
    dayIndex: 0,
    startTime: fmtMin(st),
    endTime: fmtMin(en),
    activity: `从${origin}打车前往${station}，准备乘车`,
    category: 'transport',
    startLocation: origin,
    endLocation: station,
    transportType: 'car',
    note: '出发接驳（按用户填写的出发时间生成）',
  });
  console.warn('[generatePlan] 第一天没有从「%s」出发的接驳，补一条去「%s」', origin, station);
  return items;
}

/**
 * 每天早餐兜底：第 2 天起，若 10:00 前没有任何餐饮条目，补一条"早餐+收拾退房"。
 * （第一天从家里出发，早餐在家吃，不补；出发太早赶早班车的也不硬塞。）
 */
function enforceMorningRoutine(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  byDay.forEach((list, di) => {
    if (di <= 0 || di >= days.length || !list.length) return;
    const hasBreakfast = list.some((it) =>
      it.category === 'food' && toMin(it.startTime) != null && toMin(it.startTime) < 10 * 60);
    if (hasBreakfast) return;
    const hasAnyFood = list.some((it) => it.category === 'food');
    const sorted = list.slice().sort((a, b) =>
      String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const first = sorted[0];
    const fs = toMin(first.startTime);
    if (fs == null || fs < 7 * 60 + 35) return;   // 赶早班车没空吃，别硬塞
    const prevOv = String((days[di - 1] && (days[di - 1].overnight || days[di - 1].city)) || '').trim();
    // 只在上午补早餐。实测踩过：返程日细化失败只剩 17:40 的高铁，
    // 兜底把"早餐"补在 17:00 —— 第一条都在中午以后了，该补的是午餐。
    if (fs <= 11 * 60 + 30) {
      const s = Math.max(7 * 60, fs - 40);
      const e = fs - 5;
      if (e <= s + 10) return;
      items.push({
        dayIndex: di,
        startTime: fmtMin(s),
        endTime: fmtMin(e),
        activity: prevOv ? `在${prevOv}吃早餐，收拾行李退房` : '吃早餐，收拾行李退房',
        category: 'food',
        startLocation: '',
        endLocation: '',
        transportType: '',
        note: '',
      });
      console.warn('[generatePlan] 第%d天 10 点前没有吃饭安排，补一条早餐', di + 1);
      return;
    }
    if (hasAnyFood || fs >= 15 * 60) return;      // 已有饭吃 / 下午才开始的不硬塞
    const s = Math.min(Math.max(fs - 50, 11 * 60 + 30), 13 * 60 + 30);
    items.push({
      dayIndex: di,
      startTime: fmtMin(s),
      endTime: fmtMin(s + 50),
      activity: prevOv ? `在${prevOv}附近吃午餐，收拾行李退房` : '吃午餐，收拾行李退房',
      category: 'food',
      startLocation: '',
      endLocation: '',
      transportType: '',
      note: '',
    });
    console.warn('[generatePlan] 第%d天第一条已是 %s，补午餐而不是早餐', di + 1, first.startTime);
  });
  return items;
}

/**
 * 晚间安排兜底：非末日当天若 20:30 前就结束了（典型：第一天傍晚就到目的地、
 * 行李一放就没事干），补晚餐/夜逛。必须跑在 enforceDayClosure 之前——
 * 插完由 closure 收尾"回酒店"，闭环不断。
 */
function enforceEveningPlan(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });
  byDay.forEach((list, di) => {
    if (di < 0 || di >= days.length - 1 || !list.length) return;
    const today = days[di] || {};
    const tonight = String(today.overnight || today.city || '').trim();
    if (!tonight || /返程|回家/.test(tonight)) return;
    const city = String(today.city || tonight).trim() || tonight;
    const sorted = list.slice().sort((a, b) =>
      String(a.startTime || '').localeCompare(String(b.startTime || '')));
    const last = sorted[sorted.length - 1];
    const endMin = toMin(last.endTime);
    // 15:00 前就结束的整天也别补"晚餐/夜游"——那是细化失败的残天（只落了大交通
    // +接驳），补出来就是"12:30 夜游散步"这种鬼东西，残天交给骨架重建
    if (endMin == null || endMin >= 20 * 60 + 30 || endMin < 15 * 60) return;

    if (last.category === 'hotel') {
      // 人已经回酒店但天还没黑透 → 补一条"再出门夜逛"（closure 随后补回酒店）
      const s = endMin + 30;
      if (s + 40 > 22 * 60 + 30) return;
      items.push({
        dayIndex: di,
        startTime: fmtMin(s),
        endTime: fmtMin(Math.min(s + 90, 22 * 60 + 30)),
        activity: `晚上出门到${city}市区逛逛，感受当地夜生活`,
        category: 'sight',
        startLocation: tonight,
        endLocation: city,
        transportType: 'car',
        note: '时间充裕，按兴趣选夜市/江边/商圈',
      });
      console.warn('[generatePlan] 第%d天 %s 就收尾了，补一条夜逛', di + 1, last.endTime);
      return;
    }
    // 人还在外面 → 补晚餐；时间够再补夜逛
    const s = endMin + 15;
    const dinnerEnd = Math.min(s + 75, 20 * 60 + 30);
    if (dinnerEnd > s + 30) {
      items.push({
        dayIndex: di,
        startTime: fmtMin(s),
        endTime: fmtMin(dinnerEnd),
        activity: `在${city}吃晚餐，尝当地特色菜`,
        category: 'food',
        startLocation: '',
        endLocation: city,
        transportType: '',
        note: '',
      });
    }
    const ns = dinnerEnd + 20;
    if (ns + 40 <= 22 * 60) {
      items.push({
        dayIndex: di,
        startTime: fmtMin(ns),
        endTime: fmtMin(Math.min(ns + 60, 22 * 60)),
        activity: `饭后到${city}市区夜游散步`,
        category: 'sight',
        startLocation: '',
        endLocation: city,
        transportType: 'walk',
        note: '',
      });
    }
    console.warn('[generatePlan] 第%d天 %s 就结束了，补晚餐/夜逛', di + 1, last.endTime);
  });
  return items;
}

/** 两个住宿地名是不是同一个地方（去掉括号补注与行政后缀再比，允许互相包含） */
function samePlace(a, b) {
  const norm = (s) => String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')   // 去掉"（两江四湖片区）"这类补注
    .replace(/[\s，,、·]/g, '')
    .replace(/(市区|市|县|区|镇)+$/, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * 行李逻辑兜底
 *
 * 提示词里已经写了规矩，但 LLM 常偷懒（整天不提行李）或写反（换住处仍把行李
 * 留在上一家酒店）。这里做确定性修补，只往 note 里追加提醒，不动 activity 和时间线：
 *   ① 换住处却写了"把行李寄存在酒店前台" → 纠正为"退房带走全部行李"；
 *   ② 换住处但整天没提行李 → 早上第一条补一句；
 *   ③ 任何"寄存行李"之后没人提醒取回 → 在离开那一条补"取回行李"。
 */
function enforceLuggageRules(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;

  const byDay = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (!byDay.has(di)) byDay.set(di, []);
    byDay.get(di).push(it);
  });

  const TIP_PICKUP = '离开前记得取回寄存的行李';

  byDay.forEach((list, di) => {
    if (!list.length) return;
    const today = days[di] || {};
    const prevDay = di > 0 ? days[di - 1] : null;
    const tonight = String(today.overnight || today.city || '');
    const lastNight = prevDay ? String(prevDay.overnight || prevDay.city || '') : '';
    const changedBase = !!lastNight && !samePlace(lastNight, tonight);
    const TIP_TAKE = /返程|回家|返回/.test(tonight)
      ? '今天返程，退房请带走全部行李（行李随人走）'
      : '今晚不回这家酒店，退房请带走全部行李（行李随人走）';

    const textOf = (it) => `${it.activity || ''} ${it.note || ''}`;
    const hasLuggage = (it) => /行李|箱子|大件/.test(textOf(it));
    // 否定句里的"寄存"不是寄存："行李随身带，不寄存""严禁寄存回原酒店"
    // ——先把否定短语剥掉再匹配，否则会莫名其妙冒出一条"记得取回行李"
    const stripNegation = (s) => String(s || '')
      .replace(/(不|勿|别|无需|无须|不用|避免|严禁|禁止|切记不要|不要)(寄存|存放|存包|寄放)/g, '');
    // 只把"真的把行李存下了"当成寄存：activity 里写了寄存动作，或备注里明确写了"寄存行李"。
    // 「码头有行李寄存柜」这种顺口一提不算——否则会莫名其妙冒出一条"记得取回行李"。
    const isStore = (it) => (/寄存|存放|存包/.test(stripNegation(String(it.activity || ''))) && hasLuggage(it))
      || /寄存(大件)?行李|存放(大件)?行李|行李寄存/.test(stripNegation(String(it.note || '')));
    const isPickup = (it) => /取回|取件|拿回|领回/.test(textOf(it)) && hasLuggage(it);
    const appendNote = (it, tip) => {
      if (!it) return false;
      const cur = String(it.note || '');
      if (cur.includes(tip)) return false;
      it.note = cur ? `${cur.replace(/[；;]\s*$/, '')}；${tip}` : tip;
      return true;
    };

    // ①② 换住处：行李必须随人走
    if (changedBase) {
      list.forEach((it) => {
        if (!isStore(it)) return;
        // 景区/车站/机场的临时寄存是合理操作，别误伤
        if (/景区|景点|游客中心|寄存柜|存包|车站|机场|码头/.test(textOf(it))) return;
        appendNote(it, TIP_TAKE);
      });
      if (!list.some(hasLuggage)) {
        const first = list.slice().sort((a, b) =>
          String(a.startTime || '').localeCompare(String(b.startTime || '')))[0];
        appendNote(first, TIP_TAKE);
      }
    }

    // ③ 寄存了就得有人喊你取回
    const storeIdx = list.findIndex(isStore);
    if (storeIdx < 0) return;
    // 上面刚判过这条是错的寄存（换住处还留在酒店）→ 已经改成"带走"了，别再喊他回来取
    if (String(list[storeIdx].note || '').includes('退房请带走全部行李')) return;
    // 行李就寄在本家酒店（今晚还回这家）：回来自然拿到，别多嘴喊"取回"
    // （实测：'大件行李留在酒店房间或寄存前台'被追加了'记得取回'——今晚回同一家，取什么？）
    if (!changedBase && /酒店|民宿|客栈|宾馆|青旅|房间|前台/.test(textOf(list[storeIdx]))) return;
    let reminded = false;
    for (let i = storeIdx; i < list.length; i++) {
      if (isPickup(list[i])) { reminded = true; break; }
    }
    if (reminded) return;
    // 找寄存之后第一条"要离开这儿"的条目：有移动、或终点不在寄存地
    const storePlace = String(list[storeIdx].endLocation || list[storeIdx].startLocation || '');
    let target = null;
    for (let i = storeIdx + 1; i < list.length; i++) {
      const it = list[i];
      const moved = String(it.endLocation || '').trim()
        && String(it.endLocation).trim() !== storePlace
        && String(it.endLocation).trim() !== String(it.startLocation || '').trim();
      if (it.category === 'transport' || moved) { target = it; break; }
    }
    if (!target) target = list[list.length - 1];
    if (target === list[storeIdx]) return;   // 全天就这一条，别自言自语
    appendNote(target, TIP_PICKUP);
  });

  return items;
}

// ============================================================
// 餐次纠偏 / 白天不回酒店 / 细化失败天骨架兜底
// ============================================================

/**
 * 餐次词纠偏：LLM 偶尔把"晚餐"排在早上 8 点（实测"早上就吃晚饭"）。
 * 按条目实际开始时间，把 activity 里写错的餐次词换成对的：
 *   <10:30 → 早餐；10:30~15:00 → 午餐；≥16:30 → 晚餐（中间时段不动，可能是下午茶）。
 * 只换餐次词本身，不动店名/菜品等其他内容。
 */
function fixMealLabels(items, outline) {
  asArray(items).forEach((it) => {
    if (!it || it.category !== 'food') return;
    const t = toMin(it.startTime);
    if (t == null) return;
    let wantFull = null;
    let wantShort = null;
    if (t < 10 * 60 + 30) { wantFull = '早餐'; wantShort = '早饭'; }
    else if (t < 15 * 60) { wantFull = '午餐'; wantShort = '午饭'; }
    else if (t >= 16 * 60 + 30) { wantFull = '晚餐'; wantShort = '晚饭'; }
    else return;
    let act = String(it.activity || '');
    if (!act) return;
    [['晚餐', wantFull], ['晚饭', wantShort], ['午餐', wantFull], ['午饭', wantShort], ['早餐', wantFull], ['早饭', wantShort]]
      .forEach(([from, to]) => {
        if (from !== to) act = act.split(from).join(to);
      });
    if (act !== String(it.activity || '')) {
      console.warn('[generatePlan] 「%s…」排在 %s，餐次词已纠偏',
        String(it.activity || '').slice(0, 16), it.startTime);
      it.activity = act;
    }
  });
  return items;
}

/**
 * 白天不回酒店睡觉：非返程日 15:00 前的"回酒店休息/午休"类条目直接删掉。
 * 换住处当天"到酒店放行李/办理入住"是正当操作，放行；末日不受限。
 * 实测踩过：中午 13:00 安排"返回酒店附近稍作休息"，游客被摁回酒店睡觉，
 * 下午半天凭空蒸发。
 */
function enforceNoMiddayHotel(items, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length || !asArray(items).length) return items;
  const legit = (it) => /入住|办理|放(行李|下)|寄存|行李/.test(`${it.activity || ''}${it.note || ''}`);
  const sleepy = (it) => it.category === 'hotel'
    || /回(酒店|住宿|房间)|返回酒店|午休|午睡/.test(String(it.activity || ''));
  const out = [];
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    const t = toMin(it.startTime);
    const isLastDay = di === days.length - 1;
    if (!isLastDay && it.category !== 'transport' && it.category !== 'food'
      && sleepy(it) && !legit(it) && t != null && t < 15 * 60) {
      console.warn('[generatePlan] 第%d天 %s 白天安排「%s」，删除（游客不该中午回酒店睡觉）',
        di + 1, it.startTime, String(it.activity || '').slice(0, 18));
      return;
    }
    out.push(it);
  });
  return out;
}

/**
 * 细化失败天的骨架兜底：LLM 某天重试耗尽后那天就是空白（只剩代码补的
 * 大交通+接驳，实测返程日整天空掉）。用大纲里该天的 moves / hl / meals
 * 生成一份"骨架行程"：大交通 + 三餐 + 每个必玩点一条游览，插空排时刻，
 * 保证每天至少是可执行的完整骨架，而不是半页空白。
 */
function skeletonDayItems(p, day, idx, outline) {
  const isLast = idx === outline.days.length - 1;
  const city = String(day.city || day.overnight || '').trim() || '目的地';
  const items = [];
  const mk = (startTime, endTime, activity, category, extra = {}) => items.push(Object.assign({
    dayIndex: idx,
    startTime: fmtMin(startTime),
    endTime: fmtMin(endTime),
    activity,
    category,
    startLocation: '',
    endLocation: '',
    transportType: '',
    note: '',
  }, extra));

  // 忙碌区间 = 大交通；三餐/游玩在 [6:30, 23:00] 的空档里插
  const busy = [];
  asArray(day.moves).forEach((m) => {
    const s = toMin(m.startTime);
    const e = toMin(m.endTime);
    if (s == null || e == null) return;
    busy.push([s, e]);
    const mode = String(m.mode || '').toLowerCase();
    const tt = /plane|航班|飞机/.test(mode) ? 'plane' : /train|高铁|动车|火车/.test(mode) ? 'train' : 'car';
    mk(s, e, moveActivityText(m), 'transport', {
      startLocation: String(m.from || '').trim(),
      endLocation: String(m.to || '').trim(),
      transportType: tt,
    });
  });
  busy.sort((a, b) => a[0] - b[0]);
  const DAY_S = 6 * 60 + 30;
  const DAY_E = 23 * 60;
  const place = (earliest, dur) => {
    let cur = Math.max(DAY_S, earliest);
    for (const [s, e] of busy) {
      if (cur + dur <= s) return cur;
      if (e > cur) cur = Math.max(cur, e);
    }
    return cur + dur <= DAY_E ? cur : null;
  };
  const occupy = (s, e) => { busy.push([s, e]); busy.sort((a, b) => a[0] - b[0]); };

  // 三餐（第 1 天早餐在家吃，不补；返程日晚餐看时间，交给 EveningPlan/Closure）
  if (idx > 0) {
    const s = place(8 * 60, 40);
    if (s != null) { mk(s, s + 40, `在${city}吃早餐`, 'food'); occupy(s, s + 40); }
  }
  const meals = asArray(day.meals);
  const ls = place(12 * 60, 60);
  if (ls != null) {
    mk(ls, ls + 60, meals[0] ? `午餐：${meals[0]}` : `在${city}吃午餐，尝当地特色`, 'food');
    occupy(ls, ls + 60);
  }
  // 游玩：每个必玩点一条，顺序往后排
  let cur = 9 * 60 + 30;
  asArray(day.highlights).forEach((h) => {
    const name = String(h || '').trim();
    if (!name) return;
    const s = place(cur, 120) || place(cur, 90);
    if (s == null) return;
    const dur = place(cur, 120) != null ? 120 : 90;
    mk(s, s + dur, `游览${name}`, 'sight', {
      startLocation: cur === 9 * 60 + 30 ? city : '',
      endLocation: name,
      transportType: cur === 9 * 60 + 30 ? 'car' : '',
    });
    occupy(s, s + dur);
    cur = s + dur + 15;
  });
  if (!isLast) {
    const ds = place(18 * 60 + 30, 60);
    if (ds != null) {
      mk(ds, ds + 60, meals[1] ? `晚餐：${meals[1]}` : `在${city}吃晚餐，尝当地特色`, 'food');
      occupy(ds, ds + 60);
    }
  }
  return items;
}

/**
 * 细化失败/残缺天的骨架兜底：LLM 某天重试耗尽后那天就是空白，或细化超时
 * 只落下 2~3 条（大交通+接驳），残缺得没法看。两种天都按大纲里该天的
 * moves / hl / meals 重建"骨架行程"：大交通 + 三餐 + 每个必玩点一条游览，
 * 插空排时刻，保证每天至少是可执行的完整骨架。
 * @returns {{items: Array, replaced: number[]}} replaced 是被重建的天（原条目要丢弃）
 */
function skeletonForEmptyDays(p, outline, items, doneDayIndexes) {
  const days = asArray(outline && outline.days);
  if (!days.length) return { items: [], replaced: [] };
  const counts = new Map();
  asArray(items).forEach((it) => {
    const di = Number(it.dayIndex || 0);
    counts.set(di, (counts.get(di) || 0) + 1);
  });
  // 之前轮次已完成的天不在本轮 items 里，必须排除，否则会被误判成空天重复重建
  const done = new Set(asArray(doneDayIndexes).map(Number));
  // 空天，或只剩 ≤3 条的"残天"（细化超时只落了大交通+代码兜底接驳）都重建
  const rebuild = [];
  days.forEach((d, i) => {
    if (done.has(i)) return;
    const n = counts.get(i) || 0;
    if (n === 0 || n <= 3) rebuild.push(i);
  });
  if (!rebuild.length) return { items: [], replaced: [] };
  console.warn('[generatePlan] 第 %s 天 AI 细化未产出/残缺，用大纲骨架重建',
    rebuild.map((i) => i + 1).join('、'));
  const out = [];
  rebuild.forEach((i) => out.push(...skeletonDayItems(p, days[i], i, outline)));
  return { items: out, replaced: rebuild };
}

function applyTripEdgeTimes(p, outline) {
  const days = asArray(outline && outline.days);
  if (!days.length) return outline;
  // 只认城际大交通段（市内接驳不挪）
  const railLike = (m) => /train|plane|高铁|动车|火车|航班|飞机|ship|游船/
    .test(`${m.mode || ''}${m.code || ''}`.toLowerCase());

  /** 整体平移一段班次：保持时长不变，把指定那一端挪到 wantMin */
  const shiftSeg = (m, wantMin, edge) => {
    if (wantMin == null || !m) return false;
    const s = toMin(m.startTime);
    const e = toMin(m.endTime);
    const dur = (s != null && e != null && e > s) ? e - s : null;
    if (edge === 'start') {
      if (s == null) return false;
      m.startTime = fmtMin(wantMin);
      if (dur != null) m.endTime = fmtMin(wantMin + dur);
      return true;
    }
    if (e == null) return false;
    m.endTime = fmtMin(wantMin);
    // 倒推出来的发车时刻要是退到了前一天（比如"早上 8 点到家"意味着半夜出发），
    // 就别硬挪起点了，只保证到达时刻对得上
    if (dur != null && wantMin - dur >= 0) m.startTime = fmtMin(wantMin - dur);
    return true;
  };

  const goMin = toMin(p.goTime);
  const backMin = toMin(p.backTime);
  if (goMin != null) {
    const first = days[0];
    const list = asArray(first && first.moves);
    const m = list.find(railLike) || list[0];
    if (m) {
      // goTime = **离开出发地（家门口/酒店）的时刻**，不是发车时刻！
      // 实测踩过：用户填"重庆市金童路 15:30 出发"，大纲把高铁发车写成 15:30，
      // 细化自然从"15:30 乘高铁"写起——从金童路去重庆西站的接驳凭空消失。
      // 发车时刻 = goTime + 市内接驳 40 分钟 + 安检候车（高铁 45 分 / 飞机 2 小时）。
      const modeStr = `${m.mode || ''}${m.code || ''}`.toLowerCase();
      const buffer = /plane|航班|飞机/.test(modeStr) ? 160
        : /train|高铁|动车|火车/.test(modeStr) ? 85
        : 60;                                    // bus/car/ship：门到门 40 分 + 余量
      shiftSeg(m, goMin + buffer, 'start');
    }
  }
  if (backMin != null && days.length > 1) {
    const last = days[days.length - 1];
    const list = asArray(last && last.moves);
    // 最后一天可能先有短途接驳、再上车返程 → 取**最后一段**大交通当返程
    const m = list.slice().reverse().find(railLike) || list[list.length - 1];
    if (m) {
      // backTime = **回到出发地（到家）的时刻**：大交通到达后还要 ~40 分钟
      // 市内返家接驳，到站时刻 = backTime - 40（到家那条由细化/DayClosure 生成）
      shiftSeg(m, Math.max(0, backMin - 40), 'end');
    }
  }
  return outline;
}

/** 大纲 JSON（短键名）→ 归一化结构 */
function normalizeOutlineJson(raw, p) {
  const days = asArray(raw && raw.ds).map((d, i) => ({
    date: validDate(d.d) ? d.d : shiftDate(p.startDate, i),
    city: String(d.city || '').trim(),
    theme: String(d.t || '').trim(),
    moves: asArray(d.mv).map((m) => ({
      from: m.f || '', to: m.to || '', mode: m.m || '', code: m.c || '',
      startTime: m.s || '', endTime: m.e || '',
      transfer: String(m.st || '').trim(),   // 到站后的接驳方式与耗时（选站是否合格的尺子）
    })),
    highlights: asArray(d.hl).map((x) => String(x || '').trim()).filter(Boolean),
    meals: asArray(d.ml).map((x) => String(x || '').trim()).filter(Boolean),
    overnight: String(d.ov || d.city || '').trim(),
    hotel: String(d.h || '').trim(),     // 每晚推荐酒店（按预算/节奏/兴趣挑，可空）
    note: String(d.n || '').trim(),
  }));
  const nights = asArray(raw && raw.nt).map((n) => ({ date: n.d || '', city: String(n.c || '').trim() }));
  return {
    title: String((raw && raw.t) || `${p.dest}行程`).trim().slice(0, 60),
    summary: String((raw && raw.s) || '').trim().slice(0, 200),
    nights,
    days,
  };
}

/** 归一化大纲 → 短键名 JSON（修订请求里要回喂给 LLM，省 token） */
function outlineToShortJson(outline) {
  return {
    t: outline.title,
    s: outline.summary,
    nt: asArray(outline.nights).map((n) => ({ d: n.date, c: n.city })),
    ds: asArray(outline.days).map((d) => ({
      d: d.date, city: d.city, t: d.theme,
      mv: asArray(d.moves).map((m) => ({
        f: m.from, to: m.to, m: m.mode, c: m.code, s: m.startTime, e: m.endTime, st: m.transfer,
      })),
      hl: d.highlights, ml: d.meals, ov: d.overnight, n: d.note,
    })),
  };
}

// 景区常见的"名字尾巴"：用户写「明仕庄园」、模型写「明仕田园」这种一字之差
// 不该被判成"漏了"（真跑时踩过：大纲里明明有明仕田园，却报缺明仕庄园，
// 结果白跑一次修订请求，还把这次修订挤到超时）。
const PLACE_SUFFIX = /(景区|风景区|名胜区|庄园|田园|梯田|古镇|古村|公园|森林公园|国家公园|博物馆|观景台|度假区|遗址|寺庙|保护区|海岛|海滨|瀑布|岩洞|溶洞|竹筏|游船)$/;
/** 去掉尾巴后的地名词干（太短就不剥，避免误判） */
function placeStem(name) {
  const s = String(name || '').replace(/\s+/g, '');
  const stripped = s.replace(PLACE_SUFFIX, '');
  return stripped.length >= 2 ? stripped : s;
}

/** 用户点名的地点里，大纲还没"真正去玩"的（词干匹配，容忍"庄园/田园"这类一字之差） */
function missingMustVisit(p, outline) {
  // 只认游玩字段：城市 / 当天主题 / 必玩点。mv 描述、n 提示里的出现不算——
  // 真踩过：都江堰只出现在 mv 的"坐车经过都江堰游客中心"里，
  // 整串 JSON 比对误判成已覆盖，用户想玩的地方被当成走廊开过去了。
  const playText = outline.days.map((d) =>
    [d.city, d.theme, ...asArray(d.highlights)].join('|')).join('|');
  return (p.mustVisit || []).filter((name) => {
    if (playText.includes(name)) return false;
    const stem = placeStem(name);
    if (stem.length >= 2 && playText.includes(stem)) return false;
    // 「成都市」→「成都」：城市字段常写简称，别因为带了个"市"字判成漏了
    const bare = String(name || '').replace(/(市|县|区)$/, '');
    if (bare.length >= 2 && playText.includes(bare)) return false;
    return true;
  });
}

/** hl 里不算景点的泛化词（按天重复是正常的） */
const GENERIC_HL = /^(自由活动|自由行|自由探索|酒店休息|休整|集合|出发|到达|抵达|返程|返程回家|逛逛|市区漫游|市区自由活动)$/;

/**
 * 跨天重复游玩的景点：同一个 hl 词条（或包含它的变体，如"晨拍毕棚沟"
 * vs"毕棚沟"）出现在 ≥2 个不同的天。真踩过：毕棚沟在大纲里被排了两天，
 * 行程硬生生多出一天重复爬山。
 * @returns Array<{name, days:number[]}> days 是 dayIndex（0 起）
 */
function duplicateHighlights(outline) {
  const items = [];
  outline.days.forEach((d, i) => asArray(d.highlights).forEach((h) => {
    const s = String(h || '').trim();
    if (s && !GENERIC_HL.test(s)) items.push({ s, stem: placeStem(s), day: i });
  }));
  // 归并：词条 stem 相同，或一个是另一个的子串（"毕棚沟" ⊂ "晨拍毕棚沟"）就算同一个
  const groups = [];
  items.forEach((it) => {
    const g = groups.find((grp) => grp.members.some((m) =>
      m.stem === it.stem
      || (m.stem.length >= 2 && it.s.includes(m.stem))
      || (it.stem.length >= 2 && m.s.includes(it.stem))));
    if (g) { g.members.push(it); g.days.add(it.day); } else {
      groups.push({ members: [it], days: new Set([it.day]) });
    }
  });
  return groups
    .filter((g) => g.days.size >= 2)
    .map((g) => ({ name: g.members[0].stem, days: [...g.days].sort((a, b) => a - b) }));
}

/** 从"地铁30分钟""打车约 45 分钟""步行 1 小时 10 分"这类接驳描述里读出分钟数（通用，不认地名） */
function transferMinutes(text) {
  const s = String(text || '');
  const hm = /(\d+)\s*(?:小时|个?钟头)\s*(?:(\d+)\s*分(?:钟)?)?/.exec(s);
  if (hm) return (+hm[1]) * 60 + (+(hm[2] || 0));
  const m = /(\d+)\s*分(?:钟)?/.exec(s);
  return m ? +m[1] : null;
}

/** 接驳描述里说的是不是"打车类"（打车/网约车/包车/自驾）；轨道交通与步行不算绕路 */
function isCarTransfer(text) {
  return /打车|出租车|网约|包车|租车|自驾|驾车/.test(String(text || ''));
}

/**
 * 找出"到站后还要长途打车"的大交通段（通用体检：只看接驳方式与耗时，不认任何地名/车站）。
 * 判据：到站后还得打车 carLimit 分钟以上才到当天目的地 → 站多半选在了反方向（舍近求远）；
 * 轨交/步行本身就便宜不绕路，1 小时内都算正常（大城市地铁 40 分钟到酒店很常见）。
 */
function detourTransfers(outline, carLimit) {
  // 阈值放宽到 15 分钟：模型自报的接驳耗时常常偏短（实测报"打车20分钟"，
  // 细化出来是 30 分钟），放宽一点才拦得住；验收端还要求"必须真的变好"才采纳，
  // 所以宁可多问一次，也别漏掉真正的绕路。
  const lim = carLimit || 15;
  const out = [];
  asArray(outline && outline.days).forEach((d, i) => {
    asArray(d.moves).forEach((m) => {
      const mins = transferMinutes(m.transfer);
      if (mins == null) return;
      const byCar = isCarTransfer(m.transfer);
      if ((byCar && mins >= lim) || mins > 60) {
        out.push({ dayIndex: i, move: m, minutes: mins, byCar });
      }
    });
  });
  return out;
}

/**
 * 修订大纲：把漏掉的点名地点排进去 / 清掉跨天重复游玩的景点，
 * 其余安排尽量保持不变。
 *
 * ⚠️ 只让模型输出**需要改动的那几天**，不再让它重写整份大纲：
 *    整份 8 天大纲要写 ~2700 token（实测约 30s），而这次修订是在主大纲跑完之后
 *    的剩余时间里做的，根本挤不下 —— 实测被超时掐断，漏掉的点一个也没补回来。
 *    改成"只吐 1~3 天的补丁"（几百 token，8s 左右）就能在剩余时间里跑完。
 *
 * 兼容：模型万一还是返回了完整大纲（ds 天数 = 总天数），按整份替换处理。
 * 失败返回 null（保留原大纲）。
 */
async function repairOutline(p, outline, missing, dups, detours, deadline) {
  try {
    const issues = [];
    if (missing.length) {
      issues.push(`漏掉了用户点名要去的地点：${missing.join('、')}（每一个都必须安排进某天：成为城市、当天主题或必玩点，不能只"途经"）`);
    }
    if (dups.length) {
      issues.push(`有景点被跨天重复安排：${dups.map((d) => `「${d.name}」出现在第 ${d.days.map((x) => x + 1).join('、')} 天`).join('；')}。重复的只保留一天，其余那天换成同区域其他不重复的景点`);
    }
    if (detours && detours.length) {
      issues.push(`有以下大交通段"到站后还得长途打车才到当天目的地"（说明站选在了反方向、舍近求远）：${detours.map((x) => `第 ${x.dayIndex + 1} 天 ${x.move.from}→${x.move.to}，到站后${x.move.transfer}`).join('；')}。请为这些天改用离当天最终目的地（景点/住宿）最近的车站/码头/机场——同城市域铁路、城际线、机场快线优先，班次密、票价低、不堵车；交通方式与时刻保持不变，只改到发站（车次跟着改），并把新的到站接驳写进 mv.st（争取变成步行或轨道交通）`);
    }
    const prompt = `下面这份旅行路线大纲有问题：${issues.join('。')}。
请**只输出需要改动的那几天**（其余天不要输出），把问题修掉。

【旅行需求】${profileText(p)}

【当前大纲（短键名）】
${JSON.stringify(outlineToShortJson(outline))}

# 输出格式
{"ds":[{"d":"YYYY-MM-DD","city":"城市","t":"当天主题短语","mv":[{"f":"出发站","to":"到达站","m":"train/plane/car/bus/ship","c":"车次/航班号","s":"HH:mm","e":"HH:mm","st":"到站后接驳"}],"hl":["必玩1","必玩2","必玩3"],"ov":"当晚住宿","n":"提示（20字内）"}]}

# 要求
1. ds 只包含**需要改动的天**（一般 1~2 天就够），d 必须原样抄当前大纲里的日期。mv 只在**这段交通需要改到发站**时才填（要改就把该天所有 mv 一起原样带回，别只给一段）。
2. ${missing.length ? `${missing.join('、')} 每一个都必须出现在某天的 city / t / hl 里。` : ''}${dups.length ? `重复景点每个只保留一天，被清掉的那天补上新的、不重复的景点；不要因为去重就把某天改空。` : ''}${(detours && detours.length) ? '改站的那天：交通方式与时刻保持不变，只改到发站与车次，mv.st 写新的到站接驳（争取步行/轨道交通）；没有更近的站就别改，把理由写进 n。' : ''}
3. 改动尽量小：能塞进已有某天的 hl 就别重排整条路线，其他天保持原样。住宿闭环别破坏：每晚 ov 保持原样。
4. 只输出这个 JSON 对象，不要任何解释。`;
    const text = await llm.chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], { deadline });
    const parsed = parseJSONFromText(text);
    const patched = asArray(parsed && parsed.ds);

    // 模型返回了整份大纲 → 走老的整份替换逻辑
    if (patched.length && patched.length === p.days) {
      const repaired = applyTripEdgeTimes(p, normalizeOutlineJson(parsed, p));
      if (repaired.days.length !== p.days) {
        console.warn('[generatePlan] 修订大纲天数不符（%d ≠ %d），弃用', repaired.days.length, p.days);
        return null;
      }
      return repaired;
    }

    // 只改了几天的补丁 → 按日期合并回原大纲
    const byDate = new Map();
    outline.days.forEach((d) => byDate.set(d.date, d));
    let changed = 0;
    patched.forEach((raw) => {
      const date = validDate(raw && raw.d) ? raw.d : '';
      const nd = normalizeOutlineJson({ ds: [raw] }, p).days[0];
      const target = byDate.get(date);
      if (!nd || !target) return;
      if (nd.city) target.city = nd.city;
      if (nd.theme) target.theme = nd.theme;
      if (asArray(nd.highlights).length) target.highlights = nd.highlights;
      if (asArray(nd.moves).length) target.moves = nd.moves;
      if (nd.overnight) target.overnight = nd.overnight;
      if (nd.hotel) target.hotel = nd.hotel;
      if (nd.note) target.note = nd.note;
      changed++;
    });
    if (!changed) {
      console.warn('[generatePlan] 修订补丁没有匹配到任何一天，弃用');
      return null;
    }
    console.log('[generatePlan] 修订补丁已合并 %d 天', changed);
    return applyTripEdgeTimes(p, outline);
  } catch (e) {
    console.error('[generatePlan] 大纲修订失败（保留原大纲）:', e.message);
    return null;
  }
}

// ============================================================
// ② 逐天细化（并行）
// ============================================================

const ITEM_SCHEMA =
  '{"dayIndex":0,"startTime":"HH:mm","endTime":"HH:mm","activity":"行程描述","category":"sight/food/hotel/transport/ticket/other","startLocation":"","endLocation":"","transportType":"car/walk/ride/train/plane","note":""}';

function dayDetailPrompt(p, day, idx, outline) {
  const prev = idx > 0 ? outline.days[idx - 1] : null;
  const next = idx < outline.days.length - 1 ? outline.days[idx + 1] : null;
  const isFirst = idx === 0;
  const isLast = idx === outline.days.length - 1;
  // 行李怎么走，取决于今晚回不回昨晚那家酒店（换住处 = 行李必须随身）
  const tonight = day.overnight || day.city || '';
  const lastNight = prev ? (prev.overnight || prev.city || '') : '';
  const sameBase = samePlace(lastNight, tonight);

  const block =
    `【旅行需求】${profileText(p)}\n\n` +
    `【今天】${day.date}（周${weekdayOf(day.date)}）｜${day.theme}\n` +
    `所在城市：${day.city}\n` +
    `大纲要点：${asArray(day.highlights).join('、')}\n` +
    (asArray(day.moves).length
      ? `【今天的大交通（路线既定）】${asArray(day.moves).map(
          (m) => `${m.from || '?'}→${m.to || '?'} ${m.mode || ''} ${m.code || ''} ${m.startTime || ''}-${m.endTime || ''}`
            + (m.transfer ? `；到站后接驳：${m.transfer}` : '')
        ).join('；')}\n`
      : '') +
    (day.meals && asArray(day.meals).length ? `餐饮建议：${asArray(day.meals).join('、')}\n` : '') +
    (day.note ? `提示：${day.note}\n` : '') +
    `当晚住宿：${day.overnight || day.city}${day.hotel ? `（推荐酒店：${day.hotel}，已按用户预算「${p.budget}」档挑选，最后的入住条目用它）` : ''}\n\n` +
    (prev ? `【昨天】${prev.date}｜${prev.theme}，昨晚住${prev.overnight || prev.city} —— 今天第一条行程从这里出发。\n` : '') +
    (next ? `【明天】${next.date}｜${next.theme}（今天的行程要为明天的移动留出余量）\n\n` : '\n');

  const rules =
    `请把"今天"展开为**详细到可以直接照着执行**的行程项 JSON 数组，每个元素格式：${ITEM_SCHEMA}
dayIndex 全部填 ${idx}。

# 细致度要求（核心）
1. **覆盖一整天**（唯一硬要求）：起床/早餐 → 上午安排 → 午餐 → 下午安排 → 傍晚（日落/夜景）→ 晚餐 → 夜间活动 → 回酒店休息。条数一般 8～14 条，内容多就多写、少就少写——**不要为了凑条数删掉有用的安排，也不要把一件事拆成好几条凑数**。不要只列几个景点就结束。
2. 每条 startTime / endTime 必须具体且**首尾相接**：后一条的 startTime 等于前一条的 endTime（中间留间隔也算合理，如 转场/休息），全天从起床开始、到回酒店休息结束。禁止输出空时间、"--:--"、或 endTime 等于 startTime。
3. 时间分配要符合常识和${p.pace}节奏：早餐 07:00 前后；午餐 12:00-13:00；晚餐 18:30-20:00；景区游览至少 1-2 小时；晚上安排到 21:30-22:30 之间收尾回酒店。${p.pace === '轻松' ? '每天最多 2 个主景点，留出午休和慢逛时间。' : p.pace === '紧凑' ? '行程可以更满，但必须保证吃饭和必要的交通接驳时间。' : ''}
4. activity 要写得像真人行程："14:44 乘 G2249 前往桂林西（约 4 小时 54 分）"、"20:10 去崇善米粉吃第一顿桂林米粉，点卤菜粉/锅烧粉"、"21:00 步行前往杉湖，看日月双塔夜景"。**要有具体名称**（店名/菜品/景点具体区域/观景台），不要写"吃晚饭""逛逛"这种空话；餐饮条目统一写"店名/片区 + 招牌菜"。
   4.1 **每个主要景点展开成完整链条**：抵达 → 游览（写清到底玩什么：哪段索道/哪个观景台/乘船还是徒步/核心体验与拍照点，可拆 1~3 条）→ 前往下一站。禁止只写一条"游览XX"就凭空跳到下一个景点；景区内的移动（乘索道/换观景台）也要单独成条。
5. 涉及移动的动作必须填 startLocation / endLocation（起点空着时，用上一条的位置或昨晚住宿地），并填 transportType：步行=walk，打车/包车=car，公交地铁/电动车=ride，火车=train，飞机=plane。没有移动（吃饭、休息、游览）三项都留空。
6. 备注写进 note：预约要求、末班车时间、门票信息、行李寄存、拍照机位、当地支付/语言提示等实用信息。
7. ${isFirst ? `第一天：**第 1 条必须是出发接驳**——「${p.goTime || '按大交通倒推'} 从${p.origin || '出发地'}出发，前往${(asArray(day.moves)[0] && asArray(day.moves)[0].from) || '车站/机场'}」，startLocation 填${p.origin || '出发地'}、endLocation 填车站/机场、transportType=car；随后写到站安检候车（高铁提前 45 分钟，飞机提前 2 小时），再上大交通。${p.goTime ? `**${p.goTime} 是离开${p.origin || '出发地'}的时刻（去程开始时间），不是发车时刻**；大交通发车时刻以【今天的大交通】给的 s 为准，别把 ${p.goTime} 写成发车时间。` : ''}` : ''}
8. ${isLast ? `最后一天：以回到${p.origin || '出发地'}结束——大交通到达站**之后**必须再写一条「从车站返回${p.origin || '出发地'}」（endLocation=${p.origin || '出发地'}，transportType=car），到家为止才算闭环。${p.backTime ? `**${p.backTime} 是回到${p.origin || '出发地'}的时刻（到家时刻，不是发车也不是到站）**：大交通到达时刻要为此留出市内返家接驳时间（约 40 分钟），发车/起飞时刻往前倒推。` : ''}` : ''}
9. category 取值：景点游览=sight，餐饮=food，住宿/回酒店=hotel，交通=transport，门票预订/取票=ticket，其他=other。
10. 输出顺序按时间先后。只输出数组，不要任何解释。
11. **【今天的大交通】是既定路线**：交通方式、车次、出发站/到达站照抄，不许改成别的交通方式、不许编造新车次。
    - 大交通条目必须排在它**真实被乘坐的时刻位置**（15:00 的车就写在 15:00 前后的时段），严禁为了"衔接顺"把它提前写成"倒叙/桥接/预告"。
    - ${((isFirst && p.goTime) || (isLast && p.backTime))
      ? '起止时刻是**用户指定的硬约束**，必须原样照抄，不许微调（首日照抄发车时刻、末日照抄到达时刻，用户指定的启程/到家时刻用来安排前后接驳）。'
      : '大纲里的起止时刻只是**粗排参考**：若你确知该车次实际时刻与之不符、或与今天其他安排衔接不上，就按实际/合理的时刻微调，前后条目跟着顺移，保证全天时间线首尾相接；'}
    - 时刻要调就**静默地调**，绝不允许在 activity / note 里解释、质疑、论证冲突（"鉴于…必须原样执行…""此为错误约束""修正…"这类字样一概不许出现）——用户看不见你的思考过程，只看得见行程。
    - 写的是 train/高铁/动车 → 按火车站流程安排（提前 45 分钟到站、安检、候车、上车），全程不得出现"机场""航站楼""航班""值机"等字样，transportType 填 train。
    - 写的是 plane/航班 → 按机场流程安排（提前 2 小时到机场），transportType 填 plane。不要自作主张把火车改飞机、把飞机改火车；即便你觉得另一种方式更快也不行，这是用户的选择。
${/高铁|动车/.test(p.transport) ? '12. 用户交通偏好是「高铁/动车优先」：后续所有城际段一律按高铁或动车安排（优先高铁，没有合适高铁就走动车/城际），不要生成任何航班。' : ''}
13. **activity 里只写"要做什么"，禁止写你的推理过程**：不要出现"注：根据大纲…""此处假设…""若用户…""我无法/我需要"这类自我纠错或向我的解释。这段文字会原样显示在用户的行程里，写了就很难看。
14. **住宿闭环（铁律）**：昨晚住哪，今天第 1 条就从哪出发——${prev ? `昨晚住「${prev.overnight || prev.city}」，第 1 条应写成"从该酒店出发"，startLocation 填它` : '今天从出发地启程'}；当天最后 1 条必须是"回到${day.overnight || day.city}住宿地休息"（category=hotel，endLocation 填住宿地）。绝不允许昨晚住 A 今早却凭空从 B 出发、或晚上收在 C 但住宿地是 D。${sameBase ? '当晚回同一家酒店时，早上可加一条"大件行李留在房间/寄存前台，轻装出发"（note 写明回来续住）。' : '**今晚不回昨晚这家酒店，行李必须随身走**（见第 16 条）。'}
15. **地点名要用地图搜得到的通用叫法**：startLocation / endLocation 只写地点真名，别自造"XX公园""XX景区大门"这种后缀（"象鼻山"不要写成"象鼻山公园"——地图上真有另一个"象鼻山公园"在别的省，导航会导错）；也不要带括号补注、不要写"附近/周边"这类模糊词。车站写标准站名（如"桂林北站""南宁东站"）。` +
    `\n16. **行李处理（铁律，为游客方便着想，必须落实到今天的行程条目里）**：昨晚「${lastNight || '出发地'}」→ 今晚「${tonight || '返程'}」——${sameBase
      ? '**今晚回同一家酒店**：大件行李留在房间或寄存在前台，轻装出门，晚上回来续住同一家。'
      : `**今晚不回昨晚那家酒店，行李必须随身走**：\n    - 早上写一条"退房，携带全部行李出发"；**禁止写"把大件行李寄存在${lastNight || '酒店'}前台"**——今晚不回来取，寄存等于逼游客折返取件。\n    - ${isLast
        ? '返程日行李全程随身；需要轻装时用车站/机场的寄存柜，上车前记得取回。'
        : `抵达「${tonight}」后**先到当晚酒店放行李**（写一条"到酒店放行李、轻装出门"，category=hotel），再出去游玩。`}`
    }\n    - 带着行李游玩时：写一条"在游客中心/寄存柜寄存行李"，并在**离开景区前往下一站的那一条**的 note 里写明"取回寄存的行李，别落下"。
17. **白天不许回酒店睡觉**：15:00 前禁止安排"回酒店休息/午休/回房间"（仅换住处当天的"到酒店放行李/办理入住"除外）。游客白天在外面玩，想歇脚就写景区内的茶座/长椅/观光车，回酒店只属于晚上。
18. **市内/短途交通按用户预算「${p.budget}」选型（用户预算和偏好优先于个人习惯）**：
    - 「经济」：3km 内直接步行（transportType=walk）；3km 以上优先地铁/公交（transportType=ride，activity 写清"乘地铁X号线/公交X路 从A到B站"，note 写票价与末班车）；只有轨道交通覆盖不到的路段才打车。
    - 「舒适」：地铁优先；跨区 2~6km、赶时间（赶车/赶预约）、携带行李或 22 点以后才打车（transportType=car）。
    - 「品质」：以打车为主（car），地铁只在明显更快时用。
    - 打车条目在 note 里写预估车费（如"打车约 15-20 元"）；地铁/公交条目在 note 里写票价。带行李换乘时优先打车，别让游客拖着箱子挤地铁。
    - **【今天的大交通】到达后的市内接驳同样按上面的预算基调选型**；到站离目的地很近时直接写"出站步行前往"（walk），不要动不动就打车。
19. **别重复排已安排过的内容**：对照大纲其他天的 hl/ml——今天不要再安排其他天已经玩过的具体景点（同一景点整个行程只玩一次），也不要和其他天吃同一家店；同一类体验（火锅/烧烤等同类的饭、古镇老街/博物馆/夜市等同类的玩法）全程最多 2 次，今天尽量给出和别的天不一样的花样。`;

  return [
    { role: 'system', content: SYS_PROMPT },
    { role: 'user', content: block + rules },
  ];
}

/**
 * 逐天细化：分批并行 + 时间预算，撞上限就返回已完成的部分（续跑模式）
 *
 * 为什么要分批：8 天一次性并行要 35~40s，遇到慢模型随时撞上云函数 60s 上限，
 * 一撞就前功尽弃。改成"每批 N 天、跑完一批看一眼剩余时间"，时间不够就先把
 * 已经生成好的天交回去（partial=true），前端静默再调一次接着生成剩下几天。
 * 用户全程只看到"正在细化…"，感觉不到中间断过。
 *
 * ⚠️ 失败的天必须重试，不能静默丢弃：
 *    之前 failed 的天被排除在 stillTodo 之外，导致 partial=false、整轮直接结束，
 *    用户只能事后发现"行程少了第 3 天"，而且云函数日志之外没有任何提示。
 *    现在失败天重新进队列（同一天最多 MAX_RETRY 次），耗尽才放弃，
 *    并把 gaveUpDayIndexes 交回前端明确提示。
 *
 * @param {object} p 归一化输入
 * @param {object} outline 大纲
 * @param {object} opts { doneDayIndexes: 已完成的天（续跑时跳过）,
 *                        attempts: { [dayIndex]: 已尝试次数 }（续跑时回传，避免无限重试）,
 *                        deadline: 本次调用的截止时间戳 }
 */
const MAX_DAY_RETRY = 3;

async function genDayItems(p, outline, opts = {}) {
  const days = outline.days;
  const done = new Set(asArray(opts.doneDayIndexes).map(Number));
  const attempts = Object.assign({}, opts.attempts || {});
  // 只排队"没完成 且 还没试满"的天：失败的天会再排进来重试一次
  const pending = days.map((_, i) => i)
    .filter((i) => !done.has(i) && (attempts[i] || 0) < MAX_DAY_RETRY);
  const deadline = opts.deadline || (Date.now() + 40 * 1000);
  // 一批最多 3 天（并行一次约 20-33s，视模型快慢）；剩余时间不够时自动缩批到
  // 2 天/1 天 —— 固定 3 天一批时，预算只剩 20s 就整批放弃，实测返程日因此
  // 整天空掉，兜底只剩"17:40 高铁 + 17:00 吃早餐"。
  const WAVE = 3;
  const FIRST_PER_DAY_ESTIMATE = 8500;   // 首轮按单天 ~8.5s 估

  const items = [];
  const finished = [];
  const failed = [];
  let lastCost = 0;
  let prevWave = WAVE;

  for (let k = 0; k < pending.length;) {
    // 批大小自适应：剩余时间充裕一次 3 天，紧张就缩批，尽量别浪费预算
    const rem = deadline - Date.now();
    const wave = Math.max(1, Math.min(WAVE, pending.length - k,
      rem > 50 * 1000 ? 3 : rem > 26 * 1000 ? 2 : 1));
    const batch = pending.slice(k, k + wave);
    // 单天耗时估算：首轮用默认值，之后按上一批均摊 ×1.2（单天封顶 15s）
    const perDay = lastCost
      ? Math.min(Math.ceil((lastCost / prevWave) * 1.2), 15 * 1000)
      : FIRST_PER_DAY_ESTIMATE;
    const estimate = perDay * batch.length;
    if (Date.now() + estimate > deadline) {
      console.log('[generatePlan] 时间预算不足，停止在已完成部分（续跑）: 已完成=%d 剩余=%d',
        finished.length, pending.length - finished.length - failed.length);
      break;
    }
    const waveStart = Date.now();
    const rs = await Promise.all(batch.map((idx) =>
      // 把本轮 deadline 传进去：单次超时会按剩余时间收敛，重试也会先问时间够不够
      // 这里同样不设 max_tokens：一天 10~15 条细化的正常输出就接近 3000 token，
      // 封顶会让当天的后半段（晚餐 + 夜间 + 回酒店）凭空消失
      llm.chatWithRetry(dayDetailPrompt(p, days[idx], idx, outline), { deadline })
        .then((t) => ({ i: idx, items: asArray(parseJSONFromText(t)) }))
        .catch((e) => ({ i: idx, error: e.message }))
    ));
    lastCost = Date.now() - waveStart;
    rs.forEach((r) => {
      if (r.error || !r.items.length) {
        failed.push(r.i);
        attempts[r.i] = (attempts[r.i] || 0) + 1;   // 记一次失败，续跑时才知道还能不能再试
        console.error(`[generatePlan] 第${r.i + 1}天细化失败（第${attempts[r.i]}次）:`,
          r.error || 'LLM 返回了空数组');
        return;
      }
      r.items.forEach((it) => {
        if (!it || !String(it.activity || '').trim()) return;
        items.push(Object.assign({}, it, { dayIndex: r.i })); // dayIndex 由代码强制写入，不信任 LLM
      });
      // 住宿闭环兜底：LLM 偶尔忘了把"昨晚住宿"写成第一条的起点。
      // 这里做确定性修补：当天第一条的 startLocation 为空 → 补昨晚住宿地；
      // 当天最后一条的 endLocation 为空且 category=hotel → 补今晚住宿地。
      const prevOv = r.i > 0 ? (days[r.i - 1].overnight || days[r.i - 1].city || '') : '';
      const tonightOv = days[r.i].overnight || days[r.i].city || '';
      const dayItems = items.filter((it) => it.dayIndex === r.i);
      if (dayItems.length) {
        const first = dayItems[0];
        if (!String(first.startLocation || '').trim() && prevOv) first.startLocation = prevOv;
        const last = dayItems[dayItems.length - 1];
        if (last.category === 'hotel' && !String(last.endLocation || '').trim() && tonightOv) {
          last.endLocation = tonightOv;
        }
      }
      finished.push(r.i);
    });
    k += wave;
    prevWave = wave;
  }

  const doneAll = Array.from(done).concat(finished);
  // 还要再跑的天 = 没完成 且 还有重试机会；试满 3 次的进 gaveUp，不再占用后续轮次
  // 注意用 doneAll（含本轮刚成功的天）排除，否则本轮成功的天会被误判成"待续"
  const stillTodo = days.map((_, i) => i)
    .filter((i) => !doneAll.includes(i) && (attempts[i] || 0) < MAX_DAY_RETRY);
  const gaveUp = days.map((_, i) => i)
    .filter((i) => !doneAll.includes(i) && (attempts[i] || 0) >= MAX_DAY_RETRY);

  if (!items.length && !stillTodo.length && !done.size) {
    throw new Error('逐天细化全部失败，未能生成任何行程项');
  }

  console.log('[generatePlan] 本轮：完成=%d 失败=%d 放弃=%d 待续=%d',
    finished.length, failed.length, gaveUp.length, stillTodo.length);

  return {
    items,                       // 本次新生成的条目（续跑时只含剩余天）
    doneDayIndexes: doneAll,     // 已完成（含之前轮次）
    failedDayIndexes: failed,    // 本轮失败的天（还有重试机会）
    gaveUpDayIndexes: gaveUp,    // 重试耗尽、彻底放弃的天 → 前端要提示用户
    attempts,                    // 回传尝试次数，前端原样带回下一轮
    partial: stillTodo.length > 0,  // 还有没生成的天 → 前端继续调
  };
}

// ============================================================
// ③ 闹钟：LLM 提名 + 代码算时间
// ============================================================

// 中国铁路 12306 互联网售票预售期为 15 天（含乘车当日）
// 参考真实案例：9月30日的车 → 9月16日开票（相差 14 天）
const TRAIN_PRESALE_DAYS = 14;
// 热门景区门票常规提前预约天数
const TICKET_PRESALE_DAYS = 7;

/**
 * 把 LLM 提名的闹钟做时间与合法性校验（铁律：不能全信 LLM）
 * @returns {Array} 通过校验的闹钟原始对象
 */
function sanitizeAlarmCandidates(list, p) {
  const now = Date.now();
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const out = [];
  const seen = new Set();

  asArray(list).forEach((a) => {
    const title = String((a && a.title) || '').trim();
    if (!title) return;
    const ts = parseCnTime(a.fireAt);
    // ① 时间必须解析得出来 ② 不能是已经过去的时刻 ③ 不能晚于行程结束后一天
    if (!ts || isNaN(ts) || ts < now || ts > tripEndTs + DAY_MS) return;
    const key = ts + '|' + title.replace(/\s+/g, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      title: title.slice(0, 100),
      note: String(a.note || '').slice(0, 200),
      fireAt: ts,
      fireAtStr: tsToCnDateTimeStr(ts),
      type: ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'].includes(a.type) ? a.type : 'other',
      source: 'ai',
    });
  });
  return out;
}

/**
 * 规则闹钟工厂：统一处理"算出的开票日已过去 → 降级成近期提醒"，
 * 供 buildFallbackAlarms（底线闹钟）和 backfillMissingAlarms（查漏补齐）共用。
 */
function makeRuleAlarmPusher(list, tripStartTs, tripEndTs) {
  let overdueCount = 0; // 已经过了开票日的条数：错开提醒时间，别一堆闹钟挤在同一分钟
  const nowMs = () => Date.now();
  return function push(title, dateStr, timeStr, type, note) {
    let ts = parseCnTime(`${dateStr}T${timeStr}:00`);
    if (!ts || isNaN(ts)) return;
    let finalNote = note || '';
    if (ts < nowMs()) {
      // 算出来的开票日已经过去了：行程还没出发的话，降级成"赶紧去看"的近期提醒
      // （用户多半是临时才规划，这一步能救回大量"本该早就抢票"的场景）
      if (tripEndTs < nowMs()) return;          // 行程都结束了，不再打扰
      if (tripStartTs < nowMs() - DAY_MS) return; // 出发超过一天 → 购票窗口已过
      overdueCount += 1;
      ts = nowMs() + (1 + overdueCount) * 3600 * 1000;
      // 半夜别打扰：降级提醒落在 22:00~08:00 的推到早上 9 点（同一时刻扎堆由后续错峰逻辑处理）
      const h = new Date(ts).getHours();
      if (h >= 22 || h < 8) {
        const d9 = new Date(ts);
        d9.setHours(9, 0, 0, 0);
        if (h >= 22) d9.setDate(d9.getDate() + 1);
        ts = d9.getTime();
      }
      finalNote = `按常规 ${dateStr} 就该开票/预订了，现在已经进入抢票期：${finalNote}`;
    }
    list.push({
      title: title.slice(0, 100),
      note: finalNote,
      fireAt: ts,
      fireAtStr: tsToCnDateTimeStr(ts),
      type,
      source: 'ai-rule',
    });
  };
}

/**
 * 代码兜底：无论如何都要有的几条硬闹钟
 *   · 去程/返程火车票开票日（12306 提前 15 天含当日 → T-14）
 *   · 酒店：出发前 7 天锁定可免费取消房型
 *   · 热门景区门票：提前 N 天开始预约
 * 只有当这些日期还没过去时才生成。
 */
function buildFallbackAlarms(p, outline) {
  const now = Date.now();
  const list = [];
  const tripStartTs = parseCnTime(`${p.startDate}T00:00:00`);
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const push = makeRuleAlarmPusher(list, tripStartTs, tripEndTs);

  // 1. 大交通：找第一天和最后一天里的火车/飞机班次
  // LLM 可能写 "train" 也可能写 "高铁"/"动车"，两边都要认，否则会被误判成机票（提前 30 天）
  const firstDay = outline.days[0] || {};
  const lastDay = outline.days[outline.days.length - 1] || {};
  const modeRaw = (m) => `${m.mode || ''}${m.code || ''}`.toLowerCase();
  const railMove = (day) => asArray(day.moves).find((m) => /train|plane|高铁|动车|火车|航班|飞机/.test(modeRaw(m)));
  const isTrainMove = (m) => !/plane|航班|飞机/.test(modeRaw(m));
  const go = railMove(firstDay);
  const back = railMove(lastDay);

  if (go) {
    const isTrain = isTrainMove(go);
    const before = isTrain ? TRAIN_PRESALE_DAYS : 30; // 机票通常提前 30 天以上关注
    const d = shiftDate(firstDay.date, -before);
    push(
      `${isTrain ? '开抢去程火车票' : '关注去程机票'}：${go.from || ''}→${go.to || ''}${go.code ? '（参考车次 ' + go.code + '）' : ''}`,
      d, '09:00', isTrain ? 'train' : 'plane',
      `按${isTrain ? '12306 提前 15 天预售（含当日）' : '航司常见提前 30 天放票'}推算：${d} 开票。各站/各航司具体放票时刻不同，请在 App 内设置起售提醒并提前录入乘客信息。`
    );
  }
  if (back && outline.days.length > 1) {
    const isTrain = isTrainMove(back);
    const before = isTrain ? TRAIN_PRESALE_DAYS : 30;
    const d = shiftDate(lastDay.date, -before);
    push(
      `${isTrain ? '开抢返程火车票' : '关注返程机票'}：${back.from || ''}→${back.to || ''}${back.code ? '（参考车次 ' + back.code + '）' : ''}`,
      d, '09:00', isTrain ? 'train' : 'plane',
      `返程${lastDay.date}的${isTrain ? '火车票' : '机票'}，按提前 ${before + 1} 天（含当日）推算 ${d} 开票。长假返程务必当天卡点抢。`
    );
  }

  // 2. 酒店：出发前 7 天晚 8 点
  const hotelNight = outline.nights && outline.nights.length ? String(outline.nights[0].city || '') : String(firstDay.city || '');
  push(
    `预订${hotelNight || '目的地'}住宿（可免费取消房型）`,
    shiftDate(p.startDate, -7), '20:00', 'hotel',
    '长假房源紧张且价格波动大，优先选可免费取消房型先锁价，行程确定后再比价调整。'
  );

  // 3. 门票：挑一个最像"需要预约"的景点（有景区/瀑布/竹筏等特征词的优先）
  const TICKET_HINT = /景区|瀑布|梯田|竹筏|游船|漓江|岩洞|古镇|古镇|森林公园|国家公园|博物馆|观景台|漂流|温泉|号$|寨$/;
  const allHighlights = [];
  outline.days.forEach((d, i) => {
    if (i === outline.days.length - 1) return; // 返程日的景点不值得预约
    asArray(d.highlights).forEach((h) => h && allHighlights.push(String(h)));
  });
  // 门票：最多盯 3 个最像"需要预约"的景点，别只给一条
  const hotSpots = allHighlights.filter((h) => TICKET_HINT.test(h)).slice(0, 3);
  const spots = hotSpots.length ? hotSpots : allHighlights.slice(0, 1);
  spots.forEach((s, i) => {
    push(
      `开始盯${String(s).slice(0, 20)}门票/预约放票`,
      shiftDate(p.startDate, -TICKET_PRESALE_DAYS + i), '09:00', 'ticket',
      '热门景区多提前 1-7 天限额放票，假期需每天查看余票公告，具体规则以景区官方通知为准，下单前请核对。'
    );
  });

  // 4. 包车/租车：用户选了自驾或包车时，提前 7 天定车
  if (/自驾|包车/.test(p.transport)) {
    push(
      '预订包车/租车（含保险与取还车点）',
      shiftDate(p.startDate, -7), '10:00', 'other',
      '长假车辆紧张，提前锁定车型与取还车网点，确认是否支持异地还车，下单前请核对。'
    );
  }

  // 5. 行前准备：证件 / 订单 / 装备核对（行程前 2 天）
  push(
    '核对证件、订单与装备清单',
    shiftDate(p.startDate, -2), '20:00', 'other',
    '把车票/门票/酒店订单、身份证、充电宝与药品逐项过一遍，缺的当晚补齐。'
  );

  return list;
}

/**
 * 查漏补齐：LLM 提名经常"只挑重点"，导致某段城际车票或某一晚酒店漏掉。
 * 这里对着大纲逐项清点：每段城际交通（按乘车日-预售期无同类型闹钟 → 补开票提醒）、
 * 每一晚住宿（无 hotel 闹钟 → 补预订提醒），确定性补齐，用户才不用逐条手工加。
 */
function backfillMissingAlarms(p, outline, nominated) {
  const list = [];
  const tripStartTs = parseCnTime(`${p.startDate}T00:00:00`);
  const tripEndTs = parseCnTime(`${p.endDate}T23:59:00`);
  const push = makeRuleAlarmPusher(list, tripStartTs, tripEndTs);
  const dayKey = (ts) => tsToDateStr(ts);

  const days = asArray(outline.days);

  // ① 城际交通段：每一段（train/plane/bus）都该有一条"开抢"提醒
  days.forEach((d) => {
    asArray(d.moves).forEach((m) => {
      const mode = String(m.mode || '').toLowerCase();
      const isTrain = /train|高铁|动车|火车/.test(mode + (m.code || ''));
      const isPlane = /plane|航班|飞机/.test(mode + (m.code || ''));
      if (!isTrain && !isPlane && !/bus|大巴|直通/.test(mode)) return;
      const type = isTrain ? 'train' : isPlane ? 'plane' : 'bus';
      const presale = isTrain ? TRAIN_PRESALE_DAYS : isPlane ? 30 : 5;
      const buyDate = shiftDate(d.date, -presale);
      // 该乘车日前后 1 天内已有同类型闹钟 → 视为已覆盖
      const covered = nominated.some((a) => a.type === type
        && Math.abs(parseCnTime(`${dayKey(a.fireAt)}T00:00:00`) - parseCnTime(`${buyDate}T00:00:00`)) <= DAY_MS);
      if (covered) return;
      push(
        `开抢${d.date} ${m.from || ''}→${m.to || ''}${m.code ? '（参考 ' + m.code + '）' : ''}票`,
        buyDate, '09:00', type,
        `这段城际交通（第${days.indexOf(d) + 1}天）AI 提名时漏了，按预售期自动补上。具体放票时间以官方 App 为准。`
      );
    });
  });

  // ② 住宿：每一晚（含同一酒店连住）都该有一条预订提醒
  const nights = asArray(outline.nights).length ? asArray(outline.nights)
    : days.slice(0, Math.max(0, days.length - 1)).map((d) => ({ d: d.date, c: d.overnight || d.city }));
  nights.forEach((n, i) => {
    const nightDate = validDate(n.d) ? n.d : days[i] && days[i].date;
    if (!nightDate) return;
    const bookDate = shiftDate(nightDate, -7);
    const covered = nominated.some((a) => a.type === 'hotel'
      && Math.abs(parseCnTime(`${dayKey(a.fireAt)}T00:00:00`) - parseCnTime(`${bookDate}T00:00:00`)) <= 2 * DAY_MS);
    if (covered) return;
    push(
      `预订 ${nightDate} ${n.c || ''}住宿（可免费取消房型）`,
      bookDate, '20:00', 'hotel',
      'AI 提名时漏了这一晚，按出发前 7 天自动补上。长假房源紧张，先锁可免费取消房型。'
    );
  });

  return list;
}

/**
 * 时间不够让 LLM 提名时的底线闹钟：硬规则 + 查漏补齐（都是确定性的，不调 LLM）
 * 顺序有讲究：先 buildFallbackAlarms 铺底线，再让 backfillMissingAlarms 对着它查漏，
 * 这样"每段城际票 + 每晚住宿"都能补上，不会退化成只有 1 条酒店提醒。
 */
function fallbackAlarms(p, outline) {
  const base = buildFallbackAlarms(p, outline);
  return base.concat(backfillMissingAlarms(p, outline, base));
}

async function genAlarms(p, outline, deadline) {
  const lines = outline.days.map((d, i) => {
    const mv = asArray(d.moves).map((m) => `${m.mode || ''}${m.code ? ' ' + m.code : ''} ${m.from || ''}→${m.to || ''} ${m.startTime || ''}${m.endTime ? '-' + m.endTime : ''}`).join('；');
    return `第${i + 1}天 ${d.date}｜${d.theme}｜住${d.overnight || d.city}${mv ? '｜交通：' + mv : ''}`;
  }).join('\n');

  const prompt = `一份${p.days}天行程（${p.startDate} ~ ${p.endDate}）的「待办日历」。今天按北京时间计算。

【行程】
${lines}

【旅行需求】${profileText(p)}

请**穷举**这份行程里所有需要提前预订、抢购、预约或提前准备的事项，输出 JSON 数组，每个元素：
{"title":"...","fireAt":"YYYY-MM-DD HH:mm","type":"train/plane/bus/ticket/hotel/other","note":"..."}

# 必须覆盖的类别（漏了要补）
1. 大交通票：去程/返程火车票（type=train）、机票（plane）、长途汽车票/直通车票（bus）。
2. 行程内每一段城际交通：跨城高铁、城际大巴、轮渡、包车/租车（对应 train/bus/other）。
3. 酒店：行程涉及的每一晚住宿都要单独一条（type=hotel），注明城市和日期。
4. 门票/预约：每一个需要实名预约、限量放票或分时段入园的景区/项目（type=ticket）。
5. 体验项目：竹筏/游船/漂流/潜水/温泉/跟拍/演出等需提前预订的项目（type=ticket 或 other）。
6. 行前准备：证件（身份证/护照/签证/边境通行证）、租车驾照、宠物寄养、装备采购、药品、外币/流量卡等（type=other），按"出发前 N 天"排。

# 时间推算规则（按中国各平台实际能查到的开放时间）
- 火车票 12306 预售期 15 天（含乘车当日）：乘车日减 14 天 = 开票日，时刻取 09:00（各站起售时刻不同）。
- 机票：普遍提前 30 天以上放票/开卖，取 30 天前的 10:00 开始关注。
- 长途汽车票/直通车：一般提前 3-7 天开售，取 5 天前的 09:00。
- 酒店：出发前 7 天 20:00 锁定可免费取消房型（长假再提前 3 天复查一次价格）。
- 景区门票：按国内主流 OTA/景区公众号，普遍提前 1-7 天放票，热门景区取 7 天前 09:00 开始盯。
- 行前准备类：证件/装备取出发前 3-5 天，值机/选座取出发前 1 天。

# 输出要求
0. **先在心里点数，再逐一输出**：城际交通共几段（含去程/返程/行程内中转）、住宿共几晚、需要门票/预约的点有几个——每一段/每一晚/每一个都要有对应条目，一个都不许少。宁多勿漏，这是硬要求。
1. title 写清楚抢什么、对应哪一天（例："抢去程票：重庆北→桂林西 G2249（9月30日车次）"）。
2. fireAt 必须是**未来的具体日期+时刻**，且**按时间从早到晚排序**。
3. note 里写明推算依据，并以「具体放票/开放时间以官方 App 或景区公告为准，下单前请核对」结尾。
4. 需要"提前进 App 准备"的，另起一条准备闹钟（比正式开抢早 5 分钟）。
5. **拒绝编造**：只用上面的日期推算；算不准宁可不输出，不要输出模糊或已过去的日期。
6. ${p.holiday ? '这是法定长假行程，抢票/预约压力极大，宁多勿漏。' : ''}
7. 同一件事不要重复。只输出数组。`;

  let nominated = [];
  try {
    const text = await llm.chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], deadline ? { deadline } : undefined);   // 20+ 条闹钟很常见，不设上限才能一次写完
    nominated = sanitizeAlarmCandidates(asArray(parseJSONFromText(text)), p);
  } catch (e) {
    console.error('[generatePlan] 闹钟提名失败，只走规则兜底:', e.message);
  }

  // 查漏补齐：LLM 漏提的城际段/酒店晚数，按规则确定性补上（用户别再手工加）
  nominated = nominated.concat(backfillMissingAlarms(p, outline, nominated));

  // 规则兜底补上必需的几条（去重：同一天同类型已有 LLM 提名的就跳过）
  const fallback = buildFallbackAlarms(p, outline);
  const have = new Set(nominated.map((a) => `${tsToDateStr(a.fireAt)}|${a.type}`));
  fallback.forEach((a) => {
    if (!have.has(`${tsToDateStr(a.fireAt)}|${a.type}`)) {
      nominated.push(a);
      have.add(`${tsToDateStr(a.fireAt)}|${a.type}`);
    }
  });

  // 时间扎堆的闹钟（AI 常把一堆酒店预订都定在 20:00）错开 5 分钟，避免同时炸
  const usedTs = new Map();
  const out = [];
  nominated.forEach((a) => {
    let ts = a.fireAt;
    while (usedTs.has(ts)) ts += 5 * 60 * 1000;
    usedTs.set(ts, true);
    if (ts !== a.fireAt) {
      out.push(Object.assign({}, a, {
        fireAt: ts,
        fireAtStr: tsToCnDateTimeStr(ts),
        note: `${a.note ? a.note + ' ' : ''}（与其他提醒同一时刻，已自动错开）`.trim(),
      }));
    } else {
      out.push(a);
    }
  });

  return out;
}

// ============================================================
// ④ 旅行建议
// ============================================================

async function genSuggestions(p, outline, deadline) {
  const brief = outline.days.map((d) => `${d.date} ${d.theme}`).join('\n');
  const prompt = `为以下${p.days}天行程生成旅行建议 JSON 对象：{"weather":"天气与穿着建议","gear":"装备清单","food":"必吃推荐","tips":"注意事项","transport":"交通贴士","budget":"预算参考，纯文本每行一条「项目：金额元」"}。

【旅行需求】${profileText(p)}
【逐日主题】
${brief}

要求：全部简体中文，结合目的地与出行季节给出具体建议（不要正确的废话）。budget 按 ${p.budget} 档、${p.peopleNum} 人估算。只输出对象。`;

  try {
    // 之前设过 1200 / 1800：实测 budget 字段被截成 "bud"（截断抢救把它当成键名），
    // 预算建议整段丢失。现在不设上限，6 段中文建议能一次写完整。
    const text = await llm.chatWithRetry([
      { role: 'system', content: SYS_PROMPT },
      { role: 'user', content: prompt },
    ], deadline ? { deadline } : undefined);
    const obj = parseJSONFromText(text);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.error('[generatePlan] 建议生成失败（不影响主流程）:', e.message);
    return {};
  }
}

// ============================================================
// 主入口
// ============================================================

/**
 * 生成大纲（第一阶段，单独一次云函数调用）
 */
async function generateOutline(rawInput) {
  const p = normalizeInput(rawInput);
  if (!p.dest) throw new Error('请填写目的地');
  const t0 = Date.now();
  const outline = await genOutline(p);
  console.log('[generatePlan] 大纲完成 %dms, 天数=%d', Date.now() - t0, outline.days.length);
  return {
    profile: p,
    outline,
    title: outline.title,
    summary: outline.summary,
    startDate: p.startDate,
    endDate: p.endDate,
    days: p.days,
  };
}

/**
 * 第二阶段：把大纲展开为逐天详情 + 闹钟 + 建议
 * @param {object} rawInput 与第一阶段相同的用户输入
 * @param {object} outlineData 第一阶段返回的 outline（含 days / nights / title / summary）
 */
/**
 * 给 Promise 加硬超时：到点没回来就用兜底值继续，不再干等。
 * （原 Promise 仍在后台跑，但云函数返回后进程会被回收，不影响结果）
 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      console.warn('[generatePlan] 子任务超时，走兜底');
      done(fallback);
    }, Math.max(1000, ms));
    promise.then(done).catch(() => done(fallback));
  });
}

/**
 * 同一天内时间线兜底：LLM 偶尔会排出"上一条 09:00-10:00，下一条 09:30 就开始"
 * 的重叠（真跑 101 条里出过 1 条）。按开始时间排序，重叠的把开始时间顺延到
 * 上一条结束；顺延后结束时间不晚于开始的，至少补 30 分钟，不造零时长条目。
 * 只动时间字段，不改文本。返回按天分组、天内按时间排序的新数组。
 */
function fixDayTimeOverlaps(items) {
  const days = [...new Set(asArray(items).map((it) => Number(it.dayIndex || 0)))].sort((a, b) => a - b);
  const out = [];
  days.forEach((d) => {
    const list = asArray(items).filter((it) => Number(it.dayIndex || 0) === d);
    list.sort((a, b) => String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99')));
    for (let i = 1; i < list.length; i++) {
      const prevEnd = toMin(list[i - 1].endTime);
      const curStart = toMin(list[i].startTime);
      if (prevEnd === null || curStart === null || curStart >= prevEnd) continue;
      console.warn('[generatePlan] 第%d天「%s」%s 早于上一条结束 %s，顺延',
        d + 1, String(list[i].activity || '').slice(0, 20), list[i].startTime, fmtMin(prevEnd));
      list[i].startTime = fmtMin(prevEnd);
      const curEnd = toMin(list[i].endTime);
      if (curEnd !== null && curEnd <= prevEnd) list[i].endTime = fmtMin(prevEnd + 30);
    }
    out.push(...list);
  });
  return out;
}

async function buildPlan(rawInput, outlineData, opts = {}) {
  const p = normalizeInput(rawInput);
  const outline = (outlineData && outlineData.outline) || outlineData || {};
  if (!asArray(outline.days).length) throw new Error('缺少行程大纲，无法展开详情');

  const t1 = Date.now();
  // 时间预算：细化默认 38s；整轮硬上限 55s（云函数 60s，留 5s 给写库和返回）
  // 为什么是 38 而不是 42：这轮结束后还要做地理编码（几十个地址）和写库，
  // 实测最坏一轮细化 47s + 写库就贴着上限了，收紧一点让续跑多一轮更稳。
  const budget = opts.budgetMs || 38 * 1000;
  const hardDeadline = t1 + (opts.hardBudgetMs || 55 * 1000);
  const deadline = t1 + budget;

  // 闹钟 / 建议只依赖大纲，**不需要等细化跑完**。
  // 之前是细化完了才发起，结果最后一轮细化常常吃掉 30s+，留给闹钟只剩几秒，
  // 提名请求直接被超时掐断（实测 21.5s 超时）→ 只能走规则兜底，门票/体验类的
  // 提醒全靠代码补。现在跟细化同时发起，它们能用满整轮的时间预算。
  // 中途返回 partial 时这些 Promise 会被放弃（云函数进程随即回收），不影响结果。
  const sideDeadline = hardDeadline - 4 * 1000;
  const alarmsPromise = genAlarms(p, outline, sideDeadline)
    .catch((e) => { console.error('[generatePlan] 闹钟生成失败:', e.message); return null; });
  const suggPromise = genSuggestions(p, outline, sideDeadline)
    .catch((e) => { console.error('[generatePlan] 建议生成失败:', e.message); return {}; });

  const detail = await genDayItems(p, outline, {
    doneDayIndexes: opts.doneDayIndexes,
    attempts: opts.attempts,     // 上一轮回传的失败次数，决定哪些天还能再试
    deadline,
  });
  const progress = { done: detail.doneDayIndexes.length, total: asArray(outline.days).length };
  console.log('[generatePlan] 细化完成 %dms, 原始条目=%d, partial=%s',
    Date.now() - t1, detail.items.length, detail.partial);

  // 行李规则放在 sanitize 之后：清洗会删条目（可能把"寄存行李"那条删掉，
  // 也可能把提醒取回的那条删掉），删完再看一遍才是最终要展示的结果。
  // 链路顺序（每一步都有存在的理由）：
  //   MovesAlignment  先把大交通拽回大纲既定时刻/车站（后面插接驳要按它算时刻）
  //   DayStartLocation补每天第一条的起点（昨晚住宿地）
  //   OriginAccess    第一天没有"从出发地→车站"接驳就补一条
  //   MorningRoutine  第 2 天起上午没吃饭补早餐（中午后才开始的补午餐）
  //   NoMiddayHotel   白天"回酒店休息/午休"删除（入住/放行李除外）
  //   EveningPlan     非末日 20:30 前就结束的补晚餐/夜逛
  //   fixMealLabels   餐次词按实际时刻纠偏（"早上吃晚饭"）
  //   DayClosure      收尾闭环（用大纲推荐酒店；末日补"回出发地"接驳）
  //   LuggageRules    行李 note 追加
  //   fixDayTimeOverlaps 最后顺延重叠/倒退（插入的条目可能造成重叠）
  // 用平铺变量代替俄罗斯套娃调用，括号错一层就是静默传错参数
  // 细化失败/残缺的天用大纲骨架重建（只在最后一轮做：partial 时剩余天下一轮还会来）
  const skeleton = detail.partial
    ? { items: [], replaced: [] }
    : skeletonForEmptyDays(p, outline, detail.items, detail.doneDayIndexes);
  const baseItems = skeleton.replaced.length
    ? detail.items.filter((it) => !skeleton.replaced.includes(Number(it.dayIndex || 0)))
    : detail.items;
  // 本轮真正产出条目的天：跨天循环的兜底（MovesAlignment/OriginAccess）只处理
  // 这些天，之前轮次已完成的天不许再补（续跑每轮都会写库，重复补=条目翻倍）
  const roundDays = [...new Set(baseItems.concat(skeleton.items)
    .map((it) => Number(it.dayIndex || 0)))];
  let items = enforceMovesAlignment(sanitizeItems(baseItems.concat(skeleton.items)), outline, roundDays);
  items = dedupeTransports(items);
  items = enforceDayStartLocation(items, outline);
  items = enforceOriginAccess(items, p, outline, roundDays);
  items = enforceMorningRoutine(items, outline);
  items = enforceNoMiddayHotel(items, outline);   // 白天不许回酒店睡觉
  items = enforceEveningPlan(items, outline);
  items = fixMealLabels(items, outline);          // 餐次词按实际时刻纠偏（"早上吃晚饭"）
  items = enforceDayClosure(items, outline, p);
  items = enforceLuggageRules(items, outline);
  items = fixDayTimeOverlaps(items);

  // 地理编码消歧要用的每天城市 + 地址→天下标映射。
  // savePlan 的 cityOf 靠它们给高德传 city 参数——之前只消费不生产，
  // cityOf 永远拿不到每天的城市，同名地点照样可能定位到别的省去。
  const dayCities = asArray(outline.days).map((d) => String(d.city || d.overnight || '').trim());
  const addrDay = new Map();
  items.forEach((it) => {
    const di = Number(it.dayIndex || 0);
    if (it.startLocation && !addrDay.has(it.startLocation)) addrDay.set(it.startLocation, di);
    if (it.endLocation && !addrDay.has(it.endLocation)) addrDay.set(it.endLocation, di);
  });

  // 还有天没生成完（撞时间预算）→ 只交回已完成的部分，闹钟/建议留到最后一次生成，
  // 前端拿到 partial=true 会立刻静默再调一次，用户全程只看到"正在细化…"
  if (detail.partial) {
    return {
      title: String((outlineData && outlineData.title) || outline.title || '我的行程').slice(0, 60),
      summary: String((outlineData && outlineData.summary) || outline.summary || '').slice(0, 200),
      startDate: p.startDate,
      endDate: p.endDate,
      items,
      dayCities,
      addrDay,
      partial: true,
      doneDayIndexes: detail.doneDayIndexes,
      attempts: detail.attempts,
      gaveUpDayIndexes: detail.gaveUpDayIndexes,
      progress,
      meta: {
        days: p.days,
        failedDayIndexes: detail.failedDayIndexes,
        gaveUpDayIndexes: detail.gaveUpDayIndexes,
        elapsedMs: Date.now() - t1,
      },
    };
  }

  // 等闹钟/建议收尾（它们是和细化并行跑的，一般细化结束时也差不多了）。
  // 仍然留 5s 给写库；真没回来就降级走规则兜底 —— 总比整个调用超时失败强。
  const remain = hardDeadline - Date.now() - 5 * 1000; // 再留 5s 给写库
  const [a, s] = await Promise.all([
    withTimeout(alarmsPromise, Math.max(1000, remain), null),
    withTimeout(suggPromise, Math.max(1000, remain), null),
  ]);
  // 规则兜底 = 硬底线（去程/返程票、行前准备）+ 查漏补齐（每段城际、每晚住宿）
  const alarms = a || fallbackAlarms(p, outline);
  const suggestions = s || {};
  console.log('[generatePlan] 清洗后条目=%d, 闹钟=%d, 剩余预算=%dms', items.length, alarms.length, remain);

  return {
    title: String((outlineData && outlineData.title) || outline.title || '我的行程').slice(0, 60),
    summary: String((outlineData && outlineData.summary) || outline.summary || '').slice(0, 200),
    startDate: p.startDate,
    endDate: p.endDate,
    items,
    dayCities,
    addrDay,
    alarms: alarms.sort((a, b) => a.fireAt - b.fireAt),  // 待办按时间先后排，用户照着做就行
    suggestions,
    partial: false,
    doneDayIndexes: detail.doneDayIndexes,
    attempts: detail.attempts,
    gaveUpDayIndexes: detail.gaveUpDayIndexes,
    progress,
    meta: {
      days: p.days,
      failedDayIndexes: detail.failedDayIndexes,
      gaveUpDayIndexes: detail.gaveUpDayIndexes,
      elapsedMs: Date.now() - t1,
    },
  };
}

/**
 * 一次性生成（本地测试用；云端请拆成 generateOutline + buildPlan 两次调用，
 * 单次跑完会超过云函数 60s 上限）
 */
async function generate(rawInput) {
  const t0 = Date.now();
  const first = await generateOutline(rawInput);
  const plan = await buildPlan(rawInput, first);
  plan.meta.outlineMs = plan.meta.elapsedMs;
  plan.meta.elapsedMs = Date.now() - t0;
  return plan;
}

module.exports = {
  generate, generateOutline, buildPlan, genDayItems,
  normalizeInput, sanitizeAlarmCandidates, buildFallbackAlarms, fallbackAlarms,
  shiftDate, dayDiff, isHolidayRange,
  parseDestList, missingMustVisit, placeStem, duplicateHighlights,
  applyTripEdgeTimes, enforceDayStartLocation, enforceDayClosure, enforceLuggageRules, enforceMovesAlignment,
  enforceOriginAccess, enforceMorningRoutine, enforceEveningPlan,
  fixMealLabels, enforceNoMiddayHotel, skeletonDayItems, skeletonForEmptyDays,
  transferMinutes, isCarTransfer, detourTransfers, warnDetourTransfers,
  dedupeTransports, transportCodeOf,
  isRealCode, moveActivityText, isScheduledMove,
  fixDayTimeOverlaps, samePlace, toMin, fmtMin,
};
