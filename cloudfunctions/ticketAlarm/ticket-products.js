// 独立云函数各带一份。确定需要门票/预约的产品按证据查漏，不按景点名字猜收费。
const key = (value) => String(value || '').replace(/[\s（）()·]/g, '').replace(/风景区|景区|门票|预约|游客中心/g, '');
const array = (value) => Array.isArray(value) ? value : [];
// 含入园票的基础通/套票不是单独的观光车体验；独立二销项目仍逐项核对。
const productText = (value) => String(value || '').split(/[，,；;（）()]/)
  .filter((part) => !/不含|不包含|不包括|另购/.test(part)).join(' ');
const includedAdmission = (value) => /门票|入园票/.test(productText(value))
  && /套票|通票|(?:门票|入园票)[+＋]|(?:含|包含).{0,12}观光车/.test(productText(value));
const experienceProduct = (value) => !includedAdmission(value)
  && /竹筏|漂流|游船|游轮|船票|轮渡|索道|缆车|演出|观光车|魔毯|滑道/.test(productText(value));

function actualTicketExperience(row, product = '') {
  const action = String(row && row.activity || '');
  const kind = String(product || action).match(/竹筏|漂流|游船|游轮|船票|轮渡|索道|缆车|演出|观光车|魔毯|滑道/);
  if (!kind || /^(?:不|无需|不必|取消)(?:再)?(?:乘坐|搭乘|体验|观看|游览)/.test(action)) return false;
  if (/^(?:前往|到达|抵达|返回|步行|骑行|骑电|打车|接驳|出发)/.test(action)
    && !/(?:并|随后|后|[，,；;])\s*(?:乘坐|搭乘|乘|坐|体验|观看)(?:景区)?[^。；]{0,20}(?:竹筏|漂流|游船|游轮|轮渡|索道|缆车|演出|观光车|魔毯|滑道)/.test(action)) return false;
  const words = /竹筏|漂流/.test(kind[0]) ? '竹筏|漂流' : /游船|游轮|船票|轮渡/.test(kind[0]) ? '游船|游轮|乘船|坐船|轮渡' : kind[0];
  return !/^(?:准备|计划|明日|次日)/.test(action)
    && new RegExp(`(?:乘坐|搭乘|乘|坐|体验|观看|参加|游览|漂游|漂流)?[^。；]{0,60}(?:${words})(?!码头|入口|起点|终点)`).test(action)
    && !/^(?:购票|购买|预订|预约).*?(?:票|项目)$/.test(action);
}

function ticketAccessOnly(row) {
  const action = String(row && row.activity || '');
  return !actualTicketExperience(row)
    && (/取票|检票|安检|候船|候车|排队/.test(action)
      || (row.category === 'transport' || /^(?:前往|到达|抵达|返回|步行|骑行|骑电|打车|接驳|出发)/.test(action))
        && /码头|乘船点|登船点|售票处|入口|停车场|游客中心/.test(`${action} ${row.endLocation || ''}`));
}

function explicitAdmission(row) {
  return /(?:门票|入园票|成人票|全价票)(?:价格|票价|为|约|[:：]|\s)*[¥￥]?\d+(?:\.\d+)?\s*元|需(?:要)?(?:购买|购|买)(?:入园)?门票/.test(`${row.activity || ''} ${row.note || ''}`);
}

function openLeisureVisit(row) {
  // 不断言某景点免费；无收费/入园证据的散步、骑行只是不主动补购票事项。
  return /散步|漫步|走一下|环湖|骑行|骑电动车|骑电瓶车/.test(`${row.activity || ''} ${row.note || ''}`)
    && !/入园|进入.*(?:景区|园区)|购买|购票/.test(row.activity || '')
    && !explicitAdmission(row) && !actualTicketExperience(row);
}

function normalizeTicketPolicies(values) {
  return array(values).filter((fact) => fact && fact.place && evidenceUrl(fact.sourceUrl)
    && typeof fact.ticketRequired === 'boolean' && typeof fact.reservationRequired === 'boolean')
    .map((fact) => ({ ...fact, place: String(fact.place), activity: String(fact.activity || ''),
      visitDate: String(fact.visitDate || ''), dayIndex: fact.dayIndex != null && Number.isInteger(Number(fact.dayIndex)) ? Number(fact.dayIndex) : undefined }));
}

