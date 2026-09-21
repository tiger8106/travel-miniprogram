// components/activity-item/activity-item.js
const mapUtil = require('../../utils/map');

const CATEGORY_ICONS = {
  sight: '🏞️', food: '🍜', hotel: '🏨',
  transport: '🚄', ticket: '🎫', other: '📌',
};

// 编辑抽屉里的选项（chips 形式，比 picker 更直观好看）
const TRANSPORT_OPTIONS = [
  { value: 'car', label: '驾车', icon: '🚗' },
  { value: 'walk', label: '步行', icon: '🚶' },
  { value: 'ride', label: '骑行', icon: '🚲' },
  { value: 'bus', label: '公交', icon: '🚌' },
  { value: 'train', label: '火车', icon: '🚄' },
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
  },

  data: {
    icon: '📌',
    transportOptions: TRANSPORT_OPTIONS,
    categoryOptions: CATEGORY_OPTIONS,
    showDel: false, // 删除确认弹层
  },

  observers: {
    item(item) {
      if (item) {
        this.setData({ icon: CATEGORY_ICONS[item.category] || '📌' });
      }
    },
  },

  methods: {
    noop() {},

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
