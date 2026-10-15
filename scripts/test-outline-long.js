// 真实模型回归：长行程大纲必须完整返回，且保留逐天编辑所需字段。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
env.split(/\r?\n/).forEach((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
});
const { generateOutline } = require('../cloudfunctions/generatePlan/plan');

(async () => {
  const input = {
    origin: '重庆', dest: '成都、都江堰、青城山、毕棚沟、九寨沟、黄龙',
    startDate: '2026-12-31', endDate: '2027-01-09',
    startTime: '08:00', endTime: '20:00',
    party: '情侣出行', people: 2, budget: '经济实惠', pace: '劳逸适中',
    transport: '高铁/动车优先', interests: ['自然山水', '当地美食'],
  };
  const t0 = Date.now();
  const result = await generateOutline(input);
  const days = result.outline.days || [];
  assert.equal(days.length, 10);
  assert.equal(days[0].date, input.startDate);
  assert.equal(days[9].date, input.endDate);
  assert(days.every((day) => day.date && day.city && day.theme && Array.isArray(day.highlights)));
  console.log(`长行程大纲：${days.length} 天，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，首末日期及可编辑字段完整`);
})().catch((error) => { console.error('长行程大纲失败：', error.message); process.exitCode = 1; });
