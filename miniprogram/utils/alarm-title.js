// 纯展示规则；不要用展示标题替换存储标题或作为票务去重/完成状态的键。
// sendAlarm 中保留同内容副本，独立云函数不能引用小程序目录。
function text(value) {
  return String(value || '').replace(/[\r\n\u3000]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripActions(value, traffic) {
  let s = text(value);
  s = s.replace(/^(?:(?:预计|立即|尽早)?(?:开放预约\/购票|查看并预约\/购买|开放预约|开售|放票|开抢|抢购|预订|预约|购票|购买|准备|核验|核对|确认|办理|提醒)[：:\s]*)+/, '');
  if (traffic) {
    s = s.replace(/^(?:去程|返程)?(?:高铁|动车|火车|汽车|公交)?(?:车票|机票)[：:\s]*/, '')
      .replace(/[（(](?:车票|机票)[）)]/g, '')
      .replace(/(?:车票|机票)$/, '');
  }
  s = s.replace(/\/(?:预约|购票)(?:放票|核验)?/g, '')
    .replace(/(?:预约提醒|预订提醒|购票提醒|预约|预订|购票|核验|核对|放票|开售|提醒)+$/, '')
    .replace(/参考车次\s*/g, '')
    .replace(/[，,](?:约|耗时|全程|车程|[^，,]*到).*$/, '')
    .replace(/[。；;，,：:\s]+$/, '');
  return s.trim();
}

function alarmTitleOf(alarm) {
  const a = alarm || {};
  const original = text(a.title);
  const traffic = ['train', 'plane', 'bus', 'ship'].indexOf(a.type) >= 0;
  if (!traffic && a.type !== 'ticket') return original || '行程提醒';
  const usage = text(a.usageInfo);
  // 使用日/乘车时刻来自行程，不用提醒的 fireAt（起售/办理日）冒充。
  const date = text(a.visitDate).match(/^\d{4}-\d{2}-\d{2}/)
    || usage.match(/\d{4}-\d{2}-\d{2}/) || original.match(/\d{4}-\d{2}-\d{2}/);
  const timePattern = /(?:时间[：:]\s*|\d{4}-\d{2}-\d{2}\s+)(\d{1,2}:\d{2}(?:\s*[-–—~至]\s*\d{1,2}:\d{2})?)/;
  const time = usage.match(timePattern) || original.match(timePattern);
  let content = stripActions(original, traffic).replace(/\d{4}-\d{2}-\d{2}\s*/g, '').trim();
  content = content.replace(/^\d{1,2}:\d{2}(?:\s*[-–—~至]\s*\d{1,2}:\d{2})?\s*/, '');
  if (traffic) {
    // 结构化使用信息优先于长标题中的酒店接送点/准备动作。
    const route = usage.split(/[；;]/).filter((s) => /(?:→|->|至)/.test(s) && !/^(?:时间|使用时间)/.test(s));
    if (route.length) content = stripActions(route.join('；').replace(/^路线[：:]\s*/, ''), true);
    content = content.replace(/^(?:乘坐|乘)\s*/, '');
    if (!route.length && /(?:购买|准备|在游客中心)/.test(content)) {
      const destination = content.match(/(?:前往|去往)([^。；;，,〔]+)$/);
      if (destination) content = destination[1];
    }
    content = content.replace(/的(?=直通车|公交|大巴|巴士)/g, '');
    const code = `${text(a.bookingInfo)} ${original}`.match(/\b(?:[GDCZTK]\d{1,5}|[A-Z]{2}\d{3,4})\b/i);
    if (code && content.indexOf(code[0]) < 0) content += ` ${code[0]}`;
  } else if (a.ticketProduct) {
    content = stripActions(a.ticketProduct, false);
  } else {
    content = content.replace(/^(?:游览|参观|体验)\s*/, '')
      .replace(/[（(][^（）()]*、[^（）()]*[）)]/g, '')
      .replace(/(?:及|并)(?:午餐|晚餐|早餐|用餐|游览|参观|体验|前往).*$/, '');
    // 无产品字段的旧提醒可能把游览说明拼在景区名后，保留票种而非游线文案。
    if (/[：:]/.test(content) && /门票/.test(content)) content = content.split(/[：:]/)[0] + '门票';
  }
  return [date && date[0], time && time[1].replace(/\s+/g, ''), content].filter(Boolean).join(' ') || '行程提醒';
}

// 微信事项字段最多20字；长标题缩成年月日中的月日，优先保留车次与路线。
function alarmNotificationTitleOf(alarm) {
  const full = alarmTitleOf(alarm);
  if (full.length <= 20) return full;
  let short = full.replace(/^\d{4}-(\d{2}-\d{2})/, '$1')
    .replace(/(^\d{2}-\d{2})\s+\d{1,2}:\d{2}(?:[-–—~至]\d{1,2}:\d{2})?\s*/, '$1 ');
  if (alarm && ['train', 'plane', 'bus', 'ship'].indexOf(alarm.type) >= 0) {
    const code = short.match(/\b(?:[GDCZTK]\d{1,5}|[A-Z]{2}\d{3,4})\b/i);
    if (code) {
      const date = short.match(/^\d{2}-\d{2}/);
      const route = short.replace(/^[\d-]+\s+/, '')
        .replace(new RegExp('[（(]?' + code[0] + '[）)]?', 'i'), '').trim();
      short = [date && date[0], code[0], route].filter(Boolean).join(' ');
    }
  }
  return short.slice(0, 20);
}

module.exports = { alarmTitleOf, alarmNotificationTitleOf };
