/**
 * 虚拟支付签名单测（不联网）
 *   node scripts/test-virtualpay.js
 *
 * 签错一道就是 -15005 / -15006，用户付不了款。这里用公开标准向量钉死 HMAC 实现，
 * 再钉死米大师那两条拼接规则（uri + "&" + body / session_key 不解码）。
 */
const S = require('../cloudfunctions/virtualPay/sign');
const R = require('../cloudfunctions/virtualPay/quota-rules');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`); }
}

console.log('== 1. HMAC-SHA256 实现（公开标准向量）==');
{
  // 广为人知的向量：HMAC_SHA256("key", "The quick brown fox jumps over the lazy dog")
  const got = S.hmacHex('key', 'The quick brown fox jumps over the lazy dog');
  ok(got === 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    'HMAC-SHA256 与标准向量一致', got);
  ok(S.hmacHex('secret', 'hello').length === 64, '输出是 64 位 hex', S.hmacHex('secret', 'hello').length);
  ok(/^[0-9a-f]{64}$/.test(S.hmacHex('secret', '中文也行')), '小写 hex（米大师要求小写）');
}

console.log('== 2. 两道签名的拼接规则 ==');
{
  const body = '{"offerId":"123","buyQuantity":1}';
  const p = S.paySig('AppKeyDemo', S.PAY_URI, body);
  const expect = S.hmacHex('AppKeyDemo', 'requestVirtualPayment&' + body);
  ok(p === expect, 'paySig = HMAC(AppKey, "requestVirtualPayment&" + body)', p);
  ok(S.PAY_URI === 'requestVirtualPayment', '拉起支付的 uri 不带斜杠');
  const u = S.userSig('sessionKeyDemo', body);
  ok(u === S.hmacHex('sessionKeyDemo', body), 'signature = HMAC(session_key, body)（不做 base64 解码）');
  ok(p !== u, '两道签名结果不同（key 与拼接串都不同）');
  // session_key 不能被 base64 解码后使用：这里保证传进去的是原字符串
  const b64Like = 'aGVsbG8=';
  ok(S.userSig(b64Like, body) === S.hmacHex(b64Like, body), 'session_key 原样参与 HMAC');
}

console.log('== 3. signData 字段顺序（重新排序就验签失败）==');
{
  const sd = S.buildSignData({
    offerId: '1450000001', buyQuantity: 1, env: 0,
    productId: 'plan_5', goodsPrice: 1000, outTradeNo: 'VPABC123', attach: 'openid-1',
  });
  const keys = Object.keys(JSON.parse(sd));
  ok(JSON.stringify(keys) === JSON.stringify(['offerId', 'buyQuantity', 'env', 'currencyType', 'productId', 'goodsPrice', 'outTradeNo', 'attach']),
    '字段顺序固定（前端不能再 stringify 一次）', keys);
  const o = JSON.parse(sd);
  ok(o.currencyType === 'CNY' && o.goodsPrice === 1000 && o.env === 0, '币种/价格/环境正确', o);
  ok(S.buildSignData({ offerId: 'A', productId: 'B', goodsPrice: 300 })
    === S.buildSignData({ goodsPrice: 300, productId: 'B', offerId: 'A' }),
  '入参顺序不影响输出（只看固定字段序）');
}

console.log('== 4. 商户订单号 outTradeNo ==');
{
  let bad = 0;
  const set = new Set();
  for (let i = 0; i < 500; i++) {
    const n = S.genOutTradeNo(Date.now() + i);
    if (!S.outTradeNoOk(n)) bad++;
    set.add(n);
  }
  ok(bad === 0, '500 个订单号全部符合微信规则（8-32 位、限定字符）', bad);
  ok(set.size > 490, '订单号基本不重复', set.size);
  ok(!S.outTradeNoOk('_VP123456'), '下划线开头不合法');
  ok(!S.outTradeNoOk('VP12345'), '少于 8 位不合法');
  ok(S.outTradeNoOk('VP-1|2*3@4'), '允许 _-|*@ 符号');
}

console.log('== 5. 商品表与云函数两侧规则一致 ==');
{
  const quotaRules = require('../cloudfunctions/quota/rules');
  ok(JSON.stringify(quotaRules.GOODS) === JSON.stringify(R.GOODS),
    'virtualPay 与 quota 的商品表完全一致（改一处要同步另一处）');
  ok(JSON.stringify(quotaRules.LIMITS) === JSON.stringify(R.LIMITS), '限额表也一致');
  ok(R.GOODS.every((g) => Number.isInteger(g.price) && g.price >= 100), '价格是以分为单位的正整数');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
