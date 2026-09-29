// pages/pay/pay.js
// 套餐购买页：我的额度 / 三档套餐 / 邀请奖励
//
// 计费口径（页面上也写给用户看，避免"为什么又扣我一次"的投诉）：
//   · 一次完整攻略 = 1 次额度（大纲 + 逐天细化 + 建议 + 闹钟 + 地图定位全包）
//   · 大纲不满意可以换，不额外扣；行程没生成出来不扣
//   · 查看行程、编辑、导航、闹钟提醒永久免费

const quota = require('../../utils/quota');
const auth = require('../../utils/auth');

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

  async onLoad() {
    await this.refresh();
  },

  onShow() {
    // 从支付页回来 / 首次进入都要拿最新额度（云函数发货可能有延迟）
    this.refresh();
  },

  async refresh() {
    const logged = auth.isLoggedIn();
    this.setData({ loggedIn: logged, loading: true });
    if (!logged) {
      this.setData({ loading: false });
      return;
    }
    const [info, invite] = await Promise.all([
      quota.info(true),
      quota.inviteInfo(),
    ]);
    // 赠送额度的有效期展示用：到期日 + 剩余天数
    let giftInfo = null;
    const exp = info && Number(info.giftExpireAt || 0);
    if (info && info.gift > 0 && exp) {
      const d = new Date(exp);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const daysLeft = Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
      giftInfo = { dateStr, daysLeft };
    }
    this.setData({
      info,
      giftInfo,
      goods: (info && info.goods) || [],
      invite,
      loading: false,
    });
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
        // 支付成功但云端还没确认（多半是没配回调/查单参数）：
        // 告诉用户钱不会白花，点一下就能补
        wx.showModal({
          title: '支付已提交',
          content: `${r.msg || '额度稍后自动到账'}\n\n如果一直没到账，点「刷新额度」手动同步（不会重复扣款）。`,
          confirmText: '刷新额度',
          cancelText: '知道了',
          success: (res) => { if (res.confirm) this.onSync(); },
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

  /** 付了钱额度没到 → 手动补发（幂等，不会重复加） */
  async onSync() {
    wx.showLoading({ title: '同步中…', mask: true });
    try {
      const r = await quota.syncOrders();
      wx.hideLoading();
      wx.showToast({
        title: r.delivered ? `已补发 ${r.delivered} 笔` : '暂无可补发的订单',
        icon: r.delivered ? 'success' : 'none',
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '同步失败，请稍后再试', icon: 'none' });
    }
    this.refresh();
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

  async onLogin() {
    const ok = await auth.ensureLogin('查看额度');
    if (ok) this.refresh();
  },
});
