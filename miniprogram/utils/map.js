// utils/map.js
// 地图导航（2026-09-25 v4：一键直达 + 自动实时查坐标 + 城市消歧）
//
// 微信平台规则：小程序禁止直接拉起第三方 App（高德/百度都不行），
// 唯一的官方直达路径是 wx.openLocation：
//   点一下 → 全屏打开地图、定位到目的地 → 右下角绿色「导航」按钮
//   → 弹出手机上已装的地图 App 列表（高德/百度/腾讯）→ 选高德开始导航。
//
// 坐标来源：
//   ① 生成/解析攻略时云函数已地理编码（item.endLat / endLon）
//   ② 没有坐标时，点击瞬间调用云函数实时查（不用重新上传攻略）
//
// ⚠️ 定位准不准，关键在"城市"：全国同名地点一堆（象鼻山公园、西山、人民公园），
//    云函数现在会先用城市限定 POI 搜索，再逐条校验返回结果的行政区，
//    对不上宁可不给坐标。所以这里一定要把 region 传过去，
//    并且降级复制时也要把城市带上——用户粘到高德里搜才是对的那个。

const api = require('../services/api');

/** 当前行程的大地名（组件调用没传 fallbackRegion 时兜底用） */
function currentTripRegion() {
  try {
    const t = (getApp() && getApp().globalData && getApp().globalData.currentTrip) || null;
    return (t && t.region) || '';
  } catch (e) {
    return '';
  }
}

/** 从"广西 桂林 阳朔"里取第一个城市词（复制给地图 App 搜索时用） */
function firstCity(region) {
  // 保留“都江堰/理县”这种片区组合，复制给地图搜索比只留第一个词更稳。
  const tokens = String(region || '').split(/[\s,，、]+/)
    .map((s) => s.trim()).filter(Boolean);
  return tokens[0] || '';
}

/**
 * 打开导航（一键直达，无中间弹窗）
 * @param {object} opts { from, to, mode, endLat, endLon, region, fallbackRegion }
 *   region：条目自己的城市（如「桂林」），只用于帮地理编码消歧，
 *   绝不会拼进显示名称——界面上看到的还是「象鼻山」而不是「桂林象鼻山」。
 *   fallbackRegion：整条行程的大地名（如「广西 桂林 阳朔 南宁」）。
 *   条目城市查不到时用它再试一次——跨城段（南宁东站）挂在桂林那天的
 *   条目上，光靠"桂林"一个词是查不到的。
 */
async function openAmapNav(opts) {
  const regionHint = String((opts && (opts.region || opts.fallbackRegion)) || currentTripRegion() || '').trim();
  let lat = Number(opts.endLat);
  let lon = Number(opts.endLon);
  let reason = '';

  // 没有坐标 → 实时查（约 200ms）。先条目城市、再整行程大地名，两级都带上城市消歧
  if (!(lat && lon && !isNaN(lat) && !isNaN(lon))) {
    wx.showLoading({ title: '定位中…' });
    try {
      const attempts = [opts.region, opts.fallbackRegion, currentTripRegion()]
        .filter((r, i, arr) => r && arr.indexOf(r) === i);   // 去重去空
      let coord = null;
      for (const r of attempts) {
        try {
          coord = await api.geocode(opts.to, r);
        } catch (err) {
          // 云函数会给一句能照做的提示（没配 Key / 该城市里没找到…）
          reason = (err && err.message) || '';
        }
        if (coord && coord.lon && coord.lat) break;
      }
      wx.hideLoading();
      if (coord && coord.lon && coord.lat) {
        lon = coord.lon;
        lat = coord.lat;
      }
    } catch (e) {
      wx.hideLoading();
    }
  }

  if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
    wx.openLocation({
      latitude: lat,
      longitude: lon,
      name: String(opts.to || '目的地').slice(0, 30),
      address: `从 ${opts.from || '出发地'} 出发`.slice(0, 60),
      scale: 15,
      fail: () => fallbackCopyRoute(opts),
    });
    return;
  }

  // 降级：把「城市 + 地名」复制给用户，粘到高德里搜才不会搜到外省的同名点
  const city = firstCity(regionHint);
  const keyword = city ? `${city} ${opts.to || ''}` : String(opts.to || '');
  wx.showModal({
    title: '暂时无法打开地图',
    content: `${reason || '没能定位到这个地点。'}\n\n可以复制「${keyword}」到高德/百度地图里搜索，也能正常导航。`,
    confirmText: '复制地名',
    cancelText: '取消',
    success: (r) => {
      if (r.confirm) {
        wx.setClipboardData({
          data: keyword,
          success: () => wx.showToast({ title: '已复制', icon: 'success' }),
        });
      }
    },
  });
}

/**
 * 兜底：复制目的地（带上城市，避免搜到同名地点）
 */
function fallbackCopyRoute(opts) {
  const regionHint = String((opts && (opts.region || opts.fallbackRegion)) || currentTripRegion() || '').trim();
  const city = firstCity(regionHint);
  const keyword = city ? `${city} ${opts.to || ''}` : String(opts.to || '');
  wx.setClipboardData({
    data: keyword,
    success: () => wx.showToast({ title: '已复制目的地', icon: 'success' }),
  });
}

module.exports = {
  openAmapNav,
  fallbackCopyRoute,
  firstCity,
};
