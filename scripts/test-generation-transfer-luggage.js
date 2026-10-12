// 单向客船与首到新酒店：泛化回归，不依赖某个城市或码头。
const assert = require('assert');
const R = require('../cloudfunctions/generatePlan/execution-review');
const P = require('../cloudfunctions/generatePlan/plan');
const row = (startTime, endTime, category, activity, startLocation, endLocation, transportType = '') =>
  ({ dayIndex: 1, startTime, endTime, category, activity, startLocation, endLocation, transportType, note: '' });
const hotel = '乙城中心酒店', previousHotel = '甲城酒店';
const rows = [
  row('08:00', '08:15', 'hotel', '退房并携带全部行李', previousHotel, previousHotel),
  row('08:15', '09:00', 'transport', '乘车前往出发码头', previousHotel, '甲码头', 'ride'),
  row('09:00', '12:00', 'sight', '行李随人乘客船赏沿岸风光', '甲码头', '乙码头', 'ship'),
  row('12:00', '12:30', 'transport', '从下船码头返回酒店', '乙码头', hotel, 'ride'),
  row('12:30', '12:45', 'other', '办理入住并放下大件行李', hotel, hotel),
  row('13:00', '14:00', 'sight', '老街漫步', hotel, '乙城老街', 'walk'),
  row('20:00', '21:00', 'hotel', '返回酒店休息', '乙城老街', hotel),
];
const context = { hotel, previousHotel, city: '乙城', sameHotel: false };
const issues = (candidate, extra = {}) => R.executionIssues(candidate, { ...context, ...extra });
assert(!issues(rows).some((s) => /折返|行李|重复办理入住/.test(s)), JSON.stringify(issues(rows)));
const original = JSON.stringify(rows);
issues(rows); assert.equal(JSON.stringify(rows), original, '验收不改写原条目');
const wrong = rows.map((r) => ({ ...r }));
wrong.splice(2, 0, row('09:00', '09:10', 'other', '寄存大件行李', '甲码头', '甲码头寄存处'));
wrong.splice(4, 0, row('12:00', '12:10', 'other', '取回行李', '乙码头', '乙码头'));
assert(issues(wrong).some((s) => /取回地点与寄存地点不一致/.test(s)), '不能用单向船例外放行跨码头取件');
assert(issues(wrong).some((s) => /未在离开前取回/.test(s)), '箱子留在起点必须拦截');
const disembark = [...rows.slice(0, 3), row('12:00', '12:10', 'other', '下船取行李并前往出口', '乙码头', '乙码头'),
  { ...rows[3], startTime: '12:10' }, ...rows.slice(4)];
assert(!issues(disembark).some((s) => /取回行李前没有/.test(s)), '紧接携箱船程下船取随船箱子，不是岸上寄存取件');
const shoreClaim = disembark.map((r) => /下船取行李/.test(r.activity)
  ? { ...r, activity: '下船取回寄存的行李' } : r);
assert(issues(shoreClaim).some((s) => /取回行李前没有/.test(s)), '明确岸上寄存仍需同点记录');
const missedShore = [...disembark];
missedShore.splice(2, 0, row('09:00', '09:10', 'other', '寄存大件行李', '甲码头', '甲码头寄存处'));
assert(issues(missedShore).some((s) => /取回地点与寄存地点不一致/.test(s)), '声称随船不能覆盖已有岸上未取回寄存');
assert(issues(disembark.map((r) => /下船取行李/.test(r.activity)
  ? { ...r, startLocation: '丙码头', endLocation: '丙码头' } : r)).some((s) => /取回行李前没有/.test(s)), '其他码头不能借下船取随船箱子放行');
assert(issues(disembark.map((r) => r.transportType === 'ship' ? { ...r, activity: '乘竹筏漂流，行李随人' } : r))
  .some((s) => /取回行李前没有/.test(s)), '竹筏不享有普通承运行李例外');
const noCheckin = rows.filter((r) => r.category !== 'other');
assert(issues(noCheckin).some((s) => /折返住宿/.test(s)), '仅声称首到不能取代实际办理动作');
assert(issues(noCheckin).some((s) => /大件|随身携带/.test(s)), '未安放就漫步必须拦截');
const secondReturn = [...rows.slice(0, 6),
  row('14:00', '14:30', 'transport', '返回酒店', '乙城老街', hotel, 'ride'),
  row('14:30', '14:45', 'other', '办理入住并放下大件行李', hotel, hotel),
  row('15:00', '16:00', 'sight', '另一条老街漫步', hotel, '乙城古街', 'walk'), rows.at(-1)];
