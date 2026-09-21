// pages/mine/mine.js
const auth = require('../../utils/auth');

const app = getApp();

Page({
  data: {
    openid: '',
    systemInfo: null,
  },

  onShow() {
    const openid = auth.getOpenid() || '';
    this.setData({
      openid,
      openidShort: openid ? openid.slice(0, 8) + '...' : '',
      systemInfo: app.globalData.systemInfo,
    });
  },

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
