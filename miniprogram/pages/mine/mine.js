// pages/mine/mine.js
const auth = require('../../utils/auth');
const { uploadFile } = require('../../utils/request');

const app = getApp();

Page({
  data: {
    loggedIn: false,
    loggingIn: false,
    profile: {},       // { nickname, avatarUrl }
    systemInfo: null,
    saving: false,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({
      loggedIn: !!auth.getOpenid(),
      profile: auth.getProfile() || {},
      systemInfo: app.globalData.systemInfo,
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
    if (!this.data.loggedIn) return;
    const temp = e.detail && e.detail.avatarUrl;
    if (!temp) return;
    // 先用临时路径立刻预览，再上传云存储换永久地址
    this.setData({ 'profile.avatarUrl': temp });
    this.saveProfile({ avatarTemp: temp });
  },

  onNickBlur(e) {
    if (!this.data.loggedIn) return;
    const nick = (e.detail && e.detail.value ? e.detail.value : '').trim().slice(0, 30);
    const cur = (this.data.profile.nickname || '').trim();
    if (!nick || nick === cur) return;
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
    wx.showModal({
      title: '关于',
      content: '微信旅游小程序 v1.0\n基于微信云开发\n阿稳 🧰 出品',
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
