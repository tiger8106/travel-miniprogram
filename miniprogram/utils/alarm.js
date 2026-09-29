// utils/alarm.js
// 订票闹钟前台轮询 + 震动提醒
const timeUtil = require('./time');

const STORAGE_KEY = '__alarms_cache__';
const POLL_INTERVAL = 30 * 1000;     // 30 秒检查一次
const FIRED_KEY = '__alarms_fired__';  // 已触发的闹钟 id，避免重复
const ADVANCE_KEY = '__alarm_advance_min__'; // 用户设置的提前提醒分钟数
const DEFAULT_ADVANCE_MIN = 5;

let timerId = null;
let cachedFired = null;

/**
 * 用户偏好的提前提醒分钟数（可在票务页设置）
 */
function getAdvanceMin() {
  const v = wx.getStorageSync(ADVANCE_KEY);
  return (typeof v === 'number' && v > 0) ? v : DEFAULT_ADVANCE_MIN;
}

function setAdvanceMin(minutes) {
  const m = Math.max(1, Math.min(60, Number(minutes) || DEFAULT_ADVANCE_MIN));
  wx.setStorageSync(ADVANCE_KEY, m);
  return m;
}

function leadOf(alarm) {
  const n = Number(alarm && alarm.leadMinutes);
  return isFinite(n) && n > 0 ? Math.max(1, Math.min(60, Math.round(n))) : getAdvanceMin();
}

// fireAt 是实际放票/办理时刻；旧数据里的 triggerAt 也按实际时刻兼容。
function actionAtOf(alarm) {
  if (alarm && Number(alarm.actionAt) > 0) return Number(alarm.actionAt);
  if (alarm && alarm.fireAtStr) {
    const parsed = calcTriggerAt(alarm.fireAt, alarm.fireAtStr);
    if (parsed) return parsed;
  }
  if (alarm && Number(alarm.fireAt) > 0) return Number(alarm.fireAt);
  if (alarm && Number(alarm.triggerAt) > 0) return Number(alarm.triggerAt);
  return null;
}

function remindAtOf(alarm) {
  const actionAt = actionAtOf(alarm);
  if (!actionAt) return null;
  // 提醒时刻是派生值，不采用可能来自旧缓存的 remindAt。
  return actionAt - leadOf(alarm) * 60 * 1000;
}

function isCompleted(alarm) {
  return !!(alarm && (alarm.completed === true || alarm.status === 'completed'));
}

function normalizeAlarm(alarm) {
  const actionAt = actionAtOf(alarm);
  const leadMinutes = leadOf(alarm);
  const remindAt = actionAt ? actionAt - leadMinutes * 60 * 1000 : null;
  return Object.assign({}, alarm, {
    actionAt,
    remindAt,
    leadMinutes,
    // 保留旧页面依赖的字段，但它现在代表“实际提醒时间”。
    triggerAt: remindAt,
  });
}

