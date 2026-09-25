// miniprogram/utils/eta.js
// 生成耗时预估：把"AI 大约要跑多久"从拍脑袋改成量出来的
//
// 背景（Tiger 反馈）：页脚写死「生成约需 40 秒」「展开约需 30 秒」，
//   实测大纲 15~30s、展开随天数 40~120s（还要续跑），数字和真实体验差一大截，
//   用户看到"说好 30 秒"却等了一分多钟，只会以为卡死了。
//
// 做法：每次跑完把真实耗时喂回来，用指数滑动平均拟合两个参数
//   est(days) = base + perDay × days      （base=固定开销，perDay=每天细化成本）
// 样本越多越信任实测值、越不轻易被单次抖动带跑偏。
//
// 只存本地（wx.Storage），不涉及隐私，换设备/清缓存就退回默认参数。

const KEY = 'planner_eta_v1';

// 一次都没跑过时的兜底参数（按 qwen3.8-flash 实跑标定，2026-09-25）
//   8 天国庆广西实测（qwen3.8-flash，两次真跑）：
//     大纲 29.5s / 32s（需要"漏点修订"时再加 ~8s）
//     展开 3 轮合计 84s ~ 161s（视模型快慢波动很大，所以只当初始值，跑几次就会被实测值接管）
const DEFAULTS = {
  // 大纲：一次请求（短行程也快不了多少，主要开销在 prompt 与固定规则）
  outline: { base: 22000, perDay: 1200, min: 10000, max: 52000 },
  // 展开：3 天一批并行，天多要续跑好几轮（每轮各自 60s 上限），闹钟/建议并行跑
  detail: { base: 15000, perDay: 10000, min: 20000, max: 300000 },
};

// 明显异常的值不喂进模型：太短（本地 mock / 秒回）或太长（切后台、断网重试）
const MIN_SAMPLE_MS = 2000;
const MAX_SAMPLE_MS = 10 * 60 * 1000;

let cache = null;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = wx.getStorageSync(KEY);
    if (raw && typeof raw === 'object') cache = raw;
  } catch (e) { /* 读不到就用默认 */ }
  return cache;
}

function save(store) {
  cache = store;
  try { wx.setStorageSync(KEY, store); } catch (e) { /* 存不了不影响使用 */ }
}

/**
 * 预估某个阶段要跑多久
 * @param {'outline'|'detail'} phase
 * @param {number} days 行程天数
 * @returns {number} 毫秒
 */
function estimate(phase, days) {
  const d = DEFAULTS[phase];
  if (!d) return 30000;
  const s = load()[phase];
  const n = Math.max(1, Number(days) || 1);
  if (!s || !s.n) return clamp(d.base + d.perDay * n, d.min, d.max);
  return clamp((s.base || d.base) + (s.perDay || d.perDay) * n, d.min, d.max);
}

/**
 * 跑完一次后把真实耗时记下来
 * @param {'outline'|'detail'} phase
 * @param {number} days 行程天数
 * @param {number} ms 实际耗时
 */
function record(phase, days, ms) {
  const d = DEFAULTS[phase];
  if (!d) return;
  if (!(ms > MIN_SAMPLE_MS) || ms > MAX_SAMPLE_MS) return;  // 异常样本直接丢
  const store = load();
  const n = Math.max(1, Number(days) || 1);
  const s = Object.assign({}, store[phase] || { base: d.base, perDay: d.perDay, n: 0 });
  const pred = clamp(s.base + s.perDay * n, d.min, d.max);
  const err = ms - pred;
  // 样本越多，单次误差对模型的影响越小（1/√n 衰减）
  const alpha = 0.5 / Math.sqrt(s.n + 1);
  // 误差一半归"固定开销"、一半归"每天成本"，避免单个样本把整条曲线拽歪
  s.base = clamp(s.base + alpha * err * 0.5, 1000, d.max);
  s.perDay = clamp(s.perDay + (alpha * err * 0.5) / n, 0, d.max);
  s.n = (s.n || 0) + 1;
  s.lastMs = ms;
  s.lastDays = n;
  store[phase] = s;
  save(store);
}

/** 有没有跑过（用来决定要不要加"首次可能更久"的措辞） */
function hasHistory(phase) {
  const s = load()[phase];
  return !!(s && s.n > 0);
}

/** 上次实际用时（毫秒），没有就 0 */
function lastMs(phase) {
  const s = load()[phase];
  return (s && s.lastMs) || 0;
}

/** 毫秒 → "25 秒" / "1 分 40 秒" */
function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/**
 * 页脚用的完整文案
 * @returns {string} 例："预计约 25 秒（上次实际 22 秒）"
 */
function footerText(phase, days) {
  const est = fmtDuration(estimate(phase, days));
  const last = lastMs(phase);
  if (last > 0) return `预计约 ${est}（上次实际 ${fmtDuration(last)}）`;
  return `预计约 ${est}（首次生成会稍久一点）`;
}

module.exports = { estimate, record, hasHistory, lastMs, fmtDuration, footerText, DEFAULTS };
