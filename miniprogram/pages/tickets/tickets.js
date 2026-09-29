// pages/tickets/tickets.js
const api = require('../../services/api');
const alarm = require('../../utils/alarm');
const timeUtil = require('../../utils/time');
const config = require('../../config');
const env = require('../../utils/env');
const homeCache = require('../../utils/homecache');
const auth = require('../../utils/auth');

const app = getApp();

// 闹钟列表快照缓存 key
const CACHE_KEY = 'tickets';

// 分类板块顺序 = 「正在进行」模块的展示优先级：车票 > 门票 > 酒店 > 其他
// （同时到点的事项太多时，先保证各类车票提醒被看见）
const GROUP_DEFS = [
  { key: 'traffic', label: '车票提醒', icon: '🚄', types: ['train', 'plane', 'bus'] },
  { key: 'sight', label: '门票预约', icon: '🎫', types: ['ticket'] },
  { key: 'hotel', label: '酒店住宿', icon: '🏨', types: ['hotel'] },
  { key: 'other', label: '其他事项', icon: '⏰', types: ['other'] },
];
const NOW_LIMIT = 4;               // 「正在进行/即将进行」最多展示条数
const SOON_WINDOW = 7 * 86400000;   // 7 天内算"即将进行"

function groupRank(type) {
  const i = GROUP_DEFS.findIndex((d) => d.types.indexOf(type) >= 0);
  return i < 0 ? GROUP_DEFS.length : i;   // 未知类型排最后
}

