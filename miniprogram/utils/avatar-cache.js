// 头像只作展示缓存：云 fileID 仍是资料来源，持久本地文件让微信冷启动时直接解码显示。
const PREFIX = 'avatar_local_v1_';
const inflight = new Map();
const generations = new Map();

function generation(openid) { return generations.get(openid) || 0; }

function record(openid) {
  try { return openid && wx.getStorageSync(PREFIX + openid); } catch (e) { return null; }
}

function cached(openid, fileID) {
  const r = record(openid);
  if (!r || !fileID || r.fileID !== fileID || !r.path) return '';
  try {
    wx.getFileSystemManager().accessSync(r.path);
    return r.path;
  } catch (e) { return ''; }
}

function save(openid, fileID, tempFilePath) {
  if (!openid || !fileID || !tempFilePath || !wx.getFileSystemManager) return Promise.resolve('');
  const previous = record(openid);
  const version = generation(openid);
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().saveFile({
        tempFilePath,
        success: (res) => {
          const path = res.savedFilePath || '';
          if (path) {
            if (generation(openid) !== version || wx.getStorageSync('__openid_cache__') !== openid) {
              try { wx.getFileSystemManager().removeSavedFile({ filePath: path, fail: () => {} }); } catch (e) {}
              resolve('');
              return;
            }
            try { wx.setStorageSync(PREFIX + openid, { fileID, path }); } catch (e) {}
            if (previous && previous.path && previous.path !== path) {
              try { wx.getFileSystemManager().removeSavedFile({ filePath: previous.path, fail: () => {} }); } catch (e) {}
            }
          }
          resolve(path);
        },
        fail: () => resolve(''),
      });
    } catch (e) { resolve(''); }
  });
}

function warm(openid, fileID) {
  const found = cached(openid, fileID);
  if (found) return Promise.resolve(found);
  if (!openid || !fileID) return Promise.resolve('');
  const key = `${openid}:${fileID}`;
  if (inflight.has(key)) return inflight.get(key);
  const version = generation(openid);
  const request = new Promise((resolve) => {
    if (fileID.indexOf('cloud://') === 0 && wx.cloud && wx.cloud.downloadFile) {
      wx.cloud.downloadFile({ fileID, success: (r) => resolve(r.tempFilePath || ''), fail: () => resolve('') });
    } else if (/^https?:\/\//.test(fileID) && wx.downloadFile) {
      wx.downloadFile({ url: fileID, success: (r) => resolve(r.statusCode === 200 ? r.tempFilePath : ''), fail: () => resolve('') });
    } else resolve('');
  }).then((temp) => temp && generation(openid) === version
    && wx.getStorageSync('__openid_cache__') === openid ? save(openid, fileID, temp) : '')
    .catch(() => '')
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

function clear(openid) {
  if (!openid) return;
  generations.set(openid, generation(openid) + 1);
  Array.from(inflight.keys()).forEach((key) => { if (key.indexOf(openid + ':') === 0) inflight.delete(key); });
  const previous = record(openid);
  try { wx.removeStorageSync(PREFIX + openid); } catch (e) {}
  if (previous && previous.path && wx.getFileSystemManager) {
    try { wx.getFileSystemManager().removeSavedFile({ filePath: previous.path, fail: () => {} }); } catch (e) {}
  }
}

module.exports = { cached, save, warm, clear };
