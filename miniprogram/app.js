// app.js
// 微信小程序入口文件
const auth = require('./utils/auth');
const alarm = require('./utils/alarm');

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
  },

  onLaunch() {
    // 隐私授权监听：调用 wx.chooseMessageFile 这类隐私接口时微信会拦截，
    // 这里把 resolve 交给当前页面弹窗，用户点「同意」后再放行
    this.globalData.privacyResolve = null;
    this._privacyHandler = null;   // 由使用隐私接口的页面注册
    if (wx.onNeedPrivacyAuthorization) {
      wx.onNeedPrivacyAuthorization((resolve) => {
        this.globalData.privacyResolve = resolve;
        if (typeof this._privacyHandler === 'function') {
          this._privacyHandler();
        } else {
          // 没有页面兜底就直接放弃，避免接口一直卡住
          resolve({ event: 'disagree' });
        }
      });
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
    wx.cloud.init({
      env: CLOUD_ENV_ID === 'YOUR_ENV_ID' ? undefined : CLOUD_ENV_ID,
      traceUser: true,
    });
    if (CLOUD_ENV_ID === 'YOUR_ENV_ID') {
      console.warn('[阿稳提示] CLOUD_ENV_ID 还是占位符,已临时使用默认环境。建议在 app.js 顶部填入真实环境 ID。');
    }

    // 1. 初始化系统信息
    try {
      const sys = wx.getSystemInfoSync();
      this.globalData.systemInfo = sys;
    } catch (e) {
      console.error('获取系统信息失败', e);
    }

    // 2. 静默登录拿 openid（全局只此一处发请求，页面共用同一个 Promise；
    //    登录成功后会广播，所有页面自动解锁，不用各自再点一次登录）
    //    用户主动退出过时不会自动登录，要等他在页面上自己点登录
    auth.requireLogin().then((ok) => {
      if (!ok) {
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
  },

  onHide() {
    // 后台时停止前台定时器，依靠订阅消息兜底
    alarm.stopPolling();
  },

  onError(err) {
    console.error('App.onError:', err);
    // 可上报到日志服务
  },
});