// cloudfunctions/parseTravelPlan/splitter.js
// 确定性文本预处理：按“X月X日”标题切分行程天数 + 提取预订安排 + 推断年份
// 不依赖 LLM，结果 100% 可控

// 强匹配：攻略常用格式「9月30日｜标题」
const DAY_HEADER_STRONG = /^\s*(\d{1,2})月(\d{1,2})日\s*[｜|：:]\s*(.*)$/;
// 弱匹配：单日/通勤类文档「9月20日工作通勤」——日期开头、后面跟的是标题而非具体行程内容
// (?!\s*[:\d]) 排除「9月20日 7:20起床」这种日期+时间的正文行（含正则回溯场景）
const DAY_HEADER_LOOSE = /^\s*(\d{1,2})月(\d{1,2})日(?!\s*[:\d]).{0,30}$/;
// 范围标题里的第二个日期：「1月1日至1月3日」「10月1日-10月3日」
const DAY_RANGE = /[至到~～—-]\s*(\d{1,2})月(\d{1,2})日/;
// 常见的“预订安排”章节标题：形如 “3. 预订安排”、“三、预订安排”、“预订安排”、“3.5 抢票与预订时间日历”
const BOOKING_HEADER = /^\s*(?:[一二三四五六七八九十\d]+(?:\.\d+)*[.、\s]*)?(预订|抢票|订票)/;

/**
 * 把攻略全文切成 { days: [{month, day, endMonth, endDay, title, lines}], booking: [lines], header: [前置文本] }
 */
function splitDocument(text) {
  const lines = text.split('\n');
  const days = [];
  const booking = [];
  const header = [];
  let cur = null;
  let inBooking = false;

  for (const raw of lines) {
    const line = raw.trim();

    // 进入预订章节
    if (!inBooking && BOOKING_HEADER.test(line)) {
      inBooking = true;
      cur = null;
      continue;
    }

    if (inBooking) {
      // 预订章节里再出现“X月X日｜”天标题 → 回到行程模式（容错处理）
      if (DAY_HEADER_STRONG.test(line)) {
        inBooking = false;
        cur = null;
        // 不 continue，直接落到下面的天标题匹配逻辑
      } else {
        if (line) booking.push(line);
        continue;
      }
    }

    let m = line.match(DAY_HEADER_STRONG);
    let title = m ? m[3] : '';
    if (!m) {
      const loose = line.match(DAY_HEADER_LOOSE);
      if (loose) {
        m = loose;
        title = line;
      }
    }
    if (m) {
      cur = { month: +m[1], day: +m[2], title: line, lines: [] };
      // 范围标题（1月1日至1月3日）记录结束日期
      const rm = line.match(DAY_RANGE);
      if (rm) {
        cur.endMonth = +rm[1];
        cur.endDay = +rm[2];
      }
      days.push(cur);
      continue;
    }
    if (cur && line) cur.lines.push(line);
    else if (!cur && line) header.push(line);
  }
  return { days, booking, header };
}

/**
 * 推断行程年份：以最早出现的月-日为锚点。
 * - 日期在未来 → 今年
 * - 日期刚过去不久（≤ 90 天，如昨天的工作通勤、刚结束的行程） → 仍取今年
 * - 日期过去太久（> 90 天，如 12 月写“3月出行”的计划） → 明年
 */
function inferYear(days) {
  // 服务器是 UTC，"今天"按北京时间（UTC+8）计算，避免凌晨时段差一天
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  if (!days.length) return now.getUTCFullYear();
  const anchorMD = days.reduce((a, b) =>
    a.month * 100 + a.day <= b.month * 100 + b.day ? a : b
  );
  let y = now.getUTCFullYear();
  const anchor = Date.UTC(y, anchorMD.month - 1, anchorMD.day);
  const today0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = (today0 - anchor) / 86400000;
  if (diffDays > 90) y += 1;
  return y;
}

const pad = (n) => (n < 10 ? '0' + n : '' + n);
function ymd(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

module.exports = { splitDocument, inferYear, ymd };
