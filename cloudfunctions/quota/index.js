// cloudfunctions/quota/index.js
// 额度中心：攻略生成次数、会员有效期、邀请奖励、防刷日限额
//
// 谁会调它：
//   · 小程序前端（查额度、邀请、下单前确认）
//   · generatePlan / parseTravelPlan（生成成功后扣费，云函数间调用）
//   · virtualPay（支付发货时加额度）
//
// ⚠️ 部署：右键本函数 → 上传并部署（云端安装依赖）
// ⚠️ 数据库：users（用户档案）、quota_logs（额度流水，做幂等用）
//    两个集合不存在也没关系，本函数会自动建（initdb 里也补上了）
//
// 安全约定（重要）：
//   加额度的操作（refund / deliver / 邀请奖励）只认微信上下文里的 openid，
//   不接受参数传进来的 openid —— 否则任何人都能给自己加次数。
//   扣减类操作允许云函数间调用时带 openid（最坏结果是帮别人多扣一次，
//   攻击者没有收益）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const R = require('./rules');

const COL_USER = 'users';
const COL_LOG = 'quota_logs';

const db = cloud.database();

// ============================================================
// 用户档案读写
// ============================================================

async function loadUser(openid) {
  try {
    const res = await db.collection(COL_USER).where({ _openid: openid }).limit(1).get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    // 集合不存在时先建一次（首次部署会遇到）
    if (/not exist|collection/i.test(e.errMsg || e.message || '')) {
      try { await db.createCollection(COL_USER); } catch (e2) {}
      return null;
    }
    throw e;
  }
}

async function ensureUser(openid) {
  const now = Date.now();
  let u = await loadUser(openid);
  if (u) {
    // 存量用户（收费功能上线前就注册过的）档案里没有额度字段，
    // 直接按 0 处理会让人一升级就"没次数"——给没领过赠送的补发一次。
    const x = R.normalizeUser(u);
    if (!u.gifted && !x.quota && !x.giftQuota && !x.vipUntil) {
      const patch = {
        giftQuota: R.LIMITS.gift,
        giftExpireAt: Date.now() + R.LIMITS.giftDays * 86400000,
        gifted: true,
        inviteCode: x.inviteCode || R.genInviteCode(openid),
      };
      await patchUser(u._id, patch).catch(() => {});
      return Object.assign({}, u, patch);
    }
    return u;
  }
  const doc = {
    _openid: openid,
    createdAt: now,
    lastLoginAt: now,
    nickname: '旅行者',
    avatarUrl: '',
    quota: 0,
    giftQuota: R.LIMITS.gift,                                  // 新用户送 3 次
    giftExpireAt: now + R.LIMITS.giftDays * 86400000,          // 30 天内有效
    gifted: true,
    vipUntil: 0,
    inviteCode: R.genInviteCode(openid),
    inviteCount: 0,
    inviteRewarded: 0,
    totalGen: 0,
    dayStat: {},
  };
  try {
    const add = await db.collection(COL_USER).add({ data: doc });
    return Object.assign({ _id: add._id }, doc);
  } catch (e) {
    // 并发创建可能撞车：回读一次
    return await loadUser(openid);
  }
}

async function patchUser(id, patch) {
  if (!id || !Object.keys(patch).length) return;
  await db.collection(COL_USER).doc(id).update({ data: patch });
}

// ============================================================
// 额度流水（幂等：同一个 bizKey 只扣一次）
// ============================================================

async function findLog(openid, bizKey, action) {
  try {
    const res = await db.collection(COL_LOG)
      .where({ _openid: openid, bizKey, action }).limit(1).get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    if (/not exist|collection/i.test(e.errMsg || e.message || '')) {
      try { await db.createCollection(COL_LOG); } catch (e2) {}
      return null;
    }
    throw e;
  }
}

async function addLog(openid, bizKey, action, extra) {
  try {
    await db.collection(COL_LOG).add({
      data: Object.assign({ _openid: openid, bizKey, action, ts: Date.now() }, extra || {}),
    });
  } catch (e) {
    console.warn('[quota] 流水写入失败（不影响主流程）:', e.message);
  }
}

// ============================================================
// 对外信息
// ============================================================

