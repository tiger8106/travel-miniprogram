// services/api-real.js
// 真实云函数版本 —— 通过 utils/request 调用 wx.cloud.callFunction
// 当 services/api.js 里 USE_MOCK = false 时启用本文件
const { callFn, uploadFile, downloadFile } = require('../utils/request');
const config = require('../config');

// 攻略解析
async function parseTravelPlan(fileID) {
  return callFn('parseTravelPlan', { fileID });
}

// 实时地理编码：地点名 → { lon, lat }
async function geocode(location) {
  return callFn('parseTravelPlan', { action: 'geocode', location });
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
  uploadDoc,
  downloadFromCloud,
};