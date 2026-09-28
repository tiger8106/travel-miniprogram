// cloudfunctions/generatePlan/index.js
// AI 制定新攻略：用户输入关键信息 → 生成完整行程 + 抢票闹钟 + 旅行建议 → 入库
//
// 与 parseTravelPlan 的关系：
//   parseTravelPlan 是「已有攻略文档 → 抽取结构化数据」
//   generatePlan    是「没有攻略文档 → 凭需求现场生成」
//   两者产出的 trip / item / alarm 结构完全一致，首页、行程详情、闹钟、建议四个页面无需改动。
//
// ⚠️ 为什么分成 outline / build 两次调用：
//    实测一次跑完「大纲 + 8 天细化」要 80 秒，超过云函数 60 秒硬上限。
//    拆开后：outline ~20s，build ~35s，都在上限内，而且大纲还能先给用户看一眼。
//
// ⚠️ 部署：右键本函数 → 上传并部署（云端安装依赖）
// ⚠️ 环境变量：LLM_PROVIDER / LLM_API_KEY / LLM_MODEL / AMAP_KEY（和 parseTravelPlan 一样，要在本函数再配一份）
// ⚠️ 超时时间：必须改成 60 秒（新建函数默认是 3 秒，跑大模型必超时）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const crypto = require('crypto');

const {
  generateOutline, buildPlan, dayDiff, collectSegments, applyRealSchedules,
  auditMergedDetailItems,
} = require('./plan');
const { geocodeBatch, cityTokens, searchHotelPoi, searchHotelsNearby } = require('./geocode');
const { validateOutlineHotels } = require('./hotel-validation');
const { lookupSchedules, canLookupSchedules, canSearch } = require('./schedule');

const COL_TRIP = 'trips';
const COL_ALARM = 'ticket_alarms';
const COL_SUG = 'suggestions';
const COL_JOB = 'gen_jobs';
const COL_SCHED = 'schedule_cache';
// 班次缓存 36 小时：缓存键带出行日期（同线路不同日期开行方案不同），
// 日期一换就是新键，TTL 再长也只是防止"同一天反复生成重复烧检索"
const SCHED_TTL_MS = 36 * 3600 * 1000;

// 生成引擎版本（用于确认线上跑的是哪一版）
const GEN_VERSION = 'v2.10-deadline-route-audit';

async function generateOutlineWithHotelCheck(input, opts) {
  const result = await generateOutline(input, opts || {});
  return validateOutlineHotels(result, input, searchHotelPoi, searchHotelsNearby);
}

// ---------------------------------------------------------------
// 后台续跑（用户中途离开小程序也能跑完）
//
// 为什么必须有任务表：云函数单次最硬的上限是 60s，多天行程要 2~4 轮才跑完，
// 以前这个"多跑几轮"的循环写在前端页面里 —— 用户一退出小程序，循环就断了，
// 行程永远停在半成品（只有前几天的条目，没有闹钟和建议）。
// 现在把任务落库：谁都能接着跑（前端 / 定时触发器），进度写在库里，
// 跑完自动把闹钟和建议补上，用户回来直接看结果。
//
// 租约（lease）：云函数单轮上限 60s，跑一轮之前先把 leaseUntil 推到 70s 后。
// 定时触发器只捞 leaseUntil 已过期的任务 —— 说明上一轮已经彻底没动静了
// （用户关了小程序、或者那一轮被系统杀掉），才需要它接手。
// ---------------------------------------------------------------
const JOB_LEASE_MS = 70 * 1000;
const JOB_MAX_ROUNDS = 12;                  // 正常 2-4 轮，12 轮是异常兜底
const JOB_MAX_AGE_MS = 25 * 60 * 1000;      // 单个任务最长 25 分钟
const JOB_STATUS_TTL_MS = 24 * 3600 * 1000; // 只把最近失败任务展示给前端，避免旧任务挡住新任务
const DEFAULT_ALARM_LEAD_MINUTES = 5;

function runnerIdOf(value) {
  return String(value || 'worker').slice(0, 80);
}

function alarmTypeOf(type) {
  return ['train', 'plane', 'ticket', 'hotel', 'bus', 'other'].includes(type) ? type : 'other';
}

function alarmKeyOf(a) {
  const date = String(a && (a.fireAtStr || '')).slice(0, 10);
  const title = String((a && a.title) || '提醒').trim().replace(/[\s\u3000]+/g, '');
  return `${alarmTypeOf(a && a.type)}|${date}|${title.slice(0, 100)}`;
}

function alarmLeadOf(a) {
  const n = Number(a && a.leadMinutes);
  return isFinite(n) && n > 0 ? Math.max(1, Math.min(60, Math.round(n))) : DEFAULT_ALARM_LEAD_MINUTES;
}

function alarmCompletedOf(a) {
  return !!(a && (a.completed === true || a.status === 'completed'));
}

/**
 * 调额度中心（quota 云函数）。
 * 关键约定：**额度服务不可用时一律放行** —— 它挂了最多少收一次钱，
 * 绝不能让用户连行程都生成不了（宁可漏收，不可误伤）。
 */
async function quotaCall(openid, data) {
  try {
    const res = await cloud.callFunction({
      name: 'quota',
      data: Object.assign({ openid }, data),
    });
    return (res && res.result) || {};
  } catch (e) {
    console.warn('[generatePlan] 额度服务不可用，本次不计费:', e.message);
    return {};
  }
}

/** 给一批条目补经纬度（供 wx.openLocation 打开微信原生地图）
 *  cityOf(address)：返回该地点所属的城市，帮高德消歧——
 *  全国同名地点太多，不带城市可能把"象鼻山"定位到南昌去。
 *  显示名称不受影响：经纬度只用于打开地图，用户看到的还是短地名。
 */
