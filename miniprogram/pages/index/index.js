// pages/index/index.js
const api = require('../../services/api');
const alarm = require('../../utils/alarm');
const timeUtil = require('../../utils/time');
const tripUtil = require('../../utils/trip');
const mapUtil = require('../../utils/map');
const homeCache = require('../../utils/homecache');
const auth = require('../../utils/auth');
const genrunner = require('../../utils/genrunner');

const app = getApp();

// 同一行程的闹钟时区校准节流窗口（毫秒）
const ALARM_SYNC_TTL = 10 * 60 * 1000;

// 星期名（getDay() 下标：0 = 周日）
const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

Page({
  data: {
    loading: true,
    needLogin: false,    // 未登录 → 只显示登录门禁卡
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
    tripMenuOpen: false, // 蓝卡右上角 ⋯ 菜单是否展开
  },

  onLoad() {
    // 完整攻略数据放实例上，不进 data —— 避免 setData 反复序列化大数组
    this._trips = null;     // 完整攻略列表
    this._homeList = null;  // 首页可展示的完整攻略
    this._trip = null;      // 当前完整攻略（含 items）
    this._snapSig = '';     // 上一次渲染快照的签名（用于跳过无变化的 setData）
    this._loadPromise = null;
    this._genPollTimer = null;
    this._genRefreshTimer = null;
    this._offGen = genrunner.subscribe((s) => {
      if (s && (s.status === 'running' || s.status === 'done' || s.status === 'failed')) {
        this.scheduleGenerationRefresh();
      }
    });
    // 订阅全局登录态：在「我的」登录后本页自动解锁；退出登录后自动清空
    this._offAuth = auth.watch(this, {
      onLogin: () => { this._snapSig = ''; this.loadTrip(); },
      onLogout: () => {
        this.stopTicker();
        this.stopGenerationPolling();
        this._trip = null;
        homeCache.clear();
        this._snapSig = '';
        this.setData({
          loading: false, trip: null, days: [], nowItems: [], nowTitle: '',
          homeTrips: [], homeTripLabels: [], totalTrips: 0,
        });
      },
    });
  },

  onShow() {
    this.startGenerationPolling();
    this.loadTrip();
  },

  onHide() {
    this.stopTicker();
    this.stopGenerationPolling();
  },

  onUnload() {
    this.stopTicker();
    this.stopGenerationPolling();
    if (this._genRefreshTimer) { clearTimeout(this._genRefreshTimer); this._genRefreshTimer = null; }
    if (this._offGen) { this._offGen(); this._offGen = null; }
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
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
    const trip = this._trip || this.data.trip;
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

  // 登录成功后由门禁组件回调（正常情况下登录广播已刷新过，这里只兜底）
  onLoginSuccess() {
    if (!this.data.needLogin) return;
    this.setData({ needLogin: false });
    this._snapSig = '';
    this.loadTrip();
  },

  startGenerationPolling() {
    if (this._genPollTimer) return;
    this._genPollTimer = setInterval(() => {
      const trip = this._trip;
      const runner = genrunner.get();
      if ((trip && trip.genStatus === 'generating') || runner.status === 'running') {
        this.loadTrip({ silent: true });
      } else {
        this.stopGenerationPolling();
      }
    }, 6000);
  },

  stopGenerationPolling() {
    if (this._genPollTimer) {
      clearInterval(this._genPollTimer);
      this._genPollTimer = null;
    }
  },

  scheduleGenerationRefresh() {
    if (this._genRefreshTimer) return;
    this._genRefreshTimer = setTimeout(() => {
      this._genRefreshTimer = null;
      this.loadTrip({ silent: true });
    }, 250);
  },

  // 加载流程（性能优化后的版本）：
  //   ① 冷启动先用本地快照秒开（不转圈），有数据就不显示 loading
  //   ② 只调一次 listItineraries —— 它返回的已经是完整文档，不再单独 get 一次
  //   ③ 闹钟时区校准挪到后台跑，且同一行程 10 分钟内只做一次，不再阻塞首屏
  //   ④ setData 只传渲染需要的精简字段（items 数组不再重复序列化两次）
  async loadTrip(options) {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._loadTrip(options || {}).finally(() => {
      this._loadPromise = null;
    });
    return this._loadPromise;
  },

  async _loadTrip(options) {
    // ⓪ 未登录 → 先自动静默登录一次（用户无感知）；仍然失败才显示登录门禁卡
    const ok = await auth.requireLogin();
    if (!ok) {
      this.stopTicker();
      homeCache.clear();
      this.setData({
        loading: false,
        needLogin: true,
        trip: null,
        days: [],
        nowItems: [],
        nowTitle: '',
        homeTrips: [],
        homeTripLabels: [],
        totalTrips: 0,
      });
      return;
    }
    // 已登录：把可能残留的门禁卡收起来
    if (this.data.needLogin) this.setData({ needLogin: false });

    // ① 先渲染本地快照
    if (!this._snapSig) {
      const snap = homeCache.read();
      if (snap) {
        // 记下签名：网络回来后如果内容一样就不重复 setData
        this._snapSig = JSON.stringify(snap);
        this.setData(Object.assign({ loading: false }, snap));
      } else {
        this.setData({ loading: true });
      }
    }

    try {
      // ② 拿当前用户的所有攻略（一次云调用）
      const trips = await api.listItineraries({
        compact: true,
        fullTripId: app.globalData.currentTripId || '',
      });
      this._trips = trips || [];
      if (!trips || !trips.length) {
        this._trip = null;
        this.stopGenerationPolling();
        homeCache.clear();
        this.applySnapshot({
          trip: null, days: [], nowItems: [], nowTitle: '',
          homeTrips: [], homeTripLabels: [], tripIdx: 0, totalTrips: 0,
          dateText: '', canRemoveFromHome: false, tripEnded: false, todayIdx: -1,
        });
        return;
      }
      // 首页可展示 = 进行中的 + 置顶的历史攻略
      const homeList = tripUtil.homeTrips(trips);
      this._homeList = homeList;

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
        homeCache.clear();
        this.applySnapshot({
          trip: null, days: [], nowItems: [], nowTitle: '',
          homeTrips: [], homeTripLabels: [], tripIdx: 0, totalTrips: trips.length,
          dateText: '', canRemoveFromHome: false, tripEnded: false, todayIdx: -1,
        });
        return;
      }

      // list 返回的已经是完整文档，直接用；只在极少数没命中的情况下才补一次 get
      let trip = (this._trips || []).find((t) => t._id === tripId);
      if (!trip || !Array.isArray(trip.items)) trip = await api.getItinerary(tripId);
      this._trip = trip;
      app.globalData.currentTripId = tripId;
      app.globalData.currentTrip = trip;

      if (trip.genStatus === 'generating') this.startGenerationPolling();
      else this.stopGenerationPolling();

      this.applySnapshot(this.buildSnapshot(trip, homeList, idx, trips.length));
      this.startTicker();
      // ③ 后台校准闹钟时区（不 await）
      this.syncAlarmsOnce(tripId);
    } catch (err) {
      console.error(err);
      this.setData({ loading: false });
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    }
  },

  // 组装一次渲染需要的全部字段（精简版：不把 items 大数组塞进 setData）
  buildSnapshot(trip, homeList, idx, total) {
    const days = this.buildDays(trip);
    const nowItems = this.buildNowItems(trip);
    const tripEnded = tripUtil.isEnded(trip);
    return {
      trip: {
        _id: trip._id,
        title: trip.title || '',
        summary: trip.summary || '',
        startDate: trip.startDate,
        endDate: trip.endDate,
        genStatus: trip.genStatus || '',
        genProgress: trip.genProgress || null,
        genError: trip.genError || '',
      },
      // 顶部日期文案：无效日期显示"日期未设置"，绝不能显示 "null → null"
      dateText: this.hasValidDate(trip.startDate)
        ? `${trip.startDate} → ${trip.endDate}`
        : '日期未设置',
      tripEnded,
      // 已结束且被置顶到首页的攻略 → 首页可直接"移出"
      canRemoveFromHome: tripEnded && tripUtil.getPinnedIds().indexOf(trip._id) >= 0,
      days,
      todayIdx: this.findTodayIdx(days),
      nowItems,
      nowTitle: this.nowTitleOf(nowItems),
      homeTrips: homeList.map((t) => ({
        _id: t._id,
        title: t.title,
        startDate: t.startDate,
        endDate: t.endDate,
      })),
      homeTripLabels: homeList.map((t) => t.title || '未命名行程'),
      tripIdx: idx,
      totalTrips: total,
    };
  },

  // 内容没变化就不 setData，避免无谓的视图层重绘
  applySnapshot(snap) {
    const sig = JSON.stringify(snap);
    if (sig === this._snapSig) {
      this.setData({ loading: false });
      return;
    }
    this._snapSig = sig;
    this.setData(Object.assign({}, snap, { loading: false }));
    if (snap.trip) homeCache.write(snap);
  },

  // 闹钟时区校准：后台跑 + 节流，不再拖慢首屏
  syncAlarmsOnce(tripId) {
    if (!tripId) return;
    if (Date.now() - homeCache.alarmSyncedAt(tripId) < ALARM_SYNC_TTL) return;
    api.listAlarms(tripId)
      .then((alarms) => {
        const localAlarms = (alarms || []).map((a) => ({
          ...a,
          triggerAt: alarm.calcTriggerAt(a.fireAt, a.fireAtStr),
        }));
        alarm.syncAlarms(localAlarms);
        homeCache.markAlarmSynced(tripId);
      })
      .catch(() => {});
  },

  // 切换当前展示的攻略
  onTripChange(e) {
    const idx = Number(e.detail.value);
    const t = this.data.homeTrips[idx];
    if (!t || t._id === app.globalData.currentTripId) return;
    app.globalData.currentTripId = t._id;
    this.setData({ tripIdx: idx, tripMenuOpen: false });

    // 本地已有一份完整数据 → 先秒切渲染，再后台校准，不等网络
    const full = (this._trips || []).find((x) => x._id === t._id);
    const homeList = this._homeList || [];
    if (full && Array.isArray(full.items)) {
      this._trip = full;
      app.globalData.currentTrip = full;
      this.applySnapshot(this.buildSnapshot(full, homeList, idx, this.data.totalTrips));
    }
    this.loadTrip();
  },

  // 蓝卡右上角 ⋯ 菜单
  onToggleTripMenu() {
    this.setData({ tripMenuOpen: !this.data.tripMenuOpen });
  },

  onCloseTripMenu() {
    if (this.data.tripMenuOpen) this.setData({ tripMenuOpen: false });
  },

  noop() {},

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

    // 按 dayIndex 分组，只统计条数（不再把 items 整包塞进 setData）
    const map = {};
    (trip.items || []).forEach((it) => {
      const idx = it.dayIndex || 0;
      map[idx] = (map[idx] || 0) + 1;
    });
    const countOf = (i) => map[i] || 0;

    // 没有有效起始日期 → 只按天数生成卡片，不显示具体日期，也不标"今天"
    // （绝不能用"当天"冒充第 1 天——那会复现"通勤行程显示成 9 月 21 日"的 bug）
    if (!startOk) {
      const maxDi = (trip.items || []).reduce((m, it) => Math.max(m, it.dayIndex || 0), 0);
      const days = [];
      for (let i = 0; i <= maxDi; i++) {
        days.push({ date: 'day-' + i, dayIndex: i, label: `第${i + 1}天`, count: countOf(i), past: false });
      }
      return days;
    }

    const dates = timeUtil.dateRange(startTs, endTs);
    const todayTs = new Date().setHours(0, 0, 0, 0);
    const days = dates.map((d, i) => ({
      date: timeUtil.fmtDate(d),
      dayIndex: i, // 原始第几天（列表重排后仍能对应回 itinerary 页）
      label: this.formatLabel(d, i),
      count: countOf(i),
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

    // 保险：整趟攻略的日期已经翻篇（结束日 23:59:59 都过了）→ 一条都不生成，
    // 防止个别条目时间算歪了仍被当成"正在进行"
    if (this.hasValidDate(trip.endDate)) {
      const endTs = this.parseLocalDate(trip.endDate);
      if (!isNaN(endTs) && endTs + 86400000 - 1 < Date.now()) return [];
    }

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
      if (et !== null && et < st) et += 86400000;  // 跨零点（23:30 → 00:30）：只有结束早于开始才加一天
      if (et === null || et === st) et = st + 3600000; // 没结束时间 / 开始结束相同（零时长）→ 默认 1 小时

      if (et < now) return; // 已经结束了

      list.push({ it, di, seq: i, st, et });
    });

    list.sort((a, b) => a.st - b.st || a.di - b.di || a.seq - b.seq);
    // 消歧优先用条目自己的城市（生成时逐条记的），没有再退回整条行程的大地名
    return list.slice(0, n).map((x) => this.decorateNowItem(x, now, (x.it && x.it.city) || trip.region || ''));
  },

  // "14:30" 落到某一天上 → 时间戳；解析不了返回 null
  clockOn(dayDate, str) {
    const m = String(str || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(dayDate);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return d.getTime();
  },

  decorateNowItem(x, now, region) {
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
      region: region || '',   // 大地名：导航缺坐标实时定位时给高德消歧
      ongoing,
      statusText: ongoing ? '进行中' : this.relativeStatus(x.st, now),
      dateText: this.dateTextOf(day, now),   // 「今天 10-02 周四」这类完整日期
      dayLabel: `第${x.di + 1}天`,
    };
  },

  // 行程日期：今天/明天/后天 + MM-DD + 星期（越久远越省略前缀）
  dateTextOf(d, now) {
    const a = new Date(d); a.setHours(0, 0, 0, 0);
    const b = new Date(now); b.setHours(0, 0, 0, 0);
    const days = Math.round((a.getTime() - b.getTime()) / 86400000);
    const word = days === 0 ? '今天' : (days === 1 ? '明天' : (days === 2 ? '后天' : ''));
    return [word, timeUtil.fmtDateShort(d), WEEK_NAMES[d.getDay()]].filter(Boolean).join(' ');
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
      region: item.region || '',
      // 条目城市查不到时（跨城段常这样），用整条行程的大地名再试一次
      fallbackRegion: (this._trip && this._trip.region) || '',
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
    this.setData({ tripMenuOpen: false });
    wx.showModal({
      title: '从首页移出',
      content: `「${trip.title || '该行程'}」已结束，移出后只在「历史行程」中显示，可随时再添加回来。`,
      confirmText: '移出',
      success: (r) => {
        if (!r.confirm) return;
        tripUtil.togglePinned(trip._id);
        app.globalData.currentTripId = null; // 触发首页自动回退到其他攻略
        wx.showToast({ title: '已移出首页', icon: 'none' });
        this._trips = null; // 本地数据已失效，重新拉
        homeCache.clear();
        this.loadTrip();
      },
    });
  },

  // 删除当前攻略（未过期的也能删）——行程、闹钟、建议一并删除
  async onDeleteTrip() {
    const trip = this.data.trip;
    if (!trip) return;
    this.setData({ tripMenuOpen: false });
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
      this._trips = null;
      homeCache.clear();
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

  onTapPlanner() {
    wx.navigateTo({ url: '/pages/planner/planner' });
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
