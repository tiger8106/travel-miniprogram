// cloudfunctions/virtualPay/index.js
// 微信虚拟支付：下单签名 + 发货（加额度/开会员）
//
// 为什么必须有后端：米大师的两道签名（paySig / signature）要用
// AppKey 和 session_key，这两样**绝不能下发给小程序**，只能在云函数里算。
//
// ⚠️ 后台要先做（否则下单必失败）：
//   1. 小程序后台 → 虚拟支付 → 基础配置：拿到 offerId、现网 AppKey、沙箱 AppKey
//   2. 虚拟支付 → 道具管理：建 3 个道具（ID 必须与本文件 GOODS 里的 id 一致）
//        plan_1    单次攻略    ¥3
//        plan_5    5 次卡      ¥10
//        vip_month 月卡        ¥20
//      道具要「发布到现网」，发布后约 10 分钟生效（-15014 就是这个没生效）
//   3. 云函数环境变量（本函数）：
//        XPAY_OFFER_ID          米大师 offerId
//        XPAY_APP_KEY           现网 AppKey（env=0 用）
//        XPAY_APP_KEY_SANDBOX   沙箱 AppKey（env=1 用，安卓自测时开）
//        XPAY_ENV               0=现网 1=沙箱（不填默认 0）
//        MP_APPID / MP_APPSECRET 可选：配了才能主动查单（不配就只靠平台回调发货）
//   4. 回调地址（可选但推荐）：云开发 HTTP 访问服务 → 路径指向本函数
//
// ⚠️ iOS 注意：苹果支付要在虚拟支付基础配置里单独打开，且没有沙箱，
//    只能现网真金白银自测（用 ¥3 最小档试一笔）。

const cloud = require('wx-server-sdk');
const https = require('https');
const S = require('./sign');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
// 商品与权益规则和 quota 云函数同源（云函数目录互相隔离，只能放一份拷贝，
// check-bindings.js 有断言盯着两份别走偏）
const R = require('./quota-rules');

const db = cloud.database();
const COL_ORDER = 'orders';

const OFFER_ID = String(process.env.XPAY_OFFER_ID || '');
const ENV = Number(process.env.XPAY_ENV || 0);          // 0 现网 / 1 沙箱
const APP_KEY = ENV === 1
  ? String(process.env.XPAY_APP_KEY_SANDBOX || '')
  : String(process.env.XPAY_APP_KEY || '');
const MP_APPID = String(process.env.MP_APPID || '');
const MP_SECRET = String(process.env.MP_APPSECRET || '');

// ============================================================
// 签名（细节与坑都在 ./sign.js 里，本文件只负责把它用起来）
// ============================================================

function paySig(uri, body) { return S.paySig(APP_KEY, uri, body); }
function userSig(sessionKey, body) { return S.userSig(sessionKey, body); }
function genOutTradeNo() { return S.genOutTradeNo(); }

// ============================================================
// 订单
// ============================================================

async function ensureColl(name) {
  try {
    await db.collection(name).limit(1).get();
  } catch (e) {
    if (/not exist|collection/i.test(e.errMsg || e.message || '')) {
      try { await db.createCollection(name); } catch (e2) {}
    }
  }
}