assert(issues(secondReturn).some((s) => /折返住宿/.test(s)), '第二次入住不能利用首到例外');
assert(issues(secondReturn).some((s) => /重复办理入住/.test(s)));
const fakeFirst = noCheckin.map((r) => /从下船/.test(r.activity) ? { ...r, activity: '首次入住前返回酒店休整' } : r);
assert(issues(fakeFirst).some((s) => /折返住宿/.test(s)), '标题塞首次入住不能绕过验收');
const raft = rows.map((r) => r.transportType === 'ship' ? { ...r, activity: '竹筏漂流' } : r);
assert(issues(raft).some((s) => /大件|随身携带/.test(s)), '竹筏不能套用普通客船的行李能力');
assert(issues(rows, { sameHotel: true }).some((s) => /折返住宿/.test(s)), '连住不享有首次抵达例外');
const rooms = rows.map((r) => ({ ...r, startLocation: r.startLocation === hotel ? hotel + '房间' : r.startLocation,
  endLocation: r.endLocation === hotel ? hotel + '房间' : r.endLocation }));
assert(!issues(rooms, { hotelPoiVerified: true }).some((s) => /住宿地错误|大件|随身携带|折返/.test(s)),
  '已核验物业的准确客房不应冒充新地点，实际安放和收尾仍有效');
const foreignRoom = rooms.map((r) => r.category === 'other' ? { ...r, endLocation: '乙城另一酒店房间' } : r);
assert(issues(foreignRoom, { hotelPoiVerified: true }).some((s) => /大件|随身携带/.test(s)), '另一物业房间不合并');
assert(issues(foreignRoom, { hotelPoiVerified: true }).some((s) => /办理入住的终点.*乙城另一酒店房间/.test(s)),
  '已办理但实际地点不匹配时反馈两处名称，不让模型只重复加存放备注');
const deskCheckin = rows.map((r, i) => i === 4 ? { ...r, endLocation: hotel + '前台' }
  : i === 5 ? { ...r, activity: '登山游览甲山', endLocation: '甲山观景台' } : r);
assert(!issues(deskCheckin).some((s) => /大件|随身携带|折返/.test(s)),
  '准确物业前台的实际入住安放能建立客房状态，不要求把前台导航合并为客房');
assert.equal(R.normalizeReviewRows(deskCheckin, 1, context)[4].endLocation, hotel + '前台',
  '办理子点仍保留原准确导航');
assert(issues(deskCheckin.map((r, i) => i === 4 ? { ...r, endLocation: '另一酒店前台' } : r))
  .some((s) => /大件|随身携带/.test(s)), '其他物业前台不产生本晚入住状态');
assert(issues(deskCheckin.map((r, i) => i === 4 ? { ...r, activity: '准备办理入住，行李安放需确认' } : r))
  .some((s) => /大件|随身携带/.test(s)), '纯准备前台办理仍不是实际入住安放');
const mountainAccess = [...rows.slice(0, 3), { ...rows[3], activity: '乘坐景区接驳车上山至住宿区',
  endLocation: '乙山住宿区', transportType: 'bus' }, ...deskCheckin.slice(4)];
assert(!issues(mountainAccess).some((s) => /索引3.*没有有效寄存/.test(s)),
  '真实乘车上山是载客接驳，不因上山词误当拖箱登山');
assert(issues(mountainAccess.filter((r, i) => i !== 4)).some((s) => /索引4.*没有有效寄存/.test(s)),
  '乘车携箱不豁免之后登山游览的实际存放');
assert(issues(mountainAccess.map((r, i) => i === 3 ? { ...r, activity: '乘坐接驳车后徒步上山至住宿区' } : r))
  .some((s) => /索引3.*没有有效寄存/.test(s)), '复合徒步不能借乘车标题豁免');
const targetCheckin = rows.map((r) => r === rows[3] ? { ...r, activity: '从下船码头前往酒店办理入住' } : r);
assert(!issues(targetCheckin).some((s) => /重复办理入住/.test(s)), '前往办理只是交通目的，实际入住另条安排');
assert(issues(rows.map((r) => r === rows[3] ? { ...r, activity: '乘车前往酒店并办理入住，放下行李' } : r))
  .some((s) => /重复办理入住/.test(s)), '明确交通中办完入住仍计入，不能借目的性判据漏掉重复');
const targetOnly = targetCheckin.filter((r) => r.category !== 'other');
assert(issues(targetOnly).some((s) => /大件|随身携带/.test(s)), '只写前往办理而没有实际安放仍不放行');
const placeholder = { days: [{ city: '甲城', overnight: '甲城市中心', hotel: '甲城市中心 经济型住宿片区' },
  { city: '甲城', overnight: '甲城市中心', hotel: '同上（连住）' },
  { city: '乙城', overnight: '乙城市中心', hotel: '同上(续住)' }] };
P.normalizeOutlineLodging(placeholder);
assert.equal(placeholder.days[1].hotel, placeholder.days[0].hotel, '同范围明确连住还原为实际前夜物业/片区');
assert.equal(placeholder.days[2].hotel, '', '跨城占位词不继承旧物业，重新核查当晚住宿');
const realHotel = { days: [{ city: '甲城', overnight: '甲城市中心', hotel: '同上酒店（中心店）' }] };
P.normalizeOutlineLodging(realHotel);
assert.equal(realHotel.days[0].hotel, '同上酒店（中心店）', '具体具名酒店不能因字面包含占位词被过滤');
const repeatedRest = [...rows.slice(0, 6),
  row('14:00', '14:30', 'transport', '返回住处', '乙城老街', hotel, 'ride'),
  row('14:30', '16:00', 'hotel', '回房休息', '', hotel),
  row('16:00', '16:15', 'transport', '步行去古街', hotel, '乙城古街', 'walk'),
  row('16:15', '18:00', 'sight', '古街漫步', '', '乙城古街'), rows.at(-1)];
assert(issues(repeatedRest).some((s) => /折返住宿/.test(s)), '回房同样是午休，不能靠不写酒店绕过实际住宿终点检查');
assert(issues(repeatedRest).some((s) => /索引7（14:30-16:00 回房休息/.test(s)),
  '住宿折返反馈定位实际问题窗口，不能误让模型删除夜间回房');
assert(issues(repeatedRest.map((r) => r.activity === '回房休息' ? { ...r, category: 'other', activity: '休息整理仪容' } : r))
  .some((s) => /住宿折返/.test(s)), '换分类或省略酒店词也不能隐藏真实住宿休整');
assert(!issues(repeatedRest, { middayRest: true }).some((s) => /折返住宿|住宿折返/.test(s)), '用户明确午休要求仍保留');
const restRows = [row('14:00', '15:00', 'hotel', '回房休息', '', hotel),
  row('21:00', '22:00', 'hotel', '回房休息', '', hotel)];
const eveningFirstArrival = [row('17:00', '17:30', 'transport', '从车站前往酒店', '乙站', hotel, 'ride'),
  row('17:30', '18:00', 'hotel', '回房休息', '', hotel),
  row('18:00', '19:00', 'food', '晚餐', '', hotel),
  row('19:00', '20:00', 'sight', '街区夜景', '', '乙街'), restRows[1]];
assert(!issues(eveningFirstArrival).some((s) => /晚餐前非必要折返/.test(s)),
  '到站后第一次到住宿、此前没开始游线，不是晚餐前中途折返；实际入住和行李仍另行检查');
const lateBoatArrival = [rows[0], rows[1], { ...rows[2], endTime: '16:00' },
  row('16:00', '16:30', 'transport', '返回酒店休息', '乙码头', hotel, 'ride'),
  row('16:30', '16:45', 'hotel', '办理入住并安放行李', '', hotel),
  row('17:00', '18:00', 'sight', '游览老街', '', '乙城老街'),
  row('18:00', '19:00', 'food', '晚餐', '', '乙城老街'), rows.at(-1)];
assert(!issues(lateBoatArrival).some((s) => /折返/.test(s)), '船舶转场后16点首次新住宿安放也不是晚餐前折返');
const settle = row('16:45', '17:00', 'other', '整理仪容，更换衣物准备晚餐', hotel, hotel);
const initialSettling = [...lateBoatArrival.slice(0, 5), settle, ...lateBoatArrival.slice(5)];
assert(!issues(initialSettling).some((s) => /折返/.test(s)), '首次真实入住后连续短时整理不是外出后折返');
assert(issues(initialSettling.map((r) => r === settle ? { ...r, endTime: '17:30' } : r))
  .some((s) => /住宿折返/.test(s)), '首次办理不豁免长时间酒店午休');
assert(issues([...initialSettling.slice(0, 5),
  row('16:45', '16:50', 'transport', '步行去广场', hotel, '乙广场', 'walk'),
  row('16:50', '16:55', 'sight', '广场游览', '', '乙广场'),
  { ...settle, startTime: '16:55', endTime: '17:00' }, ...initialSettling.slice(6)])
  .some((s) => /住宿折返/.test(s)), '办理后已经外出游览再回住宿不享有连续整理例外');
const exactRoom = R.normalizeReviewRows([row('17:00', '17:15', 'hotel', '办理入住并安放行李', hotel, '酒店房间')], 1, context);
assert.equal(exactRoom[0].endLocation, hotel, '准确酒店起点后的酒店房间是该物业客房');
assert.equal(R.normalizeReviewRows([row('17:00', '17:15', 'hotel', '办理入住', '另一酒店', '酒店房间')], 1, context)[0].endLocation,
  '酒店房间', '另一物业的泛称房间不能映射到当晚酒店');
assert.equal(P.dedupeDuplicateHotelItems(restRows).length, 2, '不同时段回房不是复制条目，不能删晚间闭环掩盖午休问题');
assert.equal(P.dedupeDuplicateHotelItems([restRows[0], { ...restRows[0] }]).length, 1, '同窗口复制仍去重');
assert.equal(P.dedupeDuplicateHotelItems([row('14:00', '14:15', 'hotel', '办理入住', '', hotel),
  row('21:00', '21:15', 'hotel', '办理入住', '', hotel)]).length, 1, '初稿反复办理入住仍去重，真实状态由审计判定');
console.log('✓ 单向客船行李随人、首次到新酒店安放可执行；跨码头取件、假首次、重复入住、竹筏带大件仍拦截');
