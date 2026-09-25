// scripts/test-parse-steps.js
// 分步解析（step 模式）的本地单测：只测纯函数与结构，不发真实请求。
//   node scripts/test-parse-steps.js
const ok = (cond, name, extra) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' → ' + (extra === undefined ? '' : JSON.stringify(extra))}`);
  if (!cond) process.exitCode = 1;
};

const { buildDocMeta } = require('../cloudfunctions/parseTravelPlan/docmeta');
const llm = require('../cloudfunctions/parseTravelPlan/llm');

// ---------- docmeta：正常多天文档 ----------
const SAMPLE = [
  '国庆七天广西游',
  '路线概览：',
  '重庆 → 桂林 → 阳朔 → 南宁 → 崇左，全程高铁。',
  '',
  '9月30日｜重庆 → 桂林',
  '07:20 重庆西站集合，乘 G2249（08:11-13:20）前往桂林西站。',
  '14:30 入住锦江都城酒店（桂林两江四湖象山景区店）。',
  '',
  '10月1日｜桂林市区',
  '08:30 象鼻山景区游览 2 小时。',
  '12:00 椿记烧鹅(中山店)吃午饭。',
  '',
  '预订安排',
  '9月16日 11:00 抢 G2249 高铁票',
  '10月1日 门票：象鼻山',
].join('\n');

const meta = buildDocMeta(SAMPLE);
ok(meta.days.length === 2, '两天标题 → 切出 2 天', meta.days.length);
ok(meta.days[0].date === `${meta.year}-09-30`, '第一天日期 09-30', meta.days[0].date);
ok(meta.days[1].date === `${meta.year}-10-01`, '第二天日期 10-01', meta.days[1].date);
ok(meta.startDate === meta.days[0].date && meta.endDate === meta.days[1].date, '起止日期取首末日');
ok(meta.title === '国庆七天广西游', '标题取第一行', meta.title);
ok(/重庆 → 桂林 → 阳朔/.test(meta.summary), '概览取"路线概览"下一行', meta.summary);
ok(meta.days[1].prevText.includes('锦江都城酒店'), '第二天带前一天结尾的上下文（住宿线索）', meta.days[1].prevText.slice(-60));
ok(meta.days[0].prevText === '', '第一天无前文', meta.days[0].prevText);
ok(meta.days.every((d) => d.index === meta.days.indexOf(d)), 'index 与数组下标一致');
ok(meta.booking.some((l) => l.includes('G2249')), '预订章节切出 2 行', meta.booking);
ok(meta.rawHead.startsWith('国庆七天广西游'), 'rawHead 供建议提取');
ok(meta.pseudo === false, '正常文档 pseudo=false');

// ---------- docmeta：无天标题 → 伪单日 ----------
const meta2 = buildDocMeta('随便一篇没有日期标题的游记\n今天去了公园。\n吃了饭。');
ok(meta2.pseudo === true, '无天标题 → 伪单日', meta2.pseudo);
ok(meta2.days.length === 1, '伪单日只有 1 天');
ok(meta2.days[0].lines.length === 3, '伪单日带全文行', meta2.days[0].lines.length);
ok(/^\d{4}-\d{2}-\d{2}$/.test(meta2.days[0].date), '伪单日日期=今天（北京时间）', meta2.days[0].date);

// ---------- docmeta：范围标题（1月1日至1月3日） ----------
const meta3 = buildDocMeta('1月1日至1月3日｜跨年行程\n去冰城看雪。');
ok(meta3.endDate.endsWith('-01-03'), '范围标题的结束日期生效', meta3.endDate);

// ---------- llm.js：分步解析单元齐备 ----------
ok(typeof llm.extractDay === 'function', 'extractDay 导出');
ok(typeof llm.extractAlarms === 'function', 'extractAlarms 导出');
ok(typeof llm.extractSuggestions === 'function', 'extractSuggestions 导出');
ok(typeof llm.asArray === 'function', 'asArray 导出');
ok(llm.STEP_TIMEOUT_MS <= 25 * 1000, '分步单请求超时 ≤25s（25+25 重试仍 <60s）', llm.STEP_TIMEOUT_MS);

// ---------- index.js：step 调度器与共享清洗 ----------
const idx = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/parseTravelPlan/index.js'), 'utf8');
ok(/event\.step/.test(idx) && /handleStep/.test(idx), '主入口有 step 分发');
ok(/function cleanAlarms/.test(idx), '闹钟清洗抽成共享函数（两条链路同款）');
ok(/cleanAlarms\(structured\.alarms, openid, now\)/.test(idx), '单次模式改用共享清洗');
ok(/cleanAlarms\(task\.alarmsRaw, openid, now\)/.test(idx), '分步模式用同一份清洗');

console.log(process.exitCode ? '\n有失败项 ✗' : '\n全部通过 ✓');
