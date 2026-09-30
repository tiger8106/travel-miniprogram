// cloudfunctions/parseTravelPlan/index.js
// 解析上传的 docx 攻略，调用 LLM 生成结构化行程数据

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const mammoth = require('mammoth');
const { callLLM, extractDay, extractAlarms, extractSuggestions, asArray } = require('./llm');
const { buildDocMeta } = require('./docmeta');
const { geocodeBatch, geocodeOne } = require('./geocode');
const { sanitizeItems } = require('./normalize');
const { inferAlarms, backfillRuleAlarms, INFER_THRESHOLD } = require('./alarm-infer');
// 远程配置（管理后台在线改的 KEY）：见 generatePlan/cloudCfg.js 的说明。
// 本文件那份与其内容一致，改一处要同步三处（check-bindings 有断言盯着）。
const cloudCfg = require('./cloudCfg');

const COL_TRIP = 'trips';
const COL_ALARM = 'ticket_alarms';
const COL_TASK = 'parse_tasks';

// 分步模式里地理编码步的墙钟预算：每步总上限 60s，留 20s 余量给读写库和网络
const GEOCODE_DEADLINE_MS = 35 * 1000;

// 解析引擎版本：返回给前端展示，用于确认线上跑的是不是最新代码
const PARSE_VERSION = 'v4.5-source-date-context';
const DEFAULT_ALARM_LEAD_MINUTES = 5;

function alarmType(type) {
  return ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'].includes(type) ? type : 'other';
}

function alarmKey(a) {
  const date = String(a && (a.fireAtStr || '')).slice(0, 10);
  const title = String((a && a.title) || '提醒').trim().replace(/[\s\u3000]+/g, '');
  return `${alarmType(a && a.type)}|${date}|${title.slice(0, 100)}`;
}

// 上传攻略中的原文或 LLM 结果可能同时写“提前准备”和“到点办理”。
// 它们描述的是同一件事，最终只保留实际办理时刻那一条，由 leadMinutes 统一计算提醒时刻。
function dedupeAlarmRecords(list) {
  const groups = new Map();
  const clean = (value) => String(value || '')
    .replace(/(?:提前\s*\d+\s*分钟|提前准备|准备|即将到点|到点提醒|开抢|预计开售|预计开放预约\/购票|立即查看并(?:预约|购买)|开始盯|关注|查询|预约|购票|购买|预订|抢票|抢)/g, '')
    .replace(/[\s\u3000：:（）()【】\[\]，,；;→⇒>—-]/g, '')
    .trim();
  (list || []).forEach((alarm) => {
    if (!alarm) return;
    const item = Object.assign({}, alarm);
    const date = String(item.fireAtStr || tsToCnDateTimeStr(Number(item.fireAt) || 0)).slice(0, 10);
    const code = String(item.bookingInfo || item.title || '').match(/\b[GDCZTK]\d{1,5}\b/i);
    const identity = item.linkedItemId
      ? `linked|${item.linkedItemId}`
      : `text|${alarmType(item.type)}|${date}|${Number(item.dayIndex || 0)}|${code ? code[0].toUpperCase() : clean(item.bookingInfo || item.title)}`;
    const previous = groups.get(identity);
    if (!previous) {
      groups.set(identity, item);
      return;
    }
    const winner = Number(item.fireAt || 0) >= Number(previous.fireAt || 0) ? item : previous;
    const loser = winner === item ? previous : item;
    winner.note = [winner.note, loser.note]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join('；')
      .slice(0, 500);
    winner.bookingInfo = winner.bookingInfo || loser.bookingInfo || '';
    winner.linkedItemId = winner.linkedItemId || loser.linkedItemId || '';
    groups.set(identity, winner);
  });
  return [...groups.values()];
}