function publicInfo(u, ts) {
  const x = R.normalizeUser(u);
  const av = R.available(x, ts);
  const st = R.todayStat(x, ts);
  return {
    quota: Math.max(0, x.quota),
    gift: R.giftLeft(x, ts),
    giftExpireAt: x.giftExpireAt,
    vip: R.isVip(x, ts),
    vipUntil: x.vipUntil,
    vipLeft: av.vipLeft,
    total: av.total,
    dayGen: st.gen,      // 只做统计展示：不再有"每天几次"的上限
    inviteCode: x.inviteCode,
    inviteCount: x.inviteCount,
    inviteRewarded: x.inviteRewarded,
    inviteCap: R.LIMITS.inviteCap,
    totalGen: x.totalGen,
  };
}

function goodsInfo() {
  return R.GOODS.map((g) => ({
    id: g.id, name: g.name, price: g.price, desc: g.desc, tip: g.tip, badge: g.badge || '',
    kind: g.kind, add: g.add || 0, days: g.days || 0,
    priceText: `¥${(g.price / 100).toFixed(g.price % 100 === 0 ? 0 : 2)}`,
  }));
}

// ============================================================
// 各 action
// ============================================================

/** 查额度 */
async function actionInfo(openid) {
  const u = await ensureUser(openid);
  return {
    code: 0,
    data: Object.assign(publicInfo(u, Date.now()), { goods: goodsInfo(), limits: R.LIMITS }),
  };
}

/** 生成前确认：够不够、会不会撞日限额 */
async function actionCheck(openid, event) {
  const u = await ensureUser(openid);
  const scene = String(event.scene || 'plan');
  const r = R.canConsume(u, Date.now(), scene);
  return {
    code: 0,
    data: Object.assign({ ok: r.ok, scene, needPay: !!r.needPay, msg: r.msg || '' }, publicInfo(u, Date.now())),
  };
}

/**
 * 扣费：行程落库成功后才调（大纲阶段不扣，避免"没生成出来也扣钱"的投诉）
 * bizKey 必须稳定（如 plan:<tripId> / parse:<tripId>），重复调用只扣一次。
 */
async function actionConsume(openid, event) {
  const bizKey = String(event.bizKey || '').trim();
  if (!bizKey) return { code: -1, msg: '缺少 bizKey' };
  const dup = await findLog(openid, bizKey, 'consume');
  if (dup) return { code: 0, data: { ok: true, duplicated: true, source: dup.source || '' } };

  const u = await ensureUser(openid);
  const scene = String(event.scene || 'plan');
  const can = R.canConsume(u, Date.now(), scene);
  if (!can.ok) {
    return { code: can.needPay ? -2 : -3, msg: can.msg, data: { needPay: !!can.needPay } };
  }
  const { patch, source } = R.applyConsume(u, Date.now());
  await patchUser(u._id, patch);
  await addLog(openid, bizKey, 'consume', { scene, source, tripId: event.tripId || '' });
  return { code: 0, data: { ok: true, source, left: R.available(Object.assign({}, u, patch), Date.now()).total } };
}

/** 生成失败退回（只认真实登录态，防止自己给自己退） */
async function actionRefund(openid, event, trusted) {
  if (!trusted) return { code: -1, msg: '未登录，不能退额度' };
  const bizKey = String(event.bizKey || '').trim();
  if (!bizKey) return { code: -1, msg: '缺少 bizKey' };
  const log = await findLog(openid, bizKey, 'consume');
  if (!log) return { code: 0, data: { ok: true, skipped: true } };
  if (await findLog(openid, bizKey, 'refund')) return { code: 0, data: { ok: true, duplicated: true } };
  const u = await ensureUser(openid);
  const { patch } = R.applyRefund(u, Date.now(), log.source || 'quota');
  await patchUser(u._id, patch);
  await addLog(openid, bizKey, 'refund', { scene: log.scene || '' });
  return { code: 0, data: { ok: true } };
}

/** 非计费动作的日限额计数（大纲重生成 / 建议刷新）：不扣额度，只计次 */
async function actionHit(openid, event) {
  const scene = String(event.scene || 'outline');
  const u = await ensureUser(openid);
  const can = R.canHit(u, Date.now(), scene);
  if (!can.ok) return { code: -3, msg: can.msg, data: { ok: false } };
  const { patch } = R.applyHit(u, Date.now(), scene);
  await patchUser(u._id, patch);
  return { code: 0, data: { ok: true, left: can.left - 1 } };
}