async function geocodeItems(items, regionOf, opts, cityOf) {
  try {
    const addrSet = new Set();
    items.forEach((it) => {
      // 终点优先：卡片导航默认打开终点；只有没有终点时才查起点，
      // 另外补查中间点。这样能修复分段导航，同时不把地理编码请求量翻倍。
      const add = (value) => {
        const name = String(value || '').trim();
        if (name) addrSet.add(name);
      };
      add(it.endLocation || it.startLocation);
      (Array.isArray(it.waypoints) ? it.waypoints : []).forEach((wp) => {
        add(typeof wp === 'string' ? wp : (wp && (wp.name || wp.location)));
      });
    });
    const coordMap = await geocodeBatch([...addrSet], regionOf, opts);
    if (coordMap.size) {
      items.forEach((it) => {
        const startName = String(it.startLocation || '').trim();
        const endName = String(it.endLocation || '').trim();
        const s = coordMap.get(startName);
        const e = coordMap.get(endName);
        if (s) {
          it.startLon = s.lon; it.startLat = s.lat;
          if (s.matchedName && s.matchedName !== it.startLocation) {
            it.startLocation = s.matchedName;   // 回写高德真实 POI 名，用户搜索/导航不再落空
          }
        }
        if (e) {
          it.endLon = e.lon; it.endLat = e.lat;
          if (e.matchedName && e.matchedName !== it.endLocation) {
            it.endLocation = e.matchedName;
          }
        }
        const hit = e || s;
        if (hit && hit.city) {
          // 以高德实际命中的行政区覆盖模型填的宽泛城市，避免后续实时导航
          // 带着“广西”或错误的当天城市再次搜索。
          it.city = hit.city;
        } else if (!it.city) {
          const target = endName || startName;
          if (target) it.city = cityOf ? cityOf(target) : '';
        }

        // 中间点的坐标也回写，activity-item 会按 waypoint 分段导航。
        if (Array.isArray(it.waypoints)) {
          it.waypoints = it.waypoints.map((wp) => {
            const name = typeof wp === 'string' ? wp : (wp && (wp.name || wp.location));
            const hitWp = coordMap.get(String(name || '').trim());
            if (!hitWp || typeof wp === 'string') return wp;
            return Object.assign({}, wp, { lon: hitWp.lon, lat: hitWp.lat });
          });
        }
      });
    }
    // 每条也记下它自己的城市：前端点导航时用它消歧，比整个行程的城市串准得多
    items.forEach((it) => {
      const to = it.endLocation || it.startLocation;
      if (to && !it.city) it.city = cityOf ? cityOf(to) : '';
    });
  } catch (e) {
    console.error('[generatePlan] 地理编码失败（不影响主流程）:', e.message);
  }
  return items;
}

/** 把大纲中的城市、片区、出发地整理成高德消歧范围。 */
function regionAreasOf(values) {
  const out = [];
  const seen = new Set();
  const add = (token, city) => {
    const t = String(token || '').trim();
    const c = String(city || t).trim();
    if (!t || t.length < 2 || /^(返程|回家|家中)$/.test(t)) return;
    const key = `${t}|${c}`;
    if (!seen.has(key)) { seen.add(key); out.push({ token: t, city: c }); }
  };
  (values || []).forEach((value) => {
    const text = String(value || '').replace(/[\/|]/g, ' ');
    cityTokens(text).forEach((token) => add(token, token));
    // cityTokens 会把「理县」这样的单字县名词根过滤掉，
    // 但「理县古尔沟」仍然是有效的高德消歧范围，所以把完整行政词保留。
    const re = /([\u4e00-\u9fa5]{1,8}(?:省|自治区|自治州|地区|盟|市|自治县|县|区|旗|镇|乡))/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const full = m[1];
      const bare = full.replace(/(省|自治区|自治州|地区|盟|自治县|县|区|旗|镇|乡|市)$/, '');
      add(full, bare.length >= 2 ? bare : full);
    }
  });
  return out;
}

function outlineRegion(outline, origin) {
  const values = [origin];
  (outline && Array.isArray(outline.days) ? outline.days : []).forEach((d) => {
    if (!d) return;
    values.push(d.city, d.overnight);
  });
  return [...new Set(regionAreasOf(values).map((x) => x.city))].join(' ');
}

/** 生成任务的状态始终同步到行程文档，首页和「我的行程」只需要查 trips。 */
async function updateTripGeneration(db, tripId, patch) {
  if (!tripId) return;
  try {
    await db.collection(COL_TRIP).doc(tripId).update({
      data: Object.assign({}, patch, { updatedAt: Date.now() }),
    });
  } catch (e) {
    console.warn('[generatePlan] 行程生成状态写回失败:', e.message);
  }
}

/**
 * 写库（行程 + 闹钟 + 建议），支持续跑：
 *   - 第一次（含撞时间预算的半成品）→ 新建 trip
 *   - 后续轮次（带 tripId）→ 把新生成的天合并进已有 trip，最后再补闹钟和建议
 */
