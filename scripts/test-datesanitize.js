// 验证 parseTravelPlan/index.js 里的日期清洗逻辑（从源文件抽取函数后执行）
const fs = require('fs');
const path = require('path');
// 必须用 __dirname 定位：写相对路径时，从项目根目录跑（node scripts/test-xxx.js）
// 会去找 <根>/../cloudfunctions，直接 ENOENT 崩掉
const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'cloudfunctions', 'parseTravelPlan', 'index.js'), 'utf8');

// 抽取 validDateStr / tsToDateStr 两个函数体
function extract(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数 ' + name);
  return m[0];
}
eval(extract('validDateStr'));
// tsToDateStr 早就被抽到 cn-time.js 了（index.js 里只剩 require），
// 从源文件里 eval 是找不到的 —— 直接 require 真实模块，测的才是线上跑的那份代码
const { tsToDateStr } = require(
  path.resolve(__dirname, '..', 'cloudfunctions', 'parseTravelPlan', 'cn-time.js'));

const assert = require('assert');

// 脏值全部拒绝
assert.strictEqual(validDateStr('null'), null, '字符串 "null" 应被拒绝');
assert.strictEqual(validDateStr(null), null, 'null 应被拒绝');
assert.strictEqual(validDateStr(''), null, '空串应被拒绝');
assert.strictEqual(validDateStr('2026/9/20'), null, '斜杠格式应被拒绝');
assert.strictEqual(validDateStr('2026-9-2'), null, '缺前导零应被拒绝');
assert.strictEqual(validDateStr('2026-13-40'), null, '非法日期应被拒绝');

// 合法值放行
assert.strictEqual(validDateStr('2026-09-20'), '2026-09-20');
assert.strictEqual(validDateStr('2026-02-29'), null, '2026 不是闰年，2/29 应拒绝');

// 时间戳转日期
const d = new Date(2026, 8, 20).getTime();
assert.strictEqual(tsToDateStr(d), '2026-09-20');

console.log('✅ 日期清洗逻辑 9 项断言全部通过');
