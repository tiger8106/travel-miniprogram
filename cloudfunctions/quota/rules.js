/**
 * 计费规则（纯逻辑，不依赖 wx-server-sdk —— 本地能直接跑单测）
 *
 * 设计原则：
 *   1. 金额单位统一用「分」，避免浮点误差；
 *   2. 所有判定写成纯函数（输入 user + 时间戳，输出结论/patch），
 *      数据库读写放在 index.js，规则本身才能被单测钉死；
 *   3. 只认"权益类型"，不认任何具体业务名词 —— 以后加新功能复用同一套额度。
 */

// ---------------------------------------------------------------
// 商品档位（与小程序后台「虚拟支付 → 道具管理」里建的道具一一对应）
//   kind: quota = 次卡（加次数） / vip = 会员（加有效期）
// ---------------------------------------------------------------
const GOODS = [
  {
    id: 'plan_1', name: '单次攻略', price: 300, kind: 'quota', add: 1,
    desc: '制定或上传攻略 1 次', tip: '随时可用，不过期',
  },
  {
    id: 'plan_5', name: '5 次卡', price: 1000, kind: 'quota', add: 5,
    desc: '折合 ¥2 / 次', tip: '省 ¥5', badge: '人气',
  },
  {
    id: 'vip_month', name: '月卡', price: 2000, kind: 'vip', days: 30,
    desc: '30 天内最多生成 50 次', tip: '重度用户首选', badge: '划算',
  },
];

// ---------------------------------------------------------------
// 额度与限额
// ---------------------------------------------------------------
const LIMITS = {
  gift: 3,              // 新用户注册赠送次数
  giftDays: 30,         // 赠送额度有效期（天）—— 制造紧迫感，也防小号薅
  inviteAdd: 1,         // 邀请 1 位新用户双方各得
  inviteCap: 10,        // 邀请奖励上限（防刷小号）
  vipMonthQuota: 50,    // 月卡每月上限（商品本身的定义，不是防刷）
  tipsPerTripDay: 5,    // 每行程每天刷新建议次数
};

// ---------------------------------------------------------------
// 不再设限的两类动作（只统计，不拦截）
// ---------------------------------------------------------------
// ① 每天生成次数：用户是花真金白银买的次数，**只要还有额度就不该被时间卡住**。
//    之前"非会员 3 次/天"的本意是保护高德 Key 的日配额，但它会造成一个很糟的体验：
//    用户明明还剩 10 次没用，却被"今天用完了"挡在门外 —— 相当于买了东西不让拿。
//    日配额的风险改由"总次数"这道真正的闸门承担（次数用完了自然就停了）。
// ② 大纲「换个方案」：同一趟行程只收一次钱，换方案不扣额度；
//    之前限次是怕脚本刷大纲烧 token，但它同样会挡住"还有额度却生成不了"的正常用户，
//    得不偿失。刷量的真正防线是"生成要扣次数"，大纲本身不入库、不落盘，成本可控。
const UNLIMITED_SCENES = new Set(['outline']);

// 计费场景：一次完整攻略 = 1 次额度（大纲/细化/建议/闹钟/定位全链路都算在里面）
const SCENES = {
  plan: { name: '制定新攻略', cost: 1 },
  parse: { name: '上传攻略解析', cost: 1 },
};

