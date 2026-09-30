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
//        MP_APPID / MP_APPSECRET 必填：查单与登录态都需要
//        INTERNAL_TOKEN        必填：与 quota 云函数配置成同一个强随机值
//        WX_MSG_TOKEN          必填：消息推送 URL 校验与回调验签 Token
//        WX_MSG_AES_KEY        安全模式必填（明文 JSON/XML 可不填）
//   4. 回调地址：云开发 HTTP 访问服务 → 路径指向本函数
//
// ⚠️ iOS 注意：苹果支付要在虚拟支付基础配置里单独打开，且没有沙箱，
//    只能现网真金白银自测（用 ¥3 最小档试一笔）。

const cloud = require('wx-server-sdk');
const https = require('https');
const crypto = require('crypto');
const S = require('./sign');
const X = require('./xpay');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
// 商品与权益规则和 quota 云函数同源（云函数目录互相隔离，只能放一份拷贝，
// check-bindings.js 有断言盯着两份别走偏）
const R = require('./quota-rules');

const db = cloud.database();
const COL_ORDER = 'orders';
const MAX_PENDING_ORDERS = 10;

const OFFER_ID = String(process.env.XPAY_OFFER_ID || '');
const ENV = Number(process.env.XPAY_ENV || 0);          // 0 现网 / 1 沙箱
const APP_KEY = ENV === 1
  ? String(process.env.XPAY_APP_KEY_SANDBOX || '')
  : String(process.env.XPAY_APP_KEY || '');
const MP_APPID = String(process.env.MP_APPID || '');
const MP_SECRET = String(process.env.MP_APPSECRET || '');
const WX_MSG_TOKEN = String(process.env.WX_MSG_TOKEN || '');
const WX_MSG_AES_KEY = String(process.env.WX_MSG_AES_KEY || '');

// ============================================================
// 签名（细节与坑都在 ./sign.js 里，本文件只负责把它用起来）
// ============================================================

// 带显式 key 的版本：iOS 自动切现网时用（全局 APP_KEY 还是沙箱的）
function paySigWith(key, uri, body) { return S.paySig(key, uri, body); }
function userSigWith(sessionKey, body) { return S.userSig(sessionKey, body); }
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

async function loadOrderByOpenid(openid, limit) {
  await ensureColl(COL_ORDER);
  const res = await db.collection(COL_ORDER)
    .where({ _openid: openid }).orderBy('createdAt', 'desc').limit(limit || 20).get();
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
        orderNo: order.outTradeNo,
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
  if (order.status === 'delivered') return order;
  const patch = { status: 'paid', paidAt: payInfo.platformPaidAt || Date.now() };
  await updateOrder(order._id, patch);
  return Object.assign({}, order, patch);
}

// ============================================================
// 主动查单（支付成功后前端调，用来在没有回调时也能发货）
// ============================================================

function httpsPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
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
    req.setTimeout(8000, () => req.destroy(new Error('虚拟支付接口超时')));
    req.write(data);
    req.end();
  });
}

/** GET 一个 JSON 接口（jscode2session 用；失败时 resolve 错误对象，不 reject） */
function httpsGetJson(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ errcode: -1, errmsg: `响应不是 JSON：${buf.slice(0, 80)}` }); }
      });
    }).on('error', (e) => resolve({ errcode: -1, errmsg: e.message }));
  });
}

/**
 * code 换 session_key。
 * ⚠️ 不能用 cloud.openapi.auth.code2Session：云调用里没有这个 API（报 -604100 API not found），
 * 只能拿 MP_APPID/MP_APPSECRET 走 HTTP 直调 sns/jscode2session。
 */
