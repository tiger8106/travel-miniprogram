// pages/upload/upload.js
const api = require('../../services/api');
const homeCache = require('../../utils/homecache');

const app = getApp();

Page({
  data: {
    uploading: false,
    parsing: false,
    progress: 0,
    fileName: '',
    fileID: null,
    result: null,
    errorMsg: '',
  },

  onChooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['docx', 'doc'],
      success: (res) => this.handleFile(res.tempFiles[0]),
    });
  },

  // 兼容旧版 chooseMessageFile
  onChooseFileLegacy() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => this.handleFile(res.tempFiles[0]),
    });
  },

  handleFile(file) {
    if (!file) return;
    this.setData({
      fileName: file.name,
      filePath: file.path,
      result: null,
      errorMsg: '',
    });
  },

  async onUpload() {
    if (!this.data.filePath) {
      wx.showToast({ title: '请先选择文件', icon: 'none' });
      return;
    }
    this.setData({ uploading: true, progress: 10, errorMsg: '' });
    try {
      // 1. 上传到云存储
      const fileID = await api.uploadDoc(this.data.filePath);
      this.setData({ fileID, progress: 40 });
      // 2. 解析 + 入库
      this.setData({ parsing: true, progress: 60 });
      const result = await api.parseTravelPlan(fileID);
      this.setData({ progress: 100, result });
      // 3. 提示成功
      wx.showToast({ title: '导入成功', icon: 'success' });
      // 4. 跳转首页（清掉首页快照缓存，避免先闪一下旧行程）
      app.globalData.currentTripId = result.tripId;
      homeCache.clear();
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 800);
    } catch (err) {
      console.error('[upload] error:', err);
      console.error('[upload] err.message:', err.message);
      console.error('[upload] err.errMsg:', err.errMsg);
      // 友好错误提示
      const rawMsg = err.errMsg || err.message || '解析失败';
      const msg = rawMsg.includes('pako') || rawMsg.includes('inflate')
        ? '当前为 mock 模式，docx 解析需要部署云函数才能使用。'
        : rawMsg;
      this.setData({ errorMsg: msg });
    } finally {
      this.setData({ uploading: false, parsing: false, progress: 0 });
    }
  },

  onRetry() {
    this.setData({ result: null, errorMsg: '' });
  },
});