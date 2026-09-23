// miniprogram/utils/env.js
// 运行环境 & 开发者功能可见性
//
// 用法：
//   const env = require('../../utils/env');
//   this.setData({ devMode: env.showDevTools() });
//
// 规则（受 config.js 的 SHOW_DEV_TOOLS 控制）：
//   'auto'   → 只在开发版显示；体验版 / 正式版自动隐藏（默认，推荐）
//   'trial'  → 开发版 + 体验版都显示（真机排查时临时改）
//   true     → 任何环境都显示
//   false    → 任何环境都隐藏
//
// 临时解锁：体验版想自查、又不想对体验成员公开时，用 unlockDevTools() 手动开，
// 24 小时后自动失效。入口在「我的」页连点「关于」5 次（别人不知道就不会误开）。
const config = require('../config');

const KEY_UNLOCK = '__dev_tools_unlock_ts__';
const UNLOCK_TTL = 24 * 60 * 60 * 1000; // 24 小时

/**
 * 当前小程序环境：develop(开发版) / trial(体验版) / release(正式版)
 * 取不到时按 release 处理（最保守：不显示调试功能）
 */
function envVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const v = info && info.miniProgram && info.miniProgram.envVersion;
    return v || 'release';
  } catch (e) {
    return 'release';
  }
}

/** 临时解锁是否还在有效期内 */
function isDevToolsUnlocked() {
  try {
    const ts = wx.getStorageSync(KEY_UNLOCK);
    return !!ts && Date.now() - Number(ts) < UNLOCK_TTL;
  } catch (e) {
    return false;
  }
}

/** 临时开启开发者功能（24 小时后自动失效），返回有效小时数 */
function unlockDevTools() {
  try {
    wx.setStorageSync(KEY_UNLOCK, String(Date.now()));
  } catch (e) {}
  return UNLOCK_TTL / 3600000;
}

/** 立即关掉临时解锁 */
function lockDevTools() {
  try {
    wx.removeStorageSync(KEY_UNLOCK);
  } catch (e) {}
}

/** 是否显示开发者功能（推送自检、闹钟「测试」按钮） */
function showDevTools() {
  const flag = config.SHOW_DEV_TOOLS;
  const unlocked = isDevToolsUnlocked();
  if (flag === true) return true;
  if (flag === false) return false;
  if (flag === 'trial') return envVersion() !== 'release' || unlocked;
  // 'auto'（默认）：只在开发版显示；临时解锁时任何环境都显示
  return envVersion() === 'develop' || unlocked;
}

/** 环境中文名，UI 上提示用 */
function envLabel() {
  return { develop: '开发版', trial: '体验版', release: '正式版' }[envVersion()] || '未知';
}

module.exports = {
  envVersion,
  showDevTools,
  envLabel,
  isDevToolsUnlocked,
  unlockDevTools,
  lockDevTools,
};
