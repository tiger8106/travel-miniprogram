// pages/orders/orders.js
// 我的订单（订单中心）：展示本人虚拟支付的购买记录与到账状态
//
// 数据来源：virtualPay 云函数的 action: 'orderList'（只返回 _openid 自己的订单）
// 状态口径：
//   delivered 已到账 —— 额度/会员已经加上了
//   paid      处理中 —— 钱付了、额度还没到账（查单或回调还没跑完），可点「同步订单」补发
//   created   待支付 —— 单子建了但支付没走完（一般不用管）

const quota = require('../../utils/quota');
const auth = require('../../utils/auth');

const STATUS_TEXT = { delivered: '已到账', paid: '处理中', created: '待支付' };
const STATUS_HINT = {
  delivered: '额度已到账，可以直接去生成行程了',
  paid: '支付已成功，额度正在发放（一般几分钟内到账）',
  created: '这笔订单没有完成支付，不会扣费',
};

function pad(n) { return String(n).padStart(2, '0'); }

function timeText(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function decorate(o) {
  const status = STATUS_TEXT[o.status] ? o.status : 'created';
  return Object.assign({}, o, {
    status,
    statusText: STATUS_TEXT[status],
    statusHint: STATUS_HINT[status],
    createdText: timeText(o.createdAt),
    deliveredText: o.deliveredAt ? `到账 ${timeText(o.deliveredAt)}` : '',
  });
}

Page({
  data: {
    loggedIn: false,
    loading: true,
    list: [],
    pendingCount: 0,   // 「处理中」的笔数，>0 才显示同步按钮
    syncing: false,
    paying: false,     // 正在拉起支付，防连点出两个支付弹窗
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从别处回来（比如刚买完）刷新一次，保证到账状态是新的
    this.refresh();
  },

  async refresh() {
    const logged = auth.isLoggedIn();
    this.setData({ loggedIn: logged, loading: true });
    if (!logged) {
      this.setData({ list: [], pendingCount: 0, loading: false });
      return;
    }
    const raw = await quota.orderList();
    const list = (raw || []).map(decorate);
    const pendingCount = list.filter((o) => o.status === 'paid').length;
    this.setData({ list, pendingCount, loading: false });
  },

  async onLogin() {
    const ok = await auth.ensureLogin('查看订单');
    if (ok) this.refresh();
  },

  /** 有订单卡在「处理中」时：手动触发一次补发（幂等，不会重复加额度） */
  async onSync() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
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
    this.setData({ syncing: false });
    this.refresh();
  },

  /** 回到付费页继续买（空态时用） */
  onGoPay() {
    wx.navigateTo({ url: '/pages/pay/pay' });
  },

  /**
   * 继续支付：复用原订单号重新签名拉起支付（不新建订单，避免同一笔购买留两条单）
   */
  async onPayAgain(e) {
    const no = e.currentTarget.dataset.no;
    if (!no || this.data.paying) return;
    this.setData({ paying: true });
    try {
      const r = await quota.payAgain(no);
      if (r.ok) {
        wx.showToast({ title: '支付成功', icon: 'success' });
      } else {
        wx.showModal({
          title: '支付已提交',
          content: `${r.msg || '额度稍后自动到账'}\n\n如果一直没到账，点「同步订单」手动同步（不会重复扣款）。`,
          showCancel: false,
        });
      }
    } catch (err) {
      const msg = (err && err.message) || '支付失败';
      // 「已取消」不用弹窗，toast 一下就行；长报错用弹窗（toast 截 30 字看不出原因）
      if (/取消/.test(msg)) wx.showToast({ title: '已取消支付', icon: 'none' });
      else wx.showModal({ title: '支付没走成', content: msg.slice(0, 200), showCancel: false });
    } finally {
      this.setData({ paying: false });
      this.refresh();
    }
  },

  /** 删除订单（云端只允许删「待支付」的，已支付的会拒绝并给出原因） */
  async onDelete(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    const r = await new Promise((resolve) => {
      wx.showModal({
        title: '删除订单',
        content: '这笔订单还没支付，删掉就没了。也可以直接「继续支付」买完它。',
        confirmText: '删除',
        confirmColor: '#e64340',
        cancelText: '再想想',
        success: (res) => resolve(res),
        fail: () => resolve({}),
      });
    });
    if (!r.confirm) return;

    wx.showLoading({ title: '删除中…', mask: true });
    try {
      await quota.deleteOrder(no);
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '删不掉', content: (err && err.message) || '删除失败', showCancel: false });
    }
    this.refresh();
  },
});
