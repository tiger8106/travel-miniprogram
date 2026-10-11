// 独立云函数各带一份。确定需要门票/预约的产品按证据查漏，不按景点名字猜收费。
const key = (value) => String(value || '').replace(/[\s（）()·]/g, '').replace(/风景区|景区|门票|预约|游客中心/g, '');
const array = (value) => Array.isArray(value) ? value : [];

function evidenceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const text = decodeURI(url.href);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      && !/(^|\.)(?:example\.(?:com|org|net)|localhost)$|\.(?:example|test|invalid)$/.test(url.hostname)
      && !/示例|占位|官方公告链接|placeholder|dummy|todo/i.test(text);
  } catch (_) { return false; }
}

const productName = (place, product) => key(product).includes(key(place)) ? product : `${place}${product}`;

function normalizeTicketProducts(values, requireSource = true) {
  return array(values).filter((fact) => fact && fact.place && fact.product
    && (fact.ticketRequired === true || fact.reservationRequired === true)
    && (!requireSource || evidenceUrl(fact.sourceUrl))).map((fact) => ({
    place: String(fact.place).slice(0, 80), product: productName(String(fact.place), String(fact.product)).slice(0, 100),
    ticketRequired: fact.ticketRequired === true, reservationRequired: fact.reservationRequired === true,
    sourceUrl: String(fact.sourceUrl || '').slice(0, 500), basisDate: String(fact.basisDate || '').slice(0, 10),
    note: String(fact.note || '').slice(0, 180),
    dayIndex: Number(fact.dayIndex || 0),
  }));
}

function knownTicketProducts(items, facts = []) {
  const visits = array(items).filter((row) => (['sight', 'ticket'].includes(row.category)
    || row.ticketRequired === true && /观光车|索道|缆车|游船|船票|竹筏|演出/.test(row.ticketProduct || row.activity))
    && !/公交车票|长途.*车票|高铁票|火车票|机票/.test(row.ticketProduct || '')
    && (row.ticketRequired === true && row.ticketProduct
      || !/^(?:前往|抵达|到达|途经|路过|步行去|乘车去)/.test(row.activity || '')));
  const out = [], seen = new Set();
  const add = (fact, row) => {
    const identity = `${key(fact.place)}:${key(fact.product)}`;
    // 多日内部观景共用入园产品；不同产品、不同收费区域不可互相代替。
    if (seen.has(identity)) return;
    seen.add(identity);
    out.push({ ...fact, dayIndex: Number(row.dayIndex || 0), item: row });
  };
  normalizeTicketProducts(facts).forEach((fact) => {
    const row = visits.find((entry) => Number(entry.dayIndex || 0) === fact.dayIndex
      && [entry.activity, entry.endLocation || entry.startLocation, entry.visitScope, entry.bookingInfo].some((text) => key(text).includes(key(fact.place)))
      && !/仅途经|只在外部|不入园|不进入|外观|远眺|附近$/.test(`${entry.activity || ''} ${entry.endLocation || ''}`.trim())
      && (!/游船|游轮|船票|轮渡/.test(fact.product) || entry.transportType === 'ship' || /游船|游轮|乘船|坐船/.test(entry.activity || ''))
      && (!/索道|缆车|竹筏|漂流|演出|观光车/.test(fact.product)
        || (fact.product.match(/索道|缆车|竹筏|漂流|演出|观光车/g) || []).some((word) =>
          String(entry.activity || '').includes(word)
          && (!/竹筏|漂流/.test(word) || /(?:乘坐|搭乘|乘|坐|体验|漂流|游览)[^。；]{0,60}(?:竹筏|漂流)(?!码头|入口|起点|终点)/.test(entry.activity || '')))));
    if (row) add(fact, row); // 舍弃的可选景点不留下购票提醒。
  });
  visits.forEach((row) => {
    const text = `${row.activity || ''}；${row.note || ''}；${row.bookingInfo || ''}`;
    const paid = row.ticketRequired === true || /(?:门票|入园票|成人票|全价票)(?:价格|票价|为|约|[:：]|\s)*[¥￥]?\d+(?:\.\d+)?\s*元|需(?:要)?(?:购买|购|买)(?:入园)?门票/.test(text);
    const reservation = row.reservationRequired === true || /(?:需|必须)(?:提前|实名)?预约/.test(text);
    const free = /(?:无需|不用|不必)(?:购买|购|买)?门票|免门票|免费(?:开放|入园|参观)/.test(text);
    if (!(paid && !free) && !reservation) return;
    const place = String(row.ticketPlace || row.visitScope || row.endLocation || row.startLocation || '').trim();
    if (!place || /酒店|民宿|餐厅/.test(place)) return;
    add({ place, product: productName(place, row.ticketProduct || (paid && !free ? '门票' : '预约')),
      ticketRequired: paid && !free, reservationRequired: reservation,
      sourceUrl: row.ticketSourceUrl || '', note: '原文或已核查票务证据；具体售价及办理规则以运营方为准' }, row);
  });
  return out;
}

module.exports = { normalizeTicketProducts, knownTicketProducts, ticketKey: key, evidenceUrl };