// ---------------------------------------------------------------
// 时间工具（云函数跑 UTC，业务时间是北京时间）
// ---------------------------------------------------------------
function cnDate(ts) {
  const d = new Date(Number(ts || 0) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    month: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}`,
  };
}

function dayKey(ts) { return cnDate(ts).day; }
function monthKey(ts) { return cnDate(ts).month; }

// ---------------------------------------------------------------
// 用户档案归一化（老用户没有额度字段时按新用户处理，但只补缺省项）
// ---------------------------------------------------------------
function normalizeUser(u) {
  const x = u && typeof u === 'object' ? u : {};
  return {
    quota: Number.isFinite(x.quota) ? x.quota : 0,          // 购买/邀请得到（长期有效）
    giftQuota: Number.isFinite(x.giftQuota) ? x.giftQuota : 0, // 赠送（有有效期）
    giftExpireAt: Number.isFinite(x.giftExpireAt) ? x.giftExpireAt : 0,
    vipUntil: Number.isFinite(x.vipUntil) ? x.vipUntil : 0,
    vipMonth: typeof x.vipMonth === 'string' ? x.vipMonth : '',
    vipUsed: Number.isFinite(x.vipUsed) ? x.vipUsed : 0,
    gifted: !!x.gifted,                    // 注册赠送是否已发（防重复发）
    inviteCode: typeof x.inviteCode === 'string' ? x.inviteCode : '',
    invitedBy: typeof x.invitedBy === 'string' ? x.invitedBy : '',
    inviteCount: Number.isFinite(x.inviteCount) ? x.inviteCount : 0,
    inviteRewarded: Number.isFinite(x.inviteRewarded) ? x.inviteRewarded : 0,
    dayStat: (x.dayStat && typeof x.dayStat === 'object') ? x.dayStat : {},
    totalGen: Number.isFinite(x.totalGen) ? x.totalGen : 0,
  };
}

/** 是不是会员（vipUntil 是到期时间戳） */
function isVip(u, ts) {
  const x = normalizeUser(u);
  return x.vipUntil > (ts || Date.now());
}

/** 会员本月剩余次数（跨自然月自动重置） */
function vipLeft(u, ts) {
  const x = normalizeUser(u);
  if (!isVip(x, ts)) return 0;
  const used = x.vipMonth === monthKey(ts) ? x.vipUsed : 0;
  return Math.max(0, LIMITS.vipMonthQuota - used);
}

/** 赠送额度是否已过期（没过期才算数） */
function giftLeft(u, ts) {
  const x = normalizeUser(u);
  if (x.giftQuota <= 0) return 0;
  if (x.giftExpireAt && x.giftExpireAt < (ts || Date.now())) return 0;
  return x.giftQuota;
}

/** 当前可用次数（不含每日上限） */
function available(u, ts) {
  const x = normalizeUser(u);
  const now = ts || Date.now();
  return {
    vip: isVip(x, now),
    vipLeft: vipLeft(x, now),
    quota: Math.max(0, x.quota),
    gift: giftLeft(x, now),
    total: vipLeft(x, now) + giftLeft(x, now) + Math.max(0, x.quota),
  };
}

/** 今天的日统计（跨天自动归零） */
function todayStat(u, ts) {
  const x = normalizeUser(u);
  const k = dayKey(ts || Date.now());
  const s = (x.dayStat && x.dayStat.d === k) ? x.dayStat : {};
  return {
    gen: Number.isFinite(s.gen) ? s.gen : 0,
    outline: Number.isFinite(s.outline) ? s.outline : 0,
    tips: Number.isFinite(s.tips) ? s.tips : 0,
  };
}

// ---------------------------------------------------------------
// 核心判定：能不能生成一次攻略
//
// 唯一闸门 = **还有没有次数**。不再设"每天几次"这种时间维度的限制
// （详见上方 UNLIMITED_SCENES 的说明）。dayStat.gen 仍然照记，
// 只是用来看数据、不再拿来拒绝用户。
// ---------------------------------------------------------------
function canConsume(u, ts, scene) {
  const now = ts || Date.now();
  const x = normalizeUser(u);
  const av = available(x, now);

  if (av.total <= 0) {
    return { ok: false, reason: 'no_quota', msg: '次数用完了，买个套餐继续规划吧', needPay: true, left: 0 };
  }
  return {
    ok: true,
    scene: scene || 'plan',
    cost: (SCENES[scene] || SCENES.plan).cost,
    left: av.total,
    source: av.vipLeft > 0 ? 'vip' : (av.gift > 0 ? 'gift' : 'quota'),
  };
}

/**
 * 生成一次后的用户 patch（按「先用快过期的」顺序扣，别让用户白亏）
 *   会员 → 赠送额度（有有效期）→ 长期额度
 */
function applyConsume(u, ts) {
  const now = ts || Date.now();
  const x = normalizeUser(u);
  const patch = {};
  const mk = monthKey(now);
  const dk = dayKey(now);
  const st = todayStat(x, now);
  let source = 'quota';

  if (vipLeft(x, now) > 0) {
    patch.vipMonth = mk;
    patch.vipUsed = (x.vipMonth === mk ? x.vipUsed : 0) + 1;
    source = 'vip';
  } else if (giftLeft(x, now) > 0) {
    patch.giftQuota = Math.max(0, x.giftQuota - 1);
    source = 'gift';
  } else {
    patch.quota = Math.max(0, x.quota - 1);
    source = 'quota';
  }
  patch.totalGen = x.totalGen + 1;
  patch.dayStat = { d: dk, gen: st.gen + 1, outline: st.outline, tips: st.tips };
  return { patch, source };
}

/** 扣错了/生成失败时退回（只退长期额度与赠送，会员次数也回退） */
function applyRefund(u, ts, source) {
  const now = ts || Date.now();
  const x = normalizeUser(u);
  const patch = {};
  if (source === 'vip') {
    patch.vipMonth = monthKey(now);
    patch.vipUsed = Math.max(0, (x.vipMonth === monthKey(now) ? x.vipUsed : 0) - 1);
  } else if (source === 'gift') {
    patch.giftQuota = x.giftQuota + 1;
  } else {
    patch.quota = x.quota + 1;
  }
  patch.totalGen = Math.max(0, x.totalGen - 1);
  const st = todayStat(x, now);
  patch.dayStat = { d: dayKey(now), gen: Math.max(0, st.gen - 1), outline: st.outline, tips: st.tips };
  return { patch };
}

// ---------------------------------------------------------------
// 非计费动作的日限额（大纲重生成 / 建议刷新）：不扣额度，但计次数
// ---------------------------------------------------------------
function canHit(u, ts, scene) {
  const now = ts || Date.now();
  const x = normalizeUser(u);
  const st = todayStat(x, now);
  // 换方案不限次：用户还有额度却被"今天换够了"挡住是最伤的体验，
  // 而且大纲不入库、重复生成没有额外存储成本。
  if (UNLIMITED_SCENES.has(scene)) return { ok: true, left: 999, unlimited: true };
  let used = 0;
  let lim = 0;
  if (scene === 'tips') {
    used = Number(st.tips || 0);
    lim = LIMITS.tipsPerTripDay;
  } else {
    return { ok: true, left: 999 };
  }
  if (used >= lim) {
    return { ok: false, left: 0, msg: `今天这项操作到上限了（${lim} 次/天），明天再来` };
  }
  return { ok: true, left: lim - used };
}

function applyHit(u, ts, scene) {
  const now = ts || Date.now();
  const x = normalizeUser(u);
  const st = todayStat(x, now);
  const dk = dayKey(now);
  const next = { d: dk, gen: st.gen, outline: st.outline, tips: st.tips };
  if (scene === 'outline') next.outline = st.outline + 1;
  else if (scene === 'tips') next.tips = st.tips + 1;
  return { patch: { dayStat: next } };
}

// ---------------------------------------------------------------
// 发货：买了道具之后怎么加权益
// ---------------------------------------------------------------
function goodsById(id) {
  return GOODS.find((g) => g.id === id) || null;
}

function applyDeliver(u, ts, goodsId) {
  const g = goodsById(goodsId);
  if (!g) return { ok: false, msg: `未知商品：${goodsId}` };
  const now = ts || Date.now();
  const x = normalizeUser(u);
  const patch = {};
  if (g.kind === 'vip') {
    // 已有会员期就从到期日往后延，别让连买两个月的人吃亏
    const base = x.vipUntil > now ? x.vipUntil : now;
    patch.vipUntil = base + g.days * 86400000;
    patch.vipMonth = monthKey(now);
  } else {
    patch.quota = x.quota + g.add;
  }
  return { ok: true, patch, goods: g };
}

// ---------------------------------------------------------------
// 邀请奖励
// ---------------------------------------------------------------
function genInviteCode(seed) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混淆的 I/O/0/1
  let s = String(seed || '') + Date.now() + Math.random();
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += chars[Math.abs(hashStr(s + i)) % chars.length];
  }
  return out;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 邀请成功后双方各加 1 次（被邀请人给长期额度，邀请人受上限约束） */
function inviteReward(inviter, invitee, ts) {
  const now = ts || Date.now();
  const out = { inviterPatch: null, inviteePatch: null };
  const a = normalizeUser(inviter);
  const b = normalizeUser(invitee);
  if (a.inviteRewarded < LIMITS.inviteCap) {
    out.inviterPatch = {
      quota: a.quota + LIMITS.inviteAdd,
      inviteCount: a.inviteCount + 1,
      inviteRewarded: a.inviteRewarded + 1,
    };
  } else {
    out.inviterPatch = { inviteCount: a.inviteCount + 1 };   // 人数照记，次数封顶
  }
  out.inviteePatch = { quota: b.quota + LIMITS.inviteAdd };
  out.ts = now;
  return out;
}

module.exports = {
  GOODS, LIMITS, SCENES,
  dayKey, monthKey, normalizeUser, isVip, vipLeft, giftLeft, available,
  todayStat, UNLIMITED_SCENES, canConsume, applyConsume, applyRefund,
  canHit, applyHit, goodsById, applyDeliver, genInviteCode, inviteReward,
};