async function code2SessionHttp(code) {
  if (!MP_APPID || !MP_SECRET) {
    return { errcode: -1, errmsg: '未配置 MP_APPID/MP_APPSECRET（code 换 session_key 只能走 HTTP，云调用没有 code2Session）' };
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(MP_APPID)}`
    + `&secret=${encodeURIComponent(MP_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const r = await httpsGetJson(url);
  if (r && r.session_key) return r;
  return { errcode: (r && r.errcode) || -1, errmsg: `jscode2session ${JSON.stringify(r).slice(0, 120)}` };
}

/** 小程序全局 access_token（cgi-bin/token 用 GET） */
let tokenCache = { value: '', until: 0 };
function getAccessToken() {
  if (tokenCache.value && tokenCache.until > Date.now()) return Promise.resolve(tokenCache.value);
  if (!MP_APPID || !MP_SECRET) return Promise.resolve('');
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential`
    + `&appid=${encodeURIComponent(MP_APPID)}&secret=${encodeURIComponent(MP_SECRET)}`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          const value = parsed.access_token || '';
          if (value) tokenCache = { value, until: Date.now() + Math.max(60, Number(parsed.expires_in || 7200) - 300) * 1000 };
          resolve(value);
        } catch (e) { resolve(''); }
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
    return { ok: false, pending: true, reason: 'no_access_token', msg: '无法取得微信 access_token，暂不能核实支付或发货' };
  }
  const uri = '/xpay/query_order';
  const key = X.appKeyForEnv(order.env, {
    production: process.env.XPAY_APP_KEY,
    sandbox: process.env.XPAY_APP_KEY_SANDBOX,
  });
  if (!key) return { ok: false, pending: true, reason: 'missing_app_key', msg: '缺少对应支付环境的 AppKey' };
  const request = X.signedRequest(uri, X.queryPayload(order), token, key);
  try {
    const r = await httpsPostJson(request.url, request.body);
    const result = X.readQueryResponse(r, order);
    return Object.assign({ pending: !result.ok }, result);
  } catch (e) {
    return { ok: false, pending: true, reason: 'request_failed', msg: e.message };
  }
}

async function notifyProvided(order) {
  const token = await getAccessToken();
  const key = X.appKeyForEnv(order.env, {
    production: process.env.XPAY_APP_KEY,
    sandbox: process.env.XPAY_APP_KEY_SANDBOX,
  });
  if (!token || !key) return { ok: false, reason: 'missing_credentials' };
  const request = X.signedRequest('/xpay/notify_provide_goods', X.providePayload(order), token, key);
  try {
    const response = await httpsPostJson(request.url, request.body);
    // 部分网关会把 errcode 序列化成字符串；按数值判断，避免已经回传成功却被本地记成失败。
    return { ok: Number(response.errcode) === 0, reason: response.errmsg || `errcode:${response.errcode}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 同一笔商户订单号在微信侧查证后，补齐本地状态和微信侧发货状态。 */
async function reconcileOrder(order, options) {
  const fromNotify = !!(options && options.fromNotify);
  const q = await queryOrder(order);
  const now = Date.now();
  if (q.platform) {
    await updateOrder(order._id, Object.assign({}, q.platform, {
      lastQueriedAt: now, lastQueryReason: q.reason || '',
    }));
  } else {
    await updateOrder(order._id, { lastQueriedAt: now, lastQueryReason: q.reason || 'unknown' });
  }
  if (!q.ok) {
    // 老版本把查单失败也标记为 paid；现在不允许用这个状态补发。
    if (order.status === 'paid') await updateOrder(order._id, { status: 'verifying' });
    if (q.platform && [5, 8].includes(q.status)) {
      // 回调可能丢失，但查单已经确认退款完成；先标记争议单，权益回收仍走售后复核。
      await updateOrder(order._id, {
        status: 'refunded',
        paymentReview: true,
        refundFee: Number(q.platform.refundFee || 0),
        refundAt: Number(q.platform.platformPaidAt || 0) || Date.now(),
      });
    } else if (order.status === 'delivered' && q.platform && [0, 1, 6].includes(q.status)) {
      await updateOrder(order._id, { paymentReview: true });
    }
    return { delivered: false, pending: true, reason: q.reason || q.msg || 'query_pending' };
  }
  await updateOrder(order._id, { paymentReview: false, lastVerifiedAt: now });
  let current = order;
  if (current.status !== 'delivered') {
    current = await markPaid(current, q.platform || {});
    const delivered = await deliverOrder(current);
    if (!delivered.ok) return { delivered: false, pending: true, reason: delivered.msg || 'deliver_failed' };
    current = Object.assign({}, current, { status: 'delivered' });
  }
  // 收到官方 xpay_goods_deliver_notify 时，返回 ErrCode=0 本身就是发货确认；
  // notify_provide_goods 仅用于前端确认/后台补偿查单，避免在回调内重复调用。
  let notifyResult = { ok: true };
  if (q.status === 4 || fromNotify) {
    await updateOrder(order._id, { platformNotifiedAt: now, platformNotifyError: '' });
  } else if (!fromNotify) {
    notifyResult = await notifyProvided(current);
    await updateOrder(order._id, notifyResult.ok
      ? { platformNotifiedAt: now, platformNotifyError: '' }
      : { platformNotifyError: notifyResult.reason || 'notify_failed' });
  }
  return {
    delivered: order.status !== 'delivered',
    // 权益已发放但回传失败时仍算待处理，让前端/回调重试，而不是把它当成完整成功。
    pending: !notifyResult.ok,
    verified: true,
    notifyOk: notifyResult.ok,
    notifyReason: notifyResult.reason || '',
  };
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
      enabled: !!OFFER_ID && !!APP_KEY && !!MP_APPID && !!MP_SECRET && !!process.env.INTERNAL_TOKEN,
    },
  };
}

/**
 * 选支付环境：iOS / 开发者工具不支持沙箱 → 自动切现网
 * @returns {{env:number, appKey:string, platform:string, err?:string}}
 */
function pickPayEnv(platform) {
  let env = ENV;
  let appKey = APP_KEY;
  const p = String(platform || '').toLowerCase();
  if (env === 1 && (p === 'ios' || p === 'devtools')) {
    env = 0;
    appKey = String(process.env.XPAY_APP_KEY || '');
    if (!appKey) {
      return { env, appKey: '', platform: p, err: 'iOS 不支持沙箱支付：请在云函数 virtualPay 配置现网 AppKey（XPAY_APP_KEY），或把 XPAY_ENV 改回 0' };
    }
    console.log('[virtualPay] %s 设备下单自动切现网（沙箱仅安卓可测）', p);
  }
  if (!appKey) {
    return { env, appKey: '', platform: p, err: env === 1 ? '未配置沙箱 AppKey（XPAY_APP_KEY_SANDBOX）' : '未配置现网 AppKey（XPAY_APP_KEY）' };
  }
  return { env, appKey, platform: p };
}

/**
 * 拿 session_key（userSig 要用）：
 *   主通道 HTTP 直调 jscode2session（云调用没有 code2Session，见 code2SessionHttp 注释）
 *   备用通道 users 表里缓存的 sessionKey
 * @returns {{sessionKey:string, err:string}}
 */
async function resolveSessionKey(openid, code) {
  const users = await db.collection('users').where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
  const me = users.data && users.data[0];
  let sessionKey = '';
  let err = '';

  if (code) {
    let r = await code2SessionHttp(code);
    if (!r.session_key) {
      err = r.errmsg || 'code2session 失败';
      try {
        const r2 = await cloud.openapi.auth.code2Session({ js_code: code });
        if (r2 && r2.session_key) r = r2;
      } catch (e2) {
        err += `；openapi 也不行（${String(e2.errMsg || e2.errCode || e2.message || e2).slice(0, 60)}）`;
      }
    }
    if (r && r.session_key) {
      sessionKey = r.session_key;
      err = '';
      if (me && me._id) {
        await db.collection('users').doc(me._id)
          .update({ data: { sessionKey, sessionKeyAt: Date.now() } }).catch(() => {});
      }
    } else {
      console.warn('[virtualPay] code 换 session_key 失败:', err);
    }
  } else {
    err = '前端没有传 wx.login code';
  }

  if (!sessionKey && me) sessionKey = String(me.sessionKey || '');
  if (!sessionKey) {
    console.error('[virtualPay] 拿不到 session_key:', err, 'users记录存在:', !!me);
  }
  return { sessionKey, err };
}

/** 打包前端拉起支付需要的两道签名（signData 必须原样透传，不能重新序列化） */
function buildPayParams(g, outTradeNo, price, attachOpenid, env, appKey, sessionKey) {
  const signData = S.buildSignData({
    offerId: OFFER_ID, buyQuantity: 1, env,
    productId: g.id, goodsPrice: price, outTradeNo, attach: attachOpenid,
  });
  return {
    signData,
    paySig: paySigWith(appKey, 'requestVirtualPayment', signData),
    signature: userSigWith(sessionKey, signData),
    mode: 'short_series_goods',
    env,
    outTradeNo,
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
  if (!MP_APPID || !MP_SECRET || !process.env.INTERNAL_TOKEN) {
    return { code: -2, msg: '支付核验或发货配置未完成，请联系商家' };
  }

  // 限制同一账号短时间堆积未支付订单，避免脚本刷库和后台对账噪声。
  await ensureColl(COL_ORDER);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const pending = await db.collection(COL_ORDER)
    .where({ _openid: openid, status: 'created', createdAt: db.command.gte(since) })
    .limit(MAX_PENDING_ORDERS + 1).get();
  if ((pending.data || []).length >= MAX_PENDING_ORDERS) {
    return { code: -2, msg: '已有多笔待支付订单，请先完成或取消后再下单' };
  }

  const picked = pickPayEnv(event.platform);
  if (picked.err) return { code: -2, msg: picked.err };

  const sk = await resolveSessionKey(openid, String(event.code || ''));
  if (!sk.sessionKey) {
    // 把真实原因带出去：云端日志里也有，别只给一句模糊提示
    return { code: -3, msg: `拿不到微信登录态（${sk.err || '无缓存 session_key'}）。请退出小程序重新进入后再买一次` };
  }

  const outTradeNo = genOutTradeNo();

  await db.collection(COL_ORDER).add({
    data: {
      _openid: openid,
      outTradeNo,
      goodsId: g.id,
      price: g.price,
      env: picked.env,
      platform: picked.platform,
      status: 'created',
      createdAt: Date.now(),
    },
  });

  return {
    code: 0,
    data: buildPayParams(g, outTradeNo, g.price, openid, picked.env, picked.appKey, sk.sessionKey),
  };
}

/**
 * 继续支付：对一笔「待支付」的订单，用**原来的订单号**重新签名让前端拉起支付
 * 不新建订单记录（否则同一笔购买会留两条单），原单支付成功后照常走 confirm 发货。
 */
async function actionRepay(openid, event) {
  const outTradeNo = String(event.outTradeNo || '');
  if (!outTradeNo) return { code: -1, msg: '缺少订单号' };
  if (!OFFER_ID) return { code: -2, msg: '未配置 XPAY_OFFER_ID（云函数环境变量）' };
  if (!MP_APPID || !MP_SECRET || !process.env.INTERNAL_TOKEN) {
    return { code: -2, msg: '支付核验或发货配置未完成，请联系商家' };
  }

  const order = await loadOrder(outTradeNo);
  if (!order || order._openid !== openid) return { code: -1, msg: '订单不存在' };
  if (order.status === 'delivered') return { code: -2, msg: '这笔订单已经到账了，不用再付' };
  if (order.status === 'paid') return { code: -2, msg: '这笔订单已支付，额度发放中，点「同步订单」即可' };
  if (order.status === 'cancelled') return { code: -2, msg: '这笔订单已取消，请回到付费页重新下单' };
  const checked = await queryOrder(order);
  if (checked.ok) {
    await reconcileOrder(order);
    return { code: -2, msg: '微信侧已支付，订单已同步，请勿重复付款' };
  }
  if (checked.status !== 1) return { code: -2, msg: '微信侧支付状态尚未确认，请先同步订单，避免重复扣款' };

  const g = R.goodsById(order.goodsId);
  if (!g) return { code: -3, msg: '商品已下架，请回到付费页重新购买' };

  const picked = pickPayEnv(event.platform || order.platform);
  if (picked.err) return { code: -2, msg: picked.err };
  if (picked.env !== Number(order.env || 0)) {
    return { code: -2, msg: '原订单支付环境与当前设备不一致，请重新下单' };
  }

  const sk = await resolveSessionKey(openid, String(event.code || ''));
  if (!sk.sessionKey) {
    return { code: -3, msg: `拿不到微信登录态（${sk.err || '无缓存 session_key'}）。请退出小程序重新进入后再试` };
  }

  // 价格以**下单时记录的为准**，防止期间调价导致与米大师下单金额不符
  const price = Number(order.price || g.price || 0);
  await updateOrder(order._id, { platform: picked.platform, lastPayAt: Date.now() }).catch(() => {});

  return {
    code: 0,
    data: buildPayParams(g, outTradeNo, price, openid, picked.env, picked.appKey, sk.sessionKey),
  };
}

/**
 * 取消订单：只允许取消自己「待支付」的订单
 *
 * 为什么是「取消」而不是「删除」：只把状态置为 cancelled、保留记录，
 * 不物理删除——万一用户说"我付过钱"，订单还在就能查证；真删了就说不清了。
 * 已支付 / 已到账的不给取消：那是对账和售后的凭据。
 */
async function actionCancelOrder(openid, event) {
  const outTradeNo = String(event.outTradeNo || '');
  if (!outTradeNo) return { code: -1, msg: '缺少订单号' };

  const order = await loadOrder(outTradeNo);
  if (!order || order._openid !== openid) return { code: -1, msg: '订单不存在' };
  if (order.status === 'cancelled') return { code: 0, data: { ok: true, duplicated: true, outTradeNo } };
  if (order.status !== 'created') {
    return { code: -2, msg: '已支付 / 已到账的订单不能取消（用于对账和售后）' };
  }

  const checked = await queryOrder(order);
  if (checked.ok) {
    await reconcileOrder(order);
    return { code: -2, msg: '微信侧已支付，不能取消；已为你同步订单' };
  }
  if (checked.status !== 1) {
    return { code: -2, msg: '微信侧状态尚未确认，暂不能取消，请稍后同步订单' };
  }

  await updateOrder(order._id, { status: 'cancelled', cancelledAt: Date.now() });
  return { code: 0, data: { ok: true, outTradeNo } };
}

/**
 * 支付成功后确认（前端 success 回调里调）：
 *   1. 主动查单确认真的付了钱（不能只信前端 success）
 *   2. 确认成功 → 发货；查不到 → 标记核实中，等回调或重试
 */
async function actionConfirm(openid, event) {
  const outTradeNo = String(event.outTradeNo || '');
  if (!outTradeNo) return { code: -1, msg: '缺少订单号' };
  const order = await loadOrder(outTradeNo);
  if (!order || order._openid !== openid) return { code: -1, msg: '订单不存在' };
  if (order.status === 'delivered') return { code: 0, data: { ok: true, delivered: true, duplicated: true } };
  await updateOrder(order._id, { paymentReturnedAt: Date.now(), status: 'verifying' });
  const result = await reconcileOrder(Object.assign({}, order, { status: 'verifying' }));
  if (result.delivered) return { code: 0, data: { ok: true, delivered: true } };
  return {
    code: 0,
    data: { ok: false, pending: true, msg: '正在向微信核实支付结果，请稍后到我的订单同步' },
  };
}

/** 把所有"已支付未发货"的订单补发一遍（用户点「额度没到账？刷新」时调） */
async function actionSync(openid) {
  const all = await loadOrderByOpenid(openid, 50);
  const priority = (o) => o.status !== 'delivered' ? 0 : (o.platformNotifyError ? 1 : 2);
  const list = all.sort((a, b) => priority(a) - priority(b)
    || Number(a.lastQueriedAt || 0) - Number(b.lastQueriedAt || 0)).slice(0, 12);
  let delivered = 0;
  let pending = 0;
  let verified = 0;
  for (let i = 0; i < list.length; i += 4) {
    const results = await Promise.all(list.slice(i, i + 4).map(async (o) => {
      try { return await reconcileOrder(o); }
      catch (e) { console.error('[virtualPay] 同步订单失败:', o.outTradeNo, e.message); return { pending: true }; }
    }));
    for (const r of results) {
      if (r.delivered) delivered++;
      if (r.pending) pending++;
      if (r.verified) verified++;
    }
  }
  return { code: 0, data: { delivered, pending, verified, checked: list.length } };
}

/**
 * 我的订单（订单中心列表页用）
 * 只返回本人订单（loadOrderByOpenid 已按 _openid 过滤 + 时间倒序），
 * 且只给用户需要的字段，不把结算状态、查单原因等内部对账字段下发到
 * 小程序。客服/退款可能需要的交易标识放在 support 中，由订单页默认折叠
 * 展示；outTradeNo 仍用于「继续支付/取消订单」。
 */
function userOrderNotice(order) {
  const status = String(order.status || 'created');
  if (status === 'refunded') return '订单已退款；如权益状态有疑问，请联系客服。';
  if (order.paymentReview || [5, 8].includes(Number(order.platformStatus))) {
    return '订单状态需要人工核对，请联系客服。';
  }
  if (status === 'delivered') return '权益已到账，可以使用。';
  if (status === 'paid') return '支付已完成，权益正在发放，请稍后同步订单。';
  if (status === 'verifying') return '正在确认支付结果，请勿重复付款。';
  if (status === 'created') return '尚未完成支付，可以继续支付。';
  if (status === 'cancelled') return '订单已取消；如已扣款，请联系客服。';
  return '订单状态需要人工核对，请联系客服。';
}

function userOrderNoticeType(order) {
  const status = String(order.status || 'created');
  return (status === 'refunded' || order.paymentReview
    || [5, 8].includes(Number(order.platformStatus))) ? 'warning' : 'normal';
}

async function actionOrderList(openid) {
  // 包含取消订单，方便用户确认自己的购买状态。
  const list = await loadOrderByOpenid(openid, 50);
  const money = (fen) => {
    const n = Number(fen || 0);
    return `¥${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}`;
  };
  return {
    code: 0,
    data: {
      list: (list || []).map((o) => {
        const g = R.goodsById(o.goodsId);
        return {
          outTradeNo: String(o.outTradeNo || ''),
          goodsName: (g && g.name) || String(o.goodsId || '虚拟商品'),
          goodsDesc: (g && g.desc) || '',
          amount: money(o.price),
          status: String(o.status || 'created'),
          createdAt: Number(o.createdAt || 0),
          deliveredAt: Number(o.deliveredAt || 0),
          refundFee: String(o.status || '') === 'refunded' ? Number(o.refundFee || 0) : 0,
          userNotice: userOrderNotice(o),
          noticeType: userOrderNoticeType(o),
          support: {
            merchantOrderNo: String(o.outTradeNo || ''),
            platformOrderNo: String(o.platformOrderId || ''),
            channelOrderNo: String(o.channelOrderId || ''),
            wxTransactionNo: String(o.wxpayOrderId || ''),
            paidFee: Number(o.paidFee || 0),
            paidAt: Number(o.paidAt || 0),
            refundOrderNo: String(o.refundOrderId || ''),
            refundWxTransactionNo: String(o.refundWxOrderId || ''),
            refundFee: String(o.status || '') === 'refunded' ? Number(o.refundFee || 0) : 0,
            refundAt: String(o.status || '') === 'refunded' ? Number(o.refundAt || 0) : 0,
          },
        };
      }),
    },
  };
}

/** 管理员对账视图：金额是平台查单快照，不代表银行卡已入账。 */
async function actionAdminLedger(openid, event) {
  const admins = await db.collection('users').where({ _openid: openid }).limit(1).get();
  const actor = admins.data && admins.data[0];
  if (!actor || !['admin', 'super'].includes(actor.role)) return { code: -1, msg: '无权查看支付对账' };
  await ensureColl(COL_ORDER);
  let rows = (await db.collection(COL_ORDER).orderBy('createdAt', 'desc').limit(50).get()).data || [];
  if (event.refresh) {
    for (let i = 0; i < Math.min(rows.length, 12); i += 4) {
      await Promise.all(rows.slice(i, i + 4).map((o) => reconcileOrder(o).catch((e) => {
        console.warn('[virtualPay] 管理对账查单失败:', o.outTradeNo, e.message);
      })));
    }
    rows = (await db.collection(COL_ORDER).orderBy('createdAt', 'desc').limit(50).get()).data || [];
  }
  const verified = rows.filter((o) => [2, 3, 4].includes(Number(o.platformStatus)));
  const settled = verified.filter((o) => Number(o.settlementState) === 2);
  const sum = (list, field) => list.reduce((n, o) => n + Number(o[field] || 0), 0);
  return {
    code: 0,
    data: {
      scope: '最近50笔本地订单',
      total: rows.length,
      verified: verified.length,
      settled: settled.length,
      verifiedPaidFen: sum(verified, 'paidFee'),
      settledGrossFen: sum(settled, 'paidFee'),
      settledNetEstimateFen: sum(settled, 'paidFee') - sum(settled, 'platformFee') - sum(settled, 'cpsFee'),
      list: rows.map((o) => ({
        outTradeNo: o.outTradeNo,
        goodsId: o.goodsId,
        amountFen: Number(o.price || 0),
        paidFee: Number(o.paidFee || 0),
        status: o.status,
        platformStatus: o.platformStatus === undefined ? null : o.platformStatus,
        settlementState: o.settlementState === undefined ? null : o.settlementState,
        platformNotifiedAt: Number(o.platformNotifiedAt || 0),
        platformNotifyError: String(o.platformNotifyError || ''),
        paymentReview: !!o.paymentReview,
        platformOrderId: String(o.platformOrderId || ''),
        channelOrderId: String(o.channelOrderId || ''),
        wxpayOrderId: String(o.wxpayOrderId || ''),
        createdAt: Number(o.createdAt || 0),
        paidAt: Number(o.paidAt || 0),
        settledAt: Number(o.settledAt || 0),
        refundFee: Number(o.refundFee || 0),
        refundAt: Number(o.refundAt || 0),
        refundOrderId: String(o.refundOrderId || ''),
        refundWxOrderId: String(o.refundWxOrderId || ''),
        lastQueryReason: String(o.lastQueryReason || ''),
      })),
    },
  };
}

function requestQuery(event) {
  return (event && (event.queryStringParameters || event.query)) || {};
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyNotifySignature(event, encrypted) {
  if (!WX_MSG_TOKEN) return { ok: false, reason: 'WX_MSG_TOKEN 未配置' };
  const q = requestQuery(event);
  const timestamp = String(q.timestamp || '');
  const nonce = String(q.nonce || '');
  const signature = String(q.signature || '');
  const msgSignature = String(q.msg_signature || '');
  if (!timestamp || !nonce) return { ok: false, reason: '缺少回调签名参数' };
  const plainExpected = sha1([WX_MSG_TOKEN, timestamp, nonce].sort().join(''));
  if (encrypted && msgSignature) {
    const encryptedExpected = sha1([WX_MSG_TOKEN, timestamp, nonce, encrypted].sort().join(''));
    if (safeEqual(msgSignature, encryptedExpected)) return { ok: true, encrypted: true };
  }
  if (signature && safeEqual(signature, plainExpected)) return { ok: true, encrypted: false };
  return { ok: false, reason: '回调签名校验失败' };
}

function decryptNotifyMessage(encrypted) {
  if (!WX_MSG_AES_KEY) throw new Error('安全模式回调缺少 WX_MSG_AES_KEY');
  const aesKey = Buffer.from(`${WX_MSG_AES_KEY}=`, 'base64');
  if (aesKey.length !== 32) throw new Error('WX_MSG_AES_KEY 不是有效的 43 位 EncodingAESKey');
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(Buffer.from(String(encrypted), 'base64')), decipher.final()]);
  if (plain.length < 20) throw new Error('回调密文解密结果过短');
  const msgLength = plain.readUInt32BE(16);
  const start = 20;
  const end = start + msgLength;
  const message = plain.subarray(start, end).toString('utf8');
  const appId = plain.subarray(end).toString('utf8');
  if (MP_APPID && appId && appId !== MP_APPID) throw new Error('回调 AppID 不匹配');
  return message;
}

function parseNotifyRequest(body, event) {
  const outer = X.readNotifyPayload(body);
  const encrypted = String((outer.payload && (outer.payload.Encrypt || outer.payload.encrypt)) || '');
  const signature = verifyNotifySignature(event, encrypted);
  if (!signature.ok) throw new Error(signature.reason);
  if (signature.encrypted) {
    const decrypted = decryptNotifyMessage(encrypted);
    const inner = X.readNotifyPayload(decrypted);
    return { payload: inner.payload, format: outer.format };
  }
  return outer;
}

/**
 * 米大师发货回调（后台配的回调地址指向本函数）
 * 请求体只用于定位本地订单；发货前必须再向平台查证。
 */
async function actionNotify(body, requestEvent) {
  const parsed = requestEvent ? parseNotifyRequest(body, requestEvent) : X.readNotifyPayload(body);
  const payload = parsed.payload || {};
  const eventName = String(payload.Event || payload.event || '').trim();
  if (eventName && ![
    'xpay_goods_deliver_notify',
    'xpay_refund_notify',
    'xpay_subscribe_ios_refund_query_notify',
  ].includes(eventName)) {
    return { ErrCode: 0, ErrMsg: 'ignored' };
  }

  // Apple 订阅型虚拟支付的退款问询要求在 3 秒内返回 result_code。
  // 当前商品走 short_series_goods 一次性虚拟权益，且额度没有按订单消费台账，
  // 无法可靠证明“这笔订单已经消费完”或安全扣回，因此默认建议平台按规则退款。
  // 后续只有在建立按订单授予/消费/剩余台账并完成售后规则审核后，才能对明确情形返回 1（拦截）。
  if (eventName === 'xpay_subscribe_ios_refund_query_notify') {
    const provideStatus = String(payload.provide_status || '').trim();
    const payOrderId = String(payload.pay_order_id || '').trim();
    console.info('[virtualPay] iOS 退款问询：按平台规则放行', {
      payOrderId: payOrderId.slice(0, 12),
      provideStatus,
      productId: String(payload.product_id || '').slice(0, 32),
    });
    return {
      __iosRefundQuery: true,
      result_code: 0,
      result_info: '当前为数字虚拟权益，退款由支付平台按规则审核',
      evidence: provideStatus === '1'
        ? '权益已发放，但系统尚无按订单记录的消费余量，无法据此拒绝平台退款'
        : '权益未确认完成发放，建议按原支付路径处理退款',
    };
  }

  const outTradeNo = String(eventName === 'xpay_refund_notify'
    ? (payload.MchOrderId || payload.mch_order_id || payload.OutTradeNo || '')
    : (payload.OutTradeNo || payload.outTradeNo || payload.out_trade_no || payload.order_id || payload.OrderKey || ''));
  if (!outTradeNo) return { ErrCode: -1, ErrMsg: 'missing OutTradeNo' };
  const order = await loadOrder(outTradeNo);
  if (!order) return { ErrCode: -1, ErrMsg: 'order not found' };
  const callbackOpenid = String(payload.OpenId || payload.openid || '').trim();
  if (callbackOpenid && callbackOpenid !== String(order._openid || '')) {
    return { ErrCode: -1, ErrMsg: 'openid mismatch' };
  }
  if (payload.Env !== undefined || payload.env !== undefined) {
    const callbackEnv = Number(payload.Env === undefined ? payload.env : payload.Env);
    if (Number.isInteger(callbackEnv) && callbackEnv !== Number(order.env || 0)) {
      return { ErrCode: -1, ErrMsg: 'environment mismatch' };
    }
  }
  if (eventName === 'xpay_refund_notify') {
    const retCode = Number(payload.RetCode === undefined ? payload.ret_code : payload.RetCode);
    if (retCode === 0) {
      await updateOrder(order._id, {
        status: 'refunded',
        paymentReview: true,
        refundFee: Number(payload.RefundFee || payload.refund_fee || 0),
        refundAt: Number(payload.RefundSuccTimestamp || payload.refund_succ_timestamp || 0) * 1000 || Date.now(),
        refundOrderId: String(payload.MchRefundId || payload.mch_refund_id || ''),
        refundWxOrderId: String(payload.WxRefundId || payload.wx_refund_id || ''),
      });
    } else {
      await updateOrder(order._id, { lastRefundError: String(payload.RetMsg || payload.ret_msg || 'refund_failed') });
    }
    return { ErrCode: 0, ErrMsg: 'success' };
  }
  // 不信任 HTTP 请求体，也不信任小程序端传入的 action=notify；只用它唤醒官方查单。
  const r = await reconcileOrder(order, { fromNotify: true });
  if (!r.verified) return { ErrCode: -1, ErrMsg: r.reason || 'payment not verified' };
  if (r.notifyOk === false) return { ErrCode: -1, ErrMsg: r.notifyReason || 'notify provide goods failed' };
  return { ErrCode: 0, ErrMsg: 'success' };
}

/** 自检：配置缺什么一眼看到（上线前必跑） */
function actionDiag() {
  const miss = [];
  if (!OFFER_ID) miss.push('XPAY_OFFER_ID');
  if (!APP_KEY) miss.push(ENV === 1 ? 'XPAY_APP_KEY_SANDBOX' : 'XPAY_APP_KEY');
  // MP_APPID/SECRET 不只是查单用：下单换 session_key 也靠它（云调用没有 code2Session）
  if (!MP_APPID || !MP_SECRET) miss.push('MP_APPID / MP_APPSECRET');
  if (!process.env.INTERNAL_TOKEN) miss.push('INTERNAL_TOKEN');
  if (!WX_MSG_TOKEN) miss.push('WX_MSG_TOKEN');
  return {
    code: 0,
    data: {
      version: 'v1.2-reconcile',
      env: ENV,
      envText: ENV === 1 ? '沙箱（安卓可自测）' : '现网',
      offerId: OFFER_ID ? `${OFFER_ID.slice(0, 4)}****` : '',
      appKeyReady: !!APP_KEY,
      // 当前主通道是 HTTP sns/jscode2session；不要用 cloud.openapi 是否存在误报。
      code2SessionReady: !!(MP_APPID && MP_SECRET),
      canQueryOrder: !!MP_APPID && !!MP_SECRET,
      internalTokenReady: !!process.env.INTERNAL_TOKEN,
      callbackTokenReady: !!WX_MSG_TOKEN,
      callbackDecryptReady: !!WX_MSG_AES_KEY,
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
    if (!WX_MSG_TOKEN) {
      return { statusCode: 503, headers: { 'Content-Type': 'text/plain' }, body: 'WX_MSG_TOKEN is not configured' };
    }
    if (String(event.httpMethod).toUpperCase() === 'GET') {
      const q = event.queryStringParameters || event.query || {};
      const expected = sha1([WX_MSG_TOKEN, q.timestamp || '', q.nonce || ''].sort().join(''));
      // 消息推送地址校验：只有签名通过才回显随机串。
      if (q.echostr && safeEqual(q.signature, expected)) {
        return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: String(q.echostr) };
      }
      return { statusCode: 403, headers: { 'Content-Type': 'text/plain' }, body: 'invalid callback signature' };
    }
    let body = event.body || '{}';
    if (event.isBase64Encoded) {
      try { body = Buffer.from(body, 'base64').toString('utf8'); } catch (e) {}
    }
    let r;
    try {
      r = await actionNotify(body, event);
    } catch (e) {
      console.error('[virtualPay] 回调校验/解析失败:', e.message);
      r = { ErrCode: -1, ErrMsg: e.message || 'callback rejected' };
    }
    const notify = X.readNotifyPayload(body);
    const responseBody = X.notifyResponse(r, notify.format);
    return {
      statusCode: 200,
      headers: { 'Content-Type': notify.format === 'xml' ? 'application/xml' : 'application/json' },
      body: notify.format === 'xml' ? responseBody : JSON.stringify(responseBody),
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
    if (action === 'orderList') return await actionOrderList(openid);
    if (action === 'adminLedger') return await actionAdminLedger(openid, event);
    if (action === 'repay') return await actionRepay(openid, event);
    if (action === 'cancelOrder') return await actionCancelOrder(openid, event);
    // notify 只允许从 HTTP 消息推送入口进入；不向小程序暴露一个可随意触发查单的 action。
    return { code: -1, msg: `未知 action：${action}` };
  } catch (e) {
    console.error('[virtualPay] %s error:', action, e);
    return { code: -1, msg: e.message || '支付服务异常' };
  }
};
