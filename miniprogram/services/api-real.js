// services/api-real.js
// 真实云函数版本 —— 通过 utils/request 调用 wx.cloud.callFunction
// 当 services/api.js 里 USE_MOCK = false 时启用本文件
const { callFn, uploadFile, downloadFile } = require('../utils/request');
const config = require('../config');

// 攻略解析
async function parseTravelPlan(fileID) {
  return callFn('parseTravelPlan', { fileID });
}

// 攻略分步解析：云函数 60s 上限调不高，把解析拆成六步由前端编排——
// init（读文档切分）→ day（逐天 AI 解析，循环 N 次）→ collect（闹钟+建议）
// → infer（清洗+反推待办）→ geocode（地图定位，循环到完）→ commit（入库）。
// 每步都远小于 60s，失败可从断点重试。
async function parseTravelPlanStep(payload) {
  return callFn('parseTravelPlan', payload);
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

async function listItineraries() {
  return callFn('itinerary', { action: 'list' });
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

// 上传 / 下载
async function uploadDoc(localPath) {
  const ts = Date.now();
  return uploadFile(`travel-docs/${ts}-${Math.floor(Math.random() * 1000)}.docx`, localPath);
}

async function downloadFromCloud(fileID) {
  return downloadFile(fileID);
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
  uploadDoc,
  downloadFromCloud,
};