// pages/mytrips/mytrips.js
// 我的行程：全部攻略的统一管理页（进行中在前、已过期沉底置灰）
const api = require('../../services/api');
const tripUtil = require('../../utils/trip');
const homeCache = require('../../utils/homecache');
const auth = require('../../utils/auth');

const app = getApp();

Page({
  data: {
    loading: true,
    needLogin: false,    // 未登录 → 只显示登录门禁卡
    trips: [],       // [{ _id, title, dateRange, itemCount, ended, pinned }]
    activeCount: 0,  // 进行中数量
    endedCount: 0,   // 已过期数量
  },

  onLoad() {
    // 订阅全局登录态：一处登录全站解锁
    this._offAuth = auth.watch(this, {
      onLogin: () => this.load(),
      onLogout: () => this.setData({
        loading: false, trips: [], activeCount: 0, endedCount: 0,
      }),
    });
  },

  onShow() {
    this.load();
  },

  onUnload() {
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
  },

  // 登录成功后由门禁组件回调（正常情况下登录广播已刷新过，这里只兜底）
  onLoginSuccess() {
    if (!this.data.needLogin) return;
    this.setData({ needLogin: false });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    // 未登录 → 先自动静默登录一次；仍然失败才显示登录门禁卡
    const ok = await auth.requireLogin();
    if (!ok) {
      this.setData({ loading: false, needLogin: true, trips: [], activeCount: 0, endedCount: 0 });
      return;
    }
    if (this.data.needLogin) this.setData({ needLogin: false });
    this.setData({ loading: true });
    try {
      const list = await api.listItineraries();
      const pinned = tripUtil.getPinnedIds();
      const trips = (list || []).map((t) => ({
        _id: t._id,
        title: t.title || '未命名行程',
        startDate: t.startDate || '',
        dateRange: t.startDate ? `${t.startDate} → ${t.endDate || '?'}` : '日期未设置',
        itemCount: (t.items || []).length,
        ended: tripUtil.isEnded(t),
        pinned: pinned.indexOf(t._id) >= 0,
      }));
      // 进行中/未来的排前面（按开始日期升序），已过期的沉到末尾
      trips.sort((a, b) => {
        if (a.ended !== b.ended) return a.ended ? 1 : -1;
        return String(a.startDate).localeCompare(String(b.startDate));
      });
      this.setData({
        loading: false,
        trips,
        activeCount: trips.filter((t) => !t.ended).length,
        endedCount: trips.filter((t) => t.ended).length,
      });
    } catch (err) {
      this.setData({ loading: false });
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    }
  },

  // 查看行程：整份攻略按时间顺序全部展开（只读浏览，不改动首页当前展示的攻略）
  onTapView(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/itinerary/itinerary?tripId=${id}&readonly=1&all=1` });
  },

  // 已结束的攻略：添加到首页展示 / 从首页移出
  onTogglePin(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const nowPinned = tripUtil.togglePinned(id);
    if (!nowPinned && app.globalData.currentTripId === id) {
      app.globalData.currentTripId = null;
    }
    wx.showToast({ title: nowPinned ? '已添加到首页展示' : '已从首页移出', icon: 'none' });
    this.load();
  },

  // 删除攻略（未过期的也能删）——行程、闹钟、建议一并删除
  async onTapDelete(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.title || '该行程';
    if (!id) return;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除行程',
        content: `确定删除「${name}」吗？\n行程安排、闹钟和旅行建议将一并删除，且无法恢复。`,
        confirmText: '删除',
        confirmColor: '#e74c3c',
        success: resolve,
      });
    });
    if (!res.confirm) return;
    wx.showLoading({ title: '删除中' });
    try {
      await api.deleteItinerary(id);
      if (tripUtil.getPinnedIds().indexOf(id) >= 0) tripUtil.togglePinned(id);
      if (app.globalData.currentTripId === id) app.globalData.currentTripId = null;
      homeCache.clear(); // 首页快照可能正好是这条，直接失效
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      await this.load();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    }
  },

  onTapUpload() {
    wx.navigateTo({ url: '/pages/upload/upload' });
  },
});
