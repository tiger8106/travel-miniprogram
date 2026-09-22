// utils/auth.js
// 用户鉴权相关：微信登录（openid）、个人资料、登录态管理
const { callFn } = require('./request');

const KEY_OPENID = '__openid_cache__';
const KEY_PROFILE = '__profile_cache__';
const KEY_LOGGED_OUT = '__logged_out__';   // 用户主动退出过 → 不再自动静默登录

// ============================================================
// 全局登录态：一处登录，全站解锁
//   · _listeners —— 登录/退出时广播，已打开的页面立刻同步
//   · _pending   —— 正在进行的静默登录，并发复用（避免多次 wx.login）
// ============================================================
const _listeners = [];
let _pending = null;

function _emit() {
  const logged = isLoggedIn();
  _listeners.slice().forEach((fn) => {
    try { fn(logged); } catch (e) { console.warn('[auth] 登录态回调出错', e); }
  });
}

/**
 * 订阅登录态变化，返回取消订阅函数（页面 onUnload 里调用）
 */
function onChange(fn) {
  if (typeof fn !== 'function') return function () {};
  _listeners.push(fn);
  let done = false;
  return function off() {
    if (done) return;
    done = true;
    const i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

/**
 * 页面订阅登录态：登录成功 → 自动刷新；退出登录 → 自动清空
 * @param {object} page 页面实例（this）
 * @param {{onLogin?:Function, onLogout?:Function}} handlers
 * @returns {Function} 取消订阅
 */
function watch(page, handlers) {
  handlers = handlers || {};
  return onChange((logged) => {
    try {
      if (logged) {
        if (page.setData) page.setData({ needLogin: false });
        if (handlers.onLogin) handlers.onLogin();
      } else {
        if (page.setData) page.setData({ needLogin: true });
        if (handlers.onLogout) handlers.onLogout();
        else if (typeof page.clearForLogout === 'function') page.clearForLogout();
      }
    } catch (e) {
      console.warn('[auth] watch 回调出错', e);
    }
  });
}

/**
 * 静默登录：wx.login → 云函数拿 openid，缓存到本地
 * 微信小程序登录是静默的，用户无感知；云端数据全部按 openid 隔离，
 * 所以退出后重新登录，数据照样在。
 * @param {boolean} force true = 忽略缓存强制重登
 */
function silentLogin(force) {
  return new Promise((resolve, reject) => {
    const cached = wx.getStorageSync(KEY_OPENID);
    if (cached && !force) {
      resolve(cached);
      return;
    }
    wx.login({
      success: async ({ code }) => {
        if (!code) {
          reject(new Error('微信登录 code 为空'));
          return;
        }
        try {
          const data = await callFn('login', { code });
          const openid = data.openid;
          if (!openid) {
            reject(new Error('云函数未返回 openid'));
            return;
          }
          // openid 变了（换微信账号登录）→ 清掉所有本地快照，防止串号
          const prev = wx.getStorageSync(KEY_OPENID);
          if (prev && prev !== openid) {
            try { require('./homecache').clearAll(); } catch (e) {}
          }
          wx.setStorageSync(KEY_OPENID, openid);
          // 只要用户主动登录过，就撤掉"已退出"标记，后续可以自动静默登录
          wx.removeStorageSync(KEY_LOGGED_OUT);
          // 云端返回的资料（昵称等）同步到本地缓存
          if (data.profile) setProfile(data.profile);
          resolve(openid);
        } catch (err) {
          reject(err);
        }
      },
      fail: reject,
    });
  });
}

/**
 * 幂等的自动登录：已登录直接返回；多个页面同时调用只发一次请求
 */
function autoLogin() {
  if (isLoggedIn()) return Promise.resolve(getOpenid());
  if (_pending) return _pending;
  _pending = silentLogin(true).then(
    (id) => { _pending = null; return id; },
    (err) => { _pending = null; throw err; },
  );
  return _pending;
}

/**
 * 手动登录成功后调用：广播给所有页面，让它们立刻解锁
 * （在「我的」点一次登录，首页 / 行程 / 闹钟全部跟着解锁）
 */
function notifyLogin() {
  if (isLoggedIn()) _emit();
}

/**
 * 页面进入时的守卫：未登录先自动静默登录一次（用户无感知），
 * 只有真的失败才返回 false（此时才显示登录门禁卡）
 */
async function requireLogin() {
  if (isLoggedIn()) return true;
  // 用户主动退出过 → 不再自动登录，留给门禁卡让用户自己点
  if (wx.getStorageSync(KEY_LOGGED_OUT)) return false;
  try {
    await autoLogin();
    return true;
  } catch (err) {
    console.warn('[auth] 自动登录失败', err);
    return false;
  }
}

/**
 * 是否已登录（本地有 openid 缓存）
 */
function isLoggedIn() {
  return !!wx.getStorageSync(KEY_OPENID);
}

/**
 * 获取当前 openid
 */
function getOpenid() {
  return wx.getStorageSync(KEY_OPENID) || null;
}

/**
 * 本地个人资料缓存 { nickname, avatarUrl }
 */
function getProfile() {
  return wx.getStorageSync(KEY_PROFILE) || null;
}

function setProfile(p) {
  if (p && typeof p === 'object') wx.setStorageSync(KEY_PROFILE, p);
}

/**
 * 保存昵称/头像到云端 users 表 + 本地缓存
 */
async function updateProfile(patch) {
  const data = await callFn('login', { action: 'updateProfile', profile: patch });
  const merged = Object.assign({}, getProfile() || {}, patch || {}, data.profile || {});
  setProfile(merged);
  return merged;
}

/**
 * 退出登录：只清本地会话（openid + 资料），云端数据不动。
 * 重新登录后 openid 不变，行程/闹钟/建议全部还在。
 */
function logout() {
  wx.removeStorageSync(KEY_OPENID);
  wx.removeStorageSync(KEY_PROFILE);
  // 标记"已主动退出"，避免下次进页面又被自动静默登录复活
  wx.setStorageSync(KEY_LOGGED_OUT, 1);
  _emit();   // 广播：其它页面立刻清空，不再显示任何行程数据
}

/**
 * 强制重新登录（清除缓存后重走 wx.login）
 */
function relogin() {
  logout();
  return silentLogin(true).then((openid) => {
    notifyLogin();
    return openid;
  });
}

/**
 * 操作前守卫：未登录弹窗提醒，用户确认后登录
 * @param {string} action 动作描述，如「上传攻略」
 * @returns {Promise<boolean>} true = 可以继续操作
 */
async function ensureLogin(action) {
  // 先试静默登录：能自动登进去就不打扰用户弹窗
  if (await requireLogin()) return true;
  const goOn = await new Promise((resolve) => {
    wx.showModal({
      title: '需要先登录',
      content: `${action || '这个操作'}需要先微信登录，数据会保存在你自己的账号下。`,
      confirmText: '登录',
      cancelText: '取消',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!goOn) return false;
  try {
    await silentLogin(true);
    return true;
  } catch (err) {
    wx.showToast({ title: err.message || '登录失败，请重试', icon: 'none' });
    return false;
  }
}

module.exports = {
  silentLogin,
  autoLogin,
  requireLogin,
  notifyLogin,
  onChange,
  watch,
  isLoggedIn,
  getOpenid,
  getProfile,
  setProfile,
  updateProfile,
  ensureLogin,
  logout,
  relogin,
};
