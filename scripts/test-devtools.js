// scripts/test-devtools.js
// 验证开发者功能（推送自检 / 闹钟测试）的可见性规则：
//   'auto'  → 只在开发版显示，体验版 / 正式版隐藏（防止体验成员看到调试入口）
//   'trial' → 开发版 + 体验版显示
//   true / false → 恒开 / 恒关
//
// 2026-09-29 上线清理：临时解锁（连点关于 5 次 → 24 小时）整套机制已删除，
// 这里改成反向断言——确保它不会被人无意间加回来。

const path = require('path');

const KEY = '__dev_tools_unlock_ts__';   // 仅用于模拟「老版本残留的解锁标记」
let store = {};
let ENV = 'release'; // develop / trial / release

// 模拟 wx 环境
global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: ENV } }),
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: (k) => { delete store[k]; },
};

const CONFIG_PATH = path.resolve(__dirname, '../miniprogram/config.js');
const ENV_PATH = path.resolve(__dirname, '../miniprogram/utils/env.js');

function load(flag) {
  delete require.cache[CONFIG_PATH];
  delete require.cache[ENV_PATH];
  require.cache[CONFIG_PATH] = {
    id: CONFIG_PATH, filename: CONFIG_PATH, loaded: true, exports: { SHOW_DEV_TOOLS: flag },
  };
  return require(ENV_PATH);
}

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function reset() { store = {}; }

console.log('\n[auto] 只在开发版显示');
reset();
let e = load('auto');
ENV = 'develop';
ok(e.showDevTools() === true, '开发版 → 显示');
ENV = 'trial';
ok(e.showDevTools() === false, '体验版 → 隐藏（本次修复重点）');
ENV = 'release';
ok(e.showDevTools() === false, '正式版 → 隐藏');

console.log('\n[trial] 开发版 + 体验版显示');
reset();
e = load('trial');
ENV = 'trial';
ok(e.showDevTools() === true, '体验版 → 显示');
ENV = 'release';
ok(e.showDevTools() === false, '正式版 → 隐藏');

console.log('\n[true / false] 恒开 / 恒关');
reset();
e = load(true);
ENV = 'release';
ok(e.showDevTools() === true, 'true → 正式版也显示');
e = load(false);
ENV = 'develop';
ok(e.showDevTools() === false, 'false → 开发版也不显示');

console.log('\n[上线态] 临时解锁后门已删除（2026-09-29 清理）');
reset();
e = load('auto');
// 即便本地 Storage 里还残留着以前的解锁标记，也不该再让调试入口出现
store[KEY] = String(Date.now() - 1000);
ENV = 'trial';
ok(e.showDevTools() === false, '旧解锁标记残留 → 体验版依然隐藏（后门已废）');
ENV = 'release';
ok(e.showDevTools() === false, '旧解锁标记残留 → 正式版依然隐藏');
ok(typeof e.unlockDevTools !== 'function', 'unlockDevTools 已不存在');
ok(typeof e.lockDevTools !== 'function', 'lockDevTools 已不存在');
ok(typeof e.isDevToolsUnlocked !== 'function', 'isDevToolsUnlocked 已不存在');

console.log('\n[版本号] 环境中文名');
ENV = 'trial';
ok(e.envLabel() === '体验版', 'trial → 体验版', e.envLabel());
ENV = 'develop';
ok(e.envLabel() === '开发版', 'develop → 开发版', e.envLabel());

console.log('\n' + (fail === 0 ? '全部通过 ✓' : '有失败 ✗') + `（${pass} 通过 / ${fail} 失败）\n`);
process.exit(fail === 0 ? 0 : 1);
