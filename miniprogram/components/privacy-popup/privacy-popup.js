// components/privacy-popup/privacy-popup.js
// 用户隐私保护授权弹窗：调用隐私接口（选文件）前由微信触发，必须用户点「同意」才放行
const app = getApp();

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    show: { type: Boolean, value: false },
    // 功能名（用于文案「在使用 X 前…」），各页面按自己的场景传
    feature: { type: String, value: '该功能' },
    // 说明文字：写清楚「读/写什么、不读什么」
    desc: {
      type: String,
      value: '我们只会在你主动操作时使用必要的信息，不会采集聊天记录、相册或任何个人信息，也不会对外分享。',
    },
    // 用户点「不同意」时的提示
    denyTip: { type: String, value: '未同意则无法使用该功能' },
  },

  methods: {
    noop() {},

    // 打开微信官方的《用户隐私保护指引》
    openContract() {
      if (wx.openPrivacyContract) wx.openPrivacyContract({});
    },

    onAgree() {
      const resolve = app.globalData.privacyResolve;
      if (resolve) resolve({ event: 'agree' });
      app.globalData.privacyResolve = null;
      this.triggerEvent('close');
    },

    onDisagree() {
      const resolve = app.globalData.privacyResolve;
      if (resolve) resolve({ event: 'disagree' });
      app.globalData.privacyResolve = null;
      this.triggerEvent('close');
      wx.showToast({ title: this.properties.denyTip, icon: 'none' });
    },
  },
});