async function savePlan(openid, plan, tripId, jobId, outline) {
  const db = cloud.database();
  // 生成状态写进行程本身：「我的行程」列表要靠它显示"生成中 x/y"，
  // 不需要额外查任务表（列表接口一次拿全）。
  const now = Date.now();
  const genPatch = {
    genStatus: plan.partial ? 'generating' : 'done',
    genProgress: plan.progress || null,
    jobId: plan.partial ? (jobId || '') : '',
    genError: '',
    genUpdatedAt: now,
  };
  if (!plan.partial) genPatch.genCompletedAt = now;
  // 每天的大地名（城市）：地理编码时带上，避免同名地点定位到别的城市。
  // 城市集合也存进 trip.region——前端点击导航、条目缺坐标需要实时查时，
  // 拿它继续消歧（只用于查询，不会拼进显示名称）。
  const dayCities = Array.isArray(plan.dayCities) ? plan.dayCities : [];
  const dayAreas = dayCities.map((value) => regionAreasOf([value]));
  const routeAreas = regionAreasOf([plan.origin].concat(dayCities));
  const region = [...new Set(routeAreas.map((x) => x.city))].join(' ');
  const firstCity = (routeAreas[0] && routeAreas[0].city) || '';
  // 地址里自带城市/县/片区时以它为准（取最长匹配，避免"南宁东站"被短词误伤）：
  // 城际段的终点常常不在当天城市里，用当天城市去约束会整条定位失败。
  const cityInAddr = (addr) => {
    const text = String(addr || '');
    const matches = routeAreas.filter((area) => area.token && text.indexOf(area.token) >= 0);
    matches.sort((a, b) => b.token.length - a.token.length);
    return matches[0] ? matches[0].city : '';
  };
  const dayAreaOf = (idx) => {
    const areas = idx >= 0 ? (dayAreas[idx] || []) : [];
    return (areas[0] && areas[0].city) || '';
  };
  const regionOf = (addr) => {
    const idx = plan.addrDay ? plan.addrDay.get(addr) : -1;
    const own = cityInAddr(addr);
    const day = idx >= 0 ? dayCities[idx] || '' : '';
    // 传给高德的是当天范围 + 全程范围：既能定位同名 POI，
    // 也能处理“当天住都江堰、终点却是古尔沟/理县”的跨城条目。
    return [...new Set([own, day, region].filter(Boolean))].join(' ');
  };
  const cityOf = (addr) => {
    const idx = plan.addrDay ? plan.addrDay.get(addr) : -1;
    return cityInAddr(addr) || dayAreaOf(idx) || firstCity;
  };
  // 地理编码的时间硬预算：细化轮本来就在云函数 60s 上限边缘跑，
  // 几十个地址逐个十几次高德请求不设防，整轮就被杀掉重来（反而更慢）。
  // 没编码上的地点前端导航时会走"复制地名/实时定位"兜底，功能不缺。
  const geoBudgetMs = Math.max(5000, Math.min(20000, parseInt(process.env.GEOCODE_BUDGET_MS || '', 10) || 12000));
  let finalTripId = tripId;
  let title = plan.title;
  let startDate = plan.startDate;
  let endDate = plan.endDate;
  let storedItems = Array.isArray(plan.items) ? plan.items.slice() : [];
  let oldData = null;

  // 续跑时先把旧天数和本轮新天数合并，再做一次全行程审计。否则
  // buildPlan 只能看到本轮天数，早先已经落库的龙脊天无法补齐核心路线。
  if (finalTripId) {
    const old = await db.collection(COL_TRIP).doc(finalTripId).get();
    oldData = (old && old.data) || {};
    if (!oldData._openid || oldData._openid !== openid) {
      throw new Error('行程不存在或无权操作');
    }
    const freshDays = new Set(storedItems.map((it) => it.dayIndex));
    const kept = (oldData.items || []).filter((it) => !freshDays.has(it.dayIndex));
    storedItems = kept.concat(storedItems).sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0));
  }

  // 等哪一轮真有内容了再建，否则中途放弃会在「我的行程」里留下一条 0 条的空攻略。
  if (!finalTripId && !storedItems.length && plan.partial) {
    console.log('[generatePlan] 本轮没有新条目，暂不建库，等下一轮续跑');
    return {
      tripId: '',
      title: plan.title,
      startDate: plan.startDate,
      endDate: plan.endDate,
      itemCount: 0,
      alarmCount: 0,
      partial: true,
      doneDayIndexes: plan.doneDayIndexes || [],
      attempts: plan.attempts || {},
      gaveUpDayIndexes: plan.gaveUpDayIndexes || [],
      progress: plan.progress || null,
      version: GEN_VERSION,
    };
  }

  if (outline && storedItems.length) {
    storedItems = auditMergedDetailItems(storedItems, outline);
  }
  plan.items = storedItems;
  await geocodeItems(plan.items, regionOf, { deadlineAt: Date.now() + geoBudgetMs }, cityOf);
  let itemCount = storedItems.length;

  if (!finalTripId) {
    const tripData = {
      _openid: openid,
      title: plan.title,
      summary: plan.summary,
      startDate: plan.startDate,
      endDate: plan.endDate,
      region,                  // 本行程涉及的城市（空格分隔）：导航实时定位时消歧用
      sourceType: 'ai',          // 区别于上传文档解析出来的攻略
      sourceFileID: '',
      items: storedItems,
      createdAt: now,
      updatedAt: now,
      genVersion: GEN_VERSION,
      ...genPatch,
    };
    const addRes = await db.collection(COL_TRIP).add({ data: tripData });
    finalTripId = addRes._id;
  } else {
    await db.collection(COL_TRIP).doc(finalTripId).update({
      data: {
        title: plan.title,
        summary: plan.summary,
        startDate: plan.startDate,
        endDate: plan.endDate,
        region,
        items: storedItems,
        updatedAt: now,
        genVersion: GEN_VERSION,
        ...genPatch,
      },
    });
    title = plan.title;
    startDate = plan.startDate;
    endDate = plan.endDate;
    itemCount = storedItems.length;
  }

  // 只在最后一批（非 partial）写闹钟和建议，避免续跑时重复插入
  let alarmCount = 0;
  if (!plan.partial) {
    // 幂等写回：同一事项尽量复用原记录，保留用户的完成状态、_id 和提醒偏好。
    // 旧实现先删除全部 AI 闹钟，用户已经办完的事项会在重新生成后重新变成待办。
    const existed = await db.collection(COL_ALARM)
      .where({ _openid: openid, tripId: finalTripId, source: 'ai' }).get();
    const oldByKey = new Map();
    (existed.data || []).forEach((old) => {
      const key = old.alarmKey || alarmKeyOf(old);
      if (!oldByKey.has(key)) oldByKey.set(key, old);
    });
    const usedOldIds = new Set();
    const alarms = (plan.alarms || []).map((a) => {
      const fireAt = Number(a.fireAt) || 0;
      const leadMinutes = alarmLeadOf(a);
      const fireAtStr = String(a.fireAtStr || '');
      const key = alarmKeyOf(Object.assign({}, a, { fireAtStr }));
      const old = oldByKey.get(key);
      if (old) usedOldIds.add(old._id);
      const completed = old ? alarmCompletedOf(old) : false;
      const oldFireAt = old ? Number(old.fireAt) : 0;
      return {
        old,
        data: {
          _openid: openid,
          tripId: finalTripId,
          title: String(a.title || '提醒').slice(0, 100),
          note: String(a.note || '').slice(0, 500),
          fireAt,
          fireAtStr: fireAtStr.slice(0, 32),
          leadMinutes: old ? alarmLeadOf(old) : leadMinutes,
          remindAt: fireAt - (old ? alarmLeadOf(old) : leadMinutes) * 60 * 1000,
          type: alarmTypeOf(a.type),
          dayIndex: Number.isInteger(Number(a.dayIndex)) ? Number(a.dayIndex) : undefined,
          bookingInfo: String(a.bookingInfo || '').slice(0, 160),
          usageInfo: String(a.usageInfo || '').slice(0, 180),
          linkedItemId: String(a.linkedItemId || '').slice(0, 100),
          alarmKey: key,
          source: 'ai',
          completed,
          completedAt: completed ? (Number(old.completedAt) || 0) : 0,
          status: completed ? 'completed' : 'pending',
          // 同一事项沿用通知状态；时间发生变化则必须允许新时间再次提醒。
          notified: old && oldFireAt === fireAt ? old.notified === true : false,
          notifiedAt: old && oldFireAt === fireAt ? (Number(old.notifiedAt) || 0) : 0,
          createdAt: old && old.createdAt ? old.createdAt : now,
          updatedAt: now,
          archived: false,
        },
      };
    });
    for (let i = 0; i < alarms.length; i += 20) {
      await Promise.all(alarms.slice(i, i + 20).map((entry) => {
        if (entry.old) return db.collection(COL_ALARM).doc(entry.old._id).update({ data: entry.data });
        return db.collection(COL_ALARM).add({ data: entry.data });
      }));
    }
    // 新大纲已经删掉的未完成事项可以清理；已完成事项保留在分类清单里，标记为历史记录。
    const obsolete = (existed.data || []).filter((old) => !usedOldIds.has(old._id));
    for (let i = 0; i < obsolete.length; i += 20) {
      await Promise.all(obsolete.slice(i, i + 20).map((old) => {
        if (alarmCompletedOf(old)) {
          return db.collection(COL_ALARM).doc(old._id).update({ data: { archived: true, updatedAt: now } });
        }
        return db.collection(COL_ALARM).doc(old._id).remove();
      }));
    }
    alarmCount = alarms.length + obsolete.filter(alarmCompletedOf).length;

    const s = plan.suggestions || {};
    if (s.weather || s.gear || s.food || s.tips || s.transport || s.budget) {
      const oldSug = await db.collection(COL_SUG).where({ _openid: openid, tripId: finalTripId }).get();
      const sugData = {
        _openid: openid,
        tripId: finalTripId,
        weather: s.weather || '',
        gear: s.gear || '',
        food: s.food || '',
        tips: s.tips || '',
        transport: s.transport || '',
        budget: s.budget || '',
        generatedAt: now,
      };
      if ((oldSug.data || []).length) {
        await db.collection(COL_SUG).doc(oldSug.data[0]._id).update({ data: sugData });
      } else {
        await db.collection(COL_SUG).add({ data: sugData });
      }
    }
  }

  console.log('[generatePlan] 入库完成 tripId=%s 条目=%d 闹钟=%d partial=%s 版本=%s',
    finalTripId, itemCount, alarmCount, !!plan.partial, GEN_VERSION);

  return {
    tripId: finalTripId,
    title,
    startDate,
    endDate,
    itemCount,
    alarmCount,
    partial: !!plan.partial,
    doneDayIndexes: plan.doneDayIndexes || [],
    attempts: plan.attempts || {},          // 前端原样带回，才知道哪些天还能重试
    gaveUpDayIndexes: plan.gaveUpDayIndexes || [],  // 重试耗尽的天 → 前端提示用户
    progress: plan.progress || null,        // { done, total } 给前端显示进度
    version: GEN_VERSION,
  };
}

