// pages/index/index.js
const api = require('../../services/api');
const alarm = require('../../utils/alarm');
const timeUtil = require('../../utils/time');
const tripUtil = require('../../utils/trip');
const mapUtil = require('../../utils/map');

const app = getApp();

Page({
  data: {
    loading: true,
    trip: null,
    dateText: '',        // 顶部日期文案（无效日期显示"日期未设置"）
    days: [],            // [{ date, label, items: [...] }]
    nowItems: [],        // 正在进行 / 即将进行的行程（最多 3 条，点一下直接导航）
    nowTitle: '',        // 「正在进行」/「即将开始」
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

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
  },

  // 「正在进行」会随时间变化，每分钟用本地数据重算一次（不打网络请求）
  startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => this.refreshNow(), 60000);
  },

  stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  refreshNow() {
    const trip = this.data.trip;
    if (!trip) return;
    const nowItems = this.buildNowItems(trip);
    // 内容没变就别 setData，避免无谓的渲染
    if (JSON.stringify(nowItems) === JSON.stringify(this.data.nowItems)) return;
    this.setData({ nowItems, nowTitle: this.nowTitleOf(nowItems) });
  },

  nowTitleOf(list) {
    return (list.length && list[0].ongoing) ? '正在进行' : '即将开始';
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
        this.setData({ loading: false, trip: null, days: [], nowItems: [], homeTrips: [], totalTrips: 0 });
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
          loading: false, trip: null, days: [], nowItems: [], nowTitle: '',
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

      // 2. 拼装每日行程 + 标记今天是哪一天
      const days = this.buildDays(trip);
      const todayIdx = this.findTodayIdx(days);
      // 正在进行 / 即将进行的行程（首页直接导航用）
      const nowItems = this.buildNowItems(trip);

      // 3. 闹钟：不再在首页展示，但仍拉一次做时区校准（syncAlarms 会回写云端）
      const alarms = await api.listAlarms(tripId).catch(() => []);
      const localAlarms = (alarms || []).map((a) => ({
        ...a,
        triggerAt: alarm.calcTriggerAt(a.fireAt, a.fireAtStr),
      }));
      alarm.syncAlarms(localAlarms);

      this.setData({
        loading: false,
        trip,
        dateText,
        canRemoveFromHome,
        tripEnded,
        days,
        todayIdx,
        nowItems,
        nowTitle: this.nowTitleOf(nowItems),
        homeTrips: homeList,
        homeTripLabels: homeList.map((t) => t.title || '未命名行程'),
        tripIdx: idx,
        totalTrips: trips.length,
      });
      this.startTicker();
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
        days.push({ date: 'day-' + i, dayIndex: i, label: `第${i + 1}天`, items: sortItems(map[i]), past: false });
      }
      return days;
    }

    const dates = timeUtil.dateRange(startTs, endTs);
    const todayTs = new Date().setHours(0, 0, 0, 0);
    const days = dates.map((d, i) => ({
      date: timeUtil.fmtDate(d),
      dayIndex: i, // 原始第几天（列表重排后仍能对应回 itinerary 页）
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

  // ============================================================
  // 首页「此刻行程」：正在进行 + 即将进行的行程（点一下直接导航）
  // ============================================================
  // 规则：
  //   · 结束时间 >= 现在 的条目才算「还没过」（没填结束时间按 1 小时窗口算）
  //   · 开始时间 <= 现在 <= 结束时间 → 正在进行（高亮）
  //   · 其余 → 即将进行，按时间升序取前 3 条
  //   · 行程还没开始 / 已经结束 都天然成立：前者取第一天，后者一条都没有（卡片自动隐藏）
  buildNowItems(trip, limit) {
    const n = limit || 3;
    // 没有有效起始日期就无法换算成绝对时间，宁可不显示也不瞎猜
    if (!this.hasValidDate(trip.startDate)) return [];
    const startTs = this.parseLocalDate(trip.startDate);
    if (isNaN(startTs)) return [];

    const now = Date.now();
    const list = [];

    (trip.items || []).forEach((it, i) => {
      if (!it) return;
      const di = Number(it.dayIndex || 0);
      const dayDate = new Date(startTs);
      dayDate.setDate(dayDate.getDate() + di);

      const st = this.clockOn(dayDate, it.startTime);
      if (st === null) return; // 没填时间的条目无法判断，跳过

      let et = this.clockOn(dayDate, it.endTime);
      if (et !== null && et <= st) et += 86400000; // 跨零点（23:30 → 00:30）
      if (et === null) et = st + 3600000;          // 没结束时间，默认 1 小时

      if (et < now) return; // 已经结束了

      list.push({ it, di, seq: i, st, et });
    });

    list.sort((a, b) => a.st - b.st || a.di - b.di || a.seq - b.seq);
    return list.slice(0, n).map((x) => this.decorateNowItem(x, now));
  },

  // "14:30" 落到某一天上 → 时间戳；解析不了返回 null
  clockOn(dayDate, str) {
    const m = String(str || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(dayDate);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return d.getTime();
  },

  decorateNowItem(x, now) {
    const it = x.it;
    const s = it.startLocation || '';
    const e = it.endLocation || '';
    let routeText = '';
    if (s && e) routeText = `${s} → ${e}`;
    else if (e) routeText = e;
    else if (s) routeText = s;

    const ongoing = x.st <= now && x.et >= now;
    const day = new Date(x.st);

    return {
      key: `now_${x.di}_${x.seq}`,
      dayIdx: x.di, // itinerary 页按 dayIndex 过滤，传原始天序号
      timeText: it.startTime || '--:--',
      endText: it.endTime || '',
      title: it.activity || '未命名安排',
      hasNav: !!(e || s),
      routeText,
      navTarget: e || s,
      navFrom: s || '',
      transportType: it.transportType || 'car',
      endLat: it.endLat || 0,
      endLon: it.endLon || 0,
      ongoing,
      statusText: ongoing ? '进行中' : this.relativeStatus(x.st, now),
      dayLabel: `第${x.di + 1}天 · ${timeUtil.fmtDateShort(day)}`,
    };
  },

  relativeStatus(st, now) {
    const diff = st - now;
    // 行程时间只精确到分钟，所以用 <= 而不是 < ，否则这一支永远走不到
    if (diff <= 60000) return '马上开始';
    if (diff < 3600000) return `${Math.max(1, Math.round(diff / 60000))} 分钟后`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时后`;

    const d = new Date(st);
    d.setHours(0, 0, 0, 0);
    const t = new Date(now);
    t.setHours(0, 0, 0, 0);
    const days = Math.round((d.getTime() - t.getTime()) / 86400000);
    const word = days === 1 ? '明天' : (days === 2 ? '后天' : timeUtil.fmtDateShort(st));
    return `${word} ${timeUtil.fmtTime(st)}`;
  },

  // 点卡片 → 直接导航（没填地点的改为跳详情页）
  onTapNowNav(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.nowItems[idx];
    if (!item) return;
    if (!item.hasNav || !item.navTarget) {
      this.gotoDay(item.dayIdx);
      return;
    }
    mapUtil.openAmapNav({
      from: item.navFrom,
      to: item.navTarget,
      mode: item.transportType,
      endLat: item.endLat,
      endLon: item.endLon,
    });
  },

  // 点「详情 ›」→ 进当天行程
  onTapNowDetail(e) {
    const idx = Number((e.currentTarget.dataset || {}).idx);
    const item = this.data.nowItems[Number.isNaN(idx) ? 0 : idx];
    if (!item) return;
    this.gotoDay(item.dayIdx);
  },

  gotoDay(dayIndex) {
    wx.navigateTo({ url: `/pages/itinerary/itinerary?dayIdx=${dayIndex}` });
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
    const day = this.data.days[idx];
    // 注意：days 会被重排（过期天沉底），数组下标 ≠ 第几天，
    // 必须传原始 dayIndex，否则 itinerary 页会打开错误的一天
    this.gotoDay(day && day.dayIndex != null ? day.dayIndex : idx);
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