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
  if (r.errcode !== 0 && r.errcode !== '0') {
    const detail = String(r.errmsg || '')
      .replace(/(access_token|pay_sig|session_key|appkey|app_secret|secret)\s*[:=]\s*[^\s&,;]+/ig, '$1=[redacted]')
      .replace(/\s+/g, ' ').slice(0, 120);
    const code = r.errcode === undefined ? 'invalid' : r.errcode;
    // 参数错误可能具体指“订单不存在”，只有微信明确这样说时才当作无远端订单。
    const notFound = Number(code) === 268490002 && (
      /订单不存在|不存在的订单|查无此订单|未找到(?:该)?订单|找不到(?:该)?订单|order[_\s-]*(?:id[_\s-]*)?(?:(?:is|does)[_\s-]*)?not[_\s-]*(?:exist|found)|order[_\s-]*(?:id[_\s-]*)?(?:doesn't|does not)[_\s-]*exist/i.test(detail)
      // query_order 线上真实返回：errmsg="数据不存在 rid: ..."。仅接受完整说明，不泛化参数错误。
      || /^(?:数据不存在|data\s+(?:not\s+exist|does\s+not\s+exist))(?:\s+rid\s*[:：]|$)/i.test(detail));
    return { ok: false, notFound, canCancel: notFound, canRepay: notFound,
      reason: `query_error:${code}`, detail };
  }
  // 本地下单记录先于拉起支付创建；用户在支付页退出时，微信可能还没有建单。
  if (r.order === undefined || r.order === null) {
    return { ok: false, notFound: true, canCancel: true, canRepay: true, reason: 'order_not_found' };
  }
  if (typeof r.order !== 'object' || Array.isArray(r.order)) {
    return { ok: false, reason: 'order_invalid' };
  }
  const p = r.order;
  const status = p.status === null || p.status === '' ? NaN : Number(p.status);
  if (!Number.isInteger(status)) return { ok: false, reason: 'status_invalid' };
  if (String(p.order_id || '') !== String(local.outTradeNo || '')) return { ok: false, reason: 'order_id_mismatch' };
  if (!Number.isInteger(Number(p.order_fee)) || Number(p.order_fee) !== Number(local.price)) {
    return { ok: false, reason: 'order_fee_mismatch',
      detail: `status=${status};order_fee=${String(p.order_fee).slice(0, 24)};expected=${local.price}` };
  }
  // 尚未支付的订单可能没有 paid_fee；只对该状态按 0 处理。
  // 已支付订单仍必须带明确的实付金额，不能因字段缺失误发权益。
  const paidFeeMissing = p.paid_fee === undefined || p.paid_fee === null || p.paid_fee === '';
  const paidFee = paidFeeMissing ? ([0, 1, 6].includes(status) ? 0 : NaN) : Number(p.paid_fee);
  if (!Number.isInteger(paidFee) || paidFee < 0 || paidFee > Number(p.order_fee)) {
    return { ok: false, reason: 'paid_fee_invalid',
      detail: `status=${status};paid_fee=${paidFeeMissing ? 'missing' : String(p.paid_fee).slice(0, 24)}` };
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
    paidFee,
    platformPaidAt: Number(p.paid_time || 0) * 1000,
    platformProvidedAt: Number(p.provide_time || 0) * 1000,
    settlementState: p.sett_state === undefined ? null : Number(p.sett_state),
    settledAt: Number(p.sett_time || 0) * 1000,
    platformFee: Number(p.platform_fee_fen || 0),
    cpsFee: Number(p.cps_fee_fen || 0),
    refundFee: Number(p.refund_fee || 0),
    leftFee: Number(p.left_fee || 0),
  };
  return { ok: paid, paid, status, canCancel: [0, 1, 6].includes(status) && paidFee === 0,
    canRepay: status === 1 && paidFee === 0,
    platform, reason: paid ? '' : `platform_status:${status}` };
}

module.exports = {
  appKeyForEnv, signedRequest, queryPayload, providePayload,
  readNotifyPayload, notifyResponse, iosRefundResponse, readQueryResponse,
};
