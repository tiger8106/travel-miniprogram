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
    // 编辑/新增抽屉：sheetMode = 'edit' | 'new'；editForm 为 null 时抽屉关闭
    sheetMode: 'edit',
    editingId: null,
    editForm: null,
    delItem: null,        // 待删除的闹钟（删除确认卡）
    typeOptions: TYPE_OPTIONS,
    pendingCount: 0,      // 未来闹钟数（同步到日历入口显示）
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
        loading: false, alarms: [], pendingCount: 0, editForm: null, delItem: null,
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

  // 修改提前提醒分钟数：小程序弹窗提醒 + 写入日历的提前量都跟着变
  onAdvanceChange(e) {
    const idx = Number(e.detail.value);
    const minutes = this.data.advanceOptions[idx];
    if (!minutes) return;
    alarm.setAdvanceMin(minutes);
    this.setData({ advanceIdx: idx, advanceMin: minutes });
    wx.showToast({ title: `已设为提前 ${minutes} 分钟提醒`, icon: 'none' });
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
        alarms: [], pendingCount: 0, editForm: null, delItem: null,
      });
      return;
    }
    if (this.data.needLogin) this.setData({ needLogin: false });
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      this.setData({ loading: false, alarms: [], pendingCount: 0 });
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
        this.setData({ loading: false, alarms: snap.alarms || [], pendingCount: snap.pendingCount || 0 });
      } else {
        this.setData({ loading: true });
      }
    }

    try {
      const list = await api.listAlarms(tripId);
      const items = (list || []).map((a) => {
        const triggerAt = alarm.calcTriggerAt(a.fireAt, a.fireAtStr);
        return {
          ...a,
          triggerAt,
          friendly: triggerAt ? timeUtil.fmtFriendly(triggerAt) : '',
          status: this.computeStatus(triggerAt),
        };
      });
      const now = Date.now();
      // 排序：未来的按时间升序在前，过期的沉到列表底部（内部仍按时间升序）
      items.sort((a, b) => {
        const ta = a.triggerAt || 0;
        const tb = b.triggerAt || 0;
        const aPast = ta < now;
        const bPast = tb < now;
        if (aPast !== bPast) return aPast ? 1 : -1; // 过期的排后面
        return ta - tb;
      });
      const pendingCount = items.filter((a) => a.triggerAt && a.triggerAt > now).length;

      // ② 内容没变就不 setData，避免无谓重绘
      const snap = { tripId, alarms: items, pendingCount };
      const sig = JSON.stringify(snap);
      if (sig !== this._sig) {
        this._sig = sig;
        this.setData({ alarms: items, pendingCount });
        homeCache.writePage(CACHE_KEY, snap);
      }
      this.setData({ loading: false });

      // ③ 时区校准放后台（fireAt/fireAtStr，syncAlarms 会回写云端），不阻塞渲染
      alarm.syncAlarms(items.map((a) => ({
        _id: a._id,
        title: a.title,
        note: a.note,
        fireAt: a.fireAt,
        fireAtStr: a.fireAtStr,
        triggerAt: a.triggerAt,
      })));
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
        fireAtDate: this.toDateStr(item.triggerAt || item.fireAt),
        fireAtTime: this.toTimeStr(item.triggerAt || item.fireAt),
        type: item.type || 'train',
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
      wx.showToast({ title: '请输入闹钟标题', icon: 'none' });
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
      // 保存用户选择的本地墙面时刻，时区重算时以此为准
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
        fireAt: item.triggerAt || Date.now(),
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
    const { alarms, pendingCount } = this.data;
    if (!pendingCount) {
      wx.showToast({ title: '没有未来的闹钟', icon: 'none' });
      return;
    }
    const res = await new Promise((resolve) => {
      wx.showModal({
        title: '同步到系统日历',
        content: `将把 ${pendingCount} 个未来闹钟写入手机系统日历，到点锁屏也会响铃震动（微信关了也有效）。`,
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
