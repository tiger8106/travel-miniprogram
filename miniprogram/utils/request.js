// utils/request.js
// 统一云函数调用封装

/**
 * 检测云函数执行超时（-504003 FUNCTIONS_TIME_LIMIT_EXCEEDED）
 * 云开发新创建的云函数**默认超时只有 3 秒**，跑 LLM 必然超，
 * 需要在控制台「云函数 → 配置 → 超时时间」改成 60 秒（每个函数单独配）
 * @param {object} err 原始错误
 */
function isTimeout(err) {
  const raw = `${(err && (err.errMsg || err.message)) || ''}${(err && err.errCode) || ''}`;
  return /-504003|timed out|TIME_LIMIT/i.test(raw);
}

/**
 * 检测云函数不存在（-501000 FUNCTION_NOT_FOUND）
 * 绝大多数情况 = 这个云函数还没在开发者工具里「上传并部署」到云端
 * @param {object} err 原始错误
 */
function isFnNotFound(err) {
  const raw = `${(err && (err.errMsg || err.message)) || ''}${(err && err.errCode) || ''}`;
  return /-501000|FUNCTION_NOT_FOUND|could not be found/i.test(raw);
}

/**
 * 调用云函数
 * @param {string} name 云函数名
 * @param {object} data 参数
 * @returns {Promise}
 */
function callFn(name, data = {}) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(new Error('当前微信版本不支持云开发，请升级微信'));
      return;
    }
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => {
        if (res.result && res.result.code === 0) {
          resolve(res.result.data);
        } else {
          reject(new Error((res.result && res.result.msg) || '云函数调用失败'));
        }
      },
      fail: (err) => {
        console.error(`[cloud] ${name} fail:`, err);
        // 超时不丢原始 errCode，改成能直接照做的人话提示
        if (isTimeout(err)) {
          reject(new Error(`「${name}」执行超时：请在云开发控制台把该云函数的超时时间改成 60 秒（默认只有 3 秒）`));
          return;
        }
        if (isFnNotFound(err)) {
          reject(new Error(`云函数「${name}」还没上传到云端：请在开发者工具左侧目录找到它，右键 →「上传并部署：云端安装依赖」`));
          return;
        }
        reject(err);
      },
    });
  });
}

/**
 * 上传文件到云存储
 */
function uploadFile(cloudPath, filePath) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
      reject(new Error('当前微信版本不支持云开发'));
      return;
    }
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject,
    });
  });
}

/**
 * 下载云存储文件
 */
function downloadFile(fileID) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') {
      reject(new Error('当前微信版本不支持云开发'));
      return;
    }
    wx.cloud.downloadFile({
      fileID,
      success: (res) => resolve(res.tempFilePath),
      fail: reject,
    });
  });
}

/**
 * 删除云存储文件
 */
function deleteFile(fileIDs) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.deleteFile !== 'function') {
      reject(new Error('当前微信版本不支持云开发'));
      return;
    }
    wx.cloud.deleteFile({
      fileList: Array.isArray(fileIDs) ? fileIDs : [fileIDs],
      success: resolve,
      fail: reject,
    });
  });
}

// ============================================================
// 数据库访问 —— **只在被调用时才初始化**，避免模块加载时崩溃
// （USE_MOCK 模式下根本不会调到这里）
// ============================================================
function getDB() {
  if (!wx.cloud || typeof wx.cloud.database !== 'function') {
    throw new Error('当前微信版本不支持云开发');
  }
  return wx.cloud.database();
}

function getCommand() {
  return getDB().command;
}

function getAggregate() {
  return getDB().command.aggregate;
}

module.exports = {
  callFn,
  uploadFile,
  downloadFile,
  deleteFile,
  getDB,
  getCommand,
  getAggregate,
};