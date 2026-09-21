// pages/index/index.js
const api = require('../../services/api');
const alarm = require('../../utils/alarm');
const timeUtil = require('../../utils/time');
const tripUtil = require('../../utils/trip');

const app = getApp();

Page({
  data: {
    loading: true,
    trip: null,
    dateText: '',        // 顶部日期文案（无效日期显示"日期未设置"）
    days: [],            // [{ date, label, items: [...] }]
    nextAlarms: [],      // 接下来 3 个闹钟
    todayIdx: -1,        // 今天对应第几天；-1 = 行程未开始或已结束
    homeTrips: [],       // 首页可展示的攻略（进行中 + 置顶的历史）
    homeTripLabels: [],  // 攻略标题（picker 用）
    tripIdx: 0,          // 当前选中的攻略下标
    totalTrips: 0,       // 全部行程数量（空态引导用）
    canRemoveFromHome: false, // 当前攻略是否可从首页移出（已结束 + 已置顶）
    tripEnded: false,    // 当前攻略是否已结束
  },

  onShow() {
    this.loadTrip();
  },

  onPullDownRefresh() {
    this.loadTrip().then(() => wx.stopPullDownRefresh());
  },

  async loadTrip() {
    this.setData({ loading: true });
    try {
      // 1. 拿当前用户的所有攻略，分组：进行中 / 历史
      const trips = await api.listItineraries();
      if (!trips || !trips.length) {
        this.setData({ loading: false, trip: null, days: [], nextAlarms: [], homeTrips: [], totalTrips: 0 });
        return;
      }
      // 首页可展示 = 进行中的 + 置顶的历史攻略
      const homeList = tripUtil.homeTrips(trips);

      // 当前攻略不在首页列表（比如已结束且未置顶）→ 自动切到第一个
      let tripId = app.globalData.currentTripId;
      let idx = homeList.findIndex((t) => t._id === tripId);
      if (idx < 0) {
        idx = 0;
        tripId = homeList.length ? homeList[0]._id : null;
        app.globalData.currentTripId = tripId;
      }

      // 没有任何可展示的攻略（全结束且都没置顶）
      if (!tripId) {
        this.setData({
          loading: false, trip: null, days: [], nextAlarms: [],
          homeTrips: [], homeTripLabels: [], tripIdx: 0, totalTrips: trips.length,
        });
        return;
      }

      const trip = await api.getItinerary(tripId);
      app.globalData.currentTripId = tripId;
      app.globalData.currentTrip = trip;

      // 顶部日期文案：无效日期显示"日期未设置"，绝不能显示 "null → null"
      const dateText = this.hasValidDate(trip.startDate)
        ? `${trip.startDate} → ${trip.endDate}`
        : '日期未设置';
      // 已结束且被置顶到首页的攻略 → 首页可直接"移出"
      const tripEnded = tripUtil.isEnded(trip);
      const canRemoveFromHome = tripEnded && tripUtil.getPinnedIds().indexOf(tripId) >= 0;

      // 2. 拼装每日行程
      const days = this.buildDays(trip);
      // 标记今天是哪一天
      const todayIdx = this.findTodayIdx(days);

      // 3. 拿闹钟
      const alarms = await api.listAlarms(tripId).catch(() => []);
      const localAlarms = (alarms || []).map((a) => ({
        ...a,
        triggerAt: alarm.calcTriggerAt(a.fireAt, a.fireAtStr),
      }));
      alarm.syncAlarms(localAlarms);
      const nextAlarms = this.upcomingAlarms(localAlarms, 3);

      this.setData({
        loading: false,
        trip,
        dateText,
        canRemoveFromHome,
        tripEnded,
        days,
        todayIdx,
        nextAlarms,
        homeTrips: homeList,
        homeTripLabels: homeList.map((t) => t.title || '未命名行程'),
        tripIdx: idx,
        totalTrips: trips.length,
      });
    } catch (err) {
      console.error(err);
      this.setData({ loading: false });
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    }
  },

  // 切换当前展示的攻略
  onTripChange(e) {
    const idx = Number(e.detail.value);
    const t = this.data.homeTrips[idx];
    if (!t || t._id === app.globalData.currentTripId) return;
    app.globalData.currentTripId = t._id;
    this.setData({ tripIdx: idx });
    this.loadTrip();
  },

  // "2026-09-30" → 当天本地 00:00 的时间戳
  // 直接 new Date("YYYY-MM-DD") 会被解析成 UTC 零点（北京时间 08:00），导致日期判断错位
  parseLocalDate(str) {
    if (!str) return NaN;
    const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) {
      const d = new Date(str);
      return isNaN(d.getTime()) ? NaN : d.getTime();
    }
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  },

  hasValidDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  },

  buildDays(trip) {
    const startOk = this.hasValidDate(trip.startDate);
    const startTs = startOk ? this.parseLocalDate(trip.startDate) : null;
    const endTs = startOk && this.hasValidDate(trip.endDate) ? this.parseLocalDate(trip.endDate) : startTs;

    // 按 dayIndex 分组
    const map = {};
    (trip.items || []).forEach((it) => {
      const idx = it.dayIndex || 0;
      if (!map[idx]) map[idx] = [];
      map[idx].push(it);
    });
    const sortItems = (arr) => (arr || []).sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    // 没有有效起始日期 → 只按天数生成卡片，不显示具体日期，也不标"今天"
    // （绝不能用"当天"冒充第 1 天——那会复现"通勤行程显示成 9 月 21 日"的 bug）
    if (!startOk) {
      const maxDi = (trip.items || []).reduce((m, it) => Math.max(m, it.dayIndex || 0), 0);
      const days = [];
      for (let i = 0; i <= maxDi; i++) {
        days.push({ date: 'day-' + i, label: `第${i + 1}天`, items: sortItems(map[i]), past: false });
      }
      return days;
    }

    const dates = timeUtil.dateRange(startTs, endTs);
    const todayTs = new Date().setHours(0, 0, 0, 0);
    const days = dates.map((d, i) => ({
      date: timeUtil.fmtDate(d),
      label: this.formatLabel(d, i),
      items: sortItems(map[i]),
      past: d.getTime() < todayTs, // 已过期的天
    }));
    // 已过期的天数沉到列表末尾（保持原有相对顺序，第X天编号不变）
    return days.filter((d) => !d.past).concat(days.filter((d) => d.past));
  },

  formatLabel(d, i) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${timeUtil.fmtDate(d)} ${weekdays[d.getDay()]} · 第${i + 1}天`;
  },

  // 找不到今天（行程还没开始 / 已结束）时返回 -1，
  // 千万不能返回 0 —— 否则第一天会被错标成"今天"
  findTodayIdx(days) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = today.getTime();
    for (let i = 0; i < days.length; i++) {
      if (this.parseLocalDate(days[i].date) === todayTs) return i;
    }
    return -1;
  },

  upcomingAlarms(alarms, n) {
    const now = Date.now();
    return alarms
      .filter((a) => a.triggerAt && a.triggerAt >= now - 600000) // 包括 10 分钟内的
      .sort((a, b) => a.triggerAt - b.triggerAt)
      .slice(0, n)
      .map((a) => ({
        ...a,
        friendly: timeUtil.fmtFriendly(a.triggerAt),
      }));
  },

  // 把已结束且置顶到首页的攻略移出首页（只在历史行程里保留）
  onRemoveFromHome() {
    const trip = this.data.trip;
    if (!trip) return;
    wx.showModal({
      title: '从首页移出',
      content: `「${trip.title || '该行程'}」已结束，移出后只在「历史行程」中显示，可随时再添加回来。`,
      confirmText: '移出',
      success: (r) => {
        if (!r.confirm) return;
        tripUtil.togglePinned(trip._id);
        app.globalData.currentTripId = null; // 触发首页自动回退到其他攻略
        wx.showToast({ title: '已移出首页', icon: 'none' });
        this.loadTrip();
      },
    });
  },

  // 删除当前攻略（未过期的也能删）——行程、闹钟、建议一并删除
  async onDeleteTrip() {
    const trip = this.data.trip;
    if (!trip) return;
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '删除行程',
        content: `确定删除「${trip.title || '该行程'}」吗？\n行程安排、闹钟和旅行建议将一并删除，且无法恢复。`,
        confirmText: '删除',
        confirmColor: '#e74c3c',
        success: resolve,
      });
    });
    if (!res.confirm) return;
    try {
      wx.showLoading({ title: '删除中' });
      await api.deleteItinerary(trip._id);
      // 同步清理本地置顶状态与当前选中
      if (tripUtil.getPinnedIds().indexOf(trip._id) >= 0) tripUtil.togglePinned(trip._id);
      app.globalData.currentTripId = null;
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
      await this.loadTrip();
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    }
  },

  // 事件
  onTapDay(e) {
    const idx = e.currentTarget.dataset.idx;
    wx.navigateTo({ url: `/pages/itinerary/itinerary?dayIdx=${idx}` });
  },

  onTapUpload() {
    wx.navigateTo({ url: '/pages/upload/upload' });
  },

  onTapTicket() {
    wx.switchTab({ url: '/pages/tickets/tickets' });
  },

  onTapSuggestion() {
    wx.switchTab({ url: '/pages/suggestions/suggestions' });
  },

  onTapMyTrips() {
    wx.navigateTo({ url: '/pages/mytrips/mytrips' });
  },
});