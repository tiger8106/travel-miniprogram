// miniprogram/utils/env.js
// 运行环境 & 开发者功能可见性
//
// 用法：
//   const env = require('../../utils/env');
//   this.setData({ devMode: env.showDevTools() });
//
// 规则（受 config.js 的 SHOW_DEV_TOOLS 控制）：
//   'auto'  → 开发版 / 体验版显示开发者功能，正式版自动隐藏
//   true    → 任何环境都显示
//   false   → 任何环境都隐藏
const config = require('../config');

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

/** 是否显示开发者功能（推送自检、闹钟「测试」按钮） */
function showDevTools() {
  const flag = config.SHOW_DEV_TOOLS;
  if (flag === 'auto') return envVersion() !== 'release';
  return !!flag;
}

/** 环境中文名，UI 上提示用 */
function envLabel() {
  return { develop: '开发版', trial: '体验版', release: '正式版' }[envVersion()] || '未知';
}

module.exports = { envVersion, showDevTools, envLabel };