function prepareAlarmRecords(list, openid, tripId, now, preferredLead) {
  return dedupeAlarmRecords(list).map((a) => {
    const fireAt = Number(a.fireAt) || 0;
    const n = Number(preferredLead === undefined ? a.leadMinutes : preferredLead);
    const leadMinutes = isFinite(n) && n > 0 ? Math.max(1, Math.min(60, Math.round(n))) : DEFAULT_ALARM_LEAD_MINUTES;
    const fireAtStr = String(a.fireAtStr || tsToCnDateTimeStr(fireAt));
    return Object.assign({}, a, {
      _openid: openid,
      tripId,
      fireAt,
      fireAtStr,
      leadMinutes,
      remindAt: fireAt - leadMinutes * 60 * 1000,
      completed: a.completed === true,
      completedAt: a.completed === true ? (Number(a.completedAt) || 0) : 0,
      status: a.completed === true ? 'completed' : 'pending',
      alarmKey: a.alarmKey || alarmKey(Object.assign({}, a, { fireAtStr })),
      type: alarmType(a.type),
      source: a.source || 'parsed',
      notified: a.notified === true,
      createdAt: a.createdAt || now,
      updatedAt: now,
    });
  });
}

/**
 * 调额度中心（quota 云函数）。
 * 额度校验/扣减不可用时暂停收费生成，避免静默漏收。
 */
async function quotaCall(openid, data) {
  try {
    const res = await cloud.callFunction({
      name: 'quota',
      data: Object.assign({ openid }, data),
    });
    const result = (res && res.result) || {};
    if (result.code !== 0 && !(data.action === 'check' && [-2, -3].includes(result.code))) {
      throw new Error(result.msg || '额度服务拒绝操作');
    }
    return result;
  } catch (e) {
    console.error('[parseTravelPlan] 额度服务不可用:', e.message);
    throw e;
  }
}

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

// pickCity 现在由 geocode.js 统一提供（那里挑出的城市词还要拿去做结果校验，
// 两边必须是同一套规则，否则"挑的城市"和"校验的城市"可能对不上）
const { pickCity } = require('./geocode');

// 清洗闹钟：fireAt 统一转成时间戳数字（数据库里不混字符串/数字两种类型，否则排序报错）
// 同时保存 fireAtStr（北京时间的原始墙面时刻），前端按"用户手机所在时区"重算触发时间
// 单次模式与分步模式共用（分步在 infer 步调用）
function vagueSourceDate(source, date, type) {
  if (!source) return false;
  const month = Number(date.slice(5, 7)), day = Number(date.slice(8, 10));
  const pattern = new RegExp(`(?:20\\d{2}年)?0?${month}月\\s*0?${day}(?!\\d)日?`, 'g');
  const isRelevant = (text, kind = type) => kind === 'hotel' ? /酒店|民宿|房型|住宿/.test(text)
    : kind === 'train' ? /12306|高铁|动车|车票|[GDCZTK]\d+/i.test(text)
      : kind === 'ticket' ? /门票|游船|竹筏|演出|景区|预约/.test(text)
        : kind === 'bus' ? /巴士|大巴|直通车|客运|汽车票|旅游专线/.test(text)
          : kind === 'plane' ? /机票|航班|航空|飞机/.test(text) : true;
  let vague = false, explicit = false, match;
  while ((match = pattern.exec(source))) {
    const suffix = source.slice(pattern.lastIndex, pattern.lastIndex + 160);
    // 表格可能先写事项、后写预订日期。前后都取相邻上下文，但不能越过上一日期，
    // 否则会用另一行/另一类事项的精确日期替模糊预订窗口背书。
    const before = source.slice(Math.max(0, match.index - 160), match.index).split(/\r?\n/).slice(-4);
    let boundary = -1;
    before.forEach((line, index) => {
      if (/(?:20\d{2}年)?\d{1,2}月\s*\d{1,2}/.test(line)) boundary = index;
    });
    const following = suffix.split(/\n\s*(?:20\d{2}年)?\d{1,2}月\s*\d{1,2}/)[0];
    const otherKind = ['hotel', 'train', 'ticket', 'bus', 'plane'].some((kind) => kind !== type && isRelevant(following, kind));
    if (!isRelevant(following) && (otherKind || !isRelevant(before.slice(boundary + 1).join('\n')))) continue;
    if (/^\s*(?:起|前后|左右|至|～|~|—|–|-|待定)/.test(suffix)) vague = true;
    else explicit = true;
  }
  return vague && !explicit;
}

