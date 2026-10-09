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
const homeCache = require('../../utils/homecache');
const CACHE_KEY = 'orders';

const STATUS_TEXT = { delivered: '权益已到账', refunded: '已退款', paid: '发放中', verifying: '支付确认中', created: '待支付', cancelled: '已取消' };
const STATUS_HINT = {
  delivered: '权益已到账，可以使用',
  refunded: '订单已退款；如权益状态有疑问，请联系客服',
  paid: '支付已完成，权益正在发放，请稍后同步订单',
  verifying: '正在确认支付结果，请勿重复付款',
  created: '尚未完成支付，可以继续支付',
  cancelled: '订单已取消；如已扣款，请联系客服',
};

function pad(n) { return String(n).padStart(2, '0'); }

function timeText(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function moneyText(fen) {
  const n = Number(fen || 0);
  return n ? `¥${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}` : '';
}

function decorate(o) {
  const status = STATUS_TEXT[o.status] ? o.status : 'created';
  const noticeType = o.noticeType === 'warning' ? 'warning' : 'normal';
  const support = o.support || {};
  return Object.assign({}, o, {
    status,
    statusText: STATUS_TEXT[status],
    userNotice: o.userNotice || STATUS_HINT[status],
    noticeClass: noticeType === 'warning' ? 'order-note-warning' : '',
    createdText: timeText(o.createdAt),
    deliveredText: o.deliveredAt ? `到账 ${timeText(o.deliveredAt)}` : '',
    refundText: o.status === 'refunded' && o.refundFee
      ? `退款 ${moneyText(o.refundFee)}` : '',
    detailsOpen: false,
    supportMerchantOrderNo: support.merchantOrderNo || o.outTradeNo || '',
    supportPlatformOrderNo: support.platformOrderNo || '',
    supportChannelOrderNo: support.channelOrderNo || '',
    supportWxTransactionNo: support.wxTransactionNo || '',
    supportPaidText: moneyText(support.paidFee),
    supportPaidAtText: timeText(support.paidAt),
    supportRefundOrderNo: support.refundOrderNo || '',
    supportRefundWxTransactionNo: support.refundWxTransactionNo || '',
    supportRefundText: moneyText(support.refundFee),
    supportRefundAtText: timeText(support.refundAt),
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
    loadError: '',
    page: 0,
    hasMore: false,
    loadingMore: false,
  },

  onShow() {
    // 从别处回来（比如刚买完）刷新一次，保证到账状态是新的
    const openid = auth.getOpenid();
    if (this._account && this._account !== openid) {
      this._epoch = (this._epoch || 0) + 1;
      this._refreshing = false;
      this.setData({ list: [], pendingCount: 0, page: 0, hasMore: false, loading: true });
    }
    if (!this.data.page) this.showCached();
    this.refresh();
  },

  showCached() {
    const openid = auth.getOpenid();
    const snap = openid && homeCache.readPage(CACHE_KEY);
    if (!snap || snap.openid !== openid || !Array.isArray(snap.list)) return false;
    this._account = openid;
    this.setData({ loggedIn: true, loading: false, list: snap.list,
      pendingCount: snap.pendingCount || 0, page: snap.page || 1, hasMore: !!snap.hasMore });
    return true;
  },

  async refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    const epoch = this._epoch || 0;
    const logged = auth.isLoggedIn();
    const openid = auth.getOpenid();
    const hasContent = !!this.data.page || this.showCached();
    this.setData({ loggedIn: logged, loading: logged && !hasContent });
    if (!logged) {
      this.setData({ list: [], pendingCount: 0, page: 0, hasMore: false, loading: false });
      this._refreshing = false;
      return;
    }
    try {
      // 先读订单再后台补发；原先 await syncOrders 会把首屏挡住一整次云调用。
      const result = await quota.orderList(1);
      if (auth.getOpenid() !== openid || (this._epoch || 0) !== epoch) return;
      this._account = openid;
      const first = (result.list || []).map(decorate);
      const seen = new Set(first.map((o) => o.outTradeNo));
      // 后台对账更新首批状态时，不把用户已滚动展开的历史订单突然收回去。
      const older = this.data.page > 1 ? this.data.list.filter((o) => !seen.has(o.outTradeNo)) : [];
      const list = first.concat(older);
      const pendingCount = list.filter((o) => o.status === 'paid' || o.status === 'verifying').length;
      const hasMore = !!result.hasMore;
      this.setData({ list, pendingCount, page: older.length ? this.data.page : 1,
        hasMore: older.length ? this.data.hasMore : hasMore, loadError: '', loading: false });
      homeCache.writePage(CACHE_KEY, { openid, list: first,
        pendingCount: first.filter((o) => o.status === 'paid' || o.status === 'verifying').length,
        page: 1, hasMore });
      this._refreshing = false;
      this.syncInBackground(openid);
    } catch (e) {
      if (auth.getOpenid() !== openid || (this._epoch || 0) !== epoch) return;
      this.setData({ loadError: e.message || '订单读取失败', loading: false });
    } finally {
      if ((this._epoch || 0) === epoch) this._refreshing = false;
    }
  },

  async syncInBackground(openid) {
    if (this._lastSyncAt && Date.now() - this._lastSyncAt < 60000) return;
    this._lastSyncAt = Date.now();
    try {
      const r = await quota.syncOrders();
      if (auth.getOpenid() === openid && r.delivered) this.refresh();
    } catch (e) {
      if (auth.getOpenid() === openid) this.setData({ loadError: e.message || '订单同步失败' });
    }
  },

  onReachBottom() { this.loadMore(); },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore || this._refreshing) return;
    const openid = auth.getOpenid();
    const page = this.data.page + 1;
    this.setData({ loadingMore: true });
    try {
      const result = await quota.orderList(page);
      if (auth.getOpenid() !== openid || page !== this.data.page + 1) return;
      const seen = new Set(this.data.list.map((o) => o.outTradeNo));
      const extra = (result.list || []).map(decorate).filter((o) => !seen.has(o.outTradeNo));
      const list = this.data.list.concat(extra);
      this.setData({ list, page, hasMore: !!result.hasMore,
        pendingCount: list.filter((o) => o.status === 'paid' || o.status === 'verifying').length });
    } catch (e) {
      wx.showToast({ title: e.message || '加载更多订单失败', icon: 'none' });
    } finally { this.setData({ loadingMore: false }); }
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
      this._lastSyncAt = Date.now();
      wx.hideLoading();
      wx.showToast({
        title: r.delivered ? `已补发 ${r.delivered} 笔` : `已尝试核对 ${r.checked || 0} 笔`,
        icon: r.delivered ? 'success' : 'none',
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '同步失败，请稍后再试', icon: 'none' });
    }
    this.setData({ syncing: false });
    this.refresh();
  },

  /** 展开/收起联系客服或退款所需的订单信息 */
  onToggleDetails(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    const list = (this.data.list || []).map((item) => item.outTradeNo === no
      ? Object.assign({}, item, { detailsOpen: !item.detailsOpen }) : item);
    this.setData({ list });
  },

  /** 复制展开区中的订单标识，方便粘贴给客服或支付平台 */
  onCopyDetail(e) {
    const value = String(e.currentTarget.dataset.value || '');
    if (!value) return;
    wx.setClipboardData({
      data: value,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
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

  /** 取消订单（云端只允许取消「待支付」的，已支付/已到账的会拒绝并给出原因） */
  async onCancel(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    const r = await new Promise((resolve) => {
      wx.showModal({
        title: '取消订单',
        content: '将先向微信核实支付状态。只有微信侧确认尚未支付，才能取消这笔本地订单。',
        confirmText: '取消订单',
        confirmColor: '#e64340',
        cancelText: '再想想',
        success: (res) => resolve(res),
        fail: () => resolve({}),
      });
    });
    if (!r.confirm) return;

    wx.showLoading({ title: '取消中…', mask: true });
    try {
      await quota.cancelOrder(no);
      wx.hideLoading();
      wx.showToast({ title: '订单已取消', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      wx.showModal({ title: '取消不了', content: (err && err.message) || '取消失败', showCancel: false });
    }
    this.refresh();
  },
});
