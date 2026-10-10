// pages/pay/pay.js
// 套餐购买页：我的额度 / 三档套餐 / 邀请奖励
//
// 计费口径（页面上也写给用户看，避免"为什么又扣我一次"的投诉）：
//   · 一次完整攻略 = 1 次额度（大纲 + 逐天细化 + 建议 + 闹钟 + 地图定位全包）
//   · 大纲不满意可以换，不额外扣；行程没生成出来不扣
//   · 查看行程、编辑、导航、闹钟提醒永久免费

const quota = require('../../utils/quota');
const auth = require('../../utils/auth');
const homeCache = require('../../utils/homecache');
const CACHE_KEY = 'pay';

Page({
  data: {
    info: null,
    goods: [],
    invite: null,
    payingId: '',
    inputCode: '',
    loading: true,
    loggedIn: false,
  },

  onShow() {
    // 从支付页回来 / 首次进入都要拿最新额度（云函数发货可能有延迟）
    const openid = auth.getOpenid();
    if (this._account && this._account !== openid) {
      this._epoch = (this._epoch || 0) + 1;
      this._refreshing = null;
      this.setData({ info: null, goods: [], invite: null, giftInfo: null, loading: true });
    }
    this.showCached();
    this.refresh();
  },

  showCached() {
    const openid = auth.getOpenid();
    const snap = openid && homeCache.readPage(CACHE_KEY);
    if (!snap || snap.openid !== openid || !snap.info) return false;
    this._account = openid;
    this.setData({ loggedIn: true, loading: false, info: snap.info,
      goods: snap.goods || [], invite: snap.invite || null, giftInfo: snap.giftInfo || null });
    return true;
  },

  giftInfoOf(info) {
    const exp = info && Number(info.giftExpireAt || 0);
    if (!info || info.gift <= 0 || !exp) return null;
    const d = new Date(exp);
    return {
      dateStr: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      daysLeft: Math.max(0, Math.ceil((exp - Date.now()) / 86400000)),
    };
  },

  async refresh() {
    if (this._refreshing) return this._refreshing;
    const epoch = this._epoch || 0;
    const logged = auth.isLoggedIn();
    const openid = auth.getOpenid();
    const hadContent = !!this.data.info || this.showCached();
    this.setData({ loggedIn: logged, loading: logged && !hadContent });
    if (!logged) {
      this.setData({ loading: false, info: null, goods: [], invite: null });
      return;
    }
    const fetchInfo = quota.info(true).then((info) => {
      if (auth.getOpenid() !== openid || (this._epoch || 0) !== epoch || !info) return;
      this._account = openid;
      const giftInfo = this.giftInfoOf(info);
      this.setData({ info, giftInfo, goods: info.goods || [], loading: false });
      homeCache.writePage(CACHE_KEY, { openid, info, goods: info.goods || [],
        invite: this.data.invite, giftInfo });
    });
    const fetchInvite = quota.inviteInfo().then((invite) => {
      if (auth.getOpenid() !== openid || (this._epoch || 0) !== epoch) return;
      this.setData({ invite });
      const snap = homeCache.readPage(CACHE_KEY);
      if (snap && snap.openid === openid) homeCache.writePage(CACHE_KEY, Object.assign({}, snap, { invite }));
    });
    this._refreshing = Promise.all([fetchInfo, fetchInvite])
      .catch(() => this.setData({ loading: false }))
      .finally(() => { if ((this._epoch || 0) === epoch) this._refreshing = null; });
    return this._refreshing;
  },

  /** 点「赠送额度（限时）」看有效期 */
  onGiftInfo() {
    const g = this.data.giftInfo;
    const n = this.data.info && this.data.info.gift;
    if (!g || !n) return;
    wx.showModal({
      title: '赠送额度有效期',
      content: `赠送的 ${n} 次在 ${g.dateStr} 前有效（还剩 ${g.daysLeft} 天）。过期没用的部分会作废，记得安排上。`,
      showCancel: false,
      confirmText: '知道了',
    });
  },

  // ---------- 购买 ----------

  async onBuy(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.payingId) return;
    const g = (this.data.goods || []).find((x) => x.id === id);
    if (!g) return;
    const ok = await auth.ensureLogin('购买套餐');
    if (!ok) return;

    this.setData({ payingId: id });
    try {
      const r = await quota.pay(id);
      if (r.ok) {
        wx.showToast({ title: '购买成功', icon: 'success' });
      } else {
        // 客户端支付入口已返回，但云端仍需从微信侧核实结果。
        wx.showModal({
          title: '支付已提交',
          content: `${r.msg || '支付状态待核实'}\n\n系统会自动核对，请稍后到「我的订单」查看；如已扣款但未出现订单，请保存购买凭证联系客服。`,
          confirmText: '查看订单',
          cancelText: '知道了',
          success: (res) => { if (res.confirm) this.onTapOrders(); },
        });
      }
    } catch (err) {
      const msg = (err && err.message) || '支付失败';
      if (!/取消/.test(msg)) {
        // 长报错用弹窗（toast 只能显示 30 字，截断看不出原因）
        wx.showModal({ title: '支付没走成', content: msg.slice(0, 200), showCancel: false });
      }
    } finally {
      this.setData({ payingId: '' });
      this.refresh();
    }
  },

  // ---------- 邀请 ----------

  onCopyCode() {
    const code = (this.data.invite && this.data.invite.inviteCode) || '';
    if (!code) {
      wx.showToast({ title: '邀请码还没拿到，稍后再试', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
      // 弹窗里的文字选不中（showModal 不支持 user-select），失败就开页面内浮层
      fail: () => this.setData({ copyFallback: true, copyCode: code }),
    });
  },

  /** 复制兜底浮层里再试一次 */
  onCopyRetry() {
    const code = this.data.copyCode || '';
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => {
        this.setData({ copyFallback: false });
        wx.showToast({ title: '邀请码已复制', icon: 'none' });
      },
      fail: () => wx.showToast({ title: '还是不行，请长按邀请码手动复制', icon: 'none' }),
    });
  },

  onCloseCopyFallback() {
    this.setData({ copyFallback: false });
  },

  /** 浮层内容区挡住冒泡（点内容不关闭） */
  noop2() {},

  onCodeInput(e) {
    this.setData({ inputCode: e.detail.value });
  },

  async onSubmitInvite() {
    const code = String(this.data.inputCode || '').trim();
    if (!code) {
      wx.showToast({ title: '先填邀请码', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '提交中…', mask: true });
    const r = await quota.bindInvite(code);
    wx.hideLoading();
    if (r.code === 0) {
      wx.showToast({ title: '双方各得 1 次', icon: 'success' });
      this.setData({ inputCode: '' });
      this.refresh();
    } else {
      wx.showToast({ title: (r.msg || '提交失败').slice(0, 30), icon: 'none' });
    }
  },

  /** 去订单中心（我的订单） */
  onTapOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  },

  async onLogin() {
    const ok = await auth.ensureLogin('查看额度');
    if (ok) this.refresh();
  },
});