/** 发货（支付成功后调）：加次数或延长会员期 */
async function actionDeliver(openid, event, trusted) {
  if (!trusted) return { code: -1, msg: '未登录，不能发货' };
  const u = await ensureUser(openid);
  const r = R.applyDeliver(u, Date.now(), String(event.goodsId || ''));
  if (!r.ok) return { code: -1, msg: r.msg };
  await patchUser(u._id, r.patch);
  return { code: 0, data: publicInfo(Object.assign({}, u, r.patch), Date.now()) };
}

/** 我的邀请信息 */
async function actionInviteInfo(openid) {
  const u = await ensureUser(openid);
  const x = R.normalizeUser(u);
  return {
    code: 0,
    data: {
      inviteCode: x.inviteCode,
      inviteCount: x.inviteCount,
      inviteRewarded: x.inviteRewarded,
      inviteCap: R.LIMITS.inviteCap,
      invitedBy: x.invitedBy,
      add: R.LIMITS.inviteAdd,
    },
  };
}

/**
 * 绑定邀请关系：新用户填了别人的邀请码 → 双方各 +1 次
 * 只能绑一次，且不能绑自己。
 */
async function actionBindInvite(openid, event, trusted) {
  if (!trusted) return { code: -1, msg: '未登录' };
  const code = String(event.code || '').trim().toUpperCase();
  if (!code) return { code: -1, msg: '请填写邀请码' };
  const me = await ensureUser(openid);
  const x = R.normalizeUser(me);
  if (x.inviteCode && x.inviteCode.toUpperCase() === code) {
    return { code: -1, msg: '不能填自己的邀请码哦' };
  }
  if (x.invitedBy) {
    return { code: -1, msg: `你已经用过邀请码了（${x.invitedBy}）` };
  }
  const inviterRes = await db.collection(COL_USER)
    .where({ inviteCode: code }).limit(1).get().catch(() => ({ data: [] }));
  const inviter = inviterRes.data && inviterRes.data[0];
  if (!inviter || inviter._openid === openid) {
    return { code: -1, msg: '邀请码无效' };
  }
  const reward = R.inviteReward(inviter, me, Date.now());
  await patchUser(inviter._id, reward.inviterPatch);
  await patchUser(me._id, Object.assign({}, reward.inviteePatch, { invitedBy: code }));
  await addLog(openid, `invite:${code}`, 'invite', {});
  return {
    code: 0,
    data: Object.assign(publicInfo(Object.assign({}, me, reward.inviteePatch), Date.now()), {
      reward: R.LIMITS.inviteAdd,
    }),
  };
}

/** 自检：配额配置、当前用户额度、商品表 */
async function actionDiag(openid) {
  const u = await ensureUser(openid);
  return {
    code: 0,
    data: {
      version: 'v1.0-quota',
      user: publicInfo(u, Date.now()),
      goods: goodsInfo(),
      limits: R.LIMITS,
    },
  };
}

// ============================================================
// 入口
// ============================================================

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const ctxOpenid = wxContext.OPENID || '';
  // 云函数间调用时 wxContext 可能拿不到 openid，此时用调用方传来的（调用方是从它自己的
  // wxContext 拿的，可信度等同）。来源不可信时只能做扣减类操作。
  const openid = ctxOpenid || String((event && event.openid) || '');
  // 内部调用令牌：virtualPay 这类后端服务要帮用户加额度时，
  // 云函数间调用拿不到微信上下文（trusted=false），靠这个环境变量放行。
  // 只有云端配了 INTERNAL_TOKEN 且对得上才算可信，前端猜不到。
  const internal = !!(process.env.INTERNAL_TOKEN
    && event && event.internalToken === process.env.INTERNAL_TOKEN);
  const trusted = !!ctxOpenid || internal;
  if (!openid) return { code: -1, msg: '未登录' };

  const action = String((event && event.action) || 'info');
  try {
    switch (action) {
      case 'info': return await actionInfo(openid);
      case 'check': return await actionCheck(openid, event);
      case 'consume': return await actionConsume(openid, event);
      case 'refund': return await actionRefund(openid, event, trusted);
      case 'hit': return await actionHit(openid, event);
      case 'deliver': return await actionDeliver(openid, event, trusted);
      case 'inviteInfo': return await actionInviteInfo(openid);
      case 'bindInvite': return await actionBindInvite(openid, event, trusted);
      case 'diag': return await actionDiag(openid);
      default: return { code: -1, msg: `未知 action：${action}` };
    }
  } catch (e) {
    console.error('[quota] %s error:', action, e);
    return { code: -1, msg: e.message || '额度服务异常' };
  }
};
