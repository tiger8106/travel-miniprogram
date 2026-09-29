// miniprogram/utils/env.js
// 运行环境 & 开发者功能可见性
//
// 用法：
//   const env = require('../../utils/env');
//   this.setData({ devMode: env.showDevTools() });
//
// 规则（受 config.js 的 SHOW_DEV_TOOLS 控制）：
//   'auto'   → 只在开发版显示；体验版 / 正式版自动隐藏
//   'trial'  → 开发版 + 体验版都显示（真机排查时临时改）
//   true     → 任何环境都显示
//   false    → 任何环境都隐藏（上线态，当前默认）
//
// ⚠️ 2026-09-29 上线清理：原先「连点关于 5 次 → 解锁 24 小时」的隐藏入口已删除
// （含 Storage 解锁标记、unlockDevTools / lockDevTools / isDevToolsUnlocked）。
// 理由：这类隐藏后门留在正式包里既没必要、也不好向审核解释。
// 想临时排查推送/闹钟，直接把 config.SHOW_DEV_TOOLS 改成 'trial' 或 true 重新编译即可。
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
  if (flag === true) return true;
  if (flag === false) return false;          // 上线态：任何环境都不显示
  if (flag === 'trial') return envVersion() !== 'release';
  // 'auto'：只在开发版显示
  return envVersion() === 'develop';
}

/** 环境中文名，UI 上提示用 */
function envLabel() {
  return { develop: '开发版', trial: '体验版', release: '正式版' }[envVersion()] || '未知';
}

module.exports = {
  envVersion,
  showDevTools,
  envLabel,
};