// 闹钟卡片/弹窗只保留能帮助用户执行的关键信息：车票/门票/酒店的使用
// 时间优先，其次是关联名称；生成阶段的长篇解释留在编辑页，不占满提醒界面。
function alarmKeyInfoOf(alarm) {
  const a = alarm || {};
  const clean = (value, max) => {
    const text = String(value || '').replace(/[\r\n\u3000]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const usage = clean(a.usageInfo, 120);
  if (usage) return usage;
  const booking = clean(a.bookingInfo, 80);
  if (booking) return `关联：${booking}`;
  const note = clean(a.note, 80);
  if (!note) return '';
  const first = note.split(/[；;。\n]/).map((x) => x.trim()).find(Boolean) || note;
  return clean(first, 80);
}

function alarmPopupContent(alarm, phase) {
  const a = alarm || {};
  const actionAt = actionAtOf(a);
  const friendly = timeUtil.fmtFriendly(actionAt);
  const leadMinutes = leadOf(a);
  const lines = [
    a.title || '该办事项了',
    phase === 'advance' ? `还有 ${leadMinutes} 分钟` : '现在办理',
    `办理时间：${friendly}`,
  ];
  // 弹窗不回显生成阶段的长备注；没有结构化使用信息时只保留标题和办理时间。
  const keyInfo = alarmKeyInfoOf(Object.assign({}, a, { note: '' }));
  if (keyInfo) lines.push(keyInfo);
  return lines.join('\n');
}

/**
 * 加载本地闹钟缓存
 */
function loadAlarms() {
  return wx.getStorageSync(STORAGE_KEY) || [];
}

/**
 * 保存闹钟缓存
 */
function saveAlarms(alarms) {
  wx.setStorageSync(STORAGE_KEY, alarms);
}

/**
 * 加载已触发列表
 */
function loadFired() {
  if (cachedFired) return cachedFired;
  cachedFired = wx.getStorageSync(FIRED_KEY) || {};
  // 清掉 1 天前的记录
  const cutoff = Date.now() - 86400000;
  Object.keys(cachedFired).forEach((id) => {
    if (cachedFired[id] < cutoff) delete cachedFired[id];
  });
  return cachedFired;
}

function saveFired(map) {
  cachedFired = map;
  wx.setStorageSync(FIRED_KEY, map);
}

/**
 * 触发闹钟：每条事项只在用户设置的提前时刻提醒一次
 * 只负责震动+弹窗；已触发标记由调用方写入
 */
function fireAlarm(alarm, phase) {
  // 1. 震动
  wx.vibrateLong({ type: 'heavy' });
  setTimeout(() => wx.vibrateLong({ type: 'heavy' }), 800);
  setTimeout(() => wx.vibrateLong({ type: 'heavy' }), 1600);

  // 2. 提示
  const actionAt = actionAtOf(alarm);
  const friendly = timeUtil.fmtFriendly(actionAt);
  const leadMinutes = leadOf(alarm);
  const isAdvance = phase === 'advance';
  wx.showModal({
    title: isAdvance ? '⏰ 即将到点' : '⏰ 时间到',
    content: alarmPopupContent(alarm, phase),
    confirmText: '知道了',
    showCancel: false,
  });
}

/**
 * 检查所有闹钟：每条事项只在 fireAt - leadMinutes 的时刻提醒一次，
 * 不再额外生成/触发“到点”第二条提醒。
 */
function checkAlarms() {
  const alarms = loadAlarms().map(normalizeAlarm);
  if (!alarms.length) return;
  const now = Date.now();
  const fired = loadFired();
  let changed = false;

  alarms.forEach((alarm) => {
    if (isCompleted(alarm)) return;
    const actionAt = alarm.actionAt;
    const remindAt = alarm.remindAt;
    if (!actionAt || !remindAt) return;

    // 唯一提醒：按每条事项的 leadMinutes 在提醒时刻触发。
    const remindKey = alarm._id + '__remind';
    if (now >= remindAt && !fired[remindKey]) {
      fireAlarm(alarm, 'advance');
      fired[remindKey] = Date.now();
      changed = true;
    }
  });

  if (changed) saveFired(fired);
}

/**
 * 启动前台轮询
 */
function startPolling() {
  if (timerId) return;
  checkAlarms();
  timerId = setInterval(checkAlarms, POLL_INTERVAL);
}

/**
 * 停止前台轮询（后台时）
 */
function stopPolling() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

/**
 * 重新拉闹钟列表
 */
function refreshAlarms() {
  // 各页面有缓存更新时触发，重新检查一次
  checkAlarms();
}

/**
 * 同步闹钟到本地
 * 若手机时区与北京时间不一致，重算后的触发时间会异步回写云端，
 * 保证云函数定时推送也按手机时区触发
 */
function syncAlarms(alarms) {
  const list = (alarms || []).map(normalizeAlarm);
  saveAlarms(list);
  try {
    // 懒加载，避免循环依赖；mock 模式下 updateAlarm 是 no-op
    const api = require('../services/api');
    list.forEach((a) => {
      if (!a || !a._id || !a.fireAtStr || !a.actionAt) return;
      const original = Number(a.fireAt) || 0;
      if (a.actionAt !== original || Number(a.remindAt) !== Number(a.actionAt - a.leadMinutes * 60 * 1000)) {
        api.updateAlarm(a._id, {
          fireAt: a.actionAt,
          leadMinutes: a.leadMinutes,
          fireAtStr: a.fireAtStr,
        }).catch(() => {});
      }
    });
  } catch (e) { /* ignore */ }
  refreshAlarms();
}

/**
 * 计算触发时间戳
 * - fireAtStr（"YYYY-MM-DD HH:mm"，原文墙面时刻）优先：用【用户手机所在时区】解释
 * - 否则回退 fireAt（时间戳或 Date 字符串）
 */
function calcTriggerAt(fireAt, fireAtStr) {
  if (fireAtStr) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{1,2})/.exec(String(fireAtStr));
    if (m) {
      const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
      if (!isNaN(ts)) return ts;
    }
  }
  if (!fireAt) return null;
  if (typeof fireAt === 'number') return fireAt;
  const d = new Date(fireAt);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ============================================================
// 系统日历提醒（主力方案）
// 小程序前台轮询只在小程序打开时有效；
// 写入手机系统日历后，锁屏也会响铃+震动，微信关了也能收到。
// ============================================================

/**
 * 添加单个闹钟到系统日历
 * ⚠️ wx.addPhoneCalendar 的 startTime/endTime 单位是「秒」，不是毫秒！
 *    传毫秒会导致日期跑到公元五万年，系统直接拒绝写入。
 * 提前提醒量用用户设置值（默认 5 分钟）
 * @param {object} a { title, note, triggerAt | fireAt }
 * @returns {Promise}
 */
function addToCalendar(a) {
  return new Promise((resolve, reject) => {
    const start = actionAtOf(a);
    const leadMinutes = leadOf(a);
    if (!start) return reject(new Error('该闹钟没有有效时间'));
    if (start <= Date.now()) return reject(new Error('该闹钟已过期，无需写入日历'));
    wx.addPhoneCalendar({
      title: '⏰ ' + (a.title || '抢票提醒'),
      startTime: Math.floor(start / 1000),                       // 秒
      endTime: Math.floor((start + 30 * 60 * 1000) / 1000),      // 秒，半小时后结束
      description: alarmKeyInfoOf(a) || a.title || '',
      alarm: true,
      alarmOffset: leadMinutes * 60, // 每条事项自己的提前量，单位秒
      success: resolve,
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        // 用户主动点了「取消」——不是失败，静默处理
        if (/cancel/i.test(msg)) {
          const e = new Error('已取消');
          e.code = 'CANCELLED';
          return reject(e);
        }
        reject(new Error(msg || '添加失败'));
      },
    });
  });
}

