// components/map-button/map-button.js
// 导航按钮（2026-09-25 v2）：
//   · 文案只显示**目的地**——wx.openLocation 打开的就是目的地信息，
//     原来写「磨盘山码头 → 阳朔龙头码头」会让用户以为能分段导航，误导。
//   · 中间点行程：一次行程可渲染多个本组件（每段一个），activity-item 负责。
//   · 补传 region / fallbackRegion：以前点击实时定位时城市词丢了，
//     全国搜会把「崇左南站」这类地名定位到别的城市去（实测踩过）。
const mapUtil = require('../../utils/map');

Component({
  properties: {
    startLoc: { type: String, value: '' },
    endLoc: { type: String, value: '' },
    mode: { type: String, value: 'car' },
    endLat: { type: Number, value: 0 },
    endLon: { type: Number, value: 0 },
    // 条目自己的城市（最准），只用于地理编码消歧，不进展示文案
    region: { type: String, value: '' },
    // 条目城市查不到时的兜底（整条行程的大地名）
    fallbackRegion: { type: String, value: '' },
    // 独占一行模式（多段导航时每个链接各占一行，用户实测要求）
    block: { type: Boolean, value: false },
  },

  data: {
    label: '',   // 按钮文案（只有目的地名）
    target: '',  // 导航目的地
  },

  observers: {
    'startLoc, endLoc': function (s, e) {
      // 打开地图只有目的地信息 → 文案只写目的地
      const target = e || s || '';
      this.setData({ label: target, target });
    },
  },

  methods: {
    onTap() {
      if (!this.data.target) {
        wx.showToast({ title: '缺少目的地', icon: 'none' });
        return;
      }
      mapUtil.openAmapNav({
        from: this.data.startLoc || '',
        to: this.data.target,
        mode: this.data.mode,
        title: this.data.label,
        endLat: this.data.endLat,
        endLon: this.data.endLon,
        region: this.data.region || '',
        fallbackRegion: this.data.fallbackRegion || this.data.region || '',
      });
    },
  },
});
