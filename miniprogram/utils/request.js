// utils/request.js
// 统一云函数调用封装

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