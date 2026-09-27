// app.js
// 微信小程序入口文件
const auth = require('./utils/auth');
const alarm = require('./utils/alarm');
const privacy = require('./utils/privacy');
const cloud = require('./utils/cloud');

// ============================================================
// ⚠️ 必填：云开发环境 ID（仅 USE_MOCK=false 时需要）
// 拿到位置：微信开发者工具 → 云开发 → 顶部环境列表
// 形如 'myenv-abc123' 或 'travel-prod-1xxxxxxx'
// 填好后整段上线；本地调试可以先不填，会走「默认环境」
// ============================================================
const CLOUD_ENV_ID = 'cloudbase-d1gjisaab4e470218';

// 是否走 mock 模式（与服务层开关保持一致 —— 在 services/api.js 里）
const USE_MOCK = false;

// ============================================================
// ⚠️ 必填：默认行程 ID
// ============================================================
const DEFAULT_TRIP_ID = 'mock-trip-guangxi-real-001';

App({
  globalData: {
    userInfo: null,
    openid: null,
    currentTripId: null,        // 当前正在查看的行程 id
    currentTrip: null,          // 当前行程缓存
    systemInfo: null,
    cloudReady: false,
    cloudInitError: '',
  },

  onLaunch() {
    // 隐私授权监听：调用 wx.chooseMessageFile 这类隐私接口时微信会拦截，
    // 这里把 resolve 交给当前页面弹窗，用户点「同意」后再放行。
    // 具体流程统一收在 utils/privacy.js（各页面不再各写一套，避免重复弹窗）
    this._privacyHandler = null;   // 由使用隐私接口的页面注册
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization((resolve) => privacy.onNeed(resolve));
    }

    // mock 模式下直接用默认行程 ID，不需要登录
    if (USE_MOCK) {
      this.globalData.currentTripId = DEFAULT_TRIP_ID;
      this.globalData.openid = 'mock-openid-local-dev';
      // 加载 mock 闹钟到本地缓存
      this._initMockAlarms();
      // mock 模式下也启动前台轮询 —— 闹钟到点能震动
      alarm.startPolling();
      console.info('[阿稳] MOCK 模式启动 —— 无需云开发，直接看效果');
      return;
    }

    // 真实模式：0. 初始化云开发（必须调用一次）
    if (!wx.cloud) {
      console.error('当前基础库版本过低，请升级微信至最新版');
      wx.showModal({
        title: '微信版本过低',
        content: '请升级微信到最新版，以支持云开发能力',
        showCancel: false,
      });
      return;
    }
    const cloudResult = cloud.init({ envId: CLOUD_ENV_ID, traceUser: true });
    if (!cloudResult.ok) {
      this.globalData.cloudInitError = cloudResult.error && (cloudResult.error.message || cloudResult.error.errMsg) || '云开发初始化失败';
      console.error('[阿稳] 云开发初始化失败', cloudResult.diagnostics, cloudResult.error);
      this._showCloudInitError();
      return;
    }
    this.globalData.cloudReady = true;
    if (!CLOUD_ENV_ID || CLOUD_ENV_ID === 'YOUR_ENV_ID') {
      console.warn('[阿稳提示] CLOUD_ENV_ID 还是占位符，当前使用开发者工具默认环境。正式环境请填入真实环境 ID。');
    }

    // 1. 初始化系统信息（getSystemInfoSync 已废弃，改用拆分后的新 API）
    try {
      this.globalData.systemInfo = Object.assign(
        {},
        typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : {},
        typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : {}
      );
    } catch (e) {
      console.error('获取系统信息失败', e);
    }

    // 2. 静默登录拿 openid（全局只此一处发请求，页面共用同一个 Promise；
    //    登录成功后会广播，所有页面自动解锁，不用各自再点一次登录）
    //    用户主动退出过时不会自动登录，要等他在页面上自己点登录
    auth.requireLogin().then((ok) => {
      if (!ok) {
        if (cloud.hasInitError()) {
          this.globalData.cloudReady = false;
          this.globalData.cloudInitError = cloud.requestError().message;
          this._showCloudInitError();
          return;
        }
        console.info('[阿稳] 当前未登录，等待用户在页面点登录');
        return;
      }
      this.globalData.openid = auth.getOpenid();

      // 3. 启动闹钟轮询（前台）
      alarm.startPolling();
    });

    // 4. 监听小程序切前台
    wx.onAppShow(() => {
      alarm.refreshAlarms();
    });
  },

  // mock 模式初始化闹钟数据到本地缓存
  _initMockAlarms() {
    const { STORE } = require('./services/mock-data');
    const alarms = JSON.parse(JSON.stringify(STORE.alarms));
    try {
      wx.setStorageSync('__alarms_cache__', alarms);
    } catch (e) {
      console.warn('[mock] 设置闹钟缓存失败', e);
    }
  },

  onShow() {
    alarm.refreshAlarms();
    // 云初始化失败时不要让后台生成续跑再次触发一串无意义的云函数报错。
    if (!USE_MOCK && (this.globalData.cloudInitError || cloud.hasInitError())) return;
    // 回到小程序（包括从后台切回来）先看一眼有没有没跑完的生成任务。
    // 用户点完"生成详细行程"就退出小程序时，云端 genWorker 已经在一轮轮接力了，
    // 这里 sync() 会立刻接手剩下的轮次，不等下一分钟的定时触发。
    try {
      const genrunner = require('./utils/genrunner');
      genrunner.sync();
    } catch (e) {
      console.warn('[app] 后台生成续跑检查失败（不影响使用）', e);
    }
  },

  onHide() {
    // 后台时停止前台定时器，依靠订阅消息兜底
    alarm.stopPolling();
  },

  onError(err) {
    console.error('App.onError:', err);
    // 可上报到日志服务
  },

  _showCloudInitError() {
    if (this._cloudInitErrorShown) return;
    this._cloudInitErrorShown = true;
    wx.showModal({
      title: '云开发连接失败',
      content: cloud.userMessage(),
      confirmText: '知道了',
      showCancel: false,
      complete: () => {
        this._cloudInitErrorShown = false;
      },
    });
  },
});