// ===============================================================
// 后台任务：创建 / 跑一轮 / 查进度
// ===============================================================

async function loadJob(jobId) {
  try {
    const r = await cloud.database().collection(COL_JOB).doc(jobId).get();
    return r.data || null;
  } catch (e) {
    return null;
  }
}

/** 任务对外可见的字段（不返回 input，里面有大段大纲，没必要来回搬） */
function jobPublic(job, now) {
  return {
    jobId: job._id,
    tripId: job.tripId || '',
    title: job.title || '',
    status: job.status,
    round: job.round || 0,
    progress: job.progress || null,
    itemCount: job.itemCount || 0,
    error: job.error || '',
    updatedAt: job.updatedAt || 0,
    // 租约过期 = 上一轮已经彻底没动静了，谁都可以接手继续跑
    resumable: job.status === 'running' && !(job.leaseUntil > now),
  };
}

/**
 * 跑一轮细化并把进度写回任务。
 * 无论这一轮是"没跑完（partial）"还是"跑完了"，已生成的天都已经落库，
 * 所以用户中途退出小程序也不会丢东西 —— 剩下的轮次由别人接着跑。
 */
async function runJobRound(openid, job) {
  const db = cloud.database();
  const runnerId = runnerIdOf(job.leaseOwner);
  const input = Object.assign({}, job.input || {});
  const payload = Object.assign({}, input, {
    tripId: job.tripId || '',
    doneDayIndexes: job.doneDayIndexes || [],
    attempts: job.attempts || {},
  });
  delete payload.action;
  delete payload.jobMode;

  // ★ 联网核对真实班次 = 后台专轮。为什么不再塞在大纲轮里：
  //   大纲 LLM 本身要 35-50s，塞进去检索只剩十几秒残羹，经常草草超时 →
  //   前台 outline 调用被 60s 掐死 → 转后台又从头重做大纲+检索 ——
  //   一次行程六七分钟的大头就在这。现在前台大纲不检索（快、稳），
  //   后台拿到大纲后单独用一整轮（~26s 预算）安心查，查完写回大纲再细化。
  if (!(input.outline && input.outline.days && input.outline.days.length)) {
    try {
      const res = await generateOutlineWithHotelCheck(payload, {});
      const totalDays = (res.outline && res.outline.days || []).length;
      const now = Date.now();
      await db.collection(COL_JOB).doc(job._id).update({
        data: {
          input: Object.assign({}, input, {
            outline: res.outline, title: res.title, summary: res.summary,
          }),
          title: String(res.title || job.title || ''),
          progress: { done: 0, total: totalDays },
          round: (job.round || 0) + 1,
          updatedAt: now,
          leaseUntil: now + JOB_LEASE_MS,
          leaseOwner: runnerId,
        },
      }).catch((e) => console.warn('[generatePlan] 大纲写回任务失败:', e.message));
      await updateTripGeneration(db, job.tripId, {
        title: String(res.title || job.title || '正在生成的攻略').slice(0, 60),
        summary: String(res.summary || '').slice(0, 200),
        startDate: res.startDate || input.startDate || null,
        endDate: res.endDate || input.endDate || null,
        region: outlineRegion(res.outline, input.origin),
        genStatus: 'generating',
        genProgress: { done: 0, total: totalDays },
        genError: '',
        jobId: job._id,
      });
      console.log('[generatePlan] 任务 %s 后台大纲完成：%d 天', job._id, totalDays);
      return {
        jobId: job._id,
        tripId: job.tripId || '',
        title: String(res.title || job.title || ''),
        status: 'running',
        partial: true,          // 细化还没开始 → 让驱动方接着跑下一轮
        round: (job.round || 0) + 1,
        progress: { done: 0, total: totalDays },
        itemCount: 0,
        error: '',
        version: GEN_VERSION,
      };
    } catch (e) {
      // 大纲没生成出来 ≠ 任务失败：还有下一轮。重试额度用完才认输。
      const attempts = Object.assign({}, job.attempts || {});
      attempts.outline = (attempts.outline || 0) + 1;
      const giveUp = attempts.outline >= 3;
      const now = Date.now();
      await db.collection(COL_JOB).doc(job._id).update({
        data: {
          attempts,
          round: (job.round || 0) + 1,
          status: giveUp ? 'failed' : 'running',
          error: giveUp ? `大纲连续 ${attempts.outline} 次没生成出来：${String(e.message || e).slice(0, 80)}` : '',
          updatedAt: now,
          leaseUntil: giveUp ? 0 : now + JOB_LEASE_MS,
          leaseOwner: giveUp ? '' : runnerId,
        },
      }).catch(() => {});
      if (giveUp) throw e;
      console.warn('[generatePlan] 后台大纲生成失败，留给下一轮重试(%d/3):', attempts.outline, e.message);
      return {
        jobId: job._id,
        tripId: job.tripId || '',
        title: job.title || '',
        status: 'running',
        partial: true,
        round: (job.round || 0) + 1,
        progress: job.progress || { done: 0, total: 0 },
        itemCount: 0,
        error: '',
        version: GEN_VERSION,
      };
    }
  }

  // ★ 班次专轮：大纲已就绪但还没联网核对过班次 → 本轮只做检索。
  //   给检索一整个独立预算（不再和大纲/细化抢 60s），查到的真实班次
  //   写回大纲（day.sched + moves 时刻），细化阶段照着挑、enforceRealSchedule 兜底。
  //   12306 查询失败/超时仍允许行程继续，但会清除模型臆造车次并标记待核实，
  //   绝不把未核对的铁路信息当成事实写给用户。
  const wantSearch = canLookupSchedules();
  if (!job.schedDone && wantSearch) {
    const segs = collectSegments(input.outline, { origin: input.origin });
    // 没有城际铁路/航班时直接进入细化，避免为纯市内行程白占一轮后台任务。
    if (!segs.length) {
      await db.collection(COL_JOB).doc(job._id).update({
        data: { schedDone: true, updatedAt: Date.now() },
      }).catch((e) => console.warn('[generatePlan] 班次状态写回失败:', e.message));
      job.schedDone = true;
    } else {
      try {
        const budget = Math.max(8000, Number(process.env.LLM_SEARCH_BUDGET_MS) || 26000);
        const left = Math.min(budget, 50000);
        if (left > 6000) {
          const t0 = Date.now();
          const found = await lookupSchedules(segs, left, scheduleCacheAdapter());
          const stat = applyRealSchedules(input.outline, found, input);
          // 班次校正可能把中途提前返程的日期挪回最后一天，并同步改写
          // overnight；这一步会清空旧酒店，因此必须在路线最终稳定后再核验一次。
          await validateOutlineHotels({ outline: input.outline }, input,
            searchHotelPoi, searchHotelsNearby);
          console.log('[generatePlan] 班次专轮：命中 %d 段 / 换 %d 段，用时 %dms',
            stat ? stat.segments : 0, stat ? stat.replaced : 0, Date.now() - t0);
        }
      } catch (e) {
        console.warn('[generatePlan] 班次检索整体失败，细化阶段会清除未核实车次:', e.message);
      }
      const now = Date.now();
      await db.collection(COL_JOB).doc(job._id).update({
        data: {
          // applyRealSchedules 原地改写了 outline（day.sched / moves 时刻），要写回
          'input.outline': input.outline,
          schedDone: true,
          round: (job.round || 0) + 1,
          updatedAt: now,
          leaseUntil: now + JOB_LEASE_MS,
          leaseOwner: runnerId,
        },
      }).catch((e) => console.warn('[generatePlan] 班次写回任务失败:', e.message));
      job.schedDone = true;
      return {
        jobId: job._id,
        tripId: job.tripId || '',
        title: job.title || '',
        status: 'running',
        partial: true,           // 细化下一轮开始
        round: (job.round || 0) + 1,
        progress: job.progress || { done: 0, total: (input.outline.days || []).length },
        itemCount: job.itemCount || 0,
        error: '',
        version: GEN_VERSION,
      };
    }
  }

  const plan = await buildPlan(payload, payload, {
    doneDayIndexes: job.doneDayIndexes || [],
    attempts: job.attempts || {},
    budgetMs: job.budgetMs,
  });
  if (!plan || (!plan.items.length && !plan.partial && !job.tripId)) {
    throw new Error('AI 没有生成出有效行程，请调整需求后重试');
  }
  const data = await savePlan(openid, plan, job.tripId, job._id, payload.outline);
  // 落库成功才扣费；bizKey 按 tripId 幂等，续跑多轮也只扣一次
  if (data && data.tripId) {
    await quotaCall(openid, {
      action: 'consume', scene: 'plan', bizKey: `plan:${data.tripId}`, tripId: data.tripId,
    });
  }

  const now = Date.now();
  const round = (job.round || 0) + 1;
  const tooOld = !!job.createdAt && (now - job.createdAt > JOB_MAX_AGE_MS);
  const status = !data.partial ? 'done' : ((round >= JOB_MAX_ROUNDS || tooOld) ? 'failed' : 'running');
  const patch = {
    tripId: data.tripId || job.tripId || '',
    title: data.title || job.title || '',
    doneDayIndexes: data.doneDayIndexes || [],
    attempts: data.attempts || {},
    gaveUpDayIndexes: data.gaveUpDayIndexes || [],
    progress: data.progress || null,
    itemCount: data.itemCount || 0,
    round,
    status,
    error: status === 'failed' ? '生成时间过长已停止，请重新生成或稍后再试' : '',
    updatedAt: now,
    // 还在跑 → 继续占着租约，定时触发器别插手；跑完/失败 → 释放
    leaseUntil: status === 'running' ? now + JOB_LEASE_MS : 0,
    leaseOwner: status === 'running' ? runnerId : '',
  };
  await db.collection(COL_JOB).doc(job._id).update({ data: patch }).catch((e) => {
    console.warn('[generatePlan] 任务进度写回失败:', e.message);
  });
  if (status === 'failed' && patch.tripId) {
    await updateTripGeneration(db, patch.tripId, {
      genStatus: 'failed',
      genProgress: patch.progress || null,
      genError: patch.error || '生成未完成，请稍后重试',
      jobId: '',
    });
  }
  console.log('[generatePlan] 任务 %s 第 %d 轮完成：%s，进度 %s',
    job._id, round, status, JSON.stringify(patch.progress || {}));
  return Object.assign({ jobId: job._id }, patch, {
    title: data.title,
    startDate: data.startDate,
    endDate: data.endDate,
    partial: !!data.partial,
    gaveUpDayIndexes: data.gaveUpDayIndexes || [],
    version: GEN_VERSION,
  });
}

