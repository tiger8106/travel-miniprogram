const assert = require('assert');
const storage = new Map();
global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  getStorageInfoSync: () => ({ keys: [...storage.keys()] }),
};
const cache = require('../miniprogram/utils/homecache');
cache.setSelectedTripId('user-a', 'trip-2');
cache.setSelectedTripId('user-b', 'trip-9');
assert.strictEqual(cache.selectedTripId('user-a'), 'trip-2');
assert.strictEqual(cache.selectedTripId('user-b'), 'trip-9');
cache.clear();
assert.strictEqual(cache.selectedTripId('user-a'), 'trip-2', '首页快照失效不应丢失选中行程');
cache.setSelectedTripId('user-a', null);
assert.strictEqual(cache.selectedTripId('user-a'), '');
assert.strictEqual(cache.selectedTripId('user-b'), 'trip-9');
cache.clearAll();
assert.strictEqual(cache.selectedTripId('user-b'), '', '退出账号时应清除选中行程');
console.log('✅ 首页选中行程跨启动保存、按账号隔离、退出清理');
