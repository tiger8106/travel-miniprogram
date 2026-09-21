// pages/mine/mine.js
const auth = require('../../utils/auth');
const { uploadFile } = require('../../utils/request');

const app = getApp();

Page({
  data: {
    loggedIn: false,
    loggingIn: false,
    editing: false,
    profile: {},       // { nickname, avatarUrl }
    openid: '',
    openidShort: '',
    systemInfo: null,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const openid = auth.getOpenid() || '';
    this.setData({
      loggedIn: !!openid,
      profile: auth.getProfile() || {},
      openid,
      openidShort: openid ? openid.slice(0, 8) + '...' : '',
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
        this.setData({ editing: false });
        this.refresh();
        wx.showToast({ title: '已退出', icon: 'none' });
      },
    });
  },

  // ---------- 编辑资料 ----------

  onEditProfile() {
    if (!this.data.loggedIn) {
      this.onLogin();
      return;
    }
    this.setData({ editing: !this.data.editing });
  },

  onChooseAvatar(e) {
    const avatarUrl = e.detail && e.detail.avatarUrl;
    if (!avatarUrl) return;
    // 微信返回的是临时文件路径，先存本地展示，保存时上传云存储
    this._pendingAvatar = avatarUrl;
    this.setData({ 'profile.avatarUrl': avatarUrl });
  },

  onNickInput(e) {
    this._pendingNickname = e.detail.value;
  },

  async onSaveProfile() {
    const patch = {};
    if (this._pendingNickname !== undefined) patch.nickname = this._pendingNickname;
    if (this._pendingAvatar) patch.avatarUrl = this._pendingAvatar;
    if (!Object.keys(patch).length) {
      this.setData({ editing: false });
      return;
    }
    wx.showLoading({ title: '保存中…' });
    try {
      // chooseAvatar 返回的是临时路径，先传云存储换成永久 fileID
      if (this._pendingAvatar && !/^cloud:|^https?:/.test(this._pendingAvatar)) {
        const openid = auth.getOpenid() || 'user';
        const ext = (this._pendingAvatar.match(/\.(\w+)$/) || [,'png'])[1];
        const cloudPath = `avatars/${openid}-${Date.now()}.${ext}`;
        patch.avatarUrl = await uploadFile(cloudPath, this._pendingAvatar);
      }
      const profile = await auth.updateProfile(patch);
      this._pendingAvatar = null;
      this._pendingNickname = undefined;
      this.setData({ profile, editing: false });
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      console.error('[mine] 保存资料失败', err);
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    }
  },

  // ---------- 其他 ----------

  onCopyOpenid() {
    wx.setClipboardData({
      data: this.data.openid,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

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
