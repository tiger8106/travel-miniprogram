const assert = require('assert');
const fs = require('fs');
const files = new Set();
const storage = new Map([['__openid_cache__', 'u1']]);
let downloads = 0;
global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  getFileSystemManager: () => ({
    accessSync: (path) => { if (!files.has(path)) throw new Error('missing'); },
    saveFile: ({ success }) => { files.add('/saved/avatar.png'); success({ savedFilePath: '/saved/avatar.png' }); },
    removeSavedFile: ({ filePath }) => files.delete(filePath),
  }),
  cloud: { downloadFile: ({ success }) => { downloads++; success({ tempFilePath: '/tmp/avatar.png' }); } },
};
const cache = require('../miniprogram/utils/avatar-cache');
(async () => {
  assert.strictEqual(cache.cached('u1', 'cloud://avatar'), '');
  assert.strictEqual(await cache.warm('u1', 'cloud://avatar'), '/saved/avatar.png');
  assert.strictEqual(cache.cached('u1', 'cloud://avatar'), '/saved/avatar.png');
  assert.strictEqual(await cache.warm('u1', 'cloud://avatar'), '/saved/avatar.png');
  assert.strictEqual(downloads, 1, '已持久化头像不应重复下载');
  assert.strictEqual(cache.cached('u2', 'cloud://avatar'), '', '本地头像按账号隔离');
  cache.clear('u1');
  assert.strictEqual(cache.cached('u1', 'cloud://avatar'), '', '退出登录清除头像缓存');
  let finishDownload;
  global.wx.cloud.downloadFile = ({ success }) => { finishDownload = success; };
  const pending = cache.warm('u1', 'cloud://new-avatar');
  cache.clear('u1');
  finishDownload({ tempFilePath: '/tmp/late-avatar.png' });
  assert.strictEqual(await pending, '', '退出后迟到的下载结果不得重新写入头像缓存');
  assert(/src="\{\{avatarView\}\}"/.test(fs.readFileSync('miniprogram/pages/mine/mine.wxml', 'utf8')),
    '头像组件应优先使用本地展示路径');
  console.log('✅ 头像持久本地缓存、冷启动复用及账号隔离');
})().catch((e) => { console.error(e); process.exitCode = 1; });
