// utils/genrunner.js
// 生成任务的「驱动员」—— 一个全局单例，不挂在页面上。
//
// 为什么单独拎出来：以前"细化要跑好几轮"的循环写在 planner 页面里，
// 用户一离开页面（返回/关闭小程序）循环就断了，行程永远停在半成品。
// 现在循环跑在这个模块里：页面在不在都无关紧要，切到「我的行程」甚至
// 回首页，它照样一轮一轮往下跑；就算整个小程序被关掉，云端还有 genWorker
// 定时接力，用户回来时 sync() 会接上进度继续跑。
//
// 用法：
//   const gen = require('../../utils/genrunner');
//   const res = await gen.start(payload);          // 发起一次生成（跑完才返回）
//   const off = gen.subscribe((s) => { ... });     // 订阅进度（页面 onUnload 里 off()）
//   gen.sync();                                    // 回到小程序时接上没跑完的任务

const api = require('../services/api');
const homeCache = require('./homecache');

const STORE_KEY = 'gen_running_job';
const MAX_RUN_MS = 12 * 60 * 1000;   // 本客户端最多驱动 12 分钟（防死循环）
const TIMEOUT_RE = /-504003|-601002|ESOCKETTIMEDOUT|timed out|TIME_LIMIT|执行超时/i;
const RUNNER_ID = `client-${Date.now()}-${Math.floor(Math.random() * 1000000000)}`;

let state = {
  status: 'idle',      // idle | running | done | failed
  jobId: '',
  tripId: '',
  title: '',
  round: 0,
  progress: null,      // { done, total }
  itemCount: 0,
  error: '',
};

const listeners = new Set();
let driving = false;   // 本客户端是否正在驱动某个任务
let runToken = 0;      // 账号切换后使旧请求的回调失效，避免进度串号

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emit() {
  listeners.forEach((fn) => {
    try { fn(state); } catch (e) { /* 单个页面报错不影响其他订阅者 */ }
  });
}

function set(patch) {
  state = Object.assign({}, state, patch);
  emit();
}

function subscribe(fn) {
  listeners.add(fn);
  try { fn(state); } catch (e) {}
  return () => listeners.delete(fn);
}

function get() {
  return state;
}

function saveJobId(id) {
  try {
    if (id) wx.setStorageSync(STORE_KEY, id);
    else wx.removeStorageSync(STORE_KEY);
  } catch (e) { /* 存储不可用不影响生成 */ }
}

function readJobId() {
  try { return wx.getStorageSync(STORE_KEY) || ''; } catch (e) { return ''; }
}

// 首轮云端返回 tripId 后立刻切换当前行程，首页可以显示已生成的部分；
// 不等到全部细化结束，也不继续沿用旧首页快照。
function selectGeneratedTrip(tripId) {
  if (!tripId) return;
  try {
    const app = getApp();
    if (app && app.globalData && app.globalData.currentTripId !== tripId) {
      app.globalData.currentTripId = tripId;
      app.globalData.currentTrip = null;
      homeCache.clear();
    }
  } catch (e) { /* 测试环境没有 getApp，不影响任务驱动 */ }
}

/** 一轮一轮往下跑，直到跑完 / 失败 / 超时。jobId 与 round 由调用方给。 */
async function pump(jobId, round, token) {
  let r = { jobId, round, partial: true, status: 'running' };
  const t0 = Date.now();
  let timeouts = 0;   // 连续超时次数：偶尔一轮被 60s 上限杀掉很正常，歇口气接着跑，
                      // 任务还在库里（进度已落库），绝不是"失败"——别把用户吓跑
  while (token === runToken && r.status === 'running' && r.partial && Date.now() - t0 < MAX_RUN_MS) {
    let next = null;
    try {
      // expectRound = 乐观锁：这一轮要是被云端 genWorker 抢先跑了，
      // 这里会拿到 busy，本客户端就让路，别两边同时跑同一份行程
      next = await api.resumeGen(jobId, r.round, RUNNER_ID);
      timeouts = 0;
    } catch (e) {
      if (token !== runToken) return { jobId, status: 'cancelled' };
      if (TIMEOUT_RE.test((e && e.message) || '') && timeouts < 3) {
        timeouts += 1;
        set({ jobId, status: 'running', error: '' });
        await sleep(6000);
        continue;
      }
      set({ status: 'failed', error: e.message || '续跑失败' });
      return r;
    }
    if (!next) break;
    if (token !== runToken) return { jobId, status: 'cancelled' };
    r = Object.assign({}, r, next);
    selectGeneratedTrip(r.tripId || state.tripId);
    set({
      jobId,
      tripId: r.tripId || state.tripId,
      title: r.title || state.title,
      round: r.round || state.round,
      progress: r.progress || state.progress,
      itemCount: r.itemCount || state.itemCount,
      status: r.status === 'failed' ? 'failed' : (r.partial ? 'running' : 'done'),
      error: r.error || '',
    });
    if (r.error) break;
    // busy = 别的端或定时触发器正在跑这一轮，等它跑完再问
    if (r.busy) await sleep(4000);
  }
  return r;
}

