/**
 * 米大师虚拟支付签名（纯函数，本地可单测）
 *
 * 两道签名，算法不同、用的 key 也不同，错了就是 -15005 / -15006：
 *   paySig    = hex(HMAC-SHA256(AppKey,    uri + "&" + postBody))
 *   signature = hex(HMAC-SHA256(sessionKey, postBody))
 *
 * 三条血泪规矩：
 *   1. 拉起支付时 uri 固定是 "requestVirtualPayment"（不带斜杠、不带域名）；
 *      调服务端 /xpay/* 接口时才用真实路径，如 "/xpay/query_order"。
 *   2. session_key **不做 base64 解码**，直接按 UTF-8 字符串参与 HMAC
 *      （解码了必然 -15005，踩过）。
 *   3. postBody 必须是最终发出去的那个字符串，前端不能再 JSON.stringify 一次
 *      —— 重新序列化会改字段顺序，签名就对不上（-15006）。
 */

const crypto = require('crypto');

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', String(key || ''))
    .update(String(msg || ''), 'utf8')
    .digest('hex');
}

/** 支付签名（服务端用，AppKey 按 env 选现网/沙箱） */
function paySig(appKey, uri, body) {
  return hmacHex(appKey, `${uri}&${body}`);
}

/** 用户态签名（session_key 原样使用） */
function userSig(sessionKey, body) {
  return hmacHex(sessionKey, body);
}

/** 拉起支付时用的固定 uri */
const PAY_URI = 'requestVirtualPayment';

/**
 * 组装 signData 字符串（字段顺序固定：签名就按这个串算，前端必须原样透传）
 * outTradeNo 规则：8~32 位，数字字母 _-|*@，不能以下划线开头。
 */
function buildSignData(opts) {
  const o = opts || {};
  return JSON.stringify({
    offerId: String(o.offerId || ''),
    buyQuantity: Number(o.buyQuantity || 1),
    env: Number(o.env || 0),
    currencyType: 'CNY',
    productId: String(o.productId || ''),
    goodsPrice: Number(o.goodsPrice || 0),
    outTradeNo: String(o.outTradeNo || ''),
    attach: String(o.attach || ''),
  });
}

const NO_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉 I/O/0/1 等易混淆字符

function genOutTradeNo(ts) {
  const t = Number(ts || Date.now()).toString(36).toUpperCase();
  let r = '';
  for (let i = 0; i < 6; i++) r += NO_CHARS[Math.floor(Math.random() * NO_CHARS.length)];
  return `VP${t}${r}`;
}

/** 订单号是否合法（微信要求 8-32 位、限定字符、不以下划线开头） */
function outTradeNoOk(s) {
  return /^[A-Za-z0-9_\-|*@]{8,32}$/.test(String(s || '')) && !String(s || '').startsWith('_');
}

module.exports = { hmacHex, paySig, userSig, PAY_URI, buildSignData, genOutTradeNo, outTradeNoOk, NO_CHARS };
