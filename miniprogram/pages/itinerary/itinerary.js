// pages/itinerary/itinerary.js
const api = require('../../services/api');
const mapUtil = require('../../utils/map');
const homeCache = require('../../utils/homecache');
const auth = require('../../utils/auth');

const app = getApp();

Page({
  data: {
    needLogin: false,       // 未登录 → 只显示登录门禁卡
    dayIdx: 0,
    tripId: null,
    trip: null,
    dayLabel: '',
    isToday: false,         // 当前查看的是否是今天
    readonly: false,        // 只读模式（查看历史行程）
    items: [],              // 展示顺序：进行中/未开始（按时间升序）→ 已结束（沉底置灰）
    dayTips: null,          // { tips: [], notices: [] }
    tipsLoading: false,
    editingId: '',            // 空串 = 没有正在编辑的条目（不能用 null，WXML 里 null===undefined 恒为 false）
    editForm: null,           // { key, startTime, endTime, activity, startLocation, endLocation, transportType, category, note }
    // 全行程展开模式（从「我的行程」进入）：按天顺序一次性展示整份攻略
    viewAll: false,
    dayGroups: [],           // [{ dayIndex, label, past, items: [...] }]
    totalCount: 0,
  },

  onLoad(opts) {
    this.setData({
      dayIdx: parseInt(opts.dayIdx || 0, 10),
      // 支持 ?tripId=xxx&readonly=1 直接查看指定攻略（历史行程入口），不改动全局当前行程
      viewTripId: opts.tripId || '',
      readonly: opts.readonly === '1',
      // all=1：整份攻略按时间顺序全部展开（只读浏览用）
      viewAll: opts.all === '1',
    });
    this.rawItems = [];     // 按时间排好序的原始列表
    this.dayStartTs = 0;    // 当天 00:00 的时间戳
    this.baseDate = null;   // 行程第一天的 00:00（Date）
    // 订阅全局登录态：一处登录全站解锁
    this._offAuth = auth.watch(this, {
      onLogin: () => this.load(),
      onLogout: () => this.setData({
        loading: false, trip: null, items: [], dayGroups: [], dayTips: null,
      }),
    });
  },

  onShow() {
    this.load();
    this.startTicker();    // 每分钟刷新一次"进行中/已结束"状态
  },

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
  },

  // ============================================================
  // 时间状态：当下一项的开始时间到达时，上一项自动沉底置灰
  // ============================================================
  startTicker() {
    this.stopTicker();
    this.tickerId = setInterval(() => {
      if (this.data.viewAll) this.refreshAllFlags();
      else this.applyTimeFlags();
    }, 60 * 1000);
  },

  stopTicker() {
    if (this.tickerId) {
      clearInterval(this.tickerId);
      this.tickerId = null;
    }
  },

  // "09:30" → 当天的时间戳；解析失败返回 null
  itemTs(timeStr) {
    if (!timeStr) return null;
    const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return this.dayStartTs + (+m[1]) * 3600000 + (+m[2]) * 60000;
  },

  // 根据当前时间重算每项的 past 标记并重排（不重新拉数据）
  applyTimeFlags() {
    if (!this.rawItems.length) return;
    const now = Date.now();
    const isToday = this.data.isToday;
    const dayEndTs = this.dayStartTs + 86400000; // 当天 24:00

    // 找出"最近一个已开始"的项：它的前一项都算已结束
    let lastStarted = -1;
    if (!isToday && dayEndTs <= now) {
      // 查看的是完全过去的某一天 → 全部置灰沉底（保持时间顺序）
      lastStarted = this.rawItems.length;
    } else if (isToday) {
      this.rawItems.forEach((it, i) => {
        const ts = this.itemTs(it.startTime);
        if (ts !== null && ts <= now) lastStarted = i;
      });
    }

    const active = [];   // 进行中 + 未开始，按时间升序
    const past = [];     // 已结束，沉底
    const eid = this.data.editingId || '';
    this.rawItems.forEach((it, i) => {
      const o = Object.assign({}, it, {
        past: i < lastStarted,
        // 直接把「是否正在编辑」算进条目里，避免 WXML 里做易错的 undefined 比较
        editing: !!eid && this.itemKeyOf(it) === eid,
      });
      (o.past ? past : active).push(o);
    });

    this.setData({ items: active.concat(past) });
  },

  // ============================================================
  // 全行程展开模式：按天顺序 + 天内时间顺序，一次性展示整份攻略
  // ============================================================
  tsOn(dayStartTs, timeStr) {
    if (!timeStr) return null;
    const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return dayStartTs + (+m[1]) * 3600000 + (+m[2]) * 60000;
  },

  parseTripStart(startDate) {
    const m = startDate ? String(startDate).match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  },

  buildAllDays(trip) {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const map = {};
    (trip.items || []).forEach((it) => {
      const di = Number(it.dayIndex || 0);
      (map[di] = map[di] || []).push(it);
    });
    const now = Date.now();
    return Object.keys(map)
      .map(Number)
      .sort((a, b) => a - b)
      .map((di) => {
        let label = `第 ${di + 1} 天`;
        let dayStartTs = null;
        if (this.baseDate) {
          const d = new Date(this.baseDate.getTime());
          d.setDate(d.getDate() + di);
          dayStartTs = d.getTime();
          label = `${this.formatYMD(d)} ${weekdays[d.getDay()]} · 第 ${di + 1} 天`;
        }
        const list = map[di].slice().sort((a, b) =>
          String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99'))
        );
        const dayPast = dayStartTs !== null && dayStartTs + 86400000 <= now;
        const eid = this.data.editingId || '';
        const items = list.map((it) => {
          let past = dayPast;
          if (!dayPast && dayStartTs !== null) {
            const ts = this.tsOn(dayStartTs, it.startTime);
            past = ts !== null && ts <= now;
          }
          return Object.assign({}, it, {
            past,
            editing: !!eid && this.itemKeyOf(it) === eid,
          });
        });
        return { dayIndex: di, label, past: dayPast, items };
      });
  },

  refreshAllFlags() {
    if (!this.data.trip) return;
    this.setData({ dayGroups: this.buildAllDays(this.data.trip) });
  },

  // 登录成功后由门禁组件回调（正常情况下登录广播已刷新过，这里只兜底）
  onLoginSuccess() {
    if (!this.data.needLogin) return;
    this.setData({ needLogin: false });
    this.load();
  },

  // 加载策略（2026-09-24 秒开优化）：
  //   之前每次进本页都硬等一次云函数（0.5~2s），首页点进来就干转圈。
  //   现在：全局缓存里是同一趟行程就先渲染（首页/本页编辑刚写过这份数据），
  //   后台再拉最新数据，内容变了才重渲染——点了就开，开完悄悄对齐。
  async load() {
    try {
      // 未登录 → 先自动静默登录一次；仍然失败才显示登录门禁卡
      const ok = await auth.requireLogin();
      if (!ok) {
        this.setData({ needLogin: true, loading: false, trip: null, items: [], dayGroups: [] });
        return;
      }
      this.setData({ needLogin: false });
      // 历史行程入口传了 viewTripId 就用它；否则用全局当前行程
      const tripId = this.data.viewTripId || app.globalData.currentTripId;
      if (!tripId) {
        wx.showToast({ title: '请先上传攻略', icon: 'none' });
        return;
      }

      const cached = app.globalData.currentTrip;
      if (cached && cached._id === tripId && Array.isArray(cached.items) && cached.items.length) {
        this.renderTrip(cached, tripId);
        this.bgRefresh(tripId, cached);
        return;
      }

      const trip = await api.getItinerary(tripId);
      app.globalData.currentTrip = trip;
      this.renderTrip(trip, tripId);
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
    }
  },

  // 后台刷新：缓存渲染后拉最新数据，变了才重渲染（编辑抽屉打开时不打扰）
  async bgRefresh(tripId, cached) {
    try {
      const trip = await api.getItinerary(tripId);
      if (!trip || !trip._id) return;
      app.globalData.currentTrip = trip;
      const same = trip.updatedAt && cached.updatedAt
        ? trip.updatedAt === cached.updatedAt
        : (trip.items || []).length === (cached.items || []).length;
      if (same) return;
      if (this.data.editForm) return;   // 用户正在编辑，别冲掉抽屉（下次进页再对齐）
      this.renderTrip(trip, tripId);
    } catch (e) { /* 后台刷新失败就静默：用户看的是缓存版，下次进页再试 */ }
  },

  // 本地改动同步进全局缓存：load() 优先渲染缓存，不同步会先闪一下旧内容
  syncGlobalTrip(tripId, items) {
    const g = app.globalData.currentTrip;
    if (g && g._id === tripId) {
      app.globalData.currentTrip = Object.assign({}, g, { items });
    }
  },

  // 把一趟行程渲染到页面（缓存首渲染与网络重渲染共用）
  renderTrip(trip, tripId) {
    // 补齐每条行程的稳定 key（否则编辑/删除拿不到标识）
    trip.items = this.withItemKeys(trip.items);
    this.baseDate = this.parseTripStart(trip.startDate);

    // 全行程展开模式：直接按天顺序铺开，不再按单天查看
    if (this.data.viewAll) {
      const dayGroups = this.buildAllDays(trip);
      const s = trip.startDate || '';
      const e = trip.endDate || '';
      if (trip.title) wx.setNavigationBarTitle({ title: trip.title });
      this.setData({
        tripId,
        trip,
        dayGroups,
        totalCount: (trip.items || []).length,
        dayLabel: (s || e) ? `${s || '?'} → ${e || '?'}` : '日期未设置',
        items: [],
      });
      return;
    }

    // 严格按开始时间从早到晚排；没填时间的排最后
    const sorted = (trip.items || [])
      .filter((it) => (it.dayIndex || 0) === this.data.dayIdx)
      .sort((a, b) => {
        const ta = a.startTime || '99:99';
        const tb = b.startTime || '99:99';
        return ta.localeCompare(tb);
      });
    this.rawItems = sorted;

    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const m = trip.startDate ? String(trip.startDate).match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
    const startDate = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
    const cur = new Date(startDate);
    cur.setDate(cur.getDate() + this.data.dayIdx);
    this.dayStartTs = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()).getTime();

    const today = new Date();
    const isToday = cur.getFullYear() === today.getFullYear()
      && cur.getMonth() === today.getMonth()
      && cur.getDate() === today.getDate();

    const dayLabel = `${this.formatYMD(cur)} ${weekdays[cur.getDay()]} · 第${this.data.dayIdx + 1}天`;

    this.setData({ tripId, trip, dayLabel, isToday });
    this.applyTimeFlags();
    this.loadDayTips();
  },

  formatYMD(d) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  // 行程项稳定 key：云端解析出来的 items 既没有 _id 也没有 id，
  // 导致「编辑/删除」定位不到具体条目（id 为 undefined 直接 return）。
  // 这里按「原 _id → 原 id → 天序号+数组下标」生成前端稳定 key，并写回 items，
  // 保证一次加载内 key 唯一、多次刷新 key 不变。
  withItemKeys(items) {
    const used = {};
    return (items || []).map((it, i) => {
      if (!it || typeof it !== 'object') return it;
      let k = it.key || it._id || it.id || `k${Number(it.dayIndex || 0)}_${i}`;
      while (used[k]) k += '_x';
      used[k] = 1;
      if (it.key === k) return it;
      return Object.assign({}, it, { key: k });
    });
  },

  // 统一的条目标识读取（组件内部、编辑、删除共用同一套优先级）
  itemKeyOf(it) {
    return (it && (it.key || it._id || it.id)) || '';
  },

  // 本行程的大地名（"广西 桂林"）：导航/实时定位时给高德消歧，不做展示
  tripRegion() {
    return (this.data.trip && this.data.trip.region) || '';
  },

  onTapNav(e) {
    const { item } = e.currentTarget.dataset;
    // 只填了一头也能导航：优先目的地，其次出发地（从我的位置出发）
    const to = item.endLocation || item.startLocation;
    if (!to) {
      wx.showToast({ title: '缺少目的地', icon: 'none' });
      return;
    }
    mapUtil.openAmapNav({
      from: item.startLocation || '',
      to,
      mode: item.transportType || 'car',
      title: item.startLocation && item.endLocation
        ? `${item.startLocation} → ${item.endLocation}`
        : `导航到 ${to}`,
      endLat: item.endLat,
      endLon: item.endLon,
      // 条目自己的城市最准；没有再退回整条行程的大地名
      region: item.city || this.tripRegion(),
      // 条目城市查不到时（跨城段常这样），用整条行程的大地名再试一次
      fallbackRegion: this.tripRegion(),
    });
  },

  onTapEdit(e) {
    if (this.data.readonly) return;
    // 组件 triggerEvent 的数据在 e.detail
    const item = (e.detail && e.detail.item) || e.currentTarget.dataset.item;
    if (!item) return;
    const key = this.itemKeyOf(item);
    if (!key) {
      wx.showToast({ title: '该行程缺少标识，请下拉刷新后再试', icon: 'none' });
      return;
    }
    this.setData({
      editingId: key,
      editForm: {
        id: key,
        startTime: item.startTime || '',
        endTime: item.endTime || '',
        activity: item.activity || '',
        startLocation: item.startLocation || '',
        endLocation: item.endLocation || '',
        // 中间点编辑态用纯名字数组（坐标在保存时重查）
        waypoints: (Array.isArray(item.waypoints) ? item.waypoints : [])
          .map((w) => (typeof w === 'string' ? w : (w && w.name) || ''))
          .filter((n) => String(n || '').trim()),
        transportType: item.transportType || 'car',
        category: item.category || 'sight',
        note: item.note || '',
      },
    });
    this.applyTimeFlags();   // 重算 items，让被点的那条带上 editing=true
  },

  onEditInput(e) {
    // 组件编辑表单：field 在 e.detail
    const field = (e.detail && e.detail.field) || e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [`editForm.${field}`]: e.detail.value });
  },

  onEditTransport(e) {
    this.setData({ 'editForm.transportType': e.detail.value });
  },

  onEditCategory(e) {
    this.setData({ 'editForm.category': e.detail.value });
  },

  // 中间点（途经地）增删改：{ op: 'add' | 'remove' | 'input', index, value }
  onEditWaypoint(e) {
    const d = (e && e.detail) || {};
    const wps = ((this.data.editForm && this.data.editForm.waypoints) || []).slice();
    if (d.op === 'add') {
      if (wps.length >= 5) {
        wx.showToast({ title: '中间点最多 5 个', icon: 'none' });
        return;
      }
      wps.push('');
    } else if (d.op === 'remove') {
      wps.splice(d.index, 1);
    } else if (d.op === 'input') {
      wps[d.index] = d.value;
    }
    this.setData({ 'editForm.waypoints': wps });
  },

  async onSaveEdit() {
    if (this.data.readonly) return;
    const { editForm, tripId, trip } = this.data;
    if (!editForm.activity) {
      wx.showToast({ title: '请输入行程内容', icon: 'none' });
      return;
    }
    try {
      wx.showLoading({ loading: true, title: '保存中' });
      const old = (trip.items || []).find((it) => this.itemKeyOf(it) === editForm.id) || {};

      // 地点改了 → 重新地理编码：地图导航用的是经纬度，不改会导航到旧地点
      const needStart = !!editForm.startLocation && editForm.startLocation !== (old.startLocation || '');
      const needEnd = !!editForm.endLocation && editForm.endLocation !== (old.endLocation || '');
      let startCoord = null;
      let endCoord = null;
      if (needStart || needEnd) {
        const [a, b] = await Promise.all([
          // 消歧优先用这条自己的城市（生成时逐条记的），没有再退回整条行程的大地名
          needStart ? this.tryGeocode(editForm.startLocation, old.city || this.tripRegion()) : null,
          needEnd ? this.tryGeocode(editForm.endLocation, old.city || this.tripRegion()) : null,
        ]);
        startCoord = a;
        endCoord = b;
      }

      // 中间点：没改过的沿用旧坐标，改过/新增的现场查一次（查不到先存名字，导航时实时再查）
      const oldWps = Array.isArray(old.waypoints) ? old.waypoints : [];
      const oldNames = oldWps.map((w) => (typeof w === 'string' ? w : (w && w.name) || ''));
      const newNames = (editForm.waypoints || [])
        .map((n) => String(n || '').trim())
        .filter(Boolean);
      const wpCoords = await Promise.all(newNames.map((n, i) => {
        const prev = oldWps[i];
        if (oldNames[i] === n && prev && Number(prev.lon) && Number(prev.lat)) {
          return { lon: Number(prev.lon), lat: Number(prev.lat) };
        }
        return this.tryGeocode(n, old.city || this.tripRegion());
      }));
      const waypoints = newNames.map((n, i) => {
        const c = wpCoords[i];
        return c ? { name: n, lon: c.lon, lat: c.lat } : { name: n, lon: '', lat: '' };
      });

      const items = (trip.items || []).map((it) => {
        if (this.itemKeyOf(it) !== editForm.id) return it;
        const next = {
          ...it,
          startTime: editForm.startTime,
          endTime: editForm.endTime,
          activity: editForm.activity,
          startLocation: editForm.startLocation,
          endLocation: editForm.endLocation,
          waypoints,
          transportType: editForm.transportType,
          category: editForm.category,
          note: editForm.note,
        };
        if (needStart) {
          // 查不到就清空旧坐标，导航时会按新地名实时再查一次，不会导到旧地点
          next.startLon = startCoord ? startCoord.lon : '';
          next.startLat = startCoord ? startCoord.lat : '';
        }
        if (needEnd) {
          next.endLon = endCoord ? endCoord.lon : '';
          next.endLat = endCoord ? endCoord.lat : '';
        }
        return next;
      });
      await api.updateItinerary(tripId, { items });
      homeCache.clear();
      this.syncGlobalTrip(tripId, items);
      this.setData({ editingId: '', editForm: null });
      await this.load();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onCancelEdit() {
    this.setData({ editingId: '', editForm: null });
    this.applyTimeFlags();
  },

  // 地名 → 经纬度（失败返回 null，交给导航时的实时查询兜底）
  async tryGeocode(name, region) {
    if (!name) return null;
    try {
      const r = await api.geocode(name, region || this.tripRegion());
      if (!r) return null;
      const lon = r.lon != null ? r.lon : (r.lng != null ? r.lng : r.longitude);
      const lat = r.lat != null ? r.lat : r.latitude;
      return (typeof lon === 'number' && typeof lat === 'number' && !isNaN(lon) && !isNaN(lat))
        ? { lon, lat } : null;
    } catch (e) {
      return null;
    }
  },

  // 交换起终点（编辑抽屉里的 ⇅ 按钮）
  onSwapLocation() {
    const f = this.data.editForm;
    if (!f) return;
    this.setData({
      'editForm.startLocation': f.endLocation || '',
      'editForm.endLocation': f.startLocation || '',
    });
  },

  async onDelete(e) {
    if (this.data.readonly) return;
    const id = (e.detail && e.detail.id) || e.currentTarget.dataset.id;
    if (!id) return;
    // 确认弹层已在 activity-item 组件内完成
    try {
      wx.showLoading({ title: '删除中' });
      const { trip } = this.data;
      const items = (trip.items || []).filter((it) => this.itemKeyOf(it) !== id);
      await api.updateItinerary(this.data.tripId, { items });
      homeCache.clear();
      this.syncGlobalTrip(this.data.tripId, items);
      await this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ============================================================
  // 当天建议与注意事项（suggestions 云函数按天生成并缓存）
  // ============================================================
  async loadDayTips() {
    const { tripId, dayIdx } = this.data;
    if (!tripId) return;
    // 缓存首渲染 + 后台重渲染会连着调两次：同一天只拉一次建议
    const key = tripId + '_' + dayIdx;
    if (this._tipsKey === key) return;
    this._tipsKey = key;
    this.setData({ tipsLoading: true, dayTips: null });
    try {
      const res = await api.getDayTips(tripId, dayIdx);
      const d = (res && res.data) || res || {};
      const tips = {
        tips: (d.tips || []).slice(0, 6),
        notices: (d.notices || []).slice(0, 6),
      };
      if (!tips.tips.length && !tips.notices.length) {
        this.setData({ tipsLoading: false, dayTips: null });
        return;
      }
      this.setData({ tipsLoading: false, dayTips: tips });
    } catch (err) {
      console.warn('[itinerary] 当天建议加载失败:', err && err.message);
      this.setData({ tipsLoading: false, dayTips: null });
    }
  },

  // 重新生成当天建议
  async onRetryTips() {
    const { tripId, dayIdx } = this.data;
    if (!tripId) return;
    this._tipsKey = null;   // 强制重拉（否则会被"同一天只拉一次"的守卫拦下）
    this.setData({ tipsLoading: true });
    try {
      await api.getDayTips(tripId, dayIdx, true); // force = 重新生成
      await this.loadDayTips();
    } catch (err) {
      wx.showToast({ title: err.message || '生成失败', icon: 'none' });
      this.setData({ tipsLoading: false });
    }
  },

  onAddItem() {
    if (this.data.readonly) {
      wx.showToast({ title: '历史行程为只读，无法编辑', icon: 'none' });
      return;
    }
    const { tripId, trip, dayIdx } = this.data;
    const newKey = `new_${Date.now()}`;
    const newItem = {
      key: newKey,
      _id: newKey,
      dayIndex: dayIdx,
      startTime: '09:00',
      endTime: '10:00',
      activity: '',
      startLocation: '',
      endLocation: '',
      transportType: 'car',
      category: 'sight',
      note: '',
      isNew: true,
    };
    wx.showModal({
      title: '新增行程项',
      editable: true,
      placeholderText: '输入行程描述，如：参观象鼻山',
      success: async (res) => {
        if (!res.confirm || !res.content) return;
        newItem.activity = res.content;
        try {
          wx.showLoading({ title: '添加中' });
          const items = [...(trip.items || []), newItem];
          await api.updateItinerary(tripId, { items });
          homeCache.clear();
          this.syncGlobalTrip(tripId, items);
          await this.load();
          wx.showToast({ title: '已添加', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: err.message || '添加失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      },
    });
  },
});