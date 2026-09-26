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

const { generateOutline, buildPlan, dayDiff } = require('./plan');
const { geocodeBatch } = require('./geocode');

const COL_TRIP = 'trips';
const COL_ALARM = 'ticket_alarms';
const COL_SUG = 'suggestions';

// 生成引擎版本（用于确认线上跑的是哪一版）
const GEN_VERSION = 'v1.2-quota';

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
async function geocodeItems(items, cityOf) {
  try {
    const addrSet = new Set();
    items.forEach((it) => {
      if (it.startLocation) addrSet.add(it.startLocation);
      if (it.endLocation) addrSet.add(it.endLocation);
    });
    const coordMap = await geocodeBatch([...addrSet], cityOf);
    if (coordMap.size) {
      items.forEach((it) => {
        const s = coordMap.get(it.startLocation);
        const e = coordMap.get(it.endLocation);
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
      });
    }
    // 每条也记下它自己的城市：前端点导航时用它消歧，比整个行程的城市串准得多
    items.forEach((it) => {
      const to = it.endLocation || it.startLocation;
      if (to && !it.city) it.city = cityOf(to) || '';
    });
  } catch (e) {
    console.error('[generatePlan] 地理编码失败（不影响主流程）:', e.message);
  }
  return items;
}

/**
 * 写库（行程 + 闹钟 + 建议），支持续跑：
 *   - 第一次（含撞时间预算的半成品）→ 新建 trip
 *   - 后续轮次（带 tripId）→ 把新生成的天合并进已有 trip，最后再补闹钟和建议
 */
