// utils/auth.js
// 用户鉴权相关
const { callFn } = require('./request');

const KEY_OPENID = '__openid_cache__';

/**
 * 静默登录：拿 openid，缓存到本地
 */
function silentLogin() {
  return new Promise((resolve, reject) => {
    // 优先从缓存拿
    const cached = wx.getStorageSync(KEY_OPENID);
    if (cached) {
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
          wx.setStorageSync(KEY_OPENID, openid);
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
 * 获取当前 openid
 */
function getOpenid() {
  return wx.getStorageSync(KEY_OPENID) || null;
}

/**
 * 强制重新登录（清除缓存）
 */
function relogin() {
  wx.removeStorageSync(KEY_OPENID);
  return silentLogin();
}

module.exports = {
  silentLogin,
  getOpenid,
  relogin,
};