// ---------------------------------------------------------------
// 真实班次缓存：同一条线路同一天短时不重复联网检索。
// 「换个方案」现在不限次数了，不缓存的话反复换几次就烧掉一堆检索。
// ---------------------------------------------------------------
function schedDocId(key) {
  return crypto.createHash('sha1').update(String(key), 'utf8').digest('hex');
}

async function schedCacheGet(key) {
  try {
    const r = await cloud.database().collection(COL_SCHED).doc(schedDocId(key)).get();
    const d = r && r.data;
    if (d && d.expireAt > Date.now() && Array.isArray(d.list) && d.list.length) return d.list;
  } catch (e) { /* 没缓存/集合不存在都当没有 */ }
  return null;
}

async function schedCacheSet(key, list) {
  try {
    const now = Date.now();
    const db = cloud.database();
    await ensureCollection(db, COL_SCHED);
    await db.collection(COL_SCHED).doc(schedDocId(key))
      .set({ data: { list, updatedAt: now, expireAt: now + SCHED_TTL_MS } });
  } catch (e) { console.warn('[generatePlan] 班次缓存写入失败:', e.message); }
}

/** 联网查真实班次的缓存适配（班次专轮用） */
function scheduleCacheAdapter() {
  return { get: schedCacheGet, set: schedCacheSet };
}

