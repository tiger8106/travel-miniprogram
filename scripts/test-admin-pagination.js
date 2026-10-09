const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../cloudfunctions/admin/index.js'), 'utf8');
const block = source.match(/async function actionSearchUsers\([\s\S]*?\n}\n\n\/\*\* 授权/);
assert(block, '找不到管理后台用户查询函数');
const users = Array.from({ length: 45 }, (_, i) => ({ _id: `user-${i}`, nickname: `旅行者${i}`, createdAt: 45 - i }));
const db = {
  RegExp: ({ regexp, options }) => new RegExp(regexp, options),
  collection(name) {
    assert.strictEqual(name, 'users');
    let rows = users;
    let offset = 0;
    let limit = 10;
    const chain = {
      where(filter) { rows = rows.filter((row) => filter.nickname.test(row.nickname)); return chain; },
      orderBy() { rows = rows.slice().sort((a, b) => b.createdAt - a.createdAt); return chain; },
      skip(value) { offset = value; return chain; },
      limit(value) { limit = value; return chain; },
      async count() { return { total: rows.length }; },
      async get() { return { data: rows.slice(offset, offset + limit) }; },
    };
    return chain;
  },
};
const context = { db, COL_USER: 'users', requireAdmin: async () => ({ ok: true }),
  publicUserWithHistory: async (row) => row };
vm.runInNewContext(block[0].replace(/\n\n\/\*\* 授权$/, '') + '\nthis.search = actionSearchUsers;', context);
(async () => {
  const p1 = (await context.search('admin', { page: 1 })).data;
  const p2 = (await context.search('admin', { page: 2 })).data;
  const p3 = (await context.search('admin', { page: 3 })).data;
  const p4 = (await context.search('admin', { page: 4 })).data;
  const p5 = (await context.search('admin', { page: 5 })).data;
  assert.deepStrictEqual([p1.list.length, p2.list.length, p3.list.length, p4.list.length, p5.list.length], [10, 10, 10, 10, 5]);
  assert.strictEqual(p3.totalPages, 5);
  assert.strictEqual(p3.total, 45);
  assert.strictEqual((await context.search('admin', { page: 99 })).data.page, 5);
  assert.strictEqual((await context.search('admin', { keyword: '旅行者1' })).data.total, 11);
  assert.strictEqual((await context.search('admin', { keyword: '.' })).data.total, 0, '搜索字符不能作为正则通配符');
  const wxml = fs.readFileSync(require('path').join(__dirname, '../miniprogram/pages/admin/admin.wxml'), 'utf8');
  assert(!/onUserPrev|onUserNext/.test(wxml), '用户列表不应恢复上一页/下一页按钮');
  assert(/loadMoreUsers/.test(wxml), '用户列表应在一个页面连续滚动追加');
  console.log('✅ 管理后台 45 位用户分批 10/10/10/10/5，界面连续滚动而非翻页');
})().catch((error) => { console.error(error); process.exitCode = 1; });
