// pages/mine/mine.js
const auth = require('../../utils/auth');
const { uploadFile } = require('../../utils/request');
const homeCache = require('../../utils/homecache');
const env = require('../../utils/env');

const app = getApp();

Page({
  data: {
    loggedIn: false,
    loggingIn: false,
    profile: {},       // { nickname, avatarUrl }
    saving: false,
    showPrivacy: false, // 隐私保护授权弹窗（点头像/填昵称被微信拦截时触发）
  },

  onShow() {
    // 注册隐私授权处理器：chooseAvatar / nickname 是隐私接口，
    // 未同意隐私指引时微信会静默拦截（点击无反应），由本页弹窗让用户确认
    app._privacyHandler = () => this.setData({ showPrivacy: true });
    // 隐私诊断：后台指引审核生效情况打日志，进页需要授权就直接弹，不等点击被拦
    this.checkPrivacy();
    // 保存中不刷新，避免头像上传时把预览覆盖回旧值
    if (!this.data.saving) this.refresh();
  },

  // 后台《用户隐私保护指引》改完要等微信审核通过才生效（不是保存即生效），
  // 未生效时 chooseAvatar / nickname 照样报 "api scope is not declared"。
  // 这里用官方诊断接口看当前状态，需要授权就主动弹窗，用户先同意再点头像就不会被拦
  checkPrivacy() {
    if (!wx.getPrivacySetting) return; // 低版本基础库没有此接口，忽略
    wx.getPrivacySetting({
      success: (res) => {
        console.log('[隐私诊断] 需要授权:', res.needAuthorization,
          '| 指引名称:', res.privacyContractName || '（空 = 后台指引还没生效）');
        if (res.needAuthorization && !this.data.showPrivacy) {
          this.setData({ showPrivacy: true });
        }
      },
      fail: (err) => console.warn('[隐私诊断] 获取隐私设置失败', err),
    });
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

  onTapMyTrips() {
    wx.navigateTo({ url: '/pages/mytrips/mytrips' });
  },

  onTapUpload() {
    wx.navigateTo({ url: '/pages/upload/upload' });
  },

  onTapAbout() {
    // 连点 5 次「关于」→ 临时解锁开发者功能（体验版真机自查用，24 小时后自动失效）
    const now = Date.now();
    if (!this._aboutTapTs || now - this._aboutTapTs > 1500) this._aboutTaps = 0;
    this._aboutTapTs = now;
    this._aboutTaps = (this._aboutTaps || 0) + 1;
    if (this._aboutTaps >= 5) {
      this._aboutTaps = 0;
      const hours = env.unlockDevTools();
      wx.showToast({ title: `开发者功能已开启 ${hours} 小时`, icon: 'none' });
      return;
    }

    wx.showModal({
      title: '关于',
      content: `微信旅游小程序 v1.0\n基于微信云开发\n阿稳 🧰 出品\n\n运行环境：${env.envLabel()}`,
      showCancel: false,
    });
  },

  onTapFeedback() {
    wx.showModal({
      title: '反馈',
      content: '有问题或建议？请在「我的行程」页面截图反馈。',
      showCancel: false,
    });
  },
});
