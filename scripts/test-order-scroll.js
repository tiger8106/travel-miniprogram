const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('cloudfunctions/virtualPay/index.js', 'utf8');
const block = source.match(/async function actionOrderList\(openid, event\) \{[\s\S]*?\n}\n\n\/\*\* 管理员对账/);
assert(block, '找不到订单滚动查询入口');
const rows = Array.from({ length: 25 }, (_, i) => ({ outTradeNo: `order-${i}`, goodsId: 'one',
  status: 'delivered', price: 300, createdAt: 25 - i }));
const calls = [];
const context = {
  Number, String, Math, R: { goodsById: () => ({ name: '套餐', desc: '' }) },
  userOrderNotice: () => '', userOrderNoticeType: () => 'normal',
  loadOrderByOpenid: async (openid, limit, skip) => {
    calls.push({ openid, limit, skip });
    return rows.slice(skip, skip + limit);
  },
};
vm.runInNewContext(block[0].replace(/\n\n\/\*\* 管理员对账$/, '') + '\nthis.orderList = actionOrderList;', context);
(async () => {
  const a = (await context.orderList('user-a', { page: 1 })).data;
  const b = (await context.orderList('user-a', { page: 2 })).data;
  const c = (await context.orderList('user-a', { page: 3 })).data;
  assert.deepStrictEqual([a.list.length, b.list.length, c.list.length], [10, 10, 5]);
  assert.deepStrictEqual([a.hasMore, b.hasMore, c.hasMore], [true, true, false]);
  assert.deepStrictEqual(calls.map((x) => x.skip), [0, 10, 20]);
  assert(calls.every((x) => x.openid === 'user-a' && x.limit === 11), '分批查询只读本人订单');
  const legacy = (await context.orderList('user-a', {})).data;
  assert.strictEqual(legacy.list.length, 25, '旧版不传页码仍能看到原有订单');
  console.log('✅ 历史订单每批 10 条，上滑追加至末尾，不再首屏读取全部订单');
})().catch((e) => { console.error(e); process.exitCode = 1; });
