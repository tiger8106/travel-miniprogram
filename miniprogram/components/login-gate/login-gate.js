// components/login-gate/login-gate.js
// 未登录门禁卡：页面在未登录状态下显示，引导微信登录，登录后通知页面刷新
const auth = require('../../utils/auth');

Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    tip: { type: String, value: '登录后查看你的行程' },
    desc: { type: String, value: '数据保存在你自己的微信账号下，换手机、重登录都不丢' },
  },

  data: {
    loggingIn: false,
  },

  methods: {
    async onLogin() {
      if (this.data.loggingIn) return;
      this.setData({ loggingIn: true });
      try {
        await auth.silentLogin(true);
        this.setData({ loggingIn: false });
        this.triggerEvent('success');
      } catch (err) {
        this.setData({ loggingIn: false });
        console.error('[login-gate] 登录失败', err);
        wx.showToast({ title: err.message || '登录失败，请重试', icon: 'none' });
      }
    },
  },
});
