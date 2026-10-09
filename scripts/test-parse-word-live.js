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
const raw = fs.readFileSync(0, 'utf8');
const meta = buildDocMeta(raw);

(async () => {
  const all = [];
  for (const day of meta.days) {
    const items = await extractDay(day);
    assert(items.length > 0, `第 ${day.index + 1} 天没有解析出行程`);
    all.push(...items.map((item) => Object.assign({}, item, { dayIndex: day.index })));
    console.log(`第 ${day.index + 1}/${meta.days.length} 天：${items.length} 条`);
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
  assert(first && /2026-09-30入住、2026-10-01退房/.test(first.note)
    && /2026-10-02入住、2026-10-03退房/.test(first.note)
    && /寄存/.test(first.note), '非连续入住归并，并保留 Word 中的预订注意事项');
  console.log('酒店提醒：' + reminders.map((item) => `${item.title}〔${item.note}〕`).join('；'));
  console.log('每日酒店：' + hotels.map((item) => `${item.dayIndex + 1}日 ${item.endLocation}`).join('；'));
  console.log(`Word「${meta.title}」解析完成：${meta.days.length} 天，${clean.length} 条详细安排`);
})().catch((error) => { console.error('Word 实测失败：', error.message); process.exitCode = 1; });
