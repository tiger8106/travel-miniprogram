// miniprogram/utils/privacy.js
// 微信「用户隐私保护指引」授权的统一入口
//
// ⚠️ 2026-09-25：以前是「直接调隐私接口 → 被微信拦截 → 弹窗 → 同意 → 代码再重试一次」，
//    这条链会兜成死循环：微信拦截时有可能同时回调一次 fail，页面收到 fail 又弹一次窗，
//    用户点同意后代码自动重试 → 又被拦 → 又弹……用户看到的就是"同意了还一直弹"。
//
//    另一个坑：自己弹的窗里放 <button open-type="agreePrivacyAuthorization">，
//    如果此刻微信并没有 pending 的授权请求，点了没任何反应，流程直接卡住。
//
// 现在的做法：**调用隐私接口之前先主动拿到授权**
//    wx.getPrivacySetting 看要不要授权
//      → 要就 wx.requirePrivacyAuthorize（它会产生一个确定的 pending，
//        我们的弹窗承接它，button 才有东西可 resolve）
//      → 用户点「同意」后 promise 返回 → 再去调真正的接口
//   全程只弹一次；且不再有"代码自动重试"，从根上断掉循环。
//
// 仍然保留 wx.onNeedPrivacyAuthorization 兜底（老基础库没有 requirePrivacyAuthorize，
// 或者某个接口被漏判），那条路径只是弹窗，不会自动重试。

let pendingResolve = null;  // 微信给的 resolve（拦截回调与 requirePrivacyAuthorize 共用）
let agreed = false;         // 本次会话是否已同意（微信自己也会记，这里是双保险）

/** 微信要授权了，把 resolve 存起来 */
function setPending(resolve) {
  pendingResolve = resolve;
}

/**
 * 用户做了选择（同意/不同意）：把结果交回微信，放行或终止被挂起的接口调用
 * @returns {boolean} 是否真的有 pending 被放行（false = 没有在等的调用）
 */
function finish(event) {
  const r = pendingResolve;
  pendingResolve = null;
  if (!r) return false;
  try {
    r({ event: event || 'agree' });
  } catch (e) {
    console.warn('[privacy] resolve 失败:', e);
  }
  if (event === 'agree') agreed = true;
  return true;
}

/**
 * 微信拦截隐私接口时的回调（在 app.js 里注册进 wx.onNeedPrivacyAuthorization）
 * @param {Function} resolve 微信给的 resolve
 */
function onNeed(resolve) {
  setPending(resolve);
  let app = null;
  try { app = getApp(); } catch (e) { /* 未初始化，走系统弹窗兜底 */ }
  if (app && typeof app._privacyHandler === 'function') {
    app._privacyHandler();
    return;
  }
  // 没有页面挂自定义弹窗时用系统弹窗兜底，别让用户点了没反应
  wx.showModal({
    title: '用户隐私保护提示',
    content: '使用该功能前，需要先阅读并同意《用户隐私保护指引》。',
    confirmText: '同意',
    cancelText: '不同意',
    success: (r) => finish(r.confirm ? 'agree' : 'disagree'),
    fail: () => finish('disagree'),
  });
}

/**
 * 当前是否还需要授权
 * @returns {Promise<boolean|null>} true=需要，false=已授权，null=查不到（低版本基础库）
 */
function needAuthorization() {
  return new Promise((resolve) => {
    if (!wx.getPrivacySetting) return resolve(null);
    wx.getPrivacySetting({
      success: (res) => resolve(!!(res && res.needAuthorization)),
      fail: () => resolve(null),
    });
  });
}

/**
 * 打一条诊断日志：指引到底生效没有（排查"同意了还弹"必看）
 * 「指引名称为空」= 后台的《用户隐私保护指引》还没提交/没审核通过
 */
async function diagnose(tag) {
  if (!wx.getPrivacySetting) return null;
  const info = await new Promise((resolve) => {
    wx.getPrivacySetting({
      success: (res) => resolve({
        need: !!(res && res.needAuthorization),
        contract: (res && res.privacyContractName) || '',
      }),
      fail: () => resolve(null),
    });
  });
  if (info) {
    console.log(`[隐私诊断]${tag ? ' ' + tag : ''} 需要授权=${info.need}`,
      '| 指引名称=', info.contract || '（空 = 后台指引还没生效）');
  }
  return info;
}

/**
 * 确保已拿到隐私授权（调用 chooseMessageFile / chooseAvatar / 日历 等接口前先过这一关）
 * @param {Function} [show] 需要授权时展示自定义弹窗的回调（由页面 setData 控制）
 * @returns {Promise<boolean>} true = 可以继续调接口；false = 用户拒绝
 */
async function ensure(show) {
  if (agreed) return true;

  const need = await needAuthorization();
  if (need === false) { agreed = true; return true; }
  // 查不到 / 基础库较老（没有 wx.requirePrivacyAuthorize）：
  // 放行去调，真被拦了还有 app.js 里 onNeedPrivacyAuthorization 的弹窗兜底
  if (need === null || !wx.requirePrivacyAuthorize) return true;

  // 主动发起授权请求：这样弹窗里的 button 才有 pending 可以 resolve
  if (typeof show === 'function') show();
  try {
    await wx.requirePrivacyAuthorize();
    agreed = true;
    return true;
  } catch (e) {
    console.log('[privacy] 用户未同意授权:', (e && (e.errMsg || e.message)) || e);
    return false;
  }
}

module.exports = {
  onNeed,
  ensure,
  finish,
  needAuthorization,
  diagnose,
  isAgreed: () => agreed,
};