function freeAdmissionFor(row, policies = []) {
  const rawFree = /(?:无需|不用|不必)(?:购买|购|买)?门票|免门票|免费(?:开放|入园|参观)/.test(`${row.activity || ''} ${row.note || ''}`);
  if (rawFree && !explicitAdmission(row) && row.reservationRequired !== true
    && !/需(?:要)?(?:提前|实名)?预约|必须预约/.test(`${row.activity || ''} ${row.note || ''}`)) return true;
  return normalizeTicketPolicies(policies).some((fact) => fact.ticketRequired === false && fact.reservationRequired === false
    && (fact.dayIndex === undefined || fact.dayIndex === Number(row.dayIndex || 0))
    && (fact.activity ? fact.activity === row.activity : [row.activity, row.ticketPlace, row.visitScope, row.startLocation, row.endLocation]
      .some((value) => value && key(value).includes(key(fact.place)))));
}

function filterTicketAlarms(alarms, items, policies = []) {
  const rows = array(items);
  return array(alarms).filter((alarm) => {
    if (alarm.type !== 'ticket' || alarm.source === 'manual') return true;
    const linked = alarm.linkedItemId && rows.find((row) => String(row.itemId || row._id || '') === String(alarm.linkedItemId));
    let candidates = linked ? [linked] : rows.filter((row) =>
      (alarm.dayIndex == null || Number(row.dayIndex || 0) === Number(alarm.dayIndex))
      && (String(alarm.title || '').includes(String(row.activity || '')) && String(row.activity || '').length >= 4
        || [alarm.ticketPlace, alarm.bookingInfo].some((place) => place && key(place).length >= 3
          && [row.activity, row.ticketPlace, row.visitScope, row.startLocation, row.endLocation]
            .some((value) => value && key(value).includes(key(place))))));
    const visits = candidates.filter((row) => ['sight', 'ticket'].includes(row.category) || actualTicketExperience(row));
    if (!linked && visits.length) candidates = visits;
    if (!candidates.length) return true;
    if (candidates.every(ticketAccessOnly)) return false;
    const experience = experienceProduct(alarm.ticketProduct || alarm.title || '');
    if (experience) return candidates.some((row) => actualTicketExperience(row, alarm.ticketProduct || alarm.title)
      || row.category === 'ticket' && !ticketAccessOnly(row));
    const unknown = /未.*(?:核实|确认)|核验|不代表.*确认|不确定/.test(`${alarm.note || ''} ${alarm.ticketProduct || ''}`);
    return !candidates.every((row) => freeAdmissionFor(row, policies)
      || openLeisureVisit(row) && row.ticketRequired !== true && row.reservationRequired !== true
        && !explicitAdmission(row) && (alarm.ticketRequired !== true || unknown)
        && (alarm.reservationRequired !== true || unknown));
  });
}

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
    || row.ticketRequired === true && /观光车|索道|缆车|游船|船票|竹筏|演出|魔毯|滑道/.test(row.ticketProduct || row.activity))
    && !/公交车票|长途.*车票|高铁票|火车票|机票/.test(row.ticketProduct || '')
    && (row.ticketRequired === true && row.ticketProduct
      || !/^(?:前往|抵达|到达|途经|路过|步行去|乘车去)/.test(row.activity || '')) && !ticketAccessOnly(row));
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
      && [entry.activity, entry.endLocation, entry.startLocation, entry.visitScope, entry.bookingInfo].some((text) => key(text).includes(key(fact.place)))
      && !/仅途经|只在外部|不入园|不进入|外观|远眺|附近$/.test(`${entry.activity || ''} ${entry.endLocation || ''}`.trim())
      && (!experienceProduct(fact.product) || actualTicketExperience(entry, fact.product)));
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

module.exports = { normalizeTicketProducts, normalizeTicketPolicies, actualTicketExperience, ticketAccessOnly, includedAdmission,
  explicitAdmission, openLeisureVisit, freeAdmissionFor, filterTicketAlarms, knownTicketProducts, ticketKey: key, evidenceUrl };
