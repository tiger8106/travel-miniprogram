// 将 DOCX 提取的正文从 stdin 传入，按上传流程真实调用逐天解析模型。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
env.split(/\r?\n/).forEach((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
});
const { buildDocMeta } = require('../cloudfunctions/parseTravelPlan/docmeta');
const { extractDay } = require('../cloudfunctions/parseTravelPlan/llm');
const { sanitizeItems } = require('../cloudfunctions/parseTravelPlan/normalize');
const { cleanHotelStays } = require('../cloudfunctions/parseTravelPlan/hotel-stays');
const { groupHotelReminders } = require('../cloudfunctions/parseTravelPlan/hotel-reminders');
const { inferAlarms, completeReservationAlarms } = require('../cloudfunctions/parseTravelPlan/alarm-infer');
const raw = fs.readFileSync(0, 'utf8');
const meta = buildDocMeta(raw);

(async () => {
  const all = [];
  const replay = process.argv.includes('--replay') ? process.argv[process.argv.indexOf('--replay') + 1] : '';
  const fingerprint = require('crypto').createHash('sha256').update(raw).digest('hex');
  const checkpoint = replay ? JSON.parse(fs.readFileSync(replay, 'utf8')) : null;
  if (checkpoint) assert.equal(checkpoint.fingerprint, fingerprint, '回放必须来自同一份真实文档');
  for (const day of meta.days) {
    const items = checkpoint ? checkpoint.items.filter((item) => Number(item.dayIndex) === day.index) : await extractDay(day);
    assert(items.length > 0, `第 ${day.index + 1} 天没有解析出行程`);
    all.push(...items.map((item) => Object.assign({}, item, { dayIndex: day.index })));
    console.log(`第 ${day.index + 1}/${meta.days.length} 天：${items.length} 条`);
  }
  if (!replay) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'travel-word-'));
    fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify({ fingerprint, items: all }));
    console.log('真实模型解析快照：' + path.join(dir, 'parsed.json'));
  }
  const clean = cleanHotelStays(sanitizeItems(all), meta.days);
  const covered = new Set(clean.map((item) => Number(item.dayIndex)));
  assert.equal(covered.size, meta.days.length, '清洗后必须覆盖 Word 全部日期');
  const hotels = clean.filter((item) => item.category === 'hotel');
  assert(hotels.every((item) => !item.note && !item.bookingInfo && item.endLocation), '酒店事项只应保留住宿地点');
  assert.equal(hotels.length, meta.days.length - 1, '返程前每晚应有一条住宿，返家当天不补酒店');
  const expected = [
    '梵泊美地酒店（桂林两江四湖象鼻山景区店）', '龙脊别院（西山韶乐店）',
    '梵泊美地酒店（桂林两江四湖象鼻山景区店）', '山水·忆阁酒店（阳朔西街店）',
    '山水·忆阁酒店（阳朔西街店）', '大新明仕酒店',
    '逸喆酒店（南宁朝阳广场地铁站店）',
  ];
  assert.deepStrictEqual(hotels.sort((a, b) => a.dayIndex - b.dayIndex).map((item) => item.endLocation), expected,
    'Word 实测逐晚酒店必须与原文过夜安排一致');
  const reminders = groupHotelReminders([], hotels, meta.startDate, Date.now(), meta.booking);
  assert.equal(reminders.length, 5, '七晚住宿应归并成五个酒店提醒');
  assert(reminders.every((item) => item.title && !item.note.includes(item.title)), '标题只有酒店名，备注不重复名称');
  const first = reminders.find((item) => item.title === expected[0]);
  assert(first && first.note.includes(`${meta.year}-09-30至${meta.year}-10-01`)
    && first.note.includes(`${meta.year}-10-02至${meta.year}-10-03`), '非连续入住归并');
  assert(reminders.some((item) => item.title === expected[3]
    && item.note.includes(`${meta.year}-10-03至${meta.year}-10-05`)), '连续两晚住宿截止到第三天白天退房');
  const alarmContext = { title: meta.title, startDate: meta.startDate, endDate: meta.endDate, items: clean, days: meta.days };
  const inferred = await inferAlarms(alarmContext);
  const alarms = completeReservationAlarms(alarmContext, inferred);
  assert.equal(alarms.filter((alarm) => alarm.type === 'ticket' && /遇龙河/.test(alarm.title)).length, 1,
    '遇龙河只提实际竹筏，不为前往码头再购票');
  assert(!alarms.some((alarm) => alarm.type === 'ticket' && /明仕田园|两江四湖/.test(alarm.ticketPlace || alarm.bookingInfo || alarm.title)),
    '原文田园骑行、湖边散步不补入园收费或预约核验卡');
  const reportDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'travel-word-verified-'));
  fs.writeFileSync(path.join(reportDir, 'result.json'), JSON.stringify({ fingerprint, meta, items: clean, inferred, alarms,
    ticketPolicies: alarmContext.ticketPolicies || [], hotelReminders: reminders }, null, 2));
  console.log('完整解析与提醒验收记录：' + path.join(reportDir, 'result.json'));
  const rawCodes = [...new Set([...raw.matchAll(/\b[GDCZTK]\d{1,5}\b/g)].map((match) => match[0]))];
  for (const day of meta.days) for (const line of day.lines) {
    const code = (String(line).match(/\b[GDCZTK]\d{1,5}\b/) || [])[0];
    const times = String(line).match(/\b\d{1,2}:\d{2}\b/g) || [];
    if (!code || times.length < 2) continue;
    const row = clean.find((item) => Number(item.dayIndex) === day.index && item.transportType === 'train'
      && String(item.activity).includes(code));
    assert(row && row.startTime === times[0] && row.endTime === times[1], `${code}必须保留原文运行时间${times[0]}–${times[1]}`);
  }
  for (const code of rawCodes) assert(alarms.some((alarm) => alarm.type === 'train' && alarm.title.includes(code)), `未提取${code}订票提醒`);
  assert.equal(alarms.filter((alarm) => alarm.type === 'train').length, rawCodes.length, '五段铁路不要重复泛称车票');
  assert.equal(alarms.filter((alarm) => alarm.type === 'ticket' && /漓江|竹江|磨盘山/.test(alarm.title)
    && /游船|游轮|船票/.test(alarm.title)).length, 1, '同一段漓江游船不要重复生成船票');
  assert.equal(alarms.filter((alarm) => alarm.type === 'bus').length, 3, '桂林与金坑两方向专线及明确提前买的德天汽车票必须完整且不重复');
  assert(!alarms.some((alarm) => alarm.type === 'ticket' && /前往德天.*公交车票/.test(alarm.title)), '汽车票不能混入景区门票分类');
  const raftAlarm = alarms.find((alarm) => alarm.type === 'ticket' && /遇龙河/.test(alarm.title));
  assert(raftAlarm && raftAlarm.fireAtStr === `${meta.year}-10-03 20:00`, '原文注明20点买次日筏票，不能退回提前7天9点估计');
  for (const topic of ['游船', '竹筏', '索道|缆车', '龙脊梯田.*门票', '德天']) assert(alarms.some((alarm) => alarm.type === 'ticket'
    && new RegExp(topic).test(alarm.title + alarm.note)), `未提取${topic}门票/体验提醒`);
  assert(!alarms.some((alarm) => alarm.type === 'train' && /电动车|自行车|前往.*码头/.test(alarm.title)), '不能把骑行/码头接驳当火车票');
  assert(!alarms.some((alarm) => alarm.type === 'ticket' && /象鼻山/.test(alarm.title)
    && (alarm.ticketRequired === true || /门票预订|预约购票/.test(alarm.title))), '免费入园不能误提成付费门票，未核实可保留预约核验');
  assert(!alarms.some((alarm) => alarm.type === 'ticket' && /大榕树/.test(alarm.title)), '仅骑行至大榕树附近并未入园，不应催购入园票');
  console.log('票务提醒：' + alarms.filter((alarm) => ['train', 'ticket', 'bus'].includes(alarm.type)).map((alarm) => `${alarm.type}: ${alarm.title}`).join('；'));
  console.log('酒店提醒：' + reminders.map((item) => `${item.title}〔${item.note}〕`).join('；'));
  console.log('每日酒店：' + hotels.map((item) => `${item.dayIndex + 1}日 ${item.endLocation}`).join('；'));
  console.log(`Word「${meta.title}」解析完成：${meta.days.length} 天，${clean.length} 条详细安排`);
})().catch((error) => { console.error('Word 实测失败：', error.message); process.exitCode = 1; });
