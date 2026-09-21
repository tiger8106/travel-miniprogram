// pages/suggestions/suggestions.js
const api = require('../../services/api');

const app = getApp();

Page({
  data: {
    loading: true,
    generating: false,   // AI 正在生成建议（区别于普通加载）
    refreshing: false,
    suggestions: null,
  },

  onShow() {
    this.load();
  },

  async load() {
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      this.setData({ loading: false, suggestions: null });
      return;
    }
    this.setData({ loading: true });
    try {
      let list = await api.getSuggestions(tripId);
      // 没有建议时自动生成一次（约 10-20 秒，带生成中提示）
      if (!list || (!list.weather && !list.food)) {
        this.setData({ loading: true, generating: true });
        try {
          list = await api.refreshSuggestions(tripId);
        } catch (e) {
          // 生成失败就用原来的空结果，页面会显示空态 + 手动刷新按钮
          console.warn('[suggestions] 自动生成失败:', e.message);
        }
        this.setData({ generating: false });
      }
      this.setData({ loading: false, suggestions: list });
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  async onRefresh() {
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      wx.showToast({ title: '请先上传攻略', icon: 'none' });
      return;
    }
    this.setData({ refreshing: true });
    try {
      await api.refreshSuggestions(tripId);
      await this.load();
      wx.showToast({ title: '已更新', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '更新失败', icon: 'none' });
    } finally {
      this.setData({ refreshing: false });
    }
  },
});