/**
 * 发起一次生成：建任务 → 跑首轮 → 自己接着跑完。
 * 中途用户离开页面也没关系（循环在模块里，不在页面上）。
 * @returns 与云函数 build 一致的 { tripId, itemCount, gaveUpDayIndexes, ... }
 */
async function start(payload) {
  if (driving) return state;
  const token = ++runToken;
  driving = true;
  const total = ((payload && payload.outline && payload.outline.days) || []).length || 0;
  set({
    status: 'running', jobId: '', tripId: '', title: payload && payload.title ? payload.title : '',
    round: 0, progress: { done: 0, total }, itemCount: 0, error: '',
  });
  try {
    const res = await api.startGen(Object.assign({}, payload, { runnerId: RUNNER_ID }));
    if (token !== runToken) return state;
    if (!res) throw new Error('生成失败，请重试');
    set({
      jobId: res.jobId || '',
      tripId: res.tripId || '',
      round: res.round || 1,
      progress: res.progress || state.progress,
      itemCount: res.itemCount || 0,
      status: res.partial ? 'running' : 'done',
    });
    selectGeneratedTrip(res.tripId || '');
    saveJobId(res.jobId || '');
    let r = res;
    if (res.partial) r = await pump(res.jobId, res.round, token);
    if (token !== runToken) return state;
    if (state.status === 'done') saveJobId('');
    driving = false;
    return Object.assign({}, r, { tripId: state.tripId, itemCount: state.itemCount });
  } catch (e) {
    driving = false;
    if (token !== runToken) return state;
    set({ status: 'failed', error: e.message || '生成失败' });
    throw e;
  }
}

/**
 * 回到小程序时调用：看看有没有没跑完的任务，有就接着跑。
 * 典型场景：用户发起生成后直接关掉小程序 —— 云端 genWorker 已经在接力了，
 * 用户回来时这里会立刻补上剩下的轮次，不用干等下一分钟。
 */
async function sync(options) {
  options = options || {};
  const reviveFailed = !!options.resumeFailed;
  if (driving) return state;
  const token = runToken;
  let job = null;
  try {
    const d = await api.genJobStatus();
    if (token !== runToken) return state;
    job = (d && d.job) || null;
  } catch (e) {
    return state;      // 查不到就当没有，别打扰用户
  }
  if (token !== runToken) return state;
  if (!job) {
    saveJobId('');
    if (state.status === 'running') set({ status: 'idle', jobId: '', progress: null, error: '' });
    return state;
  }
  const willRevive = reviveFailed && job.status === 'failed';
  set({
    status: (job.status === 'running' || willRevive) ? 'running' : job.status,
    jobId: job.jobId,
    tripId: job.tripId || '',
    title: job.title || '',
    round: job.round || 0,
    progress: job.progress || null,
    itemCount: job.itemCount || 0,
    error: job.error || '',
  });
  if (token !== runToken) return state;
  selectGeneratedTrip(job.tripId || '');
  if (job.status !== 'running' && !willRevive) {
    saveJobId('');
    return state;
  }
  saveJobId(job.jobId);
  if (!willRevive && !job.resumable) return state;   // 有人在跑（另一台设备或云端），安静等着
  driving = true;
  try {
    await pump(job.jobId, job.round, token);
  } finally {
    driving = false;
  }
  if (state.status === 'done') saveJobId('');
  return state;
}

/** 退出账号/切换账号时只停止本地驱动，云端任务仍由 genWorker 接力完成。 */
function reset() {
  runToken += 1;
  driving = false;
  saveJobId('');
  set({
    status: 'idle', jobId: '', tripId: '', title: '', round: 0,
    progress: null, itemCount: 0, error: '',
  });
}

module.exports = { get, subscribe, start, sync, reset, readJobId };