async function savePlan(openid, plan, tripId) {
  const db = cloud.database();
  const now = Date.now();
  // 每天的大地名（城市）：地理编码时带上，避免同名地点定位到别的城市。
  // 城市集合也存进 trip.region——前端点击导航、条目缺坐标需要实时查时，
  // 拿它继续消歧（只用于查询，不会拼进显示名称）。
  const dayCities = Array.isArray(plan.dayCities) ? plan.dayCities : [];
  const region = [...new Set(dayCities.filter(Boolean))].join(' ');
  const firstCity = dayCities.find(Boolean) || '';
  // 地址里自带城市名时以它为准（取最长匹配，避免"南宁东站"被短词误伤）：
  // 城际段的终点常常不在当天城市里，用当天城市去约束会整条定位失败。
  const cityInAddr = (addr) => {
    let best = '';
    dayCities.forEach((c) => {
      if (c && String(addr || '').indexOf(c) >= 0 && c.length > best.length) best = c;
    });
    return best;
  };
  const cityOf = (addr) => {
    const idx = plan.addrDay ? plan.addrDay.get(addr) : -1;
    const c = idx >= 0 ? (dayCities[idx] || '') : '';
    // 兜底用第一个城市：plan.dest 是"桂林、龙脊梯田、阳朔…"整串，
    // 直接塞给高德 city 参数只会被忽略，不能拿它兜底
    return cityInAddr(addr) || c || firstCity;
  };
  await geocodeItems(plan.items, cityOf);

  // 首轮颗粒无收（天天都失败）但还要续跑：别先建一个空行程，
  // 等哪一轮真有内容了再建，否则中途放弃会在「我的行程」里留下一条 0 条的空攻略。
  if (!tripId && !plan.items.length && plan.partial) {
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

  let finalTripId = tripId;
  let title = plan.title;
  let startDate = plan.startDate;
  let endDate = plan.endDate;
  let itemCount = plan.items.length;

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
      items: plan.items,
      createdAt: now,
      updatedAt: now,
      genVersion: GEN_VERSION,
    };
    const addRes = await db.collection(COL_TRIP).add({ data: tripData });
    finalTripId = addRes._id;
  } else {
    // 续跑合并：本次生成的天覆盖旧的，其余天保留，最后按 dayIndex 排序
    const old = await db.collection(COL_TRIP).doc(finalTripId).get();
    const oldData = (old && old.data) || {};
    const freshDays = new Set(plan.items.map((it) => it.dayIndex));
    const kept = (oldData.items || []).filter((it) => !freshDays.has(it.dayIndex));
    const merged = kept.concat(plan.items).sort((a, b) => (a.dayIndex || 0) - (b.dayIndex || 0));
    await db.collection(COL_TRIP).doc(finalTripId).update({
      data: {
        title: plan.title,
        summary: plan.summary,
        startDate: plan.startDate,
        endDate: plan.endDate,
        region,
        items: merged,
        updatedAt: now,
        genVersion: GEN_VERSION,
      },
    });
    title = plan.title;
    startDate = plan.startDate;
    endDate = plan.endDate;
    itemCount = merged.length;
  }

  // 只在最后一批（非 partial）写闹钟和建议，避免续跑时重复插入
  let alarmCount = 0;
  if (!plan.partial) {
    // 幂等：先把这个行程已有的 AI 闹钟清掉再写，重复生成不会翻倍
    const existed = await db.collection(COL_ALARM).where({ tripId: finalTripId, source: 'ai' }).get();
    for (let i = 0; i < (existed.data || []).length; i += 20) {
      await Promise.all(existed.data.slice(i, i + 20).map((a) =>
        db.collection(COL_ALARM).doc(a._id).remove()));
    }

    const alarms = (plan.alarms || []).map((a) => ({
      _openid: openid,
      tripId: finalTripId,
      title: a.title,
      note: a.note || '',
      fireAt: a.fireAt,
      fireAtStr: a.fireAtStr,
      type: a.type || 'other',
      source: 'ai',
      createdAt: now,
      updatedAt: now,
    }));
    for (let i = 0; i < alarms.length; i += 20) {
      await Promise.all(alarms.slice(i, i + 20).map((a) => db.collection(COL_ALARM).add({ data: a })));
    }
    alarmCount = alarms.length;

    const s = plan.suggestions || {};
    if (s.weather || s.gear || s.food || s.tips || s.transport || s.budget) {
      const oldSug = await db.collection(COL_SUG).where({ tripId: finalTripId }).get();
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

/**
 * ④ 自检：真机上「生成失败」时一键看清缺什么。
 *    只回报"配了 / 没配"的布尔值，绝不把密钥内容吐出去。
 *    排查顺序永远是：环境变量齐不齐 → 模型/端点对不对 → 网络连不连得上。
 */
async function runDiag(withPing) {
  const llm = require('./llm');
  const KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'AMAP_KEY'];
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
  const openid = wxContext.OPENID;
  if (!openid) return { code: -1, msg: '未登录' };

  const { action } = event || {};

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
    // 「换个方案」不扣额度（同一趟行程只收一次钱），但要限次数——
    // 不限的话一次大纲 2 分钱，脚本刷起来照样烧钱。
    const hit = await quotaCall(openid, { action: 'hit', scene: 'outline' });
    if (hit.code === -3) return { code: -3, msg: hit.msg || '今天换方案的次数用完了' };
    try {
      const res = await generateOutline(event);
      return {
        code: 0,
        data: {
          title: res.title,
          summary: res.summary,
          startDate: res.startDate,
          endDate: res.endDate,
          days: res.days,
          outline: res.outline,
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
    // 只在首次生成前查额度（带 tripId 的是续跑，那一次的钱已经扣过了，放行让它跑完）
    if (!event.tripId) {
      const chk = await quotaCall(openid, { action: 'check', scene: 'plan' });
      if (chk.code === -2) return { code: -2, msg: chk.msg || '次数用完了，买个套餐继续吧', needPay: true };
      if (chk.code === -3) return { code: -3, msg: chk.msg || '今天的生成次数到上限了' };
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
    const data = await savePlan(openid, plan, event.tripId);
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
