// pages/upload/upload.js
const api = require('../../services/api');
const auth = require('../../utils/auth');
const homeCache = require('../../utils/homecache');
const privacy = require('../../utils/privacy');
const quota = require('../../utils/quota');

const app = getApp();

Page({
  data: {
    uploading: false,
    parsing: false,
    needLogin: false,   // 未登录 → 只显示登录门禁卡
    showPrivacy: false, // 隐私保护授权弹窗（选文件前由微信触发）
    progress: 0,
    stageText: '',      // 解析进行到哪一步（按钮与进度条旁的文案）
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
    // 解析要跑好几个 LLM，开跑前先确认额度（云端 init 步也会拦一次）
    const can = await quota.ensureOrPay('parse');
    if (!can) return;
    this.setData({ uploading: true, progress: 5, errorMsg: '', result: null });
    this._taskState = null; // 新任务从头开始
    try {
      // 1. 上传到云存储
      const fileID = await api.uploadDoc(this.data.filePath);
      this.setData({ fileID, progress: 12 });
      // 2. 分步解析（六步流水线，每步远小于云函数 60s 上限）
      await this.runParsePipeline({ fileID });
    } catch (err) {
      console.error('[upload] error:', err);
      console.error('[upload] err.message:', err.message);
      console.error('[upload] err.errMsg:', err.errMsg);
      // 友好错误提示
      const rawMsg = err.errMsg || err.message || '解析失败';
      const msg = rawMsg.includes('pako') || rawMsg.includes('inflate')
        ? '当前为 mock 模式，docx 解析需要部署云函数才能使用。'
        : rawMsg;
      // 次数用完/撞限额不是故障，给购买引导而不是丢一句红字
      if (/次数|额度|上限/.test(msg)) {
        this.setData({ errorMsg: '' });
        quota.guideToPay(msg);
        return;
      }
      this.setData({ errorMsg: msg });
    } finally {
      this.setData({ uploading: false, parsing: false, progress: 0, stageText: '' });
    }
  },

  /**
   * 分步解析流水线：init → day×N → collect → infer → geocode（循环）→ commit
   *
   * 为什么拆步：云函数同步调用上限就是 60s（调不高），七天攻略的
   * 并行 LLM + 覆盖度复查 + 几十个地址定位 + AI 反推待办加起来经常破 60s。
   * 拆步后每步都在云函数上限内跑完；任务进度存在云数据库 parse_tasks 里，
   * 任何一步失败，点"重试"都从失败的那一步继续，前面已成功的天不会重跑。
   */
  async runParsePipeline(state) {
    this.setData({ parsing: true });
    // 断点记录：每成功一步就更新，失败时 onRetry 从这里续跑
    const mark = () => { this._taskState = Object.assign({}, state); };
    const step = (payload) => api.parseTravelPlanStep(payload);

    // ① 读文档 + 切分（秒级）
    if (!state.taskId) {
      this.setStage('读取文档…', 15);
      const init = await step({ step: 'init', fileID: state.fileID });
      // 防御：callFn 约定云函数返回 {code:0,data}，若云端版本没对齐（返回平铺字段），
      // 这里会拿到 undefined——给一句能定位问题的话，别让「reading 'taskId'」裸奔
      if (!init || !init.taskId) {
        throw new Error('解析服务返回异常（init 无 taskId）：请确认 parseTravelPlan 云函数已重新上传部署');
      }
      state.taskId = init.taskId;
      state.dayCount = init.dayCount;
      state.dayIndex = 0;
      state.next = 'day';
      mark();
    }

    // ② 逐天 AI 解析（一次调用解析一天，进度可见、失败可单天重试）
    if (state.next === 'day') {
      for (; state.dayIndex < state.dayCount; state.dayIndex++) {
        this.setStage(
          `AI 解析行程 第 ${state.dayIndex + 1}/${state.dayCount} 天…`,
          15 + Math.round(55 * (state.dayIndex / state.dayCount))
        );
        await step({ step: 'day', taskId: state.taskId, index: state.dayIndex });
        mark();
      }
      state.next = 'collect';
      mark();
    }

    // ③ 闹钟（预订章节）+ 旅行建议
    if (state.next === 'collect') {
      this.setStage('提取闹钟与旅行建议…', 74);
      await step({ step: 'collect', taskId: state.taskId });
      state.next = 'infer';
      mark();
    }

    // ④ 清洗汇总 + AI 反推待办
    if (state.next === 'infer') {
      this.setStage('反推抢票/预订待办…', 80);
      await step({ step: 'infer', taskId: state.taskId });
      state.next = 'geocode';
      mark();
    }

    // ⑤ 地理编码（每轮限墙钟 35s，一次跑不完自动再来一轮）
    if (state.next === 'geocode') {
      let remaining = 1;
      let round = 0;
      while (remaining > 0) {
        round++;
        this.setStage(`地图定位中${round > 1 ? `（第 ${round} 轮）` : ''}…`, 86);
        const g = await step({ step: 'geocode', taskId: state.taskId });
        remaining = g.remaining || 0;
        mark();
      }
      state.next = 'commit';
      mark();
    }

    // ⑥ 坐标回填 + 入库
    this.setStage('生成行程…', 96);
    const result = await step({ step: 'commit', taskId: state.taskId });
    this._taskState = null; // 全部完成，清掉断点
    this.setData({ progress: 100, result });

    // 成功：提示 + 跳首页（清掉首页快照缓存，避免先闪一下旧行程）
    wx.showToast({ title: '导入成功', icon: 'success' });
    app.globalData.currentTripId = result.tripId;
    homeCache.clear();
    quota.clear();     // 入库成功云端已扣 1 次，本地额度缓存作废
    setTimeout(() => {
      wx.switchTab({ url: '/pages/index/index' });
    }, 800);
  },

  setStage(text, progress) {
    this.setData({ stageText: text, progress });
  },

  onRetry() {
    this.setData({ result: null, errorMsg: '' });
    // 有断点 → 从失败的那一步继续（已解析的天不重跑）；没有 → 从上传重头再来
    if (this._taskState && this._taskState.taskId) {
      const state = Object.assign({}, this._taskState);
      this._taskState = null;
      this.runParsePipeline(state).catch((err) => {
        console.error('[upload] retry error:', err);
        this.setData({ errorMsg: err.errMsg || err.message || '解析失败' });
        this.setData({ uploading: false, parsing: false, progress: 0, stageText: '' });
      });
      return;
    }
    if (this.data.fileID) {
      // 文件已在云存储：跳过上传直接重跑流水线
      this.setData({ uploading: true, progress: 12 });
      this.runParsePipeline({ fileID: this.data.fileID }).catch((err) => {
        console.error('[upload] retry error:', err);
        this.setData({ errorMsg: err.errMsg || err.message || '解析失败' });
        this.setData({ uploading: false, parsing: false, progress: 0, stageText: '' });
      });
      return;
    }
    this.setData({ errorMsg: '' });
  },
});