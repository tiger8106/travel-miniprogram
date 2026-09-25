// cloudfunctions/parseTravelPlan/docmeta.js
// 确定性文档元信息：切分天、标题、概览、日期、每天的前文上下文——全程不靠 LLM。
// 「单次并行解析」（llm.js）与「分步解析」（index.js 的 step 模式）共用这一份，
// 保证两条链路对同一份文档的理解完全一致（标题/日期/切分结果不会打架）。

const { splitDocument, inferYear, ymd } = require('./splitter');

/**
 * @param {string} rawText 攻略全文
 * @returns {{
 *   title, summary, year, startDate, endDate,
 *   days: [{ index, date, title, lines, prevText }],
 *   booking: string[], rawHead: string, pseudo: boolean
 * }}
 * pseudo=true 表示文档里一个「X月X日」标题都没识别到（如纯日志），
 * 此时整份文档按"今天"的单日处理。
 */
function buildDocMeta(rawText) {
  const split = splitDocument(rawText);
  let days = split.days;
  const { booking, header } = split;
  let pseudo = false;

  // 一个天标题都没有 → 整份文档按"今天"的单日处理
  // （与旧版"单次调用兜底"的日期口径一致：日期由代码生成，不让 LLM 猜）
  if (!days.length) {
    const now = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
    const firstLine = rawText.split('\n').map((l) => l.trim()).find(Boolean) || '我的行程';
    days = [{
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      title: firstLine.slice(0, 40),
      // 伪单日也控制在单次请求吃得下的量（旧版单次调用是 8000 字符）
      lines: rawText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 300),
    }];
    pseudo = true;
  }

  const year = inferYear(days);
  const startDate = ymd(year, days[0].month, days[0].day);
  const last = days[days.length - 1];
  const endDate = (last.endMonth && last.endDay)
    ? ymd(year, last.endMonth, last.endDay)
    : ymd(year, last.month, last.day);

  // 标题取文档第一个非空行（去"1. / 一、"式编号；不能误伤"9月20日xxx"的日期数字）
  const firstLine = (rawText.split('\n').map((l) => l.trim()).find((l) => l) || '我的行程')
    .replace(/^\s*(?:\d+\s*[.、]\s*|[一二三四五六七八九十]+\s*[.、]\s*)/, '')
    .trim();
  const title = firstLine || '我的行程';

  // 概览：优先取"路线概览"行，其次取第一句完整句子
  let summary = '';
  try {
    const hLines = header.map((l) => l.trim()).filter(Boolean);
    const idx = hLines.findIndex((l) => /概览|路线/.test(l) && /[:：]\s*$/.test(l));
    if (idx >= 0 && hLines[idx + 1]) {
      summary = hLines[idx + 1].slice(0, 100);
    }
    if (!summary) {
      const m = hLines.join(' ').replace(/\s+/g, '').match(/概览[:：]([^。]*。)/);
      if (m) summary = m[1].slice(0, 100);
    }
  } catch (e) { /* ignore */ }

  // 每天的日期 + 前文上下文（累积截尾）：让模型知道前一天结束时人在哪
  // （通常是昨晚住宿），否则当天第一条移动会因原文没写出发点而缺失起点。
  const contextLines = [];
  const dayMeta = days.map((d, i) => {
    const date = ymd(year, d.month, d.day);
    const prevText = contextLines.join('\n').replace(/\s+\n/g, '\n').slice(-1200);
    contextLines.push(...d.lines);
    return { index: i, date, title: d.title, lines: d.lines, prevText };
  });

  return {
    title,
    summary,
    year,
    startDate,
    endDate,
    days: dayMeta,
    booking,
    rawHead: rawText.slice(0, 3000),
    pseudo,
  };
}

module.exports = { buildDocMeta };
