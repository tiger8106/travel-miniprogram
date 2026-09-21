// components/map-button/map-button.js
// 支持三种形态：
//   起点+终点 → "A → B"
//   只有终点 → "导航到 B"（从我的位置出发，wx.openLocation 定位到终点后点导航即可）
//   只有起点 → "从 A 出发"（少见，定位到起点让用户规划）
const mapUtil = require('../../utils/map');

Component({
  properties: {
    startLoc: { type: String, value: '' },
    endLoc: { type: String, value: '' },
    mode: { type: String, value: 'car' },
    endLat: { type: Number, value: 0 },
    endLon: { type: Number, value: 0 },
  },

  data: {
    label: '',   // 按钮文案
    target: '',  // 导航目的地
  },

  lifetimes: {
    attached() {
      const s = this.data.startLoc;
      const e = this.data.endLoc;
      let label = '';
      let target = '';
      if (s && e) {
        label = `${s} → ${e}`;
        target = e;
      } else if (e) {
        label = `导航到 ${e}`;
        target = e;
      } else if (s) {
        label = `前往 ${s}`;
        target = s;
      }
      this.setData({ label, target });
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
      });
    },
  },
});
