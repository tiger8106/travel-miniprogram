// 未核验物业只能称作住宿片区。档次是展示信息，不是另一个导航地点。
// 仅统一明确的同片区标签；不把同城酒店、附近餐馆或入口合并成一个点。
const AREA_LABEL = /^(.*?)\s*(?:经济型|舒适型|品质型)住宿片区$/;
const key = (value) => String(value || '').replace(/\s/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')');

function lodgingAreaOf(value) {
  const match = AREA_LABEL.exec(String(value || '').trim());
  return match && match[1].trim() || '';
}

function selectLodgingArea(value) {
  const first = (text) => {
    const parts = String(text).split(/[\/／]|或/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return text;
    const tail = (parts[parts.length - 1].match(/(?:片区|附近|周边)$/) || [''])[0];
    return parts[0] + (tail && !parts[0].endsWith(tail) ? tail : '');
  };
  return first(String(value || '').trim().replace(/[（(]([^）)]+)[）)]/g,
    (_, inner) => `（${first(inner)}）`));
}

function fallbackHotelLabel(area, grade) {
  return `${selectLodgingArea(area)} ${grade}住宿片区`.trim();
}

function prepareFallbackLodging(day) {
  const base = lodgingAreaOf(day && day.hotel);
  if (!base || day.hotelPoiVerified === true) return;
  const chosen = selectLodgingArea(base);
  if (key(chosen) === key(base)) return;
  // 原多选整体标签是旧草稿的别名；不把未选的单独地点当同址别名。
  day.hotelLocationAliases = [...new Set([...(day.hotelLocationAliases || []), day.hotel, base])];
  const grade = (day.hotel.match(/(经济型|舒适型|品质型)住宿片区$/) || [])[1];
  day.hotel = fallbackHotelLabel(chosen, grade);
  if (key(day.overnight) === key(base)) day.overnight = chosen;
  day.hotelSearchHint = day.hotel;
  day.hotelRecommendationReason = `暂未核验具体物业，住宿优先选择${chosen}；在主流平台核对实际酒店、位置、房型和退改规则，片区标签不是酒店名称。`;
  // 选择一个范围改变了实际导航，不能沿用原多选地点的语义审计结果。
  if (day.executionCandidate) day.executionCandidateUnaudited = true;
}

function canonicalLodgingLocation(value, hotel, aliases = [], verified = false) {
  const base = lodgingAreaOf(hotel);
  if (!base || verified || !value) return value;
  const names = [hotel, base, ...aliases].filter(Boolean);
  if (names.some((name) => key(value) === key(name))) return hotel;
  // 明确住宿名后的客房不是另一个导航地点；泛称“房间”仍不能确定酒店。
  const room = String(value).match(/(?:客房内|房间内|客房|房间)$/);
  if (room && names.some((name) => key(String(value).slice(0, -room[0].length)) === key(name))) return hotel;
  // 附属办理点保持区别，不能将“酒店附近”或景区入口直接当入住/寄存点。
  const suffix = String(value).match(/(?:酒店门口|民宿门口|门口|前台|大堂|餐厅)$/);
  if (suffix && names.some((name) => key(String(value).slice(0, -suffix[0].length)) === key(name)))
    return hotel + suffix[0];
  return value;
}

function insideLodging(value, hotel, aliases = []) {
  if (!value || !hotel) return false;
  const names = [hotel, lodgingAreaOf(hotel), ...aliases].filter(Boolean);
  return names.some((name) => key(value) === key(name)
    || key(value).startsWith(key(name))
      && /^(?:餐厅|露台|阳台|天台|庭院|公共区域|客房|房间)$/.test(key(value).slice(key(name).length)));
}

module.exports = { lodgingAreaOf, selectLodgingArea, fallbackHotelLabel, prepareFallbackLodging, canonicalLodgingLocation, insideLodging };
