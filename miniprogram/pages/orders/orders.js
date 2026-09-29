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
});
