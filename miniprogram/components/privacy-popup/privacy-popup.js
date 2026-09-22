// components/privacy-popup/privacy-popup.js
// 用户隐私保护授权弹窗：调用隐私接口（选文件）前由微信触发，必须用户点「同意」才放行
const app = getApp();

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    show: { type: Boolean, value: false },
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
      wx.showToast({ title: '未同意则无法选择文件', icon: 'none' });
    },
  },
});
