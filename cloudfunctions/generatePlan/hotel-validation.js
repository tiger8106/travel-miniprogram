/**
 * Verify concrete hotel recommendations against a city-scoped POI provider.
 * If a name cannot be found, expose a bookable search area and price tier
 * instead of showing a made-up property name.
 */
async function validateOutlineHotels(result, input, searchHotelPoi, searchHotelsNearby) {
  const outline = result && result.outline;
  const days = outline && Array.isArray(outline.days) ? outline.days : [];
  const budget = String(input && (input.budget || input.budgetLevel) || '');
  const grade = /经济/.test(budget) ? '经济型' : /品质/.test(budget) ? '品质型' : '舒适型';
  const bookable = (poi) => poi && String(poi.matchedName || '').trim()
    && !/礼宾部|接待处|售楼|停车场|停车库|餐厅|洗衣房|会议室|宴会厅|游泳池|健身房|大堂吧/.test(poi.matchedName);
  const matchingOvernight = (poi, overnight) => {
    if (!poi) return false;
    const text = String(overnight || '').replace(/[（(][^）)]*[）)]/g, '');
    const expected = [...String(overnight || '').matchAll(/([\u4e00-\u9fa5]{2,8}?)(?:自治州|地区|自治县|市|县|区|镇|乡)/g)]
      .map((match) => match[1]).filter((word) => word.length >= 2);
    if (!expected.length) {
      [...String(overnight || '').matchAll(/([\u4e00-\u9fa5]{2,8}?)(?:大寨|梯田|田园|西街|东街|南街|北街|景区|瀑布|码头|市区|县城|镇|村)/g)]
        .forEach((match) => { if (match[1].length >= 2) expected.push(match[1]); });
      if (!expected.length) {
        const bare = text.replace(/(住宿片区|酒店片区|附近|周边|市区|县城|片区|住宿|区域)$/g, '').trim();
        const root = (bare.match(/[\u4e00-\u9fa5]{2,4}/) || [''])[0];
        if (root) expected.push(root);
      }
    }
    const actual = `${poi.province || ''}${poi.city || ''}${poi.district || ''}${poi.address || ''}`;
    const addressEvidence = `${poi.district || ''}${poi.address || ''}`;
    const namedScenicArea = !/(?:自治州|地区|市(?!区)|县(?!城))/.test(overnight || '');
    const targetMatchesAddress = expected.some((word) => addressEvidence.includes(word))
      || !!(namedScenicArea && poi.areaSearch && poi.areaMatched
        && expected.some((word) => String(poi.matchedName || '').includes(word)));
    const targetMatches = targetMatchesAddress || expected.some((word) => String(poi.city || '').includes(word));
    const explicitCities = [...addressEvidence.matchAll(/([\u4e00-\u9fa5]{2,8}?)(?:市|自治州|地区|盟)/g)]
      .map((match) => match[1]).filter(Boolean);
    // Don't accept a neighboring-city POI merely because its search request was
    // scoped to the requested city. When the address names a different city and
    // none of the requested lodging-area names appears in it, retry or fall back
    // to a searchable area label.
    if (explicitCities.length && !targetMatchesAddress) return false;
    // 缺少地址证据的 POI 无法证明和当晚住宿地相符，不能作为已核验酒店展示。
    if (targetMatches) return true;
    // A city-limited POI result can omit administrative fields in AMap's payload.
    // Accept it only when the search was city-scoped and its concrete POI also
    // matched a name/address token from the requested lodging area.
    const searchCity = String(poi.searchCity || '').replace(/(市|县|区|镇|乡)$/g, '');
    return !!(poi.areaSearch && poi.areaMatched && searchCity);
  };
  await Promise.all(days.map(async (day, index) => {
    if (index === days.length - 1 || !day) return;
    const overnight = String(day.overnight || day.city || '').trim();
    if (!day.hotel && overnight) day.hotel = `${overnight} ${grade}住宿片区`;
    if (!day.hotel) return;
    // 班次校正后会再次进入这里；如果原 POI 的地址仍覆盖新的 overnight，
    // 直接复用核验结果，避免重复打地图请求。住宿范围发生变化时继续走
    // 下面的重新搜索/片区降级，不能把旧城市酒店带到新基地。
    if (day.hotelPoiVerified === true
        && String(day.hotelPoiVerifiedName || '').trim() === String(day.hotel).trim()
        && String(day.hotelPoiAddress || '').trim()
        && matchingOvernight({ address: day.hotelPoiAddress }, overnight)) return;
    const name = String(day.hotel).trim();
    const generic = /(经济型|舒适型|品质型|住宿片区|酒店片区|附近|周边)$/.test(name);
    if (!generic && !/(酒店|宾馆|客栈|民宿|饭店|公寓|度假村)/.test(name)) return;
    // 酒店以当晚住宿地为边界。day.city 可能是「重庆→成都→都江堰」交通链，
    // 不能把整串城市都交给 POI 校验，否则出发地酒店也会被误认成当天住宿。
    const routeTail = String(day.city || '').split(/(?:->|→|⇒|＞|>|—|–)/).map((x) => x.trim()).filter(Boolean).pop() || '';
    const overnightHasAddress = /(?:省|市(?!区)|自治州|地区|县(?!城)|镇|乡|村)/.test(overnight);
    const city = overnightHasAddress ? overnight : [routeTail, overnight].filter(Boolean).join(' ');
    let poi = null;
    if (!generic && typeof searchHotelPoi === 'function') {
      try { poi = await searchHotelPoi(name, city, 2500, budget); } catch (e) {
        console.warn('[generatePlan] 住宿 POI 核验失败：%s (%s)', name, e.message);
      }
    }
    if (poi && (!bookable(poi) || !matchingOvernight(poi, overnight))) {
      console.warn('[generatePlan] 第%d天住宿 POI 与当晚住宿地不符，丢弃：%s', index + 1, poi.matchedName);
      poi = null;
    }
    if ((!poi || !poi.matchedName) && typeof searchHotelsNearby === 'function') {
      try { poi = await searchHotelsNearby(city, budget, 2500); } catch (e) {
        console.warn('[generatePlan] 附近住宿搜索失败：%s (%s)', city, e.stack || e.message);
      }
    }
    if (poi && (!bookable(poi) || !matchingOvernight(poi, overnight))) poi = null;
    if (poi && poi.matchedName) {
      if (generic || poi.areaSearch) {
        console.log('[generatePlan] 第%d天住宿替换为片区可搜索 POI：%s', index + 1, poi.matchedName);
      }
      day.hotel = poi.matchedName;
      day.hotelPoiVerified = true;
      day.hotelPoiVerifiedName = day.hotel;
      day.hotelPoiAddress = [poi.province, poi.city, poi.district, poi.address].filter(Boolean).join('');
      day.hotelPoiSource = 'amap-poi';
      day.hotelPoiOvernight = overnight;
      day.hotelSearchHint = [day.hotel, day.hotelPoiAddress].filter(Boolean).join('｜');
      day.hotelRecommendationReason = `位于${overnight || city || '当晚住宿地'}范围，已用地图 POI 核验名称和地址；预订前可复制完整名称到携程、去哪儿、美团或高德核对房型、价格与取消规则。`;
    } else {
      const place = String(day.overnight || day.city || '').trim();
      day.hotel = `${place ? place + ' ' : ''}${grade}住宿片区`;
      day.hotelPoiVerified = false;
      day.hotelPoiVerifiedName = '';
      day.hotelPoiAddress = '';
      day.hotelPoiSource = '';
      day.hotelPoiOvernight = '';
      day.hotelSearchHint = day.hotel;
      day.hotelRecommendationReason = `暂未核验到具体物业，先提供${place || '当晚住宿地'}的${grade}住宿片区；请在主流平台搜索片区和档次后选择真实酒店，不要把这段片区描述当作酒店名称。`;
      console.warn('[generatePlan] 第%d天住宿名称未能核验，改为片区+档次：%s', index + 1, day.hotel);
    }
  }));
  const areaKey = (value) => String(value || '').replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000,，、/]/g, '').replace(/(市中心|市区|县城|市|县|区|镇|村|片区|附近|周边)+$/g, '');
  // 连住同一片区时复用已核验的酒店，避免每天换店、搬行李或生成酒店间接驳。
  for (let index = 1; index < days.length - 1; index++) {
    const previous = days[index - 1];
    const day = days[index];
    if (!previous || !day || !day.hotel || !previous.hotel) continue;
    if (areaKey(previous.overnight || previous.city) !== areaKey(day.overnight || day.city)) continue;
    const previousVerified = previous.hotelPoiVerified === true;
    const dayVerified = day.hotelPoiVerified === true;
    if (previousVerified || dayVerified) {
      const chosen = previousVerified ? previous : day;
      previous.hotel = chosen.hotel;
      day.hotel = chosen.hotel;
      previous.hotelPoiVerified = day.hotelPoiVerified = true;
      previous.hotelPoiVerifiedName = day.hotelPoiVerifiedName = chosen.hotel;
      previous.hotelPoiAddress = day.hotelPoiAddress = chosen.hotelPoiAddress || '';
      previous.hotelPoiSource = day.hotelPoiSource = chosen.hotelPoiSource || 'amap-poi';
      previous.hotelPoiOvernight = String(previous.overnight || previous.city || '').trim();
      day.hotelPoiOvernight = String(day.overnight || day.city || '').trim();
      previous.hotelSearchHint = day.hotelSearchHint = chosen.hotelSearchHint || [chosen.hotel, chosen.hotelPoiAddress].filter(Boolean).join('｜');
      previous.hotelRecommendationReason = day.hotelRecommendationReason = chosen.hotelRecommendationReason || '';
    }
  }
  return result;
}

module.exports = { validateOutlineHotels };
