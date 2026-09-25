// pages/upload/upload.js
const api = require('../../services/api');
const auth = require('../../utils/auth');
const homeCache = require('../../utils/homecache');
const privacy = require('../../utils/privacy');

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

  /**
   * 点「选择文件」
   * ⚠️ 顺序很关键：**先拿到隐私授权，再去调 chooseMessageFile**。
   * 以前是直接调、被微信拦截后再弹窗、同意后代码自动重试一次——
   * 微信拦截时可能同时回调一次 fail，页面收到 fail 又弹、同意后又重试，
   * 于是弹窗反复出现。现在先授权、后调用，且不再自动重试，循环从根上断掉。
   */
  async onChooseFile() {
    if (this._choosing) return;      // 防重入：连点两次不会弹两轮
    if (!wx.chooseMessageFile) {
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信不支持选择聊天文件，请升级到最新版微信后重试。',
        showCancel: false,
      });
      return;
    }
    this._choosing = true;
    try {
      const ok = await privacy.ensure(() => this.setData({ showPrivacy: true }));
      this.setData({ showPrivacy: false });   // 授权这一关过了，弹窗收起来
      if (!ok) {
        // 授权没走通：先分清是"用户没同意"还是"后台指引压根没生效"，
        // 两种情况的下一步完全不同，别都丢一句"请先同意"把人打发走
        const info = await privacy.diagnose('upload');
        const notReady = !!info && !info.contract;  // 指引名称为空 = 后台还没生效
        wx.showModal({
          title: notReady ? '隐私指引还没生效' : '还没完成授权',
          content: notReady
            ? '小程序后台的《用户隐私保护指引》还没有生效（读到的指引名称是空的）。\n\n'
              + '请到后台 → 设置 → 服务内容声明 → 用户隐私保护指引，'
              + '勾选「读取聊天文件」这一类并提交，等微信审核通过（保存不等于生效）。'
            : '刚才没有完成授权，暂时不能选择文件。回到页面重新点一次，在弹窗里选「同意并继续」即可。',
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
      await this.pickFile();
    } finally {
      this._choosing = false;
    }
  },

  /** 真正拉起文件选择（授权已就绪） */
  pickFile() {
    return new Promise((resolve) => {
      wx.chooseMessageFile({
        count: 1,
        type: 'file',
        extension: ['docx', 'doc'],
        success: (res) => { this.handleFile(res.tempFiles[0]); resolve(); },
        fail: (err) => { this.onChooseFail(err); resolve(); },
      });
    });
  },

  // 选文件失败绝不能"静默没反应"，但也绝不能再自动重试（重试就是弹窗反复出现的元凶）
  onChooseFail(err) {
    const msg = (err && err.errMsg) || '';
    console.error('[upload] chooseMessageFile 失败:', msg);
    if (/cancel/.test(msg)) return; // 用户自己取消，不算故障
    if (/privacy|scope|author/i.test(msg)) {
      // 走到这儿说明"同意"了还是被拦 —— 十有八九是后台的《用户隐私保护指引》
      // 没声明「读取聊天文件」或还没审核通过（不是保存即生效）。
      // 只提示一次，把排查路径讲清楚，不再弹授权窗、不再重试。
      if (this._privacyWarned) return;
      this._privacyWarned = true;
      this.setData({ showPrivacy: false });
      privacy.diagnose('upload');
      wx.showModal({
        title: '隐私授权还没生效',
        content: '微信提示仍需要《用户隐私保护指引》授权。\n\n'
          + '请在小程序后台 → 设置 → 服务内容声明 → 用户隐私保护指引里：\n'
          + '1）勾选「读取聊天文件」这一类；\n'
          + '2）提交后等微信审核通过（不是保存即生效）。\n\n'
          + '生效后重新进入本页即可选择文件。',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    wx.showModal({
      title: '选择文件失败',
      content: `${msg || '未知原因'}\n\n可以换个文件再试，或先把文档发到「文件传输助手」再从这里选择。`,
      showCancel: false,
      confirmText: '知道了',
    });
  },

  // 兼容旧版 chooseMessageFile（不带 extension 参数）
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

  // 只负责关弹窗：后续动作由 onChooseFile 里 await privacy.ensure() 的结果决定，
  // 不再在这里"同意后自动重试" —— 那正是弹窗反复出现的元凶
  onClosePrivacy() {
    this.setData({ showPrivacy: false });
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