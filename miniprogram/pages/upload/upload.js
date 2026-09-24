// pages/upload/upload.js
const api = require('../../services/api');
const auth = require('../../utils/auth');
const homeCache = require('../../utils/homecache');

const app = getApp();

Page({
  data: {
    uploading: false,
    parsing: false,
    needLogin: false,   // 未登录 → 只显示登录门禁卡
    showPrivacy: false, // 隐私保护授权弹窗（选文件前由微信触发）
    progress: 0,
    fileName: '',
    fileID: null,
    result: null,
    errorMsg: '',
  },

  onChooseFile() {
    if (!wx.chooseMessageFile) {
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信不支持选择聊天文件，请升级到最新版微信后重试。',
        showCancel: false,
      });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['docx', 'doc'],
      success: (res) => this.handleFile(res.tempFiles[0]),
      fail: (err) => this.onChooseFail(err),
    });
  },

  // 选文件失败绝不能"静默没反应"（实锤踩过：隐私指引重新审核后授权状态被重置，
  // 微信拦下 chooseMessageFile 又没自动弹授权 → 用户点了跟没点一样，完全不知道发生了什么）
  onChooseFail(err) {
    const msg = (err && err.errMsg) || '';
    console.error('[upload] chooseMessageFile 失败:', msg);
    if (/cancel/.test(msg)) return; // 用户自己取消，不算故障
    if (/privacy|scope|author/i.test(msg)) {
      // 微信没自动弹授权 → 我们自己弹；用户点"同意"后立即替他重试一次
      this._retryChoose = true;
      this.setData({ showPrivacy: true });
      return;
    }
    wx.showModal({
      title: '选择文件失败',
      content: `${msg || '未知原因'}\n\n可以换个文件再试，或先把文档发到「文件传输助手」再从这里选择。`,
      showCancel: false,
      confirmText: '知道了',
    });
  },

  // 兼容旧版 chooseMessageFile
  onChooseFileLegacy() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => this.handleFile(res.tempFiles[0]),
      fail: (err) => this.onChooseFail(err),
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

  onLoad() {
    // 订阅全局登录态：一处登录全站解锁
    this._offAuth = auth.watch(this, { onLogout: () => this.setData({ fileName: '', result: null }) });
  },

  onUnload() {
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
    this.unbindPrivacy();
  },

  onHide() {
    // 离开本页就交出授权处理权，避免别的页面触发时弹到看不见的地方
    this.unbindPrivacy();
  },

  // 注册隐私授权处理器：微信拦截隐私接口（选文件）时回调它，由当前可见页面弹窗确认
  bindPrivacy() {
    app._privacyHandler = () => this.setData({ showPrivacy: true });
  },

  unbindPrivacy() {
    if (app._privacyHandler) app._privacyHandler = null;
    this.setData({ showPrivacy: false });
  },

  onClosePrivacy(e) {
    this.setData({ showPrivacy: false });
    // 从失败回调里手动弹的授权（不是微信拦截自动触发的）：
    // 用户点"同意"后微信不会自动重试刚才被拦的调用，这里替他再选一次
    const agreed = !!(e && e.detail && e.detail.agreed);
    if (this._retryChoose) {
      this._retryChoose = false;
      if (agreed) setTimeout(() => this.onChooseFile(), 300);
    }
  },

  async onShow() {
    this.bindPrivacy();
    // 未登录 → 先自动静默登录一次；仍然失败才显示登录门禁卡
    const ok = await auth.requireLogin();
    if (!ok) {
      this.setData({ needLogin: true, fileName: '' });
      return;
    }
    if (this.data.needLogin) this.setData({ needLogin: false });
  },

  // 登录成功后由门禁组件回调
  onLoginSuccess() {
    this.setData({ needLogin: false });
  },

  async onUpload() {
    if (!this.data.filePath) {
      wx.showToast({ title: '请先选择文件', icon: 'none' });
      return;
    }
    // 未登录先提醒登录，登录成功后再继续
    const ok = await auth.ensureLogin('上传攻略');
    if (!ok) return;
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