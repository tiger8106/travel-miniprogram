// utils/auth.js
// 用户鉴权相关：微信登录（openid）、个人资料、登录态管理
const { callFn } = require('./request');

const KEY_OPENID = '__openid_cache__';
const KEY_PROFILE = '__profile_cache__';

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
}

/**
 * 强制重新登录（清除缓存后重走 wx.login）
 */
function relogin() {
  logout();
  return silentLogin(true);
}

module.exports = {
  silentLogin,
  isLoggedIn,
  getOpenid,
  getProfile,
  setProfile,
  updateProfile,
  logout,
  relogin,
};