/**
 * 批量添加未来闹钟到系统日历（逐个串行，避免弹窗打架）
 * 用户中途点取消 → 停止批次，不算失败
 * @returns {Promise<{ok:number, total:number, cancelled:number}>}
 */
async function addAllToCalendar(list) {
  const now = Date.now();
  const future = (list || []).filter((a) => {
    const t = actionAtOf(a);
    return t && t > now && !isCompleted(a);
  });
  if (!future.length) return { ok: 0, total: 0, cancelled: 0 };

  let ok = 0;
  let cancelled = 0;
  let authDenied = false;
  for (const a of future) {
    try {
      await addToCalendar(a);
      ok++;
    } catch (e) {
      if (e.code === 'CANCELLED') {
        // 用户取消了系统弹窗，不想继续写，直接收工
        cancelled++;
        break;
      }
      if (/auth|deny|authorize|permission/i.test(e.message || '')) {
        authDenied = true;
        break;
      }
      // 单个失败（如已过期、重复）跳过，继续下一个
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (authDenied) {
    const err = new Error('日历权限被拒绝');
    err.code = 'AUTH_DENIED';
    throw err;
  }
  return { ok, total: future.length, cancelled };
}

/**
 * 请求订阅消息授权（微信「服务通知」推送的前提）
 * @returns {Promise<'accept'|'reject'|'unavailable'>} 永不 reject
 */
function requestSubscribe(tmplId) {
  return new Promise((resolve) => {
    if (!tmplId || !wx.requestSubscribeMessage) return resolve('unavailable');
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        if (res && res[tmplId] === 'accept') return resolve('accept');
        // reject / ban / filter 等状态原样带回，方便诊断
        resolve('reject(' + ((res && res[tmplId]) || '空') + ')');
      },
      fail: (e) => resolve('fail(' + ((e && e.errMsg) || '未知') + ')'),
    });
  });
}

module.exports = {
  startPolling,
  stopPolling,
  refreshAlarms,
  syncAlarms,
  loadAlarms,
  calcTriggerAt,
  actionAtOf,
  remindAtOf,
  normalizeAlarm,
  alarmKeyInfoOf,
  alarmPopupContent,
  fireAlarm,         // 暴露供测试
  addToCalendar,
  addAllToCalendar,
  getAdvanceMin,
  setAdvanceMin,
  requestSubscribe,
};
