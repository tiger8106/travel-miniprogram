// cloudfunctions/parseTravelPlan/index.js
// 解析上传的 docx 攻略，调用 LLM 生成结构化行程数据

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const mammoth = require('mammoth');
const { callLLM } = require('./llm');
const { geocodeBatch, geocodeOne } = require('./geocode');
const { sanitizeItems } = require('./normalize');

const COL_TRIP = 'trips';
const COL_ALARM = 'ticket_alarms';

// 解析引擎版本：返回给前端展示，用于确认线上跑的是不是最新代码
const PARSE_VERSION = 'v3.6-alarm-fix';

// 日期强校验：只接受合法的 YYYY-MM-DD
// LLM 偶尔会输出 "null"、""、"2026/9/20"、"2026-13-40" 等脏值，一律拒绝
function validDateStr(s) {
  const str = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(+str.slice(0, 4), +str.slice(5, 7) - 1, +str.slice(8, 10));
  // 回读比对：防止 "2026-13-40" 这类值被 Date 自动进位成合法日期
  if (isNaN(d.getTime())) return null;
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const roundTrip = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return roundTrip === str ? str : null;
}

// ⚠️ 云函数服务器时区是 UTC，所有"北京时间"的解析/格式化必须走 cn-time.js，
// 否则会出现 15:15 → 23:15 这类 +8 小时错位、凌晨时间日期差一天等问题
const { parseCnTime, tsToDateStr, tsToCnDateTimeStr } = require('./cn-time');

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  // 子功能：实时地理编码（前端点击地图按钮时，给地点名查经纬度）
  // 复用本函数的环境变量 AMAP_KEY，前端不用重新上传攻略
  if (event && event.action === 'geocode') {
    if (!openid) return { code: -1, msg: '未登录' };
    const location = (event.location || '').trim();
    if (!location) return { code: -1, msg: '缺少 location' };
    try {
      const coord = await geocodeOne(location);
      if (!coord) return { code: -1, msg: '未配置 AMAP_KEY 或未查到该地点' };
      return { code: 0, data: coord };
    } catch (e) {
      return { code: -1, msg: e.message || '地理编码失败' };
    }
  }

  const { fileID } = event || {};

  if (!fileID) {
    return { code: -1, msg: '缺少 fileID' };
  }
  if (!openid) {
    return { code: -1, msg: '未登录' };
  }

  try {
    // 1. 下载 docx
    const dlRes = await cloud.downloadFile({ fileID });
    const buffer = dlRes.fileContent;

    // 2. 用 mammoth 解析成纯文本（保留段落结构）
    const textResult = await mammoth.extractRawText({ buffer });
    const rawText = textResult.value;
    if (!rawText || rawText.length < 20) {
      return { code: -1, msg: '文档内容为空或过短' };
    }

    // 3. 调用 LLM 生成结构化 JSON
    const structured = await callLLM(rawText);
    if (!structured) {
      return { code: -1, msg: 'AI 解析失败' };
    }
    console.log('[parseTravelPlan] 引擎版本:', PARSE_VERSION, '| 文本长度:', rawText.length);
    console.log('[parseTravelPlan] LLM 返回 items 数量:', (structured.items || []).length);
    console.log('[parseTravelPlan] LLM 返回 items[0]:', JSON.stringify(structured.items?.[0] || null));
    console.log('[parseTravelPlan] LLM 返回 alarms:', JSON.stringify(structured.alarms || []));

    // 4. 入库 - 行程
    const db = cloud.database();
    const _ = db.command;
    const now = Date.now();

    // 清洗：字段规范化 + 缺失时间智能回填 + "同点假导航"清除（详见 normalize.js）
    const items = sanitizeItems(structured.items);
    console.log('[parseTravelPlan] 清洗后 items 数量:', items.length);

    // 4.1 地理编码：把地点名转成经纬度（供 wx.openLocation 打开微信原生地图）
    // 未配置 AMAP_KEY 时自动跳过，前端走“复制路线”降级
    try {
      const addrSet = new Set();
      items.forEach((it) => {
        if (it.startLocation) addrSet.add(it.startLocation);
        if (it.endLocation) addrSet.add(it.endLocation);
      });
      const coordMap = await geocodeBatch([...addrSet]);
      if (coordMap.size) {
        items.forEach((it) => {
          const s = coordMap.get(it.startLocation);
          const e = coordMap.get(it.endLocation);
          if (s) { it.startLon = s.lon; it.startLat = s.lat; }
          if (e) { it.endLon = e.lon; it.endLat = e.lat; }
        });
      }
    } catch (e) {
      console.error('[parseTravelPlan] 地理编码失败（不影响主流程）:', e.message);
    }

    // 清洗闹钟：fireAt 统一转成时间戳数字（数据库里不混字符串/数字两种类型，否则排序报错）
    // 同时保存 fireAtStr（北京时间的原始墙面时刻），前端按"用户手机所在时区"重算触发时间
    const validTypes = ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'];
    const alarms = (structured.alarms || [])
      .map((a) => {
        if (!a || !(a.title || '').trim()) return null;
        const ts = typeof a.fireAt === 'number' ? a.fireAt : parseCnTime(a.fireAt);
        if (!ts || isNaN(ts)) return null;
        return {
          _openid: openid,
          title: String(a.title).trim().slice(0, 100),
          note: a.note || '',
          fireAt: ts,
          fireAtStr: tsToCnDateTimeStr(ts),
          type: validTypes.includes(a.type) ? a.type : 'other',
          source: 'parsed',
          createdAt: now,
          updatedAt: now,
        };
      })
      .filter(Boolean);

    // 去重：同一时刻 + 相同标题（忽略空格差异）只保留一条
    const seenAlarm = new Set();
    const dedupAlarms = alarms.filter((a) => {
      const key = a.fireAt + '|' + a.title.replace(/\s+/g, '');
      if (seenAlarm.has(key)) return false;
      seenAlarm.add(key);
      return true;
    });
    alarms.length = 0;
    dedupAlarms.forEach((a) => alarms.push(a));
    console.log('[parseTravelPlan] 清洗后 alarms 数量:', alarms.length);

    // 日期清洗：LLM 返回的脏值（"null"/乱格式）全部拦下，再逐级兜底
    let startDate = validDateStr(structured.startDate);
    let endDate = validDateStr(structured.endDate);
    console.log('[parseTravelPlan] LLM 原始日期:', structured.startDate, '~', structured.endDate, '→ 校验后:', startDate, '~', endDate);

    // 兜底 1：从闹钟的绝对时间反推行程首日
    if (!startDate && alarms.length) {
      const minTs = Math.min.apply(null, alarms.map((a) => a.fireAt));
      startDate = tsToDateStr(minTs);
      console.log('[parseTravelPlan] startDate 从闹钟反推:', startDate);
    }
    // 兜底 2：都没有 → 用今天（单日日程如通勤，通常就是当天/次日）
    if (!startDate) {
      startDate = tsToDateStr(now);
      console.log('[parseTravelPlan] startDate 最终兜底为今天:', startDate);
    }
    // endDate 缺失 → startDate + 最大 dayIndex（行程实际跨的天数）
    if (!endDate || endDate < startDate) {
      const maxDi = items.reduce((m, it) => Math.max(m, it.dayIndex || 0), 0);
      endDate = tsToDateStr(parseCnTime(startDate + 'T00:00:00') + maxDi * 86400000);
      console.log('[parseTravelPlan] endDate 兜底推导:', endDate);
    }

    const tripData = {
      _openid: openid,
      title: structured.title || '我的行程',
      summary: structured.summary || '',
      startDate,
      endDate,
      sourceFileID: fileID,
      items,
      createdAt: now,
      updatedAt: now,
      parseVersion: PARSE_VERSION,
    };

    const addRes = await db.collection(COL_TRIP).add({ data: tripData });
    const tripId = addRes._id;

    // 5. 入库 - 闹钟（已在上文清洗）

    if (alarms.length) {
      // 批量插入，每次最多 20 条
      for (let i = 0; i < alarms.length; i += 20) {
        const batch = alarms.slice(i, i + 20).map((a) =>
          db.collection(COL_ALARM).add({ data: { ...a, tripId } })
        );
        await Promise.all(batch);
      }
    }

    // 6. 入库 - 旅行建议
    if (structured.suggestions) {
      await db.collection('suggestions').add({
        data: {
          _openid: openid,
          tripId,
          weather: structured.suggestions.weather || '',
          gear: structured.suggestions.gear || '',
          food: structured.suggestions.food || '',
          tips: structured.suggestions.tips || '',
          transport: structured.suggestions.transport || '',
          budget: structured.suggestions.budget || '',
          generatedAt: now,
        },
      });
    }

    return {
      code: 0,
      data: {
        tripId,
        title: tripData.title,
        startDate: tripData.startDate,
        endDate: tripData.endDate,
        itemCount: (tripData.items || []).length,
        alarmCount: alarms.length,
        version: PARSE_VERSION,
      },
    };
  } catch (err) {
    console.error('[parseTravelPlan] error:', err);
    return { code: -1, msg: err.message || '解析失败' };
  }
};