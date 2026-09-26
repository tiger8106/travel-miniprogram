// utils/quota.js
// 额度：查余额、生成前校验、拉起虚拟支付、邀请奖励
//
// 计费口径（和云端 rules.js 保持一致）：
//   · 一次完整攻略 = 1 次额度（大纲/细化/建议/闹钟/定位全链路都算在里面）
//   · 大纲阶段不扣费，行程落库成功才扣（失败不收钱）
//   · 会员 > 赠送额度（有有效期，先用）> 长期额度

const { callFn, callFnKeepCode } = require('./request');

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 30 * 1000;      // 30 秒内不重复查，省调用次数

function clear() {
  _cache = null;
  _cacheAt = 0;
}

/** 查额度（带短缓存） */
async function info(force) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;
  try {
    const d = await callFn('quota', { action: 'info' });
    _cache = d || null;
    _cacheAt = now;
    return _cache;
  } catch (e) {
    // 额度服务没部署/出错时返回 null：调用方按"放行"处理，不能挡住用户
    console.warn('[quota] 查询失败（本次不拦截）:', e.message);
    return null;
  }
}

/**
 * 生成前的守卫：够不够额度、有没有撞日限额
 * @param {string} scene plan（制定新攻略）/ parse（上传攻略解析）
 * @returns {Promise<{ok:boolean, needPay?:boolean, msg?:string, info?:object}>}
 */
async function ensure(scene) {
  const r = await callFnKeepCode('quota', { action: 'check', scene: scene || 'plan' });
  // 额度云函数还没部署/网络异常 → 放行（新功能不能把老功能搞挂）
  if (r.code === -999 || r.code === -1) {
    console.warn('[quota] 守卫不可用，放行:', r.msg);
    return { ok: true, info: null };
  }
  if (r.code === 0 && r.data && r.data.ok) return { ok: true, info: r.data };
  return {
    ok: false,
    needPay: r.code === -2 || !!(r.data && r.data.needPay),
    msg: r.msg || (r.data && r.data.msg) || '次数用完了',
    info: r.data || null,
  };
}

/** 弹出「去购买」引导（额度不够时用），用户确认后跳转付费页 */
function guideToPay(msg) {
  return new Promise((resolve) => {
    wx.showModal({
      title: '次数不够啦',
      content: `${msg || '剩余次数不足'}\n\n买个套餐接着玩：¥3/次、¥10/5次、¥20/月。`,
      confirmText: '去看看',
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({ url: '/pages/pay/pay' });
        }
        resolve(!!res.confirm);
      },
      fail: () => resolve(false),
    });
  });
}

/** 额度守卫 + 不足引导，一步到位 */
async function ensureOrPay(scene) {
  const r = await ensure(scene);
  if (r.ok) return true;
  await guideToPay(r.msg);
  return false;
}

// ============================================================
// 支付
// ============================================================

function loginCode() {
  return new Promise((resolve, reject) => {
    wx.login({ success: (r) => (r && r.code ? resolve(r.code) : reject(new Error('微信登录失败'))), fail: reject });
  });
}

/** 当前是不是开发者工具/模拟器（虚拟支付只支持真机，模拟器必报 no permission） */
function isDevtools() {
  try {
    const d = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
    return d.platform === 'devtools';
  } catch (e) { return false; }
}

/**
 * 买一个套餐：下单（云函数算签名）→ 拉起支付 → 确认发货
 * @param {string} goodsId plan_1 / plan_5 / vip_month
 */
async function pay(goodsId) {
  if (typeof wx.requestVirtualPayment !== 'function') {
    throw new Error('当前微信版本不支持虚拟支付（需基础库 2.19.2+）');
  }
  // 模拟器不支持虚拟支付（报 "no permission"）：提前拦下来，别让用户以为支付坏了
  if (isDevtools()) {
    throw new Error('开发者工具的模拟器不支持虚拟支付，请点「预览」用真机扫码后再买');
  }
  wx.showLoading({ title: '下单中…', mask: true });
  let order;
  try {
    const code = await loginCode().catch(() => '');
    try {
      order = await callFn('virtualPay', { action: 'createOrder', goodsId, code });
    } catch (e) {
      // code 是一次性的：偶发失效（并行登录/时钟差）会报"登录态"，换个新 code 重试一次
      if (!/登录态/.test(e.message)) throw e;
      const code2 = await loginCode().catch(() => '');
      if (!code2) throw e;
      order = await callFn('virtualPay', { action: 'createOrder', goodsId, code: code2 });
    }
  } finally {
    wx.hideLoading();
  }
  if (!order || !order.signData) throw new Error('下单失败，请稍后再试');

  // signData 必须原样透传：重新 JSON.stringify 会改字段顺序 → 验签失败（-15006）
  await new Promise((resolve, reject) => {
    wx.requestVirtualPayment({
      signData: order.signData,
      paySig: order.paySig,
      signature: order.signature,
      mode: order.mode || 'short_series_goods',
      success: resolve,
      fail: (err) => {
        const code = err && err.errCode;
        if (code === -2) reject(new Error('已取消支付'));
        else if (code === -15007) reject(new Error('登录态过期，请重新进入小程序后重试'));
        else if (code === -15010 || code === -15014) reject(new Error('商品还没发布生效，请稍等 10 分钟再试'));
        else if (/no permission/i.test((err && err.errMsg) || '')) {
          reject(new Error('虚拟支付在当前环境不可用：模拟器不支持支付，请用真机重试；真机仍报错请到小程序后台确认「虚拟支付」权限已开通'));
        }
        else reject(new Error((err && err.errMsg) || '支付失败'));
      },
    });
  });

  // 不能只信前端 success：让云端查单确认真的到账
  clear();
  const r = await callFnKeepCode('virtualPay', { action: 'confirm', outTradeNo: order.outTradeNo });
  if (r.code === 0 && r.data && (r.data.delivered || r.data.ok)) {
    clear();
    return { ok: true };
  }
  // 查单不可用（没配 MP_APPSECRET）时靠平台回调发货：提示用户可以手动刷新
  return { ok: false, pending: true, msg: (r.data && r.data.msg) || '支付成功，额度稍后自动到账' };
}

/** 手动补发：付了钱但额度没到账时点「刷新」用它 */
async function syncOrders() {
  const r = await callFnKeepCode('virtualPay', { action: 'sync' });
  clear();
  return (r.code === 0 && r.data) || { delivered: 0, pending: 0 };
}

// ============================================================
// 邀请
// ============================================================

async function inviteInfo() {
  try {
    return await callFn('quota', { action: 'inviteInfo' });
  } catch (e) {
    return null;
  }
}

async function bindInvite(code) {
  const r = await callFnKeepCode('quota', { action: 'bindInvite', code });
  clear();
  return r;
}

module.exports = {
  info, ensure, ensureOrPay, guideToPay, clear,
  pay, syncOrders, inviteInfo, bindInvite,
};
