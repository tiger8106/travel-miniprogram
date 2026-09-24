// pages/alarm-group/alarm-group.js
// 分类闹钟详情页：从闹钟 Tab 的分类折叠卡点进来，看/改/删某一类的全部提醒。
// 编辑、删除、写日历的能力和闹钟 Tab 保持一致（同一套 ticket-alarm 组件 + 底部抽屉）。
const api = require('../../services/api');
const alarm = require('../../utils/alarm');
const timeUtil = require('../../utils/time');
const env = require('../../utils/env');
const auth = require('../../utils/auth');

const app = getApp();

// 分类定义与闹钟 Tab 完全一致（key 由页面参数传入，这里按 key 找类型集合）
const GROUP_DEFS = {
  traffic: { label: '车票提醒', icon: '🚄', types: ['train', 'plane', 'bus'] },
  sight: { label: '门票预约', icon: '🎫', types: ['ticket'] },
  hotel: { label: '酒店住宿', icon: '🏨', types: ['hotel'] },
  other: { label: '其他事项', icon: '⏰', types: ['other'] },
};

const TYPE_OPTIONS = [
  { value: 'train', label: '高铁/火车', icon: '🚄' },
  { value: 'plane', label: '机票', icon: '✈️' },
  { value: 'ticket', label: '景区门票', icon: '🎫' },
  { value: 'hotel', label: '酒店', icon: '🏨' },
  { value: 'bus', label: '巴士', icon: '🚌' },
  { value: 'other', label: '其他', icon: '⏰' },
];

