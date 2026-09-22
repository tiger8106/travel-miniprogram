// scripts/test-globallogin.js
// 验证「一处登录，全站解锁」：登录态广播 + 自动静默登录 + 退出后不被复活
const path = require('path');

// ---- mock 微信运行时 ----
const store = new Map();
let loginCalls = 0;
global.wx = {
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  setStorageSync: (k, v) => store.set(k, v),
  removeStorageSync: (k) => store.delete(k),
  login: ({ success }) => { loginCalls += 1; success({ code: 'code-' + loginCalls }); },
  cloud: {
    callFunction: ({ success }) => success({ result: { code: 0, data: { openid: 'openid-abc' } } }),
  },
};

const auth = require(path.join(__dirname, '../miniprogram/utils/auth.js'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('✓ ' + name); }
  else { fail += 1; console.log('✗ ' + name); }
}

(async () => {
  // 1. 未登录 → requireLogin 自动静默登录成功
  ok(!auth.isLoggedIn(), '初始状态未登录');
  const r1 = await auth.requireLogin();
  ok(r1 === true, '首次进入自动静默登录成功');
  ok(auth.getOpenid() === 'openid-abc', 'openid 已缓存到 storage');

  // 2. 并发调用只发一次 wx.login
  loginCalls = 0;
  store.delete('__openid_cache__');
  await Promise.all([auth.requireLogin(), auth.requireLogin(), auth.requireLogin()]);
  ok(loginCalls === 1, '并发 3 次只发 1 次 wx.login（实际 ' + loginCalls + '）');

  // 3. 登录广播：所有订阅页立刻收到登录通知
  store.delete('__openid_cache__');
  let got = null;
  const page = { data: { needLogin: true }, setData(d) { Object.assign(this.data, d); } };
  const off = auth.watch(page, { onLogin: () => { got = 'login'; }, onLogout: () => { got = 'logout'; } });
  await auth.silentLogin(true);
  auth.notifyLogin();
  ok(got === 'login', 'notifyLogin 广播后其它页面收到登录通知');
  ok(page.data.needLogin === false, '广播自动把页面的门禁卡收起');

  // 4. 退出登录广播 + 清空
  auth.logout();
  ok(got === 'logout', 'logout 广播后其它页面收到退出通知');
  ok(page.data.needLogin === true, '退出后其它页面显示门禁卡');
  ok(!auth.isLoggedIn(), '退出后本地无 openid');

  // 5. 退出后不会被自动登录复活
  const r2 = await auth.requireLogin();
  ok(r2 === false, '主动退出后不再自动静默登录（等用户自己点）');
  ok(auth.getOpenid() === null, '退出后 getOpenid 为空');

  // 6. 用户重新登录 → 标记清除，全站解锁
  await auth.silentLogin(true);
  ok(auth.isLoggedIn(), '重新登录成功');
  auth.notifyLogin();
  ok(got === 'login', '重新登录再次广播');
  const r3 = await auth.requireLogin();
  ok(r3 === true, '重新登录后 requireLogin 直通');

  // 7. 取消订阅后不再收到广播
  off();
  got = null;
  auth.logout();
  ok(got === null, '取消订阅后不再收到广播');

  console.log('\n' + (fail === 0 ? `全部通过 ✓（${pass} 项）` : `${fail} 项失败 ✗`));
  process.exit(fail === 0 ? 0 : 1);
})();
