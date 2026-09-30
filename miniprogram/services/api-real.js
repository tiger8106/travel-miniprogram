// services/api-real.js
// 真实云函数版本 —— 通过 utils/request 调用 wx.cloud.callFunction
// 当 services/api.js 里 USE_MOCK = false 时启用本文件
const { callFn, uploadFile, downloadFile } = require('../utils/request');
const config = require('../config');
const alarm = require('../utils/alarm');

// 攻略解析
async function parseTravelPlan(fileID) {
  return callFn('parseTravelPlan', { fileID, leadMinutes: alarm.getAdvanceMin() });
}

// 攻略分步解析：云函数 60s 上限调不高，把解析拆成六步由前端编排——
// init（读文档切分）→ day（逐天 AI 解析，循环 N 次）→ collect（闹钟+建议）
// → infer（清洗+反推待办）→ geocode（地图定位，循环到完）→ commit（入库）。
// 每步都远小于 60s，失败可从断点重试。
async function parseTravelPlanStep(payload) {
  return callFn('parseTravelPlan', Object.assign({ leadMinutes: alarm.getAdvanceMin() }, payload));
}

// 实时地理编码：地点名 → { lon, lat }
// city：可选的大地名（省/市/县），帮高德消歧，避免定位到同名的其他地点
async function geocode(location, city) {
  return callFn('parseTravelPlan', { action: 'geocode', location, city: city || '' });
}

// 行程 CRUD
async function saveItinerary(payload) {
  return callFn('itinerary', { action: 'save', payload });
}

async function getItinerary(tripId) {
  return callFn('itinerary', { action: 'get', tripId });
}

async function listItineraries(options) {
  options = options || {};
  return callFn('itinerary', {
    action: 'list',
    compact: !!options.compact,
    fullTripId: options.fullTripId || '',
  });
}

async function updateItinerary(tripId, patch) {
  return callFn('itinerary', { action: 'update', tripId, patch });
}

async function deleteItinerary(tripId) {
  return callFn('itinerary', { action: 'delete', tripId });
}

// 闹钟 CRUD
async function saveAlarms(tripId, alarms) {
  return callFn('ticketAlarm', { action: 'save', tripId, alarms });
}

async function listAlarms(tripId) {
  return callFn('ticketAlarm', { action: 'list', tripId });
}

async function setAlarmAdvance(tripId, minutes) {
  return callFn('ticketAlarm', { action: 'setAdvance', tripId, minutes });
}

async function updateAlarm(alarmId, patch) {
  return callFn('ticketAlarm', { action: 'update', alarmId, patch });
}

async function deleteAlarm(alarmId) {
  return callFn('ticketAlarm', { action: 'delete', alarmId });
}

// 立即给当前用户发一条订阅消息提醒（闹钟「测试」按钮用）
// 模板 ID 从前端 config.js 一起带过去：云函数环境变量没配也能正常推送
async function sendTestAlarm(payload) {
  return callFn('sendAlarm', {
    action: 'test',
    templateId: config.SUBSCRIBE_TEMPLATE_ID || '',
    ...payload,
  });
}

// 订阅消息体检：不发消息，只回报云函数版本 / 模板 / openid 等诊断信息
async function getAlarmStatus() {
  return callFn('sendAlarm', {
    action: 'status',
    templateId: config.SUBSCRIBE_TEMPLATE_ID || '',
  });
}
async function getSuggestions(tripId) {
  return callFn('suggestions', { action: 'get', tripId });
}

async function refreshSuggestions(tripId) {
  return callFn('suggestions', { action: 'refresh', tripId });
}

// 按天的建议与注意事项（行程详情页底部）
async function getDayTips(tripId, dayIndex, force) {
  return callFn('suggestions', { action: 'dayTips', tripId, dayIndex, force });
}

// AI 制定新攻略（两阶段，避免单次调用撞上云函数 60s 上限）
async function generateOutline(input) {
  return callFn('generatePlan', Object.assign({ action: 'outline' }, input));
}

async function buildPlan(input, outlineData) {
  return callFn('generatePlan', Object.assign({ action: 'build' }, input, outlineData));
}

// 云函数体检：环境变量齐不齐、模型连不连得上（生成失败时前端自动调，帮用户自助排查）
async function generateDiag() {
  return callFn('generatePlan', { action: 'diag' });
}

