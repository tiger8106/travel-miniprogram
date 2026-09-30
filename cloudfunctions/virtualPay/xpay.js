// 虚拟支付服务端接口的请求和响应校验。只有明确的已支付状态可以发放权益。
const S = require('./sign');

function appKeyForEnv(env, keys) {
  return Number(env) === 1 ? String(keys.sandbox || '') : String(keys.production || '');
}

function signedRequest(uri, data, token, appKey) {
  const body = JSON.stringify(data);
  const paySig = S.paySig(appKey, uri, body);
  return {
    url: `https://api.weixin.qq.com${uri}?access_token=${encodeURIComponent(token)}&pay_sig=${paySig}`,
    body,
  };
}

function queryPayload(order) {
  return { openid: order._openid, env: Number(order.env || 0), order_id: order.outTradeNo };
}

function providePayload(order) {
  return { order_id: order.outTradeNo, env: Number(order.env || 0) };
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

function xmlValue(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = String(xml || '').match(re);
  return match ? decodeXmlText(match[1]) : '';
}

/** 兼容微信消息推送的 JSON 与 XML 明文格式。 */
function readNotifyPayload(body) {
  if (body && typeof body === 'object') return { payload: body, format: 'json' };
  const text = String(body || '').trim();
  if (!text) return { payload: {}, format: 'unknown' };
  if (/^[{[]/.test(text)) {
    try { return { payload: JSON.parse(text), format: 'json' }; } catch (e) {}
  }
  if (/^<\w+/.test(text)) {
    const fields = [
      'Event', 'OpenId', 'OutTradeNo', 'Env', 'MsgType', 'ToUserName', 'Encrypt',
      'MchOrderId', 'WxOrderId', 'RefundFee', 'RetCode', 'WxRefundId', 'MchRefundId',
      'RefundSuccTimestamp', 'refund_time', 'order_time', 'channel_bill', 'bundleid',
      'service_type', 'product_id', 'p_count', 'refund_request_reason', 'provide_status',
      'consumption_status', 'pay_order_id',
    ];
    const payload = {};
    fields.forEach((field) => { const value = xmlValue(text, field); if (value !== '') payload[field] = value; });
    return { payload, format: 'xml' };
  }
  return { payload: {}, format: 'unknown' };
}

function iosRefundResponse(result, format) {
  const code = Number(result && result.result_code);
  const info = String(result && result.result_info || '已按支付平台规则处理退款问询');
  const evidence = String(result && result.evidence || '');
  if (format === 'xml') {
    const cdata = (value) => String(value).replace(/]]>/g, ']]]]><![CDATA[>');
    return `<xml><result_code>${Number.isFinite(code) ? code : 0}</result_code>`
      + `<result_info><![CDATA[${cdata(info)}]]></result_info>`
      + `<evidence><![CDATA[${cdata(evidence)}]]></evidence></xml>`;
  }
  return {
    result_code: Number.isFinite(code) ? code : 0,
    result_info: info,
    evidence,
  };
}

function notifyResponse(result, format) {
  if (result && result.__iosRefundQuery) return iosRefundResponse(result, format);
  const code = Number(result && (result.ErrCode === undefined ? result.errcode : result.ErrCode));
  const msg = String(result && (result.ErrMsg || result.errmsg || '') || (code === 0 ? 'success' : 'failed'));
  if (format === 'xml') {
    const safe = msg.replace(/]]>/g, ']]]]><![CDATA[>');
    return `<xml><ErrCode>${Number.isFinite(code) ? code : -1}</ErrCode><ErrMsg><![CDATA[${safe}]]></ErrMsg></xml>`;
  }
  return { ErrCode: Number.isFinite(code) ? code : -1, ErrMsg: msg };
}

function readQueryResponse(response, local) {
  const r = response || {};
  if (r.errcode !== 0 || !r.order || typeof r.order !== 'object') {
    return { ok: false, reason: `query_error:${r.errcode === undefined ? 'invalid' : r.errcode}` };
  }
  const p = r.order;
  const status = Number(p.status);
  if (String(p.order_id || '') !== String(local.outTradeNo || '')) return { ok: false, reason: 'order_id_mismatch' };
  if (!Number.isInteger(Number(p.order_fee)) || Number(p.order_fee) !== Number(local.price)) {
    return { ok: false, reason: 'order_fee_mismatch' };
  }
  if (!Number.isInteger(Number(p.paid_fee)) || Number(p.paid_fee) < 0 || Number(p.paid_fee) > Number(p.order_fee)) {
    return { ok: false, reason: 'paid_fee_invalid' };
  }
  if (p.env_type !== undefined && Number(p.env_type) !== Number(local.env || 0) + 1) {
    return { ok: false, reason: 'environment_mismatch' };
  }
  const paid = [2, 3, 4].includes(status);
  const platform = {
    platformStatus: status,
    platformOrderId: String(p.wx_order_id || ''),
    channelOrderId: String(p.channel_order_id || ''),
    wxpayOrderId: String(p.wxpay_order_id || ''),
    paidFee: Number(p.paid_fee || 0),
    platformPaidAt: Number(p.paid_time || 0) * 1000,
    platformProvidedAt: Number(p.provide_time || 0) * 1000,
    settlementState: p.sett_state === undefined ? null : Number(p.sett_state),
    settledAt: Number(p.sett_time || 0) * 1000,
    platformFee: Number(p.platform_fee_fen || 0),
    cpsFee: Number(p.cps_fee_fen || 0),
    refundFee: Number(p.refund_fee || 0),
    leftFee: Number(p.left_fee || 0),
  };
  return { ok: paid, paid, status, platform, reason: paid ? '' : `platform_status:${status}` };
}

module.exports = {
  appKeyForEnv, signedRequest, queryPayload, providePayload,
  readNotifyPayload, notifyResponse, iosRefundResponse, readQueryResponse,
};
