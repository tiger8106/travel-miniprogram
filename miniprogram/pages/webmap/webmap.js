// pages/webmap/webmap.js
Page({
  data: {
    url: '',
    title: '',
  },

  onLoad(opts) {
    this.setData({
      url: decodeURIComponent(opts.url || ''),
      title: decodeURIComponent(opts.title || '导航'),
    });
    wx.setNavigationBarTitle({ title: this.data.title });
  },
});