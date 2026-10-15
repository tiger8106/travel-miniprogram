// 起床准备和赴观景点的交通不是观景，不能锁定太阳窗口并吞掉实际游览。
function solarViewingAction(row, event) {
  const action = String(row && row.activity || '');
  // “起床后拍摄”包含实际观景；“起床，准备前往看日出”只是在准备。
  const preparationOnly = /^(?:起床|洗漱|整理|收拾|准备)/.test(action)
    && !/(?:后|然后|随后|并)(?:在[^，；]{1,20})?(?:观赏|观看|拍摄|欣赏)/.test(action);
  const approachingOnly = /(?:前往|上行|下行|攀登|等待|寻找.{0,8}机位).{0,30}(?:日出|日落|夕阳|落日)/.test(action)
    && !/(?:观赏|观看|拍摄|欣赏).{0,20}(?:日出|日落|夕阳|落日)/.test(action);
  return !!row && (row.category === 'sight' || row.category === 'other' && /观赏|观看|拍摄|欣赏/.test(action))
    && (event === '日落' ? /日落|夕阳|落日/.test(action) : event ? action.includes(event) : /日出|日落|夕阳|落日/.test(action))
    && !preparationOnly && !approachingOnly
    && !/准备(?:前往|出发|去)|明天|明日|次日|第二天|不看|不拍|放弃|舍弃|取消/.test(action);
}
module.exports = { solarViewingAction };