// ---------- 后台生成（中途退出小程序也能跑完） ----------

// 建任务 + 跑首轮。返回的 jobId 用来续跑
async function startGen(input) {
  return callFn('generatePlan', Object.assign({ action: 'build', jobMode: true }, input));
}

// 续跑一轮。带 expectRound 做乐观锁：只有"没人替我跑过"时才真的跑
async function resumeGen(jobId, expectRound, runnerId) {
  const data = { action: 'resume', jobId };
  if (expectRound != null) data.expectRound = expectRound;
  if (runnerId) data.runnerId = runnerId;
  return callFn('generatePlan', data);
}

// 查当前有没有正在后台生成的任务
async function genJobStatus() {
  return callFn('generatePlan', { action: 'jobStatus' });
}

async function dismissGen(jobId) {
  return callFn('generatePlan', { action: 'dismissJob', jobId });
}

// 上传 / 下载
async function uploadDoc(localPath) {
  const ts = Date.now();
  return uploadFile(`travel-docs/${ts}-${Math.floor(Math.random() * 1000)}.docx`, localPath);
}

async function downloadFromCloud(fileID) {
  return downloadFile(fileID);
}

// ============================================================
// 管理后台（admin 云函数）
// 说明：页面入口本身只对管理员可见，普通用户看不到也点不到。
//      这些接口在云端还会再验一次管理员身份，前端显示隐藏不是安全边界。
// ============================================================

/** 当前账号的身份与平台概况 */
function adminWhoami() {
  return callFn('admin', { action: 'whoami' });
}

/** 最近订单的微信侧支付和结算快照；云端再次校验管理员身份。 */
function adminPaymentLedger(refresh) {
  return callFn('virtualPay', { action: 'adminLedger', refresh: !!refresh });
}

/** 用一次性认领码成为超级管理员 */
function adminClaim(code) {
  return callFn('admin', { action: 'claim', code });
}

/** 按微信号 / 昵称找用户（管理员） */
function adminSearchUsers(keyword) {
  return callFn('admin', { action: 'searchUsers', keyword });
}

/** 授权 / 取消授权「不限量使用」 */
function adminSetUnlimited(userId, enable) {
  return callFn('admin', { action: 'setUnlimited', userId, enable: enable !== false });
}

/** 管理员名单 */
function adminListStaff() {
  return callFn('admin', { action: 'listStaff' });
}

/** 增/撤管理员（仅超级管理员） */
function adminSetAdmin(userId, isAdmin) {
  return callFn('admin', { action: 'setAdmin', userId, isAdmin: isAdmin !== false });
}

/** 可配置项清单（敏感值已脱敏） */
function adminGetConfig() {
  return callFn('admin', { action: 'getConfig' });
}

/** 保存配置 patch（只传改动的项；清空 = 交还给环境变量） */
function adminSaveConfig(patch) {
  return callFn('admin', { action: 'saveConfig', patch });
}

/** 操作日志 */
function adminAuditList() {
  return callFn('admin', { action: 'auditList' });
}

/** 清空操作日志（仅超级管理员） */
function adminClearAudit() {
  return callFn('admin', { action: 'clearAudit' });
}

/** 连通性自检 */
function adminTestLlm() {
  return callFn('admin', { action: 'testLlm' });
}

function adminTestAmap() {
  return callFn('admin', { action: 'testAmap' });
}

module.exports = {
  parseTravelPlan,
  parseTravelPlanStep,
  geocode,
  saveItinerary,
  getItinerary,
  listItineraries,
  updateItinerary,
  deleteItinerary,
  saveAlarms,
  listAlarms,
  setAlarmAdvance,
  updateAlarm,
  deleteAlarm,
  sendTestAlarm,
  getAlarmStatus,
  getSuggestions,
  refreshSuggestions,
  getDayTips,
  generateOutline,
  buildPlan,
  generateDiag,
  startGen,
  resumeGen,
  genJobStatus,
  dismissGen,
  uploadDoc,
  downloadFromCloud,
  adminWhoami,
  adminPaymentLedger,
  adminClaim,
  adminSearchUsers,
  adminSetUnlimited,
  adminListStaff,
  adminSetAdmin,
  adminGetConfig,
  adminSaveConfig,
  adminAuditList,
  adminClearAudit,
  adminTestLlm,
  adminTestAmap,
};
