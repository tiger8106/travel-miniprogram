const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');

const storage = new Map([['__openid_cache__', 'admin-a']]);
global.wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
};
let calls = 0;
const waiting = [];
const api = { adminRole: () => { calls++; return new Promise((resolve) => waiting.push(resolve)); } };
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (parent && /utils\/admin-role\.js$/.test(parent.filename) && name === '../services/api') return api;
  return originalLoad.call(this, name, parent, isMain);
};
const adminRole = require('../miniprogram/utils/admin-role');
Module._load = originalLoad;

adminRole.remember('admin-a', true);
adminRole.remember('user-b', false);
assert(adminRole.cached('admin-a'));
assert(!adminRole.cached('user-b'), '管理员展示提示须按账号隔离');

let page;
const auth = { getOpenid: () => storage.get('__openid_cache__') || null,
  getProfile: () => ({ nickname: '管理员' }), isLoggedIn: () => !!storage.get('__openid_cache__') };
vm.runInNewContext(fs.readFileSync('miniprogram/pages/mine/mine.js', 'utf8'), {
  Date, console, getApp: () => ({}), Page: (value) => { page = value; },
  require(name) {
    if (name.endsWith('/auth')) return auth;
    if (name.endsWith('/admin-role')) return adminRole;
    if (name.endsWith('/homecache')) return { readPage: () => null };
    if (name.endsWith('/avatar-cache')) return { cached: () => '', warm: async () => '' };
    if (name.endsWith('/quota')) return { info: async () => null };
    if (name.endsWith('/privacy')) return { diagnose: async () => {}, ensure: async () => true };
    return {};
  },
});
page.data = Object.assign({}, page.data);
page.setData = (patch) => Object.assign(page.data, patch);

(async () => {
  page.onShow();
  assert.strictEqual(page.data.isAdmin, true, '进入“我的”时管理员入口须与其他菜单同步出现');
  await Promise.resolve();
  assert.strictEqual(calls, 1, '入口校验只发轻量身份请求');
  const duplicate = adminRole.refresh('admin-a');
  assert.strictEqual(calls, 1, '并发身份请求应复用同一 Promise');
  waiting.shift()({ isAdmin: false });
  await duplicate;
  await Promise.resolve();
  assert.strictEqual(page.data.isAdmin, false, '云端撤销管理员后入口应刷新隐藏');

  adminRole.remember('admin-a', true);
  page.refresh();
  await Promise.resolve();
  assert.strictEqual(calls, 2);
  storage.set('__openid_cache__', 'user-b');
  page.setData({ isAdmin: false });
  waiting.shift()({ isAdmin: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(page.data.isAdmin, false, '旧账号回包不得污染新账号页面');
  assert.strictEqual(adminRole.cached('user-b'), false);
  adminRole.clear('admin-a');
  assert.strictEqual(adminRole.cached('admin-a'), false, '退出后清理身份提示');

  storage.delete('__openid_cache__');
  global.wx.login = ({ success }) => success({ code: 'login-code' });
  Module._load = function (name, parent, isMain) {
    if (parent && /utils\/auth\.js$/.test(parent.filename) && name === './request') {
      return { callFn: async () => ({ openid: 'first-login-admin',
        profile: { nickname: '新管理员' }, isAdmin: true }) };
    }
    return originalLoad.call(this, name, parent, isMain);
  };
  const authModule = require('../miniprogram/utils/auth');
  Module._load = originalLoad;
  await authModule.silentLogin(true);
  assert(adminRole.cached('first-login-admin'), '首次登录返回角色后，进入“我的”前就有同步展示提示');

  const backend = fs.readFileSync('cloudfunctions/admin/index.js', 'utf8');
  assert(/case 'role':[\s\S]{0,150}loadUserByOpenid\(openid\)/.test(backend),
    '“我的”页须走只查身份的后端入口');
  console.log('✅ 管理入口首帧同步显示、轻量校验、并发复用及跨账号隔离');
})().catch((error) => { console.error(error); process.exitCode = 1; });
