// components/activity-item/activity-item.js
const mapUtil = require('../../utils/map');

const CATEGORY_ICONS = {
  sight: '🏞️', food: '🍜', hotel: '🏨',
  ticket: '🎫', other: '📌',
};

// 交通条目按 transportType（activity 文本兜底）选图标，不再全员火车头
function transportIcon(item) {
  const t = String((item && item.transportType) || '').toLowerCase();
  const act = String((item && item.activity) || '');
  if (t === 'walk' || /步行|徒步/.test(act)) return '🚶';
  if (t === 'train' || /高铁|动车|火车|列车|城际/.test(act)) return '🚄';
  if (t === 'plane' || /航班|飞机|航站楼/.test(act)) return '✈️';
  if (t === 'ride') {
    if (/公交|巴士|大巴/.test(act)) return '🚌';
    return '🚇';   // 生成端约定：ride = 公交地铁/电动车，默认给地铁
  }
  if (t === 'bus' || /公交|巴士|大巴|班车/.test(act)) return '🚌';
  if (/缆车|索道/.test(act)) return '🚡';
  if (/船|游船|渡轮/.test(act)) return '⛴️';
  return '🚗';     // car / 未标注 → 打车/驾车
}

// 编辑抽屉里的选项（chips 形式，比 picker 更直观好看）
// 注意取值约定与生成端一致：ride = 公交地铁/电动车（不是骑行）
const TRANSPORT_OPTIONS = [
  { value: 'car', label: '打车/驾车', icon: '🚗' },
  { value: 'walk', label: '步行', icon: '🚶' },
  { value: 'ride', label: '公交/地铁', icon: '🚇' },
  { value: 'train', label: '火车', icon: '🚄' },
  { value: 'plane', label: '飞机', icon: '✈️' },
  { value: 'bus', label: '大巴', icon: '🚌' },
];

const CATEGORY_OPTIONS = [
  { value: 'sight', label: '景点', icon: '🏞️' },
  { value: 'food', label: '餐饮', icon: '🍜' },
  { value: 'hotel', label: '住宿', icon: '🏨' },
  { value: 'transport', label: '交通', icon: '🚄' },
  { value: 'ticket', label: '票务', icon: '🎫' },
  { value: 'other', label: '其他', icon: '📌' },
];

Component({
  properties: {
    item: {
      type: Object,
      value: {},
    },
    editing: {
      type: Boolean,
      value: false,
    },
    editForm: {
      type: Object,
      value: null,
    },
    // 只读模式（查看历史行程）：隐藏编辑/删除按钮
    readonly: {
      type: Boolean,
      value: false,
    },
    // 大地名（"广西 桂林"）：导航缺坐标实时定位时给高德消歧，不做展示
    region: {
      type: String,
      value: '',
    },
    // 条目城市查不到时的兜底（整条行程的大地名）
    fallbackRegion: {
      type: String,
      value: '',
    },
  },

  data: {
    icon: '📌',
    transportOptions: TRANSPORT_OPTIONS,
    categoryOptions: CATEGORY_OPTIONS,
    showDel: false, // 删除确认弹层
    navLegs: [],    // 导航段列表：[{ from, to, lat, lon }]，有中间点时一段一个按钮
  },

  observers: {
    item(item) {
      if (item) {
        this.setData({
          icon: item.category === 'transport'
            ? transportIcon(item)
            : (CATEGORY_ICONS[item.category] || '📌'),
          navLegs: this.buildNavLegs(item),
        });
      }
    },
  },

  methods: {
    noop() {},

    // 导航段拆分：起点 → [中间点…] → 终点，每段一个"直达目的地"按钮。
    // 用户在编辑抽屉加的中间点（如 漓江漂流沿途的 九马画山/黄布倒影/兴坪）
    // 会依次生成导航链接，点到哪段就导航到哪段。
    buildNavLegs(item) {
      if (!item) return [];
      const wps = Array.isArray(item.waypoints) ? item.waypoints : [];
      const stops = [];
      wps.forEach((w) => {
        const name = typeof w === 'string' ? w : (w && w.name);
        if (name) {
          stops.push({
            to: name,
            lat: (typeof w === 'object' && Number(w.lat)) || 0,
            lon: (typeof w === 'object' && Number(w.lon)) || 0,
          });
        }
      });
      if (item.endLocation) {
        stops.push({ to: item.endLocation, lat: Number(item.endLat) || 0, lon: Number(item.endLon) || 0 });
      }
      if (!stops.length && item.startLocation) {
        // 只有起点（少见）：定位到起点让用户规划
        stops.push({ to: item.startLocation, lat: Number(item.startLat) || 0, lon: Number(item.startLon) || 0 });
      }
      let prev = item.startLocation || '';
      return stops.map((s) => {
        const leg = { from: prev, to: s.to, lat: s.lat, lon: s.lon };
        prev = s.to;
        return leg;
      });
    },

    onTapNav() {
      const { item } = this.data;
      if (!item.startLocation || !item.endLocation) {
        wx.showToast({ title: '请先编辑起终点', icon: 'none' });
        return;
      }
      mapUtil.openAmapNav({
        from: item.startLocation,
        to: item.endLocation,
        mode: item.transportType || 'car',
        title: `${item.startLocation} → ${item.endLocation}`,
        endLat: item.endLat,
        endLon: item.endLon,
        region: this.data.region || '',
      });
    },

    // ---------- 编辑 ----------
    onTapEdit() {
      const item = this.data.item || {};
      const key = item.key || item._id || item.id || '';
      if (!key) {
        wx.showToast({ title: '该行程缺少标识，请下拉刷新', icon: 'none' });
        return;
      }
      this.triggerEvent('tapedit', { item });
    },

    onSave() {
      this.triggerEvent('saveedit', {});
    },

    onCancel() {
      this.triggerEvent('canceledit', {});
    },

    onInput(e) {
      this.triggerEvent('editinput', {
        field: e.currentTarget.dataset.field,
        value: e.detail.value,
      });
    },

    onPickerChange(e) {
      this.triggerEvent('editinput', {
        field: e.currentTarget.dataset.field,
        value: e.detail.value,
      });
    },

    onPickTransport(e) {
      this.triggerEvent('edittransport', { value: e.currentTarget.dataset.value });
    },

    onPickCategory(e) {
      this.triggerEvent('editcategory', { value: e.currentTarget.dataset.value });
    },

    // 交换起终点
    onSwapLocation() {
      this.triggerEvent('swaplocation', {});
    },

    // ---------- 中间点（途经地）----------
    onAddWaypoint() {
      this.triggerEvent('editwaypoint', { op: 'add' });
    },

    onRemoveWaypoint(e) {
      this.triggerEvent('editwaypoint', {
        op: 'remove',
        index: e.currentTarget.dataset.index,
      });
    },

    onWaypointInput(e) {
      this.triggerEvent('editwaypoint', {
        op: 'input',
        index: e.currentTarget.dataset.index,
        value: e.detail.value,
      });
    },

    // ---------- 删除（先弹确认卡） ----------
    onTapDelete() {
      this.setData({ showDel: true });
    },

    onCancelDelete() {
      this.setData({ showDel: false });
    },

    onConfirmDelete() {
      const it = this.data.item || {};
      const id = it.key || it._id || it.id || '';
      this.setData({ showDel: false });
      if (!id) {
        wx.showToast({ title: '该行程缺少标识，请下拉刷新', icon: 'none' });
        return;
      }
      this.triggerEvent('tapdelete', { id });
    },
  },
});