Page({
  data: {
    key: '',
    label: '分类提醒',
    icon: '⏰',
    loading: true,
    alarms: [],
    totalCount: 0,     // 行程全部闹钟数（显示"共 N 类里的 M 条"用不上，先给标题计数）
    pendingCount: 0,   // 该分类未来待办数
    editForm: null,    // 编辑抽屉（null=关闭）
    editingId: null,
    delItem: null,
    typeOptions: TYPE_OPTIONS,
    devMode: false,
    showPrivacy: false,
  },

  noop() {},

  onLoad(query) {
    const key = (query && query.key) || 'other';
    const def = GROUP_DEFS[key] || GROUP_DEFS.other;
    this._types = def.types;
    this.setData({
      key,
      label: (query && query.label && decodeURIComponent(query.label)) || def.label,
      icon: (query && query.icon && decodeURIComponent(query.icon)) || def.icon,
      devMode: env.showDevTools(),
    });
    if (query && query.label) wx.setNavigationBarTitle({ title: decodeURIComponent(query.label) });
  },

  onShow() {
    this.load();
  },

  onUnload() {
    this.unbindPrivacy();
  },

  onHide() {
    this.unbindPrivacy();
  },

  bindPrivacy() {
    app._privacyHandler = () => this.setData({ showPrivacy: true });
  },

  unbindPrivacy() {
    if (app._privacyHandler) app._privacyHandler = null;
    this.setData({ showPrivacy: false });
  },

  onClosePrivacy() {
    this.setData({ showPrivacy: false });
  },

  async load() {
    const ok = await auth.requireLogin();
    if (!ok) {
      this.setData({ loading: false, alarms: [] });
      return;
    }
    this.bindPrivacy();
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      this.setData({ loading: false, alarms: [], pendingCount: 0 });
      return;
    }
    try {
      const list = await api.listAlarms(tripId);
      const now = Date.now();
      const items = (list || [])
        .filter((a) => this._types.indexOf(a.type || 'other') >= 0)
        .map((a) => {
          const triggerAt = alarm.calcTriggerAt(a.fireAt, a.fireAtStr);
          return {
            ...a,
            triggerAt,
            friendly: triggerAt ? timeUtil.fmtFriendly(triggerAt) : '',
            status: this.computeStatus(triggerAt),
          };
        });
      // 未来的在前（按时间升序），过期的沉底
      items.sort((a, b) => {
        const ta = a.triggerAt || 0;
        const tb = b.triggerAt || 0;
        const aPast = ta < now;
        const bPast = tb < now;
        if (aPast !== bPast) return aPast ? 1 : -1;
        return ta - tb;
      });
      this.setData({
        loading: false,
        alarms: items,
        pendingCount: items.filter((a) => a.triggerAt && a.triggerAt > now).length,
      });
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  computeStatus(triggerAt) {
    if (!triggerAt) return 'unknown';
    const now = Date.now();
    if (triggerAt < now) return 'past';
    if (triggerAt - now < 86400000) return 'soon';
    return 'future';
  },

  // ============================================================
  // 编辑 / 新增（底部抽屉，与闹钟 Tab 同款交互）
  // ============================================================
  onAdd() {
    const base = Date.now() + 3600000;
    this.setData({
      editingId: 'new',
      editForm: {
        title: '',
        note: '',
        fireAtDate: this.toDateStr(base),
        fireAtTime: this.toTimeStr(base),
        type: this._types[0] || 'other',
      },
    });
  },

  onTapEdit(e) {
    const item = (e.detail && e.detail.item) || e.currentTarget.dataset.item;
    if (!item) return;
    this.setData({
      editingId: item._id,
      editForm: {
        title: item.title || '',
        note: item.note || '',
        fireAtDate: this.toDateStr(item.triggerAt || item.fireAt),
        fireAtTime: this.toTimeStr(item.triggerAt || item.fireAt),
        type: item.type || (this._types[0] || 'other'),
      },
    });
  },

  toDateStr(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  toTimeStr(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  onEditInput(e) {
    const field = (e.detail && e.detail.field) || e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`editForm.${field}`]: e.detail.value });
  },

  onEditType(e) {
    const value = (e.detail && e.detail.value) || e.currentTarget.dataset.value;
    if (!value) return;
    this.setData({ 'editForm.type': value });
  },

  onDateChange(e) {
    this.setData({ 'editForm.fireAtDate': e.detail.value });
  },

  onTimeChange(e) {
    this.setData({ 'editForm.fireAtTime': e.detail.value });
  },

  parseDateTime(dateStr, timeStr) {
    const d = new Date(`${String(dateStr).replace(/-/g, '/')} ${timeStr}:00`);
    return isNaN(d.getTime()) ? null : d.getTime();
  },

  validateForm() {
    const { editForm } = this.data;
    if (!editForm.title) {
      wx.showToast({ title: '请输入提醒标题', icon: 'none' });
      return null;
    }
    if (!editForm.fireAtDate || !editForm.fireAtTime) {
      wx.showToast({ title: '请选择日期时间', icon: 'none' });
      return null;
    }
    const fireAt = this.parseDateTime(editForm.fireAtDate, editForm.fireAtTime);
    if (!fireAt) {
      wx.showToast({ title: '时间格式错误', icon: 'none' });
      return null;
    }
    return {
      title: editForm.title,
      note: editForm.note,
      fireAt,
      fireAtStr: `${editForm.fireAtDate} ${editForm.fireAtTime}`,
      type: editForm.type,
    };
  },

  async onSaveEdit() {
    const { editingId } = this.data;
    const patch = this.validateForm();
    if (!patch) return;
    try {
      wx.showLoading({ title: '保存中' });
      await api.updateAlarm(editingId, patch);
      this.setData({ editingId: null, editForm: null });
      await this.load();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async onConfirmAdd() {
    const data = this.validateForm();
    if (!data) return;
    try {
      wx.showLoading({ title: '添加中' });
      const tripId = app.globalData.currentTripId;
      await api.saveAlarms(tripId, [data]);
      this.setData({ editingId: null, editForm: null });
      await this.load();
      wx.showToast({ title: '已添加', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '添加失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onSheetSave() {
    if (this.data.editingId === 'new') this.onConfirmAdd();
    else this.onSaveEdit();
  },

  onCancelEdit() {
    this.setData({ editingId: null, editForm: null });
  },

  // ============================================================
  // 删除（确认卡）
  // ============================================================
  onDelete(e) {
    const item = (e.detail && e.detail.item) || e.currentTarget.dataset.item;
    if (!item) return;
    this.setData({ delItem: item });
  },

  onCancelDelete() {
    this.setData({ delItem: null });
  },

  async onConfirmDelete() {
    const item = this.data.delItem;
    if (!item || !item._id) {
      this.setData({ delItem: null });
      return;
    }
    this.setData({ delItem: null });
    try {
      wx.showLoading({ title: '删除中' });
      await api.deleteAlarm(item._id);
      await this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ============================================================
  // 写入系统日历
  // ============================================================
  async onTapCalendar(e) {
    const item = (e.detail && e.detail.item) || e.currentTarget.dataset.item;
    if (!item) return;
    try {
      wx.showLoading({ title: '写入日历' });
      await alarm.addToCalendar(item);
      wx.hideLoading();
      wx.showToast({ title: '已加入系统日历', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      this.handleCalendarError(err);
    }
  },

  handleCalendarError(err) {
    if (err && (err.code === 'CANCELLED' || /取消|cancel/i.test(err.message || ''))) {
      return;
    }
    if (err && err.code === 'AUTH_DENIED') {
      wx.showModal({
        title: '需要日历权限',
        content: '请在设置中允许小程序访问手机日历，才能到点响铃提醒。',
        confirmText: '去设置',
        success: (r) => {
          if (r.confirm) wx.openSetting();
        },
      });
    } else {
      wx.showToast({ title: (err && err.message) || '添加失败', icon: 'none' });
    }
  },
});