// 闹钟类型选项（编辑抽屉里的 chips）
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
    loading: true,
    alarms: [],
    groups: [],        // 按板块分类的待办（车票/门票/酒店/其他）
    nowAlarms: [],     // 正在进行 / 即将进行
    nowExtra: 0,       // 顶部模块装不下、被折叠的条数
    // 编辑/新增抽屉：sheetMode = 'edit' | 'new'；editForm 为 null 时抽屉关闭
    sheetMode: 'edit',
    editingId: null,
    editForm: null,
    delItem: null,        // 待删除的闹钟（删除确认卡）
    typeOptions: TYPE_OPTIONS,
    pendingCount: 0,      // 所有未完成事项数
    futureCount: 0,       // 尚未到办理时间的事项数（同步到日历入口显示）
    completedCount: 0,    // 已完成但仍保留在分类清单中的事项数
    advanceOptions: [1, 2, 3, 5, 10, 15, 30, 60],  // 提前提醒分钟数可选项
    advanceOptionsLabel: ['1 分钟', '2 分钟', '3 分钟', '5 分钟', '10 分钟', '15 分钟', '30 分钟', '60 分钟'],
    advanceIdx: 3,
    devMode: false,       // 开发者功能（推送自检 / 闹钟测试）是否可见，由 utils/env 决定
    advanceMin: 5,
    showPrivacy: false,   // 隐私保护授权弹窗（写入系统日历前由微信触发）
  },

  // 遮罩层事件穿透拦截（catchtap / catchtouchmove 用）
  noop() {},

  onLoad() {
    // 订阅全局登录态：一处登录全站解锁
    this._offAuth = auth.watch(this, {
      onLogin: () => this.load(),
      onLogout: () => this.setData({
        loading: false, alarms: [], pendingCount: 0, futureCount: 0, completedCount: 0, editForm: null, delItem: null,
        groups: [], nowAlarms: [], nowExtra: 0,
      }),
    });
  },

  onUnload() {
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
    this.unbindPrivacy();
  },

  onHide() {
    // 离开本页就交出授权处理权，避免别的页面触发时弹到看不见的地方
    this.unbindPrivacy();
  },

  // 注册隐私授权处理器：微信拦截隐私接口（写系统日历）时回调它，由当前可见页面弹窗确认
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

  onShow() {
    this.bindPrivacy();
    // 恢复用户设置的提前提醒分钟数
    this.setData({
      advanceMin: alarm.getAdvanceMin(),
      advanceIdx: Math.max(0, this.data.advanceOptions.indexOf(alarm.getAdvanceMin())),
      // 正式版自动隐藏调试入口（受 config.js 的 SHOW_DEV_TOOLS 控制）
      devMode: env.showDevTools(),
    });
    this.load();
  },

  // 修改提前提醒分钟数：本地轮询、系统日历和云端订阅消息统一使用这个值
  async onAdvanceChange(e) {
    const idx = Number(e.detail.value);
    const minutes = this.data.advanceOptions[idx];
    if (!minutes) return;
    const tripId = app.globalData.currentTripId;
    alarm.setAdvanceMin(minutes);
    this.setData({ advanceIdx: idx, advanceMin: minutes });
    if (!tripId) {
      wx.showToast({ title: `已设为提前 ${minutes} 分钟提醒`, icon: 'none' });
      return;
    }
    try {
      await api.setAlarmAdvance(tripId, minutes);
      this._advanceSyncKey = `${tripId}:${minutes}`;
      this._sig = '';
      await this.load();
      wx.showToast({ title: `已设为提前 ${minutes} 分钟提醒`, icon: 'none' });
    } catch (err) {
      wx.showToast({ title: err.message || '提醒设置保存失败', icon: 'none' });
    }
  },

  // 登录成功后由门禁组件回调（正常情况下登录广播已刷新过，这里只兜底）
  onLoginSuccess() {
    if (!this.data.needLogin) return;
    this.setData({ needLogin: false });
    this.load();
  },

  async load() {
    // 未登录 → 先自动静默登录一次；仍然失败才显示登录门禁卡
    const ok = await auth.requireLogin();
    if (!ok) {
      this.setData({
        loading: false, needLogin: true,
        alarms: [], pendingCount: 0, futureCount: 0, completedCount: 0, editForm: null, delItem: null,
        groups: [], nowAlarms: [], nowExtra: 0,
      });
      return;
    }
    if (this.data.needLogin) this.setData({ needLogin: false });
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      this.setData({
        loading: false, alarms: [], groups: [], nowAlarms: [], nowExtra: 0,
        pendingCount: 0, futureCount: 0, completedCount: 0,
      });
      return;
    }

    // 换了行程 → 旧快照作废
    if (this._tripId !== tripId) {
      this._tripId = tripId;
      this._sig = '';
    }

    // ① 先用本地快照秒开，有缓存就不转圈
    if (!this._sig) {
      const snap = homeCache.readPage(CACHE_KEY);
      if (snap && snap.tripId === tripId) {
        this._sig = JSON.stringify(snap);
        this.setData({ loading: false, alarms: snap.alarms || [], pendingCount: snap.pendingCount || 0,
          futureCount: snap.futureCount || 0, completedCount: snap.completedCount || 0 });
      } else {
        this.setData({ loading: true });
      }
    }

    try {
      const list = await api.listAlarms(tripId);
      const preferredLead = alarm.getAdvanceMin();
      const needAdvanceSync = (list || []).some((a) =>
        Number(a.leadMinutes || 5) !== preferredLead);
      if (needAdvanceSync && this._advanceSyncKey !== `${tripId}:${preferredLead}`) {
        this._advanceSyncKey = `${tripId}:${preferredLead}`;
        api.setAlarmAdvance(tripId, preferredLead).catch(() => {
          this._advanceSyncKey = '';
        });
      }
      const items = (list || []).map((a) => {
        const actionAt = alarm.actionAtOf(a);
        const leadMinutes = preferredLead;
        const remindAt = actionAt ? actionAt - leadMinutes * 60 * 1000 : null;
        const completed = a.completed === true || a.status === 'completed';
        return {
          ...a,
          actionAt,
          remindAt,
          triggerAt: remindAt, // 兼容旧组件，新的展示逻辑使用 actionAt/remindAt
          leadMinutes,
          completed,
          friendly: actionAt ? timeUtil.fmtFriendly(actionAt) : '',
          actionFriendly: actionAt ? timeUtil.fmtFriendly(actionAt) : '',
          remindFriendly: remindAt ? timeUtil.fmtFriendly(remindAt) : '',
          displayInfo: alarm.alarmKeyInfoOf(a),
          status: this.computeStatus(remindAt, completed),
        };
      });
      const now = Date.now();
      // 未完成事项在前，已完成事项沉底；各自按提醒时间排序。
      items.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        const ta = a.remindAt || a.actionAt || 0;
        const tb = b.remindAt || b.actionAt || 0;
        return ta - tb;
      });
      const pendingCount = items.filter((a) => !a.completed).length;
      const futureCount = items.filter((a) => !a.completed && a.actionAt && a.actionAt > now).length;
      const completedCount = items.filter((a) => a.completed).length;
      const views = this.buildViews(items);

      // ② 内容没变就不 setData，避免无谓重绘（视图派生数据一起比，避免状态过期）
      const snap = { tripId, alarms: items, pendingCount, futureCount, completedCount };
      const sig = JSON.stringify(snap);
      if (sig !== this._sig) {
        this._sig = sig;
        this.setData(Object.assign({ alarms: items, pendingCount, futureCount, completedCount }, views));
        homeCache.writePage(CACHE_KEY, snap);
      } else {
        // 数据没变，但"正在进行/即将进行"是按当前时间算的，仍要刷新一次
        this.setData(views);
      }
      this.setData({ loading: false });

      // ③ 时区与提醒时间校准放后台，不阻塞渲染
      alarm.syncAlarms(items);
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  // 派生视图：① 顶部「正在进行/即将进行」 ② 分类折叠卡（点击进分类详情页）
  // 分类 = 车票（火车/飞机/汽车）、门票、酒店、其他，类内按时间先后排
  buildViews(items) {
    const now = Date.now();

    // 分类只出摘要卡：待办数/已完成数 + 下一条最近提醒，全量列表在分类页
    const groups = GROUP_DEFS.map((def) => {
      const list = items.filter((a) => def.types.indexOf(a.type || 'other') >= 0);
      const upcoming = list
        .filter((a) => !a.completed && (a.remindAt || a.actionAt))
        .sort((a, b) => (a.remindAt || a.actionAt) - (b.remindAt || b.actionAt))[0];
      return {
        key: def.key,
        label: def.label,
        icon: def.icon,
        count: list.length,
        pending: list.filter((a) => !a.completed).length,
        completed: list.filter((a) => a.completed).length,
        nextTitle: def.key === 'hotel' && upcoming ? '请在此分类逐项确认住宿预订' : (upcoming ? upcoming.title : ''),
        nextTime: def.key === 'hotel' || !upcoming ? '' : `提醒 ${upcoming.remindFriendly}`,
      };
    }).filter((g) => g.count);

    // 正在进行：提醒时间已到但事项还没完成（即使跨天也保留，避免漏办）
    // 即将进行：未来 7 天内需要办理的事项
    const cand = items.filter((a) => a.type !== 'hotel'
      && !a.completed && (a.remindAt || a.actionAt) && (a.remindAt || a.actionAt) <= now + SOON_WINDOW);
    // 先按提醒时间，再按板块优先级；逾期事项会优先显示。
    cand.sort((a, b) => ((a.remindAt || a.actionAt) - (b.remindAt || b.actionAt))
      || (groupRank(a.type) - groupRank(b.type)));

    const nowAlarms = cand.slice(0, NOW_LIMIT).map((a) => {
      const remindAt = a.remindAt || a.actionAt;
      const ongoing = remindAt <= now;
      const gap = remindAt - now;
      let statusText = '待办';
      if (ongoing) statusText = '进行中';
      else if (gap < 3600000) statusText = `${Math.max(1, Math.round(gap / 60000))} 分钟后`;
      else if (gap < 86400000) statusText = `${Math.round(gap / 3600000)} 小时后`;
      else statusText = `${Math.round(gap / 86400000)} 天后`;
      return {
        ...a,
        ongoing,
        statusText,
        typeLabel: (GROUP_DEFS[groupRank(a.type)] || GROUP_DEFS[GROUP_DEFS.length - 1]).label,
      };
    });

    return {
      groups,
      nowAlarms,
      nowExtra: Math.max(0, cand.length - nowAlarms.length),
      hotelHint: items.some((a) => a.type === 'hotel' && !a.completed),
    };
  },

  // 点顶部模块里的某条 → 直接打开编辑抽屉
  onTapNowAlarm(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.nowAlarms[idx];
    if (item) this.onTapEdit({ detail: { item } });
  },

  async onToggleComplete(e) {
    const detailItem = e.detail && e.detail.item;
    const ds = e.currentTarget.dataset || {};
    const item = detailItem || ds.item
      || (ds.idx != null ? this.data.nowAlarms[Number(ds.idx)] : null);
    if (!item || !item._id || this._completeBusy) return;
    this._completeBusy = true;
    const completed = !item.completed;
    try {
      await api.updateAlarm(item._id, { completed });
      this._sig = '';
      await this.load();
      wx.showToast({ title: completed ? '已完成，已移出待办' : '已恢复待办', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: err.message || '状态保存失败', icon: 'none' });
    } finally {
      this._completeBusy = false;
    }
  },

  // 点分类折叠卡 → 跳到分类详情页看该类全部闹钟
  onTapGroup(e) {
    const key = e.currentTarget.dataset.key;
    const def = GROUP_DEFS.find((d) => d.key === key);
    if (!def) return;
    wx.navigateTo({
      url: `/pages/alarm-group/alarm-group?key=${key}&label=${encodeURIComponent(def.label)}&icon=${encodeURIComponent(def.icon)}`,
    });
  },

  computeStatus(remindAt, completed) {
    if (completed) return 'completed';
    if (!remindAt) return 'unknown';
    const now = Date.now();
    if (remindAt < now) return 'past';
    if (remindAt - now < 86400000) return 'soon';
    return 'future';
  },

  // ============================================================
  // 编辑 / 新增（底部抽屉）
  // ============================================================
  onTapEdit(e) {
    // 组件 triggerEvent 的数据在 e.detail
    const item = (e.detail && e.detail.item) || e.currentTarget.dataset.item;
    if (!item) return;
    this.setData({
      sheetMode: 'edit',
      editingId: item._id,
      editForm: {
        title: item.title || '',
        note: item.note || '',
        fireAtDate: this.toDateStr(item.actionAt || item.fireAt),
        fireAtTime: this.toTimeStr(item.actionAt || item.fireAt),
        type: item.type || 'train',
        bookingInfo: item.bookingInfo || '',
      },
    });
  },

  onAdd() {
    const base = Date.now() + 3600000;
    this.setData({
      sheetMode: 'new',
      editingId: 'new',
      editForm: {
        title: '',
        note: '',
        fireAtDate: this.toDateStr(base),
        fireAtTime: this.toTimeStr(base),
      type: 'train',
      bookingInfo: '',
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

  // iOS 的 new Date("2026-09-30 15:00:00") 返回 Invalid Date，必须用斜杠格式
  parseDateTime(dateStr, timeStr) {
    const d = new Date(`${String(dateStr).replace(/-/g, '/')} ${timeStr}:00`);
    return isNaN(d.getTime()) ? null : d.getTime();
  },

  // 抽屉底部统一保存按钮
  onSheetSave() {
    if (this.data.sheetMode === 'new') this.onConfirmAdd();
    else this.onSaveEdit();
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
      leadMinutes: this.data.advanceMin,
      // 保存用户选择的本地墙面时刻，时区重算时以此为准
      fireAtStr: `${editForm.fireAtDate} ${editForm.fireAtTime}`,
      type: editForm.type,
      bookingInfo: String(editForm.bookingInfo || '').slice(0, 160),
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
      this._sig = ''; // 数据已变，强制刷新渲染
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
      // 只保存新增的那一条（之前会把整个列表重复插入，导致闹钟翻倍）
      await api.saveAlarms(tripId, [data]);
      this.setData({ editingId: null, editForm: null });
      this._sig = ''; // 数据已变，强制刷新渲染
      await this.load();
      wx.showToast({ title: '已添加', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '添加失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onCancelEdit() {
    this.setData({ editingId: null, editForm: null });
  },

  // ============================================================
  // 删除（自定义确认卡）
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
      this._sig = ''; // 数据已变，强制刷新渲染
      await this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '删除失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ============================================================
  // 测试闹钟：震动 + 弹窗 + 微信「服务通知」订阅消息推送
  // 诊断模式：每一步的结果都记录在 trace 里，任何出口都必然弹窗展示，
  // 避免"点了没反应"的黑盒情况
  // ============================================================
  async onTapTest(e) {
    const trace = [];
    const step = (name, val) => {
      trace.push(`${name}：${val}`);
      console.log('[推送测试]', name, val);
    };
    const showTrace = (title, copyable) => {
      const text = trace.join('\n');
      wx.showModal({
        title,
        content: text,
        confirmText: '知道了',
        cancelText: copyable ? '复制' : '知道了',
        showCancel: !!copyable,
        success: (r) => { if (r.cancel && copyable) wx.setClipboardData({ data: text }); },
      });
    };

    try {
      // 组件 triggerEvent 的数据在 e.detail
      const item = (e.detail && e.detail.item) || e.currentTarget.dataset.item;
      if (!item) {
        wx.showModal({ title: '测试', content: '❌ 没拿到闹钟数据（按钮事件没触发成功）', showCancel: false });
        return;
      }
      step('闹钟', item.title || '(无标题)');

      // 1. 震动（小程序前台时）
      if (wx.vibrateLong) {
        wx.vibrateLong({ type: 'heavy' });
        setTimeout(() => wx.vibrateLong({ type: 'heavy' }), 600);
        setTimeout(() => wx.vibrateLong({ type: 'heavy' }), 1200);
      }

      // 2. 微信订阅消息推送（需要模板 ID + 用户授权）
      const tmplId = config.SUBSCRIBE_TEMPLATE_ID;
      step('模板ID', tmplId ? '已配置 …' + tmplId.slice(-6) : '❌ 未配置');
      if (!tmplId) {
        showTrace('⏰ 本地提醒已触发', false);
        return;
      }

      step('订阅授权', '弹出中…');
      const accepted = await alarm.requestSubscribe(tmplId);
      step('授权结果', accepted);
      if (accepted !== 'accept') {
        showTrace('⚠️ 未获得订阅授权', true);
        return;
      }

      // 3. 调云函数推送
      step('调用云函数 sendAlarm', '发送中…');
      const t0 = Date.now();
      const res = await api.sendTestAlarm({
        title: item.title || '行程提醒',
        note: item.note || '点击查看详情',
        fireAt: item.actionAt || item.fireAt || Date.now(),
        leadMinutes: item.leadMinutes || this.data.advanceMin,
      });
      step('云函数耗时', (Date.now() - t0) + 'ms');
      const d = (res && res.data) || res || {};
      step('云函数返回', JSON.stringify(d));
      if (!d.deployTag) {
        showTrace('⚠️ 云函数是旧版本', true);
        return;
      }
      showTrace('✅ 微信已受理，请查收', false);
      wx.showToast({ title: '已发送，去服务通知看', icon: 'none', duration: 2500 });
    } catch (err) {
      step('异常', (err && (err.errMsg || err.message)) || String(err));
      showTrace('❌ 推送失败', true);
    }
  },

  // 订阅消息自检：云函数版本 / 模板是否生效 / 字段布局 / 接收方 openid
  async onSelfCheck() {
    try {
      wx.showLoading({ title: '体检中' });
      const res = await api.getAlarmStatus();
      wx.hideLoading();
      const d = (res && res.data) || res || {};
      const lines = [
        `运行环境：${env.envLabel()}（调试入口${env.showDevTools() ? '已开启' : '已隐藏'}）`,
        `云函数版本：${d.deployTag || '❌ 旧版本（请重新部署 sendAlarm）'}`,
        `模板 ID：${d.hasTemplateId ? '已配置 …' + (d.templateIdTail || '') : '❌ 未配置'}`,
        `模板状态：${d.tmplState || '-'}`,
        `字段布局：${d.layout || '-'}`,
        `接收方 openid …${d.openidTail || '????'}`,
      ];
      const text = lines.join('\n');
      wx.showModal({
        title: '🩺 推送自检',
        content: text,
        confirmText: '知道了',
        cancelText: '复制',
        success: (r) => { if (r.cancel) wx.setClipboardData({ data: text }); },
      });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({
        title: '体检失败',
        content: (err && err.message) || '未知错误',
        showCancel: false,
      });
    }
  },

  // 单个闹钟 → 系统日历
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

  // 一键同步所有未来闹钟 → 系统日历
  async onSyncAllToCalendar() {
    const { alarms, futureCount } = this.data;
    if (!futureCount) {
      wx.showToast({ title: '没有未来的事项', icon: 'none' });
      return;
    }
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '同步到系统日历',
        content: `将把 ${futureCount} 个未来事项写入手机系统日历，到点锁屏也会响铃震动（微信关了也有效）。`,
        confirmText: '开始同步',
        success: resolve,
      });
    });
    if (!res.confirm) return;
    try {
      wx.showLoading({ title: '同步中…' });
      const { ok, total, cancelled } = await alarm.addAllToCalendar(alarms);
      wx.hideLoading();
      // 全部被用户取消 —— 静默收工，不弹任何失败提示
      if (!ok && cancelled) return;
      const cancelPart = cancelled ? `，${cancelled} 个已取消` : '';
      wx.showModal({
        title: '同步完成',
        content: `成功 ${ok}/${total} 个${cancelPart}。可以在手机日历 App 里查看，将提前 ${this.data.advanceMin} 分钟提醒。`,
        showCancel: false,
      });
    } catch (err) {
      wx.hideLoading();
      this.handleCalendarError(err);
    }
  },

  handleCalendarError(err) {
    // 用户主动点了取消 —— 不算失败，不提示
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
