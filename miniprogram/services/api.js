// services/api.js
// API 服务层入口，根据 USE_MOCK 开关选择真实云函数还是 mock 数据
//
// ============================================================
// ⚙️ 开关在这里 —— 改 USE_MOCK 一个变量就能切换：
//   true  = 使用本地 mock 数据，**不需要云开发**（推荐试用）
//   false = 调用真实云函数（需要开通云开发 + 配置环境变量）
// ============================================================
const USE_MOCK = false;

const realApi = require('./api-real');
const mockApi = require('./api-mock');

const api = USE_MOCK ? mockApi : realApi;

// 给开发者一个明显的提示
console.info(
  `[API] 当前模式：${USE_MOCK ? '🟢 MOCK（本地数据，不需要云开发）' : '🔴 真实云函数'}`
);

module.exports = api;