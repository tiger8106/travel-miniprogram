// pages/mine/mine.js
const auth = require('../../utils/auth');
const { uploadFile } = require('../../utils/request');
const homeCache = require('../../utils/homecache');
const env = require('../../utils/env');
const privacy = require('../../utils/privacy');
const quota = require('../../utils/quota');
const api = require('../../services/api');
const config = require('../../config');

/**
 * api 层有两种封装，返回形态不一样：
 *   callFn         → 成功时直接给业务体（如 {isAdmin, me, items}）
 *   callFnKeepCode → 给 {code, data, msg}
 * 这里两种都吃掉，统一返回业务体。
 * ⚠️ 踩过的坑：直接写 r.data 时，走 callFn 的接口恒为 undefined，
 *    管理员菜单就永远显示不出来（后台列表/配置也一样全空）。
 */
function bodyOf(r) {
  if (!r || typeof r !== "object") return {};
  if (r.data && typeof r.data === 'object') return r.data;
  return r;
}

const app = getApp();

Page({
  data: {
    loggedIn: false,
    loggingIn: false,
    profile: {},       // { nickname, avatarUrl }
    saving: false,
    showPrivacy: false, // 隐私保护授权弹窗（点头像/填昵称被微信拦截时触发）
    quotaText: '查看剩余次数与套餐',
    // 管理后台入口：由服务端判定身份后才显示（前端隐藏不是安全边界，云端会再验一次）
    isAdmin: false,
  },

  onShow() {
    // 注册隐私授权处理器：chooseAvatar / nickname 是隐私接口，
    // 未同意隐私指引时微信会静默拦截（点击无反应），由本页弹窗让用户确认
    app._privacyHandler = () => this.setData({ showPrivacy: true });
    // 隐私诊断：后台指引审核生效情况打日志，进页需要授权就先拿到授权，不等点击被拦
    this.checkPrivacy();
    // 保存中不刷新，避免头像上传时把预览覆盖回旧值
    if (!this.data.saving) this.refresh();
  },

  // 后台《用户隐私保护指引》改完要等微信审核通过才生效（不是保存即生效），
  // 未生效时 chooseAvatar / nickname 照样报 "api scope is not declared"。
  // 这里主动走一次授权流程：privacy.ensure 会先产生 pending 再弹窗，
  // 用户点「同意」按钮才真正生效（自己直接 setData 弹窗时按钮点了没反应的坑踩过）。
  async checkPrivacy() {
    await privacy.diagnose('mine');
    const ok = await privacy.ensure(() => this.setData({ showPrivacy: true }));
    this.setData({ showPrivacy: false });
    if (!ok) console.log('[mine] 用户未同意隐私指引，头像/昵称会被微信拦截');
  },

  onHide() {
    if (app._privacyHandler) app._privacyHandler = null;
  },

  onUnload() {
    if (app._privacyHandler) app._privacyHandler = null;
  },

  onClosePrivacy() {
    this.setData({ showPrivacy: false });
  },

  refresh() {
    const profile = auth.getProfile() || {};
    // 记住云端已保存的值：昵称 bindinput 实时写入 data 后，
    // blur 时要用「云端值」而不是 data 判断是否有改动，否则永远存不进去
    this._saved = { nickname: profile.nickname || '', avatarUrl: profile.avatarUrl || '' };
    this.setData({
      loggedIn: !!auth.getOpenid(),
      profile,
    });
    this.loadQuota();
    this.loadAdminRole();
  },

  /**
   * 查一次身份：管理员才显示「管理后台」菜单。
   * 失败/没部署都静默 —— 这只是一份额外的入口，不该因为它报什么错吓到用户。
   */
  async loadAdminRole() {
    this.setData({ isAdmin: false });
    if (!auth.isLoggedIn() || !api.adminWhoami) return;
    try {
      const r = await api.adminWhoami();
      const d = bodyOf(r);
      this.setData({ isAdmin: !!d.isAdmin });
    } catch (e) {
      console.warn('[mine] 管理员身份不可用（不影响使用）:', (e && e.message) || e);
    }
  },

  onTapAdmin() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  // ---------- 登录 / 退出 ----------

  onLogin() {
    if (this.data.loggingIn || this.data.loggedIn) return;
    this.setData({ loggingIn: true });
    auth.silentLogin(true).then((openid) => {
      app.globalData.openid = openid;
      this.setData({ loggingIn: false });
      this.refresh();
      // 广播：其它页面（首页 / 行程 / 闹钟）立刻解锁，不用各自再点一次登录
      auth.notifyLogin();
      wx.showToast({ title: '登录成功', icon: 'success' });
    }).catch((err) => {
      this.setData({ loggingIn: false });
      console.error('[mine] 登录失败', err);
      wx.showToast({ title: err.message || '登录失败，请重试', icon: 'none' });
    });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后云端数据仍然保留，重新登录即可恢复。',
      confirmText: '退出',
      confirmColor: '#e74c3c',
      success: (res) => {
        if (!res.confirm) return;
        auth.logout();
        // 清掉本地所有页面快照，退出后立即看不到任何行程信息
        homeCache.clearAll();
        app.globalData.openid = null;
        app.globalData.currentTripId = null;
        app.globalData.currentTrip = null;
        this.refresh();
        wx.showToast({ title: '已退出', icon: 'none' });
      },
    });
  },

  // ---------- 资料：点头像换头像 / 点昵称改昵称，改完自动保存 ----------

  onChooseAvatar(e) {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    const temp = e.detail && e.detail.avatarUrl;
    if (!temp) {
      wx.showToast({ title: '未获取到头像，请重试', icon: 'none' });
      return;
    }
    // 先用临时路径立刻预览，再上传云存储换永久地址
    this.setData({ 'profile.avatarUrl': temp });
    this.saveProfile({ avatarTemp: temp });
  },

  onNickInput(e) {
    // 实时同步输入值进 data，防止部分机型 blur 时拿不到最新值
    this.setData({ 'profile.nickname': e.detail.value });
  },

  onNickBlur(e) {
    if (!this.data.loggedIn) return;
    const nick = (e.detail && e.detail.value ? e.detail.value : '').trim().slice(0, 30);
    const saved = (this._saved && this._saved.nickname) || '';
    if (!nick || nick === saved) return;
    this.setData({ 'profile.nickname': nick });
    this.saveProfile({ nickname: nick });
  },

  async saveProfile(patch) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      // chooseAvatar 返回的是临时路径 → 传云存储换成永久 fileID
      if (patch.avatarTemp) {
        const openid = auth.getOpenid() || 'user';
        const ext = (patch.avatarTemp.match(/\.(\w+)$/) || [, 'png'])[1];
        const cloudPath = `avatars/${openid}-${Date.now()}.${ext}`;
        patch.avatarUrl = await uploadFile(cloudPath, patch.avatarTemp);
        delete patch.avatarTemp;
      }
      const profile = await auth.updateProfile(patch);
      this.setData({ profile });
      this._saved = { nickname: profile.nickname || '', avatarUrl: profile.avatarUrl || '' };
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.error('[mine] 保存资料失败', err);
      // 失败时回读本地缓存，避免界面与云端不一致
      this.setData({ profile: auth.getProfile() || {} });
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  // ---------- 其他 ----------

  // AI 制定新攻略：填需求 → 生成完整行程（含抢票闹钟）
  onTapPlanner() {
    wx.navigateTo({ url: '/pages/planner/planner' });
  },

  onTapMyTrips() {
    wx.navigateTo({ url: '/pages/mytrips/mytrips' });
  },

  onTapUpload() {
    wx.navigateTo({ url: '/pages/upload/upload' });
  },

  onTapPay() {
    wx.navigateTo({ url: '/pages/pay/pay' });
  },

  // 额度概览：只做展示，失败也不影响本页其它功能
  async loadQuota() {
    if (!auth.isLoggedIn()) {
      this.setData({ quotaText: '查看剩余次数与套餐' });
      return;
    }
    const info = await quota.info();
    if (!info) return;
    const txt = info.vip
      ? `月卡会员 · 本月还剩 ${info.vipLeft} 次`
      : `剩余 ${info.total} 次 · 今日已生成 ${info.dayGen || 0} 次`;
    this.setData({ quotaText: txt });
  },

  onTapAbout() {
    // 连点 5 次「关于」→ 开启开发者功能；再连点 5 次 → 关闭（体验版真机自查用）
    const now = Date.now();
    if (!this._aboutTapTs || now - this._aboutTapTs > 1500) this._aboutTaps = 0;
    this._aboutTapTs = now;
    this._aboutTaps = (this._aboutTaps || 0) + 1;
    if (this._aboutTaps >= 5) {
      this._aboutTaps = 0;
      if (env.isDevToolsUnlocked()) {
        env.lockDevTools();
        wx.showToast({ title: '开发者功能已关闭', icon: 'none' });
      } else {
        const hours = env.unlockDevTools();
        wx.showToast({ title: `开发者功能已开启 ${hours} 小时`, icon: 'none' });
      }
      return;
    }

    wx.showModal({
      title: '关于',
      content: `${config.APP_NAME} v${config.APP_VERSION}\n${config.APP_BRAND}\n\n运行环境：${env.envLabel()}`,
      showCancel: false,
    });
  },
});