/**
 * 集合不存在（-502005 Db or Table not exist）曾让后台生成直接挂掉：
 * 写库前先兜底自动建集合。对已存在的集合 createCollection 会报错，吞掉即可。
 * （部署清单里仍建议手动建好并配权限，这里是"忘了建也不炸"的保险。）
 */
const _ensuredCols = new Set();
async function ensureCollection(db, name) {
  if (_ensuredCols.has(name)) return;
  try {
    await db.createCollection(name);
    console.log('[generatePlan] 已自动创建集合:', name);
  } catch (e) { /* 多半是"集合已存在"，不用管 */ }
  _ensuredCols.add(name);
}

/** 建任务（首轮）。只在建任务前查一次额度，续跑不再查（那一次的钱已经扣过了） */
async function createJob(openid, event) {
  const db = cloud.database();
  await ensureCollection(db, COL_JOB);
  const now = Date.now();

  // 同一账号只允许一个生成任务。前端锁按钮只能防住单页面连点，
  // 还要在云端拦截多设备/重复请求，否则会同时烧模型并互相覆盖行程。
  const active = await db.collection(COL_JOB)
    .where({ _openid: openid, status: 'running' })
    .orderBy('updatedAt', 'desc').limit(1).get().catch(() => ({ data: [] }));
  const activeJob = active.data && active.data[0];
  if (activeJob && (!activeJob.createdAt || now - activeJob.createdAt <= JOB_MAX_AGE_MS)) {
    return { code: -4, msg: '已有一个行程正在生成，请到首页查看进度' };
  }
  if (activeJob) {
    await db.collection(COL_JOB).doc(activeJob._id).update({
      data: {
        status: 'failed', error: '任务超过最长运行时间，已停止',
        leaseUntil: 0, leaseOwner: '', updatedAt: now,
      },
    }).catch(() => {});
    await updateTripGeneration(db, activeJob.tripId, {
      genStatus: 'failed',
      genError: '任务超过最长运行时间，已停止',
      jobId: '',
    });
  }
  const chk = await quotaCall(openid, { action: 'check', scene: 'plan' });
  if (chk.code === -2) return { code: -2, msg: chk.msg || '次数用完了，买个套餐继续吧', needPay: true };
  if (chk.code === -3) return { code: -3, msg: chk.msg || '暂时无法生成' };
  const input = Object.assign({}, event);
  delete input.action;
  delete input.jobMode;
  delete input.tripId;
  delete input.doneDayIndexes;
  delete input.attempts;
  const runnerId = runnerIdOf(event.runnerId);
  delete input.runnerId;
  const totalDays = ((input.outline || {}).days || []).length || 0;
  const budgetMs = Number(event.budgetMs);
  const doc = {
    _openid: openid,
    status: 'running',
    title: String(input.title || ''),
    input,
    tripId: '',
    doneDayIndexes: [],
    attempts: {},
    progress: { done: 0, total: totalDays },
    round: 0,
    itemCount: 0,
    createdAt: now,
    updatedAt: now,
    leaseUntil: now + JOB_LEASE_MS,   // 建好就算占住，避免定时器抢在首轮之前
    leaseOwner: runnerId,
    error: '',
  };
  if (budgetMs > 0) doc.budgetMs = budgetMs;
  let jobId = '';
  let tripId = '';
  try {
    const add = await db.collection(COL_JOB).add({ data: doc });
    jobId = add._id;
    const outline = input.outline || {};
    const tripData = {
      _openid: openid,
      title: String(input.title || '正在生成的攻略').slice(0, 60),
      summary: String(input.summary || '').slice(0, 200),
      startDate: input.startDate || null,
      endDate: input.endDate || null,
      region: outlineRegion(outline, input.origin),
      sourceType: 'ai',
      sourceFileID: '',
      items: [],
      createdAt: now,
      updatedAt: now,
      genVersion: GEN_VERSION,
      genStatus: 'generating',
      genProgress: { done: 0, total: totalDays },
      genError: '',
      jobId,
    };
    const trip = await db.collection(COL_TRIP).add({ data: tripData });
    tripId = trip._id;
    await db.collection(COL_JOB).doc(jobId).update({ data: { tripId, updatedAt: Date.now() } });
    return { code: 0, job: Object.assign({}, doc, { _id: jobId, tripId }) };
  } catch (e) {
    if (tripId) await db.collection(COL_TRIP).doc(tripId).remove().catch(() => {});
    if (jobId) await db.collection(COL_JOB).doc(jobId).remove().catch(() => {});
    throw e;
  }
}

