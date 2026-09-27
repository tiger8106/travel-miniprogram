// utils/cloud.js
// 小程序端云开发初始化状态与错误诊断。
//
// wx.cloud.init() 本身没有 success/fail 回调。开发者工具在环境 ID、
// AppID、登录账号或网络不匹配时，通常只在控制台打印「no baseresponse」，
// 页面随后还会继续调用云函数，导致用户只能看到一串底层错误。

let state = {
  status: 'idle', // idle | ready | failed
  envId: '',
  error: null,
};

function wxApi() {
  return typeof wx !== 'undefined' ? wx : null;
}

function normalizeEnvId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id || /^(YOUR_ENV_ID|your-env-id|<[^>]+>)$/i.test(id)) return '';
  return id;
}

function errorText(err) {
  if (!err) return '';
  return String(err.errMsg || err.message || err.msg || err);
}

function isInitFailure(err) {
  const raw = errorText(err);
  return /no baseresponse|cloud\s*init|environment|env(?:ironment)?\s*id|not\s*authorized|unauthorized|access\s*denied/i.test(raw);
}

function runtimeAppId() {
  const api = wxApi();
  try {
    const info = api && api.getAccountInfoSync && api.getAccountInfoSync();
    return (info && info.miniProgram && info.miniProgram.appId) || '';
  } catch (e) {
    return '';
  }
}

function diagnostics() {
  return {
    status: state.status,
    envId: state.envId || '(开发者工具默认环境)',
    appId: runtimeAppId() || '(无法读取)',
    rawError: errorText(state.error),
  };
}

function markFailed(err) {
  if (!isInitFailure(err)) return false;
  state.status = 'failed';
  state.error = err || new Error('云开发初始化失败');
  return true;
}

/**
 * 初始化云开发。
 * @param {{envId?: string, traceUser?: boolean, force?: boolean}} options
 * @returns {{ok: boolean, error?: Error, diagnostics: object}}
 */
function init(options) {
  options = options || {};
  if (state.status === 'ready' && !options.force) {
    return { ok: true, diagnostics: diagnostics() };
  }

  const api = wxApi();
  state.envId = normalizeEnvId(options.envId);
  state.error = null;
  state.status = 'idle';

  if (!api || !api.cloud || typeof api.cloud.init !== 'function') {
    const err = new Error('当前基础库不支持云开发');
    state.status = 'failed';
    state.error = err;
    return { ok: false, error: err, diagnostics: diagnostics() };
  }

  const initOptions = {
    traceUser: options.traceUser !== false,
  };
  // 不传 env 时由开发者工具/小程序使用当前默认云环境。
  // 这样保留了本地调试的兜底，但正式环境仍建议填显式环境 ID。
  if (state.envId) initOptions.env = state.envId;

  try {
    api.cloud.init(initOptions);
    state.status = 'ready';
    return { ok: true, diagnostics: diagnostics() };
  } catch (err) {
    state.status = 'failed';
    state.error = err;
    return { ok: false, error: err, diagnostics: diagnostics() };
  }
}

function hasInitError() {
  return state.status === 'failed';
}

function requestError() {
  if (hasInitError()) {
    return new Error('云开发初始化失败，请检查 AppID、云环境 ID 和开发者工具当前环境后重新编译');
  }
  return new Error('云开发尚未初始化，请重新打开小程序');
}

function userMessage() {
  const d = diagnostics();
  return [
    '云开发没有返回有效响应（no baseresponse）。',
    `当前小程序 AppID：${d.appId}`,
    `当前云环境：${d.envId}`,
    '',
    '请在微信开发者工具确认：',
    '1. 云开发右上角环境与这里的环境 ID 完全一致；',
    '2. 当前登录账号有该环境权限，且环境没有被删除或停用；',
    '3. 项目 AppID 与云环境所属小程序一致；',
    '4. 网络或代理可访问微信云开发，然后重新编译。',
  ].join('\n');
}

function getState() {
  return {
    status: state.status,
    envId: state.envId,
    error: state.error,
  };
}

module.exports = {
  init,
  markFailed,
  isInitFailure,
  hasInitError,
  requestError,
  userMessage,
  diagnostics,
  getState,
};