function cleanAlarms(rawAlarms, openid, now, sourceText = '') {
  const validTypes = ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'];
  const alarms = (rawAlarms || [])
    .map((a) => {
      if (!a || !(a.title || '').trim()) return null;
      const ts = typeof a.fireAt === 'number' ? a.fireAt : parseCnTime(a.fireAt);
      if (!ts || isNaN(ts)) return null;
      const type = validTypes.includes(a.type) ? a.type : 'other';
      if (vagueSourceDate(sourceText, tsToDateStr(ts), type)) return null;
      return {
        _openid: openid,
        title: String(a.title).trim().slice(0, 100),
        note: a.note || '',
        fireAt: ts,
        fireAtStr: tsToCnDateTimeStr(ts),
        type,
        dayIndex: Number(a.dayIndex || 0),
        bookingInfo: String(a.bookingInfo || '').slice(0, 160),
        usageInfo: String(a.usageInfo || '').slice(0, 160),
        linkedItemId: String(a.linkedItemId || ''),
        source: 'parsed',
        createdAt: now,
        updatedAt: now,
      };
    })
    .filter(Boolean);

  // 去重：同一时刻 + 相同标题（忽略空格差异）只保留一条
  const seenAlarm = new Set();
  return dedupeAlarmRecords(alarms.filter((a) => {
    const key = a.fireAt + '|' + a.title.replace(/\s+/g, '');
    if (seenAlarm.has(key)) return false;
    seenAlarm.add(key);
    return true;
  }));
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  // 管理后台在线配置优先于环境变量（失败静默沿用）
  await cloudCfg.apply();

  // 子功能：实时地理编码（前端点击地图按钮时，给地点名查经纬度）
  // 复用本函数的环境变量 AMAP_KEY，前端不用重新上传攻略
  if (event && event.action === 'geocode') {
    if (!openid) return { code: -1, msg: '未登录' };
    const location = (event.location || '').trim();
    if (!location) return { code: -1, msg: '缺少 location' };
    try {
      // event.city：前端传来的大地名（可能是"广西 桂林"整串，也可能是该条自己的城市）。
      // geocodeOne 内部会挑出城市词、并用它校验返回结果——城市对不上宁可不给坐标，
      // 免得把"象鼻山"定位到南昌去。
      const coord = await geocodeOne(location, event.city || '');
      if (!coord) {
        return { code: -1, msg: '没能在该城市内定位到「'
          + String(location).slice(0, 12) + '」，可以复制地名到地图 App 搜索' };
      }
      return { code: 0, data: coord };
    } catch (e) {
      return { code: -1, msg: e.message || '地理编码失败' };
    }
  }

  // ---------- 分步解析模式（step）：把一次 60s 的大调用拆成六步 ----------
  // 背景：云函数同步调用上限就是 60s，调不高。7 天攻略的
  // 「并行 LLM + 覆盖度复查 + 几十个地址的地理编码 + AI 反推待办」任何一环
  // 抖动一下总时长就破 60s，前端只会看到"执行时间超时"。
  // 分步后：前端逐步调用、任务进度存 parse_tasks 集合，每步都远小于 60s，
  // 哪一步失败就从哪一步重试（任务态在库里，天然断点续跑）。
  if (event && event.step) {
    if (!openid) return { code: -1, msg: '未登录' };
    const db = cloud.database();
    try {
      const r = await handleStep(event, { db, openid, now: Date.now() });
      // ⚠️ 前端 callFn 的约定是 { code: 0, data: {...} }——它只 resolve res.result.data。
      // handleStep 各 step 返回的是平铺字段，必须在这里统一包上 data，
      // 否则前端拿到 undefined，报「Cannot read properties of undefined (reading 'taskId')」。
      if (r && r.code === 0) return { code: 0, data: r };
      return r;
    } catch (e) {
      console.error(`[parseTravelPlan] step=${event.step} 失败:`, e.message);
      return { code: -1, msg: e.message || '解析失败', step: event.step };
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
    // 兼容旧版直接解析入口；前端不用它也必须在云端校验，防止直调绕过额度。
    const checked = await quotaCall(openid, { action: 'check', scene: 'parse' });
    if (checked.code === -2) return { code: -2, msg: checked.msg || '次数用完了，买个套餐继续吧', needPay: true };
    if (checked.code === -3) return { code: -3, msg: checked.msg || '暂时无法生成' };
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
    // 未配置 AMAP_KEY 时自动跳过，前端走“复制路线”降级。
    // 带上 LLM 提取的大地名（region）消歧：全国同名地点太多，
    // 不带城市可能把"龙脊梯田""西山"定位到别的省去。
    const region = String(structured.region || '').trim();
    const cityHint = pickCity(region);
    try {
      const addrSet = new Set();
      items.forEach((it) => {
        if (it.startLocation) addrSet.add(it.startLocation);
        if (it.endLocation) addrSet.add(it.endLocation);
      });
      // ⚠️ 传整串 region（「广西 桂林 阳朔 南宁 崇左」），不要只传 pickCity 的
      // 第一个城市词——跨城行程里桂林那天的条目完全可能是「南宁东站」「崇左南站」，
      // 只拿第一个城市词搜索会把后面几站全部定位失败或乱定位（实测踩过）。
      // geocodeOne 内部会把 region 拆成候选城市逐个试。
      const coordMap = await geocodeBatch([...addrSet], region ? () => region : undefined);
      if (coordMap.size) {
        items.forEach((it) => {
          const s = coordMap.get(it.startLocation);
          const e = coordMap.get(it.endLocation);
          if (s) {
            it.startLon = s.lon; it.startLat = s.lat;
            if (s.matchedName && s.matchedName !== it.startLocation) {
              it.startLocation = s.matchedName;   // 回写高德真实 POI 名，搜索/导航不再落空
            }
          }
          if (e) {
            it.endLon = e.lon; it.endLat = e.lat;
            if (e.matchedName && e.matchedName !== it.endLocation) {
              it.endLocation = e.matchedName;
            }
          }
          // 命中的是哪个城市就记哪个（geocodeOne 校验通过时回传），
          // 前端点导航时用它做城市消歧——比整条行程共用一个城市词准得多
          const hitCity = (e && e.city) || (s && s.city) || '';
          if (hitCity) it.city = hitCity;
          else if (cityHint && !it.city) it.city = cityHint;
        });
      } else if (cityHint) {
        // 没查到坐标的老兜底：至少给前端一个行程级城市词
        items.forEach((it) => {
          const to = it.endLocation || it.startLocation;
          if (to && !it.city) it.city = cityHint;
        });
      }
    } catch (e) {
      console.error('[parseTravelPlan] 地理编码失败（不影响主流程）:', e.message);
    }

    const alarms = cleanAlarms(structured.alarms, openid, now, rawText);
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
      region,               // 大地名（省 市）：前端导航实时定位时消歧用，不做展示
      sourceFileID: fileID,
      items,
      createdAt: now,
      updatedAt: now,
      parseVersion: PARSE_VERSION,
    };

    const addRes = await db.collection(COL_TRIP).add({ data: tripData });
    const tripId = addRes._id;

    // 5. 入库 - 闹钟
    //    文档里没写抢票时间（很常见：攻略只写"9月30日 G2249 出发"）→ 用行程反推一份
    //    「什么时候该抢票/预订/准备」的待办清单，别让闹钟页空着
    if (alarms.length < INFER_THRESHOLD) {
      try {
        const inferred = await inferAlarms({
          title: tripData.title,
          startDate,
          endDate,
          items,
        });
        const have = new Set(alarms.map((a) => `${a.fireAt}|${a.title.replace(/\s+/g, '')}`));
        inferred.forEach((a) => {
          const key = `${a.fireAt}|${a.title.replace(/\s+/g, '')}`;
          if (!have.has(key)) { alarms.push(a); have.add(key); }
        });
        alarms.sort((a, b) => a.fireAt - b.fireAt);
        console.log('[parseTravelPlan] 补上 AI 反推待办，闹钟合计 %d 条', alarms.length);
      } catch (e) {
        console.error('[parseTravelPlan] 待办反推异常（不影响主流程）:', e.message);
      }
    }
    const ruleBackfill = backfillRuleAlarms({ startDate, endDate, items }, alarms);
    if (ruleBackfill.length) {
      alarms.push(...ruleBackfill);
      alarms.sort((a, b) => a.fireAt - b.fireAt);
      console.log('[parseTravelPlan] 详细行程规则查漏补齐 %d 条待办', ruleBackfill.length);
    }

    const storedAlarms = prepareAlarmRecords(alarms, openid, tripId, now, event.leadMinutes);
    if (storedAlarms.length) {
      // 批量插入，每次最多 20 条
      for (let i = 0; i < storedAlarms.length; i += 20) {
        const batch = storedAlarms.slice(i, i + 20).map((a) =>
          db.collection(COL_ALARM).add({ data: a })
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

    await quotaCall(openid, { action: 'consume', scene: 'parse', bizKey: `parse:${tripId}`, tripId });
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
// ==================================================================
// 分步解析（step 模式）实现
// 流程：init → day×N → collect → infer → geocode（循环）→ commit
// 每步独立调用、独立计时，任务进度存 parse_tasks，失败从断点重试。
// ==================================================================

async function ensureTaskCollection(db) {
  try {
    await db.createCollection(COL_TASK);
  } catch (e) {
    // 集合已存在 / 无权限创建（控制台手动建过）→ 都当成功
  }
}

async function loadTask(db, taskId, openid) {
  const res = await db.collection(COL_TASK).doc(taskId).get();
  const task = res && res.data;
  if (!task || task._openid !== openid) {
    throw new Error('解析任务不存在或无权访问，请重新上传攻略');
  }
  return task;
}

async function saveTask(db, taskId, patch) {
  await db.collection(COL_TASK).doc(taskId).update({
    data: Object.assign({}, patch, { updatedAt: Date.now() }),
  });
}

async function handleStep(event, ctx) {
  const { db, openid, now } = ctx;

  switch (event.step) {
    // ---------- ① 读文档 + 切分（不调 LLM，秒级） ----------
    case 'init': {
      const { fileID } = event;
      if (!fileID) return { code: -1, msg: '缺少 fileID' };
      // 开跑前先看额度：不够就别烧 token 了（前端也会拦一次，这里是防绕过的硬门槛）
      const chk = await quotaCall(openid, { action: 'check', scene: 'parse' });
      if (chk.code === -2) return { code: -2, msg: chk.msg || '次数用完了，买个套餐继续吧', needPay: true };
      if (chk.code === -3) return { code: -3, msg: chk.msg || '今天的生成次数到上限了' };
      await ensureTaskCollection(db);

      const dlRes = await cloud.downloadFile({ fileID });
      const rawText = (await mammoth.extractRawText({ buffer: dlRes.fileContent })).value;
      if (!rawText || rawText.length < 20) {
        return { code: -1, msg: '文档内容为空或过短' };
      }

      const meta = buildDocMeta(rawText);
      const doc = {
        _openid: openid,
        status: 'parsing',
        fileID,
        leadMinutes: Number(event.leadMinutes) > 0
          ? Math.max(1, Math.min(60, Math.round(Number(event.leadMinutes)))) : DEFAULT_ALARM_LEAD_MINUTES,
        title: meta.title,
        summary: meta.summary,
        year: meta.year,
        startDate: meta.startDate,
        endDate: meta.endDate,
        days: meta.days,                     // [{index,date,title,lines,prevText}]
        dayItems: meta.days.map(() => null), // 每天解析出的行程项
        dayStatus: meta.days.map(() => false),
        booking: meta.booking,
        rawHead: meta.rawHead,
        createdAt: now,
        updatedAt: now,
      };
      const addRes = await db.collection(COL_TASK).add({ data: doc });
      console.log('[step/init] 任务 %s：%d 天，%s ~ %s',
        addRes._id, meta.days.length, meta.startDate, meta.endDate);
      return {
        code: 0,
        taskId: addRes._id,
        dayCount: meta.days.length,
        title: meta.title,
        startDate: meta.startDate,
        endDate: meta.endDate,
      };
    }

    // ---------- ② 逐天 AI 解析（一次调用 = 一天 = 1 个 LLM 请求） ----------
    case 'day': {
      const { taskId, index } = event;
      const task = await loadTask(db, taskId, openid);
      const d = (task.days || [])[index];
      if (!d) return { code: -1, msg: '天序号越界' };
      // 幂等：已成功过的天直接返回（重试不重复花钱花时间）
      if (task.dayStatus && task.dayStatus[index]) {
        return { code: 0, itemCount: (task.dayItems[index] || []).length, cached: true };
      }
      const items = await extractDay(d);
      const dayItems = task.dayItems || [];
      dayItems[index] = items.filter((it) => it && String(it.activity || '').trim());
      const dayStatus = task.dayStatus || [];
      dayStatus[index] = true;
      await saveTask(db, taskId, { dayItems, dayStatus });
      console.log('[step/day] 第 %d 天解析出 %d 条', index + 1, dayItems[index].length);
      return { code: 0, index, itemCount: dayItems[index].length };
    }

    // ---------- ③ 闹钟（预订章节）+ 旅行建议（两个小请求并行） ----------
    case 'collect': {
      const task = await loadTask(db, event.taskId, openid);
      let alarmsRaw = [];
      let suggestions = {};
      const jobs = [];
      jobs.push(
        extractSuggestions(task.rawHead || '')
          .then((s) => { suggestions = s || {}; })
          .catch((e) => {
            console.error('[step/collect] 建议提取失败（跳过）:', e.message);
          })
      );
      if ((task.booking || []).length) {
        jobs.push(
          extractAlarms(task.booking, task.year)
            .then((a) => { alarmsRaw = a; })
            .catch((e) => {
              console.error('[step/collect] 闹钟提取失败（跳过）:', e.message);
            })
        );
      }
      await Promise.all(jobs);
      const region = String(suggestions.region || '').trim();
      delete suggestions.region;
      await saveTask(db, event.taskId, { alarmsRaw, suggestions, region });
      return { code: 0, alarmCount: alarmsRaw.length, hasSuggestions: !!Object.keys(suggestions).length };
    }

    // ---------- ④ 汇总清洗 + 日期兜底 + AI 反推待办（最多 1 个 LLM 请求） ----------
    case 'infer': {
      const task = await loadTask(db, event.taskId, openid);
      const rawItems = [].concat(...(task.dayItems || []).filter(Boolean));

      // 清洗：字段规范化 + 缺失时间智能回填 + "同点假导航"清除（详见 normalize.js）
      const items = sanitizeItems(rawItems);
      console.log('[step/infer] 清洗后 items 数量:', items.length);

      // 日期：init 时已由代码从"X月X日"标题确定性生成，这里只做格式校验与兜底
      let startDate = validDateStr(task.startDate);
      let endDate = validDateStr(task.endDate);
      if (!startDate) startDate = tsToDateStr(now);
      if (!endDate || endDate < startDate) {
        const maxDi = items.reduce((m, it) => Math.max(m, it.dayIndex || 0), 0);
        endDate = tsToDateStr(parseCnTime(startDate + 'T00:00:00') + maxDi * 86400000);
      }

      const alarms = cleanAlarms(task.alarmsRaw, openid, now, (task.booking || []).join('\n'));

      // 文档里没写抢票时间（很常见）→ 用行程反推一份待办清单，别让闹钟页空着
      if (alarms.length < INFER_THRESHOLD) {
        try {
          const inferred = await inferAlarms({
            title: task.title,
            startDate,
            endDate,
            items,
          });
          const have = new Set(alarms.map((a) => `${a.fireAt}|${a.title.replace(/\s+/g, '')}`));
          inferred.forEach((a) => {
            const key = `${a.fireAt}|${a.title.replace(/\s+/g, '')}`;
            if (!have.has(key)) { alarms.push(a); have.add(key); }
          });
          alarms.sort((a, b) => a.fireAt - b.fireAt);
          console.log('[step/infer] 补上 AI 反推待办，闹钟合计 %d 条', alarms.length);
        } catch (e) {
          console.error('[step/infer] 待办反推异常（不影响主流程）:', e.message);
        }
      }
      const ruleBackfill = backfillRuleAlarms({ startDate, endDate, items }, alarms);
      if (ruleBackfill.length) {
        alarms.push(...ruleBackfill);
        alarms.sort((a, b) => a.fireAt - b.fireAt);
        console.log('[step/infer] 详细行程规则查漏补齐 %d 条待办', ruleBackfill.length);
      }

      // 汇总去重要编码的地址（geocode 步按这个清单分批跑）
      const addrSet = new Set();
      items.forEach((it) => {
        if (it.startLocation) addrSet.add(it.startLocation);
        if (it.endLocation) addrSet.add(it.endLocation);
      });

      await saveTask(db, event.taskId, {
        items,
        alarms,
        addrList: [...addrSet],
        startDate,
        endDate,
      });
      return { code: 0, itemCount: items.length, alarmCount: alarms.length, addrCount: addrSet.size };
    }

    // ---------- ⑤ 地理编码（限墙钟 35s，一次跑不完下次继续） ----------
    case 'geocode': {
      const task = await loadTask(db, event.taskId, openid);
      const region = String(task.region || '').trim();
      const coords = task.coords || {};
      const pending = (task.addrList || []).filter((a) => a && !coords[a]);
      if (!pending.length) return { code: 0, remaining: 0, done: true };

      const t0 = Date.now();
      let processed = 0;
      for (const addr of pending) {
        // 逐个地址检查墙钟：单条 geocodeOne 最坏十几秒，超预算就停下、写库、下次接着跑
        if (Date.now() - t0 > GEOCODE_DEADLINE_MS) break;
        try {
          // 传整串 region（「广西 桂林 阳朔 南宁 崇左」），geocodeOne 内部拆候选城市逐个试
          const c = await geocodeOne(addr, region);
          if (c) coords[addr] = c;
        } catch (e) {
          console.error('[step/geocode] %s 失败（跳过）:', addr, e.message);
        }
        processed++;
      }
      await saveTask(db, event.taskId, { coords });
      const remaining = pending.length - processed;
      console.log('[step/geocode] 本轮 %d 个，累计命中 %d 个，剩余 %d',
        processed, Object.keys(coords).length, remaining);
      return { code: 0, remaining, processed };
    }

    // ---------- ⑥ 坐标回填 + 入库（秒级） ----------
    case 'commit': {
      const task = await loadTask(db, event.taskId, openid);
      // 幂等：上次 commit 已成功（比如写库后网络断了）→ 直接返回上次结果
      if (task.tripId && task.resultInfo) {
        return Object.assign({ code: 0, resumed: true }, task.resultInfo);
      }

      const items = task.items || [];
      const coords = task.coords || {};
      const region = String(task.region || '').trim();
      const cityHint = pickCity(region);

      // 坐标与城市回填（与旧链路同款判定：命中哪个城市记哪个，前端导航消歧用）
      items.forEach((it) => {
        const s = coords[it.startLocation];
        const e = coords[it.endLocation];
        if (s) {
          it.startLon = s.lon; it.startLat = s.lat;
          if (s.matchedName && s.matchedName !== it.startLocation) {
            it.startLocation = s.matchedName;   // 回写高德真实 POI 名
          }
        }
        if (e) {
          it.endLon = e.lon; it.endLat = e.lat;
          if (e.matchedName && e.matchedName !== it.endLocation) {
            it.endLocation = e.matchedName;
          }
        }
        const hitCity = (e && e.city) || (s && s.city) || '';
        if (hitCity) it.city = hitCity;
        else if (cityHint && !it.city) it.city = cityHint;
      });

      const alarms = prepareAlarmRecords(task.alarms || [], openid, '', now,
        event.leadMinutes === undefined ? task.leadMinutes : event.leadMinutes);
      const tripData = {
        _openid: openid,
        title: task.title || '我的行程',
        summary: task.summary || '',
        startDate: task.startDate,
        endDate: task.endDate,
        region,               // 大地名（省 市）：前端导航实时定位时消歧用，不做展示
        sourceFileID: task.fileID,
        items,
        createdAt: now,
        updatedAt: now,
        parseVersion: PARSE_VERSION,
      };

      const addRes = await db.collection(COL_TRIP).add({ data: tripData });
      const tripId = addRes._id;

      // 闹钟入库：批量插入，每次最多 20 条
      const storedAlarms = alarms.map((a) => Object.assign({}, a, { tripId }));
      if (storedAlarms.length) {
        for (let i = 0; i < storedAlarms.length; i += 20) {
          const batch = storedAlarms.slice(i, i + 20).map((a) =>
            db.collection(COL_ALARM).add({ data: a })
          );
          await Promise.all(batch);
        }
      }

      // 旅行建议入库
      const suggestions = task.suggestions || {};
      if (Object.keys(suggestions).length) {
        await db.collection('suggestions').add({
          data: {
            _openid: openid,
            tripId,
            weather: suggestions.weather || '',
            gear: suggestions.gear || '',
            food: suggestions.food || '',
            tips: suggestions.tips || '',
            transport: suggestions.transport || '',
            budget: suggestions.budget || '',
            generatedAt: now,
          },
        });
      }

      const resultInfo = {
        tripId,
        title: tripData.title,
        startDate: tripData.startDate,
        endDate: tripData.endDate,
        itemCount: items.length,
        alarmCount: alarms.length,
        version: PARSE_VERSION,
      };

      // 任务收尾：清掉大字段（原文/中间结果），保留一条小记录便于排查
      await saveTask(db, event.taskId, {
        status: 'done',
        tripId,
        resultInfo,
        days: null,
        dayItems: null,
        dayStatus: null,
        booking: null,
        rawHead: null,
        items: null,
        alarms: null,
        alarmsRaw: null,
        addrList: null,
        coords: null,
      });
      console.log('[step/commit] 行程 %s 完成：%d 条行程，%d 条闹钟',
        tripId, resultInfo.itemCount, resultInfo.alarmCount);
      // 入库成功才扣费（解析中途失败不收钱）；bizKey 带 tripId，重复 commit 只扣一次
      await quotaCall(openid, {
        action: 'consume', scene: 'parse', bizKey: `parse:${tripId}`, tripId,
      });
      return Object.assign({ code: 0 }, resultInfo);
    }

    default:
      return { code: -1, msg: `未知 step：${event.step}` };
  }
}
