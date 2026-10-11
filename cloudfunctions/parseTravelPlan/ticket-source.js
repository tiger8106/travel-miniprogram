// 只读公开售票资料：不跟随重定向，DNS解析后禁止私网/回环，限时限体积。
const https = require('https');
const http = require('http');
const dns = require('dns');
const net = require('net');
const { evidenceUrl, ticketKey } = require('./ticket-products');

function publicAddress(address) {
  if (address.includes(':')) return /^[23][0-9a-f]{3}:/i.test(address)
    && !/^2001:(?:db8|0):|^2002:/i.test(address); // 不接收映射IPv4、本地、文档及隧道地址。
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a > 0 && a < 224 && ![10, 127].includes(a) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 192 && [0, 2].includes(b)) && !(a === 198 && b === 51 && parts[2] === 100)
    && !(a === 203 && b === 0 && parts[2] === 113)
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19].includes(b));
}

function readSource(url, timeout = 3000) {
  if (!evidenceUrl(url)) return Promise.resolve('');
  return new Promise((resolve) => {
    let req, timer, settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (req) req.destroy();
      resolve(value || '');
    };
    const target = new URL(url);
    if (target.port && !['80', '443'].includes(target.port)) return finish('');
    const address = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(address) && !publicAddress(address)) return finish('');
    timer = setTimeout(() => finish(''), timeout);
    req = (target.protocol === 'https:' ? https : http).get(target, {
      headers: { 'User-Agent': 'TravelTicketPolicy/1.0', 'Accept-Encoding': 'identity' },
      lookup: (hostname, options, callback) => dns.lookup(hostname, { all: true }, (error, addresses) => {
        if (error || !addresses.length || addresses.some((item) => !publicAddress(item.address)))
          return callback(error || new Error('禁止访问非公开地址'));
        // Node版本可能要求all数组；云端旧运行时则接收单地址。
        if (options && options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }),
    }, (response) => {
      if (response.statusCode !== 200 || !/html|text|json/.test(response.headers['content-type'] || '')) {
        response.resume(); return finish('');
      }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 196608) return finish('');
        chunks.push(chunk);
      });
      response.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      response.on('error', () => finish(''));
    });
    req.on('error', () => finish(''));
  });
}

function admissionPolicy(html, place) {
  const text = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '')
    .replace(/&(?:nbsp|ensp|emsp);|\s/g, '');
  const name = ticketKey(place).replace(/风景名胜区$/, '');
  if (name.length < 2) return null;
  let at = -1;
  while ((at = text.indexOf(name, at + 1)) >= 0) {
    const context = text.slice(Math.max(0, at - 20), at + name.length + 65);
    if (/免费(?:开放|入园)|全面免费|免收门票|0元门票|门票免费/.test(context)) return { paid: false };
    if (/(?:入园票|门票|成人票|全价票)(?:价格|票价|为|约|[:：]|[（(]){0,3}[¥￥]?\d+(?:\.\d+)?元/.test(context)
      && !/免费|免票|0元/.test(context)) return { paid: true };
  }
  return null; // 页面打不开、JS渲染或无法绑定具体地点时，不能确认收费。
}

async function verifyAdmissions(alarms) {
  const rows = alarms.filter((a) => a.type === 'ticket' && a.ticketPlace
    && !/游船|游轮|船票|轮渡|索道|缆车|竹筏|漂流|演出|观光车/.test(a.ticketProduct || a.title));
  const urls = [...new Set(rows.map((a) => a.sourceUrl).filter(evidenceUrl))];
  const sources = new Map(await Promise.all(urls.map(async (url) => [url, await readSource(url).catch(() => '')])));
  rows.forEach((alarm) => {
    const policy = admissionPolicy(sources.get(alarm.sourceUrl), alarm.ticketPlace);
    if (policy && policy.paid) return;
    alarm.ticketRequired = false;
    alarm.reservationRequired = true; // 保留办理核验卡，不宣称必买付费入园票。
    alarm.ticketProduct = `${alarm.ticketPlace}${policy ? '免费入园预约' : '门票/预约核验'}`;
    alarm.title = `${alarm.visitDate || ''} ${alarm.ticketProduct}`.trim();
    alarm.note = policy ? '公开来源明确免费入园；请核对出行日预约规则，不购买入园收费票'
      : '入园收费政策未独立核实，请查看运营方门票/预约要求；不代表已确认收费';
  });
  return alarms;
}

module.exports = { publicAddress, admissionPolicy, verifyAdmissions, readSource };