/**
 * ④ 自检：真机上「生成失败」时一键看清缺什么。
 *    只回报"配了 / 没配"的布尔值，绝不把密钥内容吐出去。
 *    排查顺序永远是：环境变量齐不齐 → 模型/端点对不对 → 网络连不连得上。
 */
async function runDiag(withPing) {
  const llm = require('./llm');
  const KEYS = [
    'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'AMAP_KEY',
    'LLM_ENABLE_SEARCH', 'LLM_SEARCH_CAPABLE',
  ];
  const env = {};
  KEYS.forEach((k) => { env[k] = !!process.env[k]; });

  let cfg = null;
  let cfgError = '';
  try { cfg = llm.getConfig(); } catch (e) { cfgError = e.message; }

  const out = {
    version: GEN_VERSION,
    env,
    provider: process.env.LLM_PROVIDER || '(未设置)',
    model: cfg ? cfg.model : null,
    baseURL: cfg ? cfg.baseURL : null,
    searchEnabled: canSearch(),
    officialRailEnabled: process.env.RAIL12306_ENABLED !== '0',
    scheduleEnabled: canLookupSchedules(),
    cfgError,
    ping: '未探测',
  };

  if (withPing && cfg) {
    const t0 = Date.now();
    let timer = null;
    const timeout = new Promise((res) => { timer = setTimeout(() => res('探测超时(12s)'), 12000); });
    const call = llm.chat([{ role: 'user', content: '只回复两个字：正常' }], 16)
      .then(() => null)
      .catch((e) => e.message);
    const raced = await Promise.race([call, timeout]);
    clearTimeout(timer);
    out.ping = raced ? `失败：${raced}` : `正常（${Date.now() - t0}ms）`;
  } else if (withPing) {
    out.ping = '跳过（配置不全，先补齐再测）';
  }
  return out;
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  // 云函数互相调用（定时触发器 genWorker → 本函数）时拿不到微信上下文，
  // 这种内部调用由调用方把 openid 显式带过来（下面还会校验任务归属，冒充也没用）。
  const ctxOpenid = wxContext.OPENID || '';
  if (!ctxOpenid && !(event && event.openid)) return { code: -1, msg: '未登录' };
  const openid = ctxOpenid || String(event.openid);

  const { action } = event || {};

  // ②-B 查后台生成进度（用户回到小程序 / 切到「我的行程」时问一次）
  if (action === 'jobStatus') {
    try {
      const db = cloud.database();
      const res = await db.collection(COL_JOB)
        .where({ _openid: openid })
        .orderBy('updatedAt', 'desc').limit(10).get();
      const now = Date.now();
      const jobs = (res.data || [])
        .filter((j) => j.status === 'running'
          || (j.status === 'failed' && now - Number(j.updatedAt || 0) <= JOB_STATUS_TTL_MS))
        .slice(0, 3)
        .map((j) => jobPublic(j, now));
      return { code: 0, data: { jobs, job: jobs[0] || null } };
    } catch (e) {
      return { code: 0, data: { jobs: [], job: null } };   // 查不到就当没有在跑的任务
    }
  }

  // ②-C 续跑一轮：前端自己接着跑（expectRound 做乐观锁），
  //     或定时触发器接手（不带 expectRound，只看租约过期没）
  if (action === 'resume') {
    const jobId = String((event && event.jobId) || '');
    if (!jobId) return { code: -1, msg: '缺少 jobId' };
    const db = cloud.database();
    const job = await loadJob(jobId);
    if (!job || job._openid !== openid) return { code: -1, msg: '任务不存在' };
    const runnerId = runnerIdOf(event && event.runnerId);
    const now0 = Date.now();
    // 失败任务允许复活：用户在「我的行程」点「继续生成」时再给一次机会。
    // 已生成的天都在库里，复活接着跑就行；最多复活 2 次、超过 25 分钟不救，
    // 防止一个死任务被无限重试烧 token。
    if (job.status === 'failed') {
      const revivals = Number(job.revivals || 0);
      const tooOld = job.createdAt && (now0 - job.createdAt > JOB_MAX_AGE_MS);
      if (revivals >= 2 || tooOld) return { code: 0, data: jobPublic(job, now0) };
      await cloud.database().collection(COL_JOB).doc(jobId).update({
        data: {
          status: 'running', revivals: revivals + 1, error: '',
          leaseUntil: now0 + JOB_LEASE_MS, leaseOwner: runnerId, updatedAt: now0,
        },
      }).catch(() => {});
      job.status = 'running';
      job.leaseOwner = runnerId;
      job.leaseUntil = now0 + JOB_LEASE_MS;
      console.log('[generatePlan] 任务 %s 复活（第 %d 次）', jobId, revivals + 1);
    }
    if (job.status !== 'running') return { code: 0, data: jobPublic(job, Date.now()) };
    const now = Date.now();
    // 乐观锁：带 expectRound 说明是"我刚跑完第 n 轮，我要接着跑" ——
    // 只要没别人推进过（round 没变）就放行，这样连续几轮之间不用干等租约过期。
    // 不带 expectRound 的是定时触发器，靠租约判断上一轮是不是已经死了。
    const sameOwner = job.leaseOwner && job.leaseOwner === runnerId;
    const busy = event.expectRound != null
      ? (Number(job.round) !== Number(event.expectRound)
        || (job.leaseUntil > now && !sameOwner))
      : (job.leaseUntil > now);
    if (busy) return { code: 0, data: Object.assign(jobPublic(job, now), { busy: true }) };
    // 读取租约后再做一次带条件的更新，防止两个 genWorker 实例同时捞到同一任务。
    // 前端续跑可以续自己的租约；不同 runner 不能覆盖正在执行的那一轮。
    const claimWhere = {
      _id: jobId,
      _openid: openid,
      status: 'running',
      round: Number(job.round) || 0,
    };
    if (job.leaseUntil > now) claimWhere.leaseOwner = runnerId;
    else claimWhere.leaseUntil = db.command.lt(now);
    const claimed = await db.collection(COL_JOB).where(claimWhere).update({
      data: { leaseUntil: now + JOB_LEASE_MS, leaseOwner: runnerId, updatedAt: now },
    }).catch(() => null);
    const claimedCount = claimed && claimed.stats
      ? Number(claimed.stats.updated || claimed.stats.updatedCount || 0) : 0;
    if (!claimedCount) {
      return { code: 0, data: Object.assign(jobPublic(job, now), { busy: true }) };
    }
    job.leaseOwner = runnerId;
    job.leaseUntil = now + JOB_LEASE_MS;
    try {
      const out = await runJobRound(openid, job);
      return { code: 0, data: out };
    } catch (err) {
      console.error('[generatePlan] resume error:', err);
      await cloud.database().collection(COL_JOB).doc(jobId).update({
        data: {
          status: 'failed', error: String(err.message || err).slice(0, 100),
          updatedAt: Date.now(), leaseUntil: 0, leaseOwner: '',
        },
      }).catch(() => {});
      await updateTripGeneration(cloud.database(), job.tripId, {
        genStatus: 'failed',
        genError: String(err.message || err).slice(0, 100),
        jobId: '',
      });
      return { code: -1, msg: err.message || '续跑失败' };
    }
  }

  // ① 预览：只算天数等元信息，不调 LLM（前端选完日期即时反馈）
  if (action === 'preview') {
    try {
      return { code: 0, data: { days: dayDiff(event.startDate, event.endDate) } };
    } catch (e) {
      return { code: -1, msg: '日期不合法' };
    }
  }

  // ①.5 自检：不烧 token 也能看清配置状态（前端在生成失败时自动调它）
  if (action === 'diag') {
    try {
      return { code: 0, data: await runDiag(event.ping !== false) };
    } catch (e) {
      return { code: -1, msg: e.message || '自检失败' };
    }
  }

  // ② 阶段一：生成路线大纲（~20s）。先给前端展示，用户不满意可以换一版。
  if (action === 'outline') {
    // 「换个方案」不扣额度、也不限次数（同一趟行程只在细化入库时收一次钱）。
    // 之前限制"非会员 5 次/天"是为了防脚本刷大纲烧 token，但副作用很致命：
    // 用户明明还有额度，却因为"今天换够了"而生成不了攻略 —— 等于收了钱不给货。
    // 现在只计次不拦截（额度侧 canHit 对 outline 恒放行），刷量由"生成要扣次数"兜住。
    quotaCall(openid, { action: 'hit', scene: 'outline' }).catch(() => {});
    try {
      // 前台大纲**不做联网检索**：大纲 LLM 本身 35-50s，再塞检索必撞 60s 上限
      // → 超时转后台 → 大纲从头重做，一次行程平白多两三分钟。
      // 联网核对班次改由后台任务专轮完成（见 runJobRound），大纲阶段只管快。
      const res = await generateOutlineWithHotelCheck(event, {});
      return {
        code: 0,
        data: {
          title: res.title,
          summary: res.summary,
          startDate: res.startDate,
          endDate: res.endDate,
          days: res.days,
          outline: res.outline,
          schedule: null,              // 班次核对在后台专轮做，这里恒为空
          version: GEN_VERSION,
        },
      };
    } catch (e) {
      console.error('[generatePlan] outline error:', e);
      return { code: -1, msg: e.message || '路线规划失败' };
    }
  }

  // ③ 阶段二：展开逐天详情 + 闹钟 + 建议，并入库
  //    入参 = 原始输入 + 阶段一返回的 { title, summary, outline }
  //    续跑：前端拿到 partial=true 就带上 tripId + doneDayIndexes 再调一次，
  //          直到 partial=false（用户全程只看到"正在细化…"）
  try {
    if (!event.dest && !event.destCity) return { code: -1, msg: '缺少目的地' };

    // ★ 后台模式：建任务 → 跑首轮 → 立刻返回。用户就算马上退出小程序，
    //   剩下的轮次也会由定时触发器（genWorker）接着跑完并自动入库。
    if (event.jobMode) {
      const made = await createJob(openid, event);
      if (made.code !== 0) return { code: made.code, msg: made.msg, needPay: made.needPay };
      try {
        const out = await runJobRound(openid, made.job);
        return { code: 0, data: out };
      } catch (err) {
        await cloud.database().collection(COL_JOB).doc(made.job._id).update({
          data: {
            status: 'failed', error: String(err.message || err).slice(0, 100),
            updatedAt: Date.now(), leaseUntil: 0, leaseOwner: '',
          },
        }).catch(() => {});
        await updateTripGeneration(cloud.database(), made.job.tripId, {
          genStatus: 'failed',
          genError: String(err.message || err).slice(0, 100),
          jobId: '',
        });
        throw err;
      }
    }

    // 只在首次生成前查额度（带 tripId 的是续跑，那一次的钱已经扣过了，放行让它跑完）
    if (!event.tripId) {
      const chk = await quotaCall(openid, { action: 'check', scene: 'plan' });
      if (chk.code === -2) return { code: -2, msg: chk.msg || '次数用完了，买个套餐继续吧', needPay: true };
      if (chk.code === -3) return { code: -3, msg: chk.msg || '暂时无法生成' };
    }
    const budget = event.budgetMs ? Number(event.budgetMs) : undefined;
    const plan = await buildPlan(event, event, {
      doneDayIndexes: event.doneDayIndexes,
      attempts: event.attempts,     // 续跑时带回上一轮的失败次数
      budgetMs: budget,
    });
    // 续跑中途可能这一轮只完成了重试、没产出新条目（partial=true），这时要放行让它继续；
    // 只有彻底没有内容、也没有 tripId 可合并时才算失败。
    if (!plan || (!plan.items.length && !plan.partial && !event.tripId)) {
      return { code: -1, msg: 'AI 没有生成出有效行程，请调整需求后重试' };
    }
    const data = await savePlan(openid, plan, event.tripId, '', event.outline);
    // 落库成功才扣费：大纲阶段没生成出来不收钱（避免"失败也扣费"的投诉）。
    // bizKey 用 tripId，续跑多轮也只扣一次（quota 侧按 bizKey 幂等）。
    if (data && data.tripId) {
      await quotaCall(openid, {
        action: 'consume', scene: 'plan', bizKey: `plan:${data.tripId}`, tripId: data.tripId,
      });
    }
    return { code: 0, data };
  } catch (err) {
    console.error('[generatePlan] build error:', err);
    return { code: -1, msg: err.message || '生成失败' };
  }
};
