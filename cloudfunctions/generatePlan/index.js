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
const GEN_VERSION = 'v1.0-gen';

/** 阶段二：写库（行程 + 闹钟 + 建议） */
async function savePlan(openid, plan) {
  const db = cloud.database();
  const now = Date.now();
  const items = plan.items;

  // 地理编码：地点名 → 经纬度（供 wx.openLocation 打开微信原生地图）
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
    console.error('[generatePlan] 地理编码失败（不影响主流程）:', e.message);
  }

  const tripData = {
    _openid: openid,
    title: plan.title,
    summary: plan.summary,
    startDate: plan.startDate,
    endDate: plan.endDate,
    sourceType: 'ai',          // 区别于上传文档解析出来的攻略
    sourceFileID: '',
    items,
    createdAt: now,
    updatedAt: now,
    genVersion: GEN_VERSION,
  };
  const addRes = await db.collection(COL_TRIP).add({ data: tripData });
  const tripId = addRes._id;

  // 闹钟：plan.js 已经算好 fireAt（时间戳）+ fireAtStr（北京时间墙面时刻）
  const alarms = (plan.alarms || []).map((a) => ({
    _openid: openid,
    tripId,
    title: a.title,
    note: a.note || '',
    fireAt: a.fireAt,
    fireAtStr: a.fireAtStr,
    type: a.type || 'other',
    source: a.source || 'ai',
    createdAt: now,
    updatedAt: now,
  }));
  for (let i = 0; i < alarms.length; i += 20) {
    await Promise.all(alarms.slice(i, i + 20).map((a) => db.collection(COL_ALARM).add({ data: a })));
  }

  // 旅行建议
  const s = plan.suggestions || {};
  if (s.weather || s.gear || s.food || s.tips || s.transport || s.budget) {
    await db.collection(COL_SUG).add({
      data: {
        _openid: openid,
        tripId,
        weather: s.weather || '',
        gear: s.gear || '',
        food: s.food || '',
        tips: s.tips || '',
        transport: s.transport || '',
        budget: s.budget || '',
        generatedAt: now,
      },
    });
  }

  console.log('[generatePlan] 入库完成 tripId=%s 条目=%d 闹钟=%d 版本=%s',
    tripId, items.length, alarms.length, GEN_VERSION);

  return {
    tripId,
    title: tripData.title,
    startDate: tripData.startDate,
    endDate: tripData.endDate,
    itemCount: items.length,
    alarmCount: alarms.length,
    version: GEN_VERSION,
  };
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

  // ② 阶段一：生成路线大纲（~20s）。先给前端展示，用户不满意可以换一版。
  if (action === 'outline') {
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

  // ③ 阶段二：展开逐天详情 + 闹钟 + 建议，并入库（~35s）
  //    入参 = 原始输入 + 阶段一返回的 { title, summary, outline }
  try {
    if (!event.dest && !event.destCity) return { code: -1, msg: '缺少目的地' };
    const plan = await buildPlan(event, event);
    if (!plan || !plan.items.length) {
      return { code: -1, msg: 'AI 没有生成出有效行程，请调整需求后重试' };
    }
    return { code: 0, data: await savePlan(openid, plan) };
  } catch (err) {
    console.error('[generatePlan] build error:', err);
    return { code: -1, msg: err.message || '生成失败' };
  }
};
