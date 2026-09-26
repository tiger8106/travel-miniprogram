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
const { lookupSchedules } = require('./schedule');

const COL_TRIP = 'trips';
const COL_ALARM = 'ticket_alarms';
const COL_SUG = 'suggestions';
const COL_JOB = 'gen_jobs';
const COL_SCHED = 'schedule_cache';
const SCHED_TTL_MS = 7 * 24 * 3600 * 1000;   // 班次缓存 7 天

// 生成引擎版本（用于确认线上跑的是哪一版）
const GEN_VERSION = 'v1.3-bgjob';

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
async function savePlan(openid, plan, tripId, jobId) {
  const db = cloud.database();
  // 生成状态写进行程本身：「我的行程」列表要靠它显示"生成中 x/y"，
  // 不需要额外查任务表（列表接口一次拿全）。
  const genPatch = {
    genStatus: plan.partial ? 'generating' : 'done',
    genProgress: plan.progress || null,
    jobId: jobId || '',
  };
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
      ...genPatch,
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
        ...genPatch,
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
  const input = Object.assign({}, job.input || {});
  const payload = Object.assign({}, input, {
    tripId: job.tripId || '',
    doneDayIndexes: job.doneDayIndexes || [],
    attempts: job.attempts || {},
  });
  delete payload.action;
  delete payload.jobMode;

  const plan = await buildPlan(payload, payload, {
    doneDayIndexes: job.doneDayIndexes || [],
    attempts: job.attempts || {},
    budgetMs: job.budgetMs,
  });
  if (!plan || (!plan.items.length && !plan.partial && !job.tripId)) {
    throw new Error('AI 没有生成出有效行程，请调整需求后重试');
  }
  const data = await savePlan(openid, plan, job.tripId, job._id);
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
  };
  await db.collection(COL_JOB).doc(job._id).update({ data: patch }).catch((e) => {
    console.warn('[generatePlan] 任务进度写回失败:', e.message);
  });
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
// 真实班次缓存：同一条线路（from→to）7 天内不重复联网检索。
// 「换个方案」现在不限次数了，不缓存的话反复换几次就烧掉一堆检索。
// ---------------------------------------------------------------
async function schedCacheGet(key) {
  try {
    const r = await cloud.database().collection(COL_SCHED).doc(key).get();
    const d = r && r.data;
    if (d && d.expireAt > Date.now() && Array.isArray(d.list) && d.list.length) return d.list;
  } catch (e) { /* 没缓存/集合不存在都当没有 */ }
  return null;
}

async function schedCacheSet(key, list) {
  try {
    const now = Date.now();
    await cloud.database().collection(COL_SCHED).doc(key)
      .set({ data: { list, updatedAt: now, expireAt: now + SCHED_TTL_MS } });
  } catch (e) { console.warn('[generatePlan] 班次缓存写入失败:', e.message); }
}

/** 联网查真实班次的落地实现（带缓存 + 降级） */
function makeScheduleLookup() {
  return (segments, ms) => lookupSchedules(segments, ms, {
    get: schedCacheGet,
    set: schedCacheSet,
  });
}

/** 建任务（首轮）。只在建任务前查一次额度，续跑不再查（那一次的钱已经扣过了） */
async function createJob(openid, event) {
  const db = cloud.database();
  const chk = await quotaCall(openid, { action: 'check', scene: 'plan' });
  if (chk.code === -2) return { code: -2, msg: chk.msg || '次数用完了，买个套餐继续吧', needPay: true };
  if (chk.code === -3) return { code: -3, msg: chk.msg || '暂时无法生成' };
  const input = Object.assign({}, event);
  delete input.action;
  delete input.jobMode;
  const now = Date.now();
  const totalDays = ((input.outline || {}).days || []).length || 0;
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
    budgetMs: Number(event.budgetMs) || undefined,
    createdAt: now,
    updatedAt: now,
    leaseUntil: now + JOB_LEASE_MS,   // 建好就算占住，避免定时器抢在首轮之前
    error: '',
  };
  const add = await db.collection(COL_JOB).add({ data: doc });
  return { code: 0, job: Object.assign({}, doc, { _id: add._id }) };
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
        .where({ _openid: openid, status: 'running' })
        .orderBy('updatedAt', 'desc').limit(3).get();
      const now = Date.now();
      const jobs = (res.data || []).map((j) => jobPublic(j, now));
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
    const job = await loadJob(jobId);
    if (!job || job._openid !== openid) return { code: -1, msg: '任务不存在' };
    if (job.status !== 'running') return { code: 0, data: jobPublic(job, Date.now()) };
    const now = Date.now();
    // 乐观锁：带 expectRound 说明是"我刚跑完第 n 轮，我要接着跑" ——
    // 只要没别人推进过（round 没变）就放行，这样连续几轮之间不用干等租约过期。
    // 不带 expectRound 的是定时触发器，靠租约判断上一轮是不是已经死了。
    const busy = event.expectRound != null
      ? (Number(job.round) !== Number(event.expectRound))
      : (job.leaseUntil > now);
    if (busy) return { code: 0, data: Object.assign(jobPublic(job, now), { busy: true }) };
    try {
      const out = await runJobRound(openid, job);
      return { code: 0, data: out };
    } catch (err) {
      console.error('[generatePlan] resume error:', err);
      await cloud.database().collection(COL_JOB).doc(jobId).update({
        data: { status: 'failed', error: String(err.message || err).slice(0, 100), updatedAt: Date.now(), leaseUntil: 0 },
      }).catch(() => {});
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
    const t0 = Date.now();
    try {
      // 联网核对真实班次：模型凭记忆写的车次号/时刻和现实对不上（根因是它没有实时数据）。
      // 开搜索会让大纲多花几秒，所以给一个硬预算，超了就静默降级回"模型自己编排"。
      // 关掉：环境变量 LLM_ENABLE_SEARCH=0
      // 开搜索会让大纲多花几秒，所以两道约束：整体不越过 50s（云函数 60s），
      // 检索本身不超过 LLM_SEARCH_BUDGET_MS（默认 22s）。超了就静默降级。
      const wantSearch = process.env.LLM_ENABLE_SEARCH !== '0';
      const res = await generateOutline(event, wantSearch ? {
        scheduleLookup: makeScheduleLookup(),
        scheduleDeadline: t0 + 50000,
        scheduleBudgetMs: Number(process.env.LLM_SEARCH_BUDGET_MS) || 22000,
      } : {});
      return {
        code: 0,
        data: {
          title: res.title,
          summary: res.summary,
          startDate: res.startDate,
          endDate: res.endDate,
          days: res.days,
          outline: res.outline,
          schedule: res.schedule,      // { segments, replaced }：命中几段、换了几段
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
            updatedAt: Date.now(), leaseUntil: 0,
          },
        }).catch(() => {});
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
