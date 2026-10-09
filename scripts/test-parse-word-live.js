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
  const clean = sanitizeItems(all);
  const covered = new Set(clean.map((item) => Number(item.dayIndex)));
  assert.equal(covered.size, meta.days.length, '清洗后必须覆盖 Word 全部日期');
  console.log(`Word「${meta.title}」解析完成：${meta.days.length} 天，${clean.length} 条详细安排`);
})().catch((error) => { console.error('Word 实测失败：', error.message); process.exitCode = 1; });