async function loadOrder(outTradeNo) {
  await ensureColl(COL_ORDER);
  const res = await db.collection(COL_ORDER).where({ outTradeNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function loadOrderByOpenid(openid) {
  await ensureColl(COL_ORDER);
  const res = await db.collection(COL_ORDER)
    .where({ _openid: openid }).orderBy('createdAt', 'desc').limit(20).get();
  return res.data || [];
}

async function updateOrder(id, patch) {
  await db.collection(COL_ORDER).doc(id).update({ data: patch });
}

// ============================================================
// 发货：加额度 / 开会员（走 quota 云函数，保证额度逻辑只有一份）
// ============================================================

async function deliverOrder(order) {
  if (!order || order.status === 'delivered') {
    return { ok: true, duplicated: !!(order && order.status === 'delivered') };
  }
  try {
    const res = await cloud.callFunction({
      name: 'quota',
      data: {
        action: 'deliver',
        goodsId: order.goodsId,
        openid: order._openid,
        internalToken: process.env.INTERNAL_TOKEN || '',
      },
    });
    const r = (res && res.result) || {};
    if (r.code !== 0) {
      console.error('[virtualPay] 发货失败:', r.msg);
      return { ok: false, msg: r.msg };
    }
    await updateOrder(order._id, { status: 'delivered', deliveredAt: Date.now() });
    return { ok: true, data: r.data };
  } catch (e) {
    console.error('[virtualPay] 调用 quota 发货异常:', e.message);
    return { ok: false, msg: e.message };
  }
}

/**
 * 把订单标记为已支付（支付成功但还没发货时先记下来，发货可能异步）
 */
async function markPaid(order, payInfo) {
  if (order.status === 'paid' || order.status === 'delivered') return order;
  const patch = { status: 'paid', paidAt: Date.now(), payInfo: payInfo || {} };
  await updateOrder(order._id, patch);
  return Object.assign({}, order, patch);
}

// ============================================================
// 主动查单（支付成功后前端调，用来在没有回调时也能发货）
// ============================================================

function httpsPostJson(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** 小程序全局 access_token（cgi-bin/token 用 GET） */
function getAccessToken() {
  if (!MP_APPID || !MP_SECRET) return Promise.resolve('');
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential`
    + `&appid=${encodeURIComponent(MP_APPID)}&secret=${encodeURIComponent(MP_SECRET)}`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf).access_token || ''); } catch (e) { resolve(''); }
      });
    }).on('error', () => resolve(''));
  });
}

/**
 * 查订单状态。米大师字段名以官方文档为准，这里做宽容解析：
 * 只要能认出"已支付"就发货，认不出来返回 pending（不误判、不重复发）。
 */
async function queryOrder(order) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, pending: true, reason: 'no_access_token', msg: '未配置 MP_APPID/MP_APPSECRET，无法主动查单，等待平台回调发货' };
  }
  const uri = '/xpay/query_order';
  const body = JSON.stringify({
    openid: order._openid,
    offerId: OFFER_ID,
    outTradeNo: order.outTradeNo,
    env: ENV,
    ts: Math.floor(Date.now() / 1000),
  });
  const signed = JSON.stringify(Object.assign(JSON.parse(body), {
    paySig: paySig(uri, body),
    signature: '',
  }));
  try {
    const r = await httpsPostJson(`https://api.weixin.qq.com${uri}?access_token=${encodeURIComponent(token)}`, JSON.parse(signed));
    const state = String(r.order_state || r.orderState || r.state || r.status || r.order_status || r.orderStatus || '').toLowerCase();
    const paid = /paid|success|successed|已支付|完成|2|3/.test(state)
      || r.errcode === 0 && /paid|success/.test(JSON.stringify(r));
    return { ok: !!paid, pending: !paid, raw: r };
  } catch (e) {
    return { ok: false, pending: true, reason: 'request_failed', msg: e.message };
  }
}

// ============================================================
// action 实现
// ============================================================

/** 商品列表（价格/文案，前端付费页直接用） */
function actionGoods() {
  return {
    code: 0,
    data: {
      goods: R.GOODS.map((g) => ({
        id: g.id, name: g.name, price: g.price, desc: g.desc, tip: g.tip, badge: g.badge || '',
        priceText: `¥${(g.price / 100).toFixed(g.price % 100 === 0 ? 0 : 2)}`,
      })),
      enabled: !!OFFER_ID && !!APP_KEY,
    },
  };
}

/**
 * 下单：算好两道签名，把 signData 原样交给前端
 * 前端拿到后不要 JSON.stringify，直接透传（重新序列化会改字段顺序 → 验签失败 -15006）
 */
async function actionCreateOrder(openid, event) {
  const goodsId = String(event.goodsId || '');
  const g = R.goodsById(goodsId);
  if (!g) return { code: -1, msg: `未知商品：${goodsId}` };
  if (!OFFER_ID) return { code: -2, msg: '未配置 XPAY_OFFER_ID（云函数环境变量）' };
  if (!APP_KEY) return { code: -2, msg: ENV === 1 ? '未配置沙箱 AppKey（XPAY_APP_KEY_SANDBOX）' : '未配置现网 AppKey（XPAY_APP_KEY）' };

  // session_key：用前端传来的 code 换（wx.login），存 users 表供后续下单复用
  let sessionKey = '';
  const users = await db.collection('users').where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
  const me = users.data && users.data[0];
  let code = String(event.code || '');
  let codeErr = '';
  if (code) {
    try {
      const r = await cloud.openapi.auth.code2Session({ js_code: code });
      if (r && r.session_key) {
        sessionKey = r.session_key;
        if (me && me._id) {
          await db.collection('users').doc(me._id)
            .update({ data: { sessionKey, sessionKeyAt: Date.now() } }).catch(() => {});
        }
      } else {
        codeErr = `code2Session 没返回 session_key（errMsg=${String((r && r.errMsg) || JSON.stringify(r)).slice(0, 120)}）`;
      }
    } catch (e) {
      codeErr = String(e.errMsg || e.errCode || e.message || e).slice(0, 120);
      console.warn('[virtualPay] code2Session 失败:', codeErr);
    }
  } else {
    codeErr = '前端没有传 wx.login code';
  }
  if (!sessionKey && me) sessionKey = String(me.sessionKey || '');
  if (!sessionKey) {
    // 把真实原因带出去：云端日志里也有，别只给一句模糊提示
    console.error('[virtualPay] 拿不到 session_key:', codeErr, 'users记录存在:', !!me);
    return { code: -3, msg: `拿不到微信登录态（${codeErr || '无缓存 session_key'}）。请退出小程序重新进入后再买一次` };
  }

  const outTradeNo = genOutTradeNo();
  // 字段顺序固定：签名按这个串算，前端必须原样传
  const signData = S.buildSignData({
    offerId: OFFER_ID, buyQuantity: 1, env: ENV,
    productId: g.id, goodsPrice: g.price, outTradeNo, attach: openid,
  });

  await ensureColl(COL_ORDER);
  await db.collection(COL_ORDER).add({
    data: {
      _openid: openid,
      outTradeNo,
      goodsId: g.id,
      price: g.price,
      env: ENV,
      status: 'created',
      createdAt: Date.now(),
    },
  });

  return {
    code: 0,
    data: {
      signData,
      paySig: paySig('requestVirtualPayment', signData),
      signature: userSig(sessionKey, signData),
      mode: 'short_series_goods',
      env: ENV,
      outTradeNo,
    },
  };
}

/**
 * 支付成功后确认（前端 success 回调里调）：
 *   1. 主动查单确认真的付了钱（不能只信前端 success）
 *   2. 确认成功 → 发货；查不到 → 标记 paid，等回调补发
 */
async function actionConfirm(openid, event) {
  const outTradeNo = String(event.outTradeNo || '');
  if (!outTradeNo) return { code: -1, msg: '缺少订单号' };
  const order = await loadOrder(outTradeNo);
  if (!order || order._openid !== openid) return { code: -1, msg: '订单不存在' };
  if (order.status === 'delivered') return { code: 0, data: { ok: true, duplicated: true } };

  const q = await queryOrder(order);
  if (q.ok) {
    await markPaid(order, q.raw || {});
    const d = await deliverOrder(Object.assign({}, order, { status: 'paid' }));
    if (!d.ok) return { code: -4, msg: d.msg || '发货失败' };
    return { code: 0, data: { ok: true, delivered: true } };
  }
  // 查单不可用（没配 secret）或还没同步：先标记已支付，靠回调发货
  await markPaid(order, { from: 'confirm', reason: q.reason || '' });
  return {
    code: 0,
    data: { ok: false, pending: true, msg: q.msg || '支付结果确认中，额度稍后自动到账' },
  };
}

/** 把所有"已支付未发货"的订单补发一遍（用户点「额度没到账？刷新」时调） */
async function actionSync(openid) {
  const list = await loadOrderByOpenid(openid);
  let delivered = 0;
  let pending = 0;
  for (const o of list) {
    if (o.status === 'delivered') continue;
    if (o.status === 'paid') {
      const d = await deliverOrder(o);
      if (d.ok) delivered++; else pending++;
    } else {
      const q = await queryOrder(o);
      if (q.ok) {
        await markPaid(o, q.raw || {});
        const d = await deliverOrder(Object.assign({}, o, { status: 'paid' }));
        if (d.ok) delivered++; else pending++;
      } else {
        pending++;
      }
    }
  }
  return { code: 0, data: { delivered, pending } };
}

/**
 * 米大师发货回调（后台配的回调地址指向本函数）
 * 宽容解析：只认订单号 + 金额对得上就发货，幂等（已发过的不再发）。
 */
async function actionNotify(body) {
  let payload = body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
  }
  const outTradeNo = String(payload.outTradeNo || payload.out_trade_no || '');
  if (!outTradeNo) return { errcode: -1, errmsg: 'missing outTradeNo' };
  const order = await loadOrder(outTradeNo);
  if (!order) return { errcode: -1, errmsg: 'order not found' };
  const price = Number(payload.goodsPrice || payload.goods_price || order.price || 0);
  if (price && order.price && price !== order.price) {
    console.warn('[virtualPay] 回调金额与订单不符 %s: %s vs %s', outTradeNo, price, order.price);
    return { errcode: -1, errmsg: 'price mismatch' };
  }
  await markPaid(order, payload);
  const d = await deliverOrder(Object.assign({}, order, { status: 'paid' }));
  return d.ok ? { errcode: 0, errmsg: 'success' } : { errcode: -2, errmsg: d.msg || 'deliver failed' };
}

/** 自检：配置缺什么一眼看到（上线前必跑） */
function actionDiag() {
  const miss = [];
  if (!OFFER_ID) miss.push('XPAY_OFFER_ID');
  if (!APP_KEY) miss.push(ENV === 1 ? 'XPAY_APP_KEY_SANDBOX' : 'XPAY_APP_KEY');
  return {
    code: 0,
    data: {
      version: 'v1.1-pay',
      env: ENV,
      envText: ENV === 1 ? '沙箱（安卓可自测）' : '现网',
      offerId: OFFER_ID ? `${OFFER_ID.slice(0, 4)}****` : '',
      appKeyReady: !!APP_KEY,
      code2SessionReady: !!(cloud.openapi && cloud.openapi.auth && cloud.openapi.auth.code2Session),
      canQueryOrder: !!MP_APPID && !!MP_SECRET,
      internalTokenReady: !!process.env.INTERNAL_TOKEN,
      missing: miss,
      tip: miss.length
        ? `缺环境变量：${miss.join('、')}。去云开发控制台 → 云函数 virtualPay → 配置 → 环境变量里加`
        : '配置齐了，可以用安卓沙箱自测一笔',
      goods: R.GOODS.map((g) => ({ id: g.id, price: g.price })),
    },
  };
}

// ============================================================
// 入口（兼容两种调用：云函数调用 / HTTP 回调）
// ============================================================

exports.main = async (event, context) => {
  // HTTP 访问服务（回调）进来时，event 里带 httpMethod
  if (event && event.httpMethod) {
    let body = event.body || '{}';
    if (event.isBase64Encoded) {
      try { body = Buffer.from(body, 'base64').toString('utf8'); } catch (e) {}
    }
    const r = await actionNotify(body);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    };
  }

  const wxContext = cloud.getWXContext();
  const openid = (wxContext && wxContext.OPENID) || '';
  const action = String((event && event.action) || 'goods');

  if (action === 'diag') return actionDiag();
  if (action === 'goods') return actionGoods();
  if (!openid) return { code: -1, msg: '未登录' };

  try {
    if (action === 'createOrder') return await actionCreateOrder(openid, event);
    if (action === 'confirm') return await actionConfirm(openid, event);
    if (action === 'sync') return await actionSync(openid);
    if (action === 'notify') return await actionNotify(event.body || event.rawBody || event);
    return { code: -1, msg: `未知 action：${action}` };
  } catch (e) {
    console.error('[virtualPay] %s error:', action, e);
    return { code: -1, msg: e.message || '支付服务异常' };
  }
};
