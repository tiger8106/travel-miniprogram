// utils/map.js
// 地图导航（2026-09-20 v3：一键直达 + 自动实时查坐标）
//
// 微信平台规则：小程序禁止直接拉起第三方 App（高德/百度都不行），
// 唯一的官方直达路径是 wx.openLocation：
//   点一下 → 全屏打开地图、定位到目的地 → 右下角绿色「导航」按钮
//   → 弹出手机上已装的地图 App 列表（高德/百度/腾讯）→ 选高德开始导航。
//
// 坐标来源：
//   ① 解析攻略时云函数已地理编码（item.endLat / endLon）
//   ② 没有坐标时，点击瞬间调用云函数实时查（不用重新上传攻略）

const api = require('../services/api');

/**
 * 打开导航（一键直达，无中间弹窗）
 * @param {object} opts { from, to, mode, endLat, endLon, region }
 *   region：省/市/县等大地名（如「广西 桂林」），只用于帮地理编码消歧，
 *   绝不会拼进显示名称——界面上看到的还是「龙脊梯田」而不是「广西桂林龙脊梯田」。
 *   没有它时，重名地点（全国一堆"西湖""人民公园"）可能定位到别的城市去。
 */
async function openAmapNav(opts) {
  let lat = Number(opts.endLat);
  let lon = Number(opts.endLon);

  // 没有坐标 → 实时查一次（约 200ms），带上大地名消歧
  if (!(lat && lon && !isNaN(lat) && !isNaN(lon))) {
    wx.showLoading({ title: '定位中…' });
    try {
      const coord = await api.geocode(opts.to, opts.region || '');
      wx.hideLoading();
      if (coord && coord.lon && coord.lat) {
        lon = coord.lon;
        lat = coord.lat;
      }
    } catch (e) {
      wx.hideLoading();
      // 查不到，走降级
    }
  }

  if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
    // 直接全屏打开微信地图，定位到目的地
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

  // 降级：说明云函数没配 AMAP_KEY
  wx.showModal({
    title: '暂时无法打开地图',
    content: `云函数还没有配置高德 Key（AMAP_KEY），无法把「${String(opts.to || '').slice(0, 15)}」转成地图坐标。\n\n配置后即可一键打开地图导航。现在可以先复制目的地名称到高德 App 搜索。`,
    confirmText: '复制目的地',
    cancelText: '取消',
    success: (r) => {
      if (r.confirm) {
        wx.setClipboardData({
          data: String(opts.to || ''),
          success: () => wx.showToast({ title: '已复制', icon: 'success' }),
        });
      }
    },
  });
}

/**
 * 兜底：复制目的地
 */
function fallbackCopyRoute(opts) {
  wx.setClipboardData({
    data: String(opts.to || ''),
    success: () => wx.showToast({ title: '已复制目的地', icon: 'success' }),
  });
}

module.exports = {
  openAmapNav,
  fallbackCopyRoute,
};
