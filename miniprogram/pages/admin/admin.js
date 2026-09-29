// pages/admin/admin.js
// 管理后台：管理员认领 / 给用户授权不限量 / 在线配置（大模型 Key、高德 Key 等）
//
// 安全边界说明（写在这里是因为很容易被理解错）：
//   云端每次都会重新校验管理员身份，页面上的显示/隐藏只是 UX，
//   **不是安全边界**。换句话说：就算有人手改本地 storage 把入口翻出来，
//   调接口照样被云端拒。
//
// 入口。「我的」页只对管理员显示这个菜单，普通用户看不到。

const api = require('../../services/api');
const auth = require('../../utils/auth');

/**
 * api 层有两种封装，返回形态不一样：
 *   callFn         → 成功时直接给业务体（如 {isAdmin, me, items}）
 *   callFnKeepCode → 给 {code, data, msg}
 * 这里两种都吃掉，统一返回业务体。
 * ⚠️ 踩过的坑：直接写 r.data 时，走 callFn 的接口恒为 undefined，
 *    管理员菜单就永远显示不出来（后台列表/配置也一样全空）。
 */
function bodyOf(r) {
  if (!r || typeof r !== "object") return {};
  if (r.data && typeof r.data === 'object') return r.data;
  return r;
}

const TABS = [
  { key: 'users', label: '👥 授权' },
  { key: 'config', label: '🔧 配置' },
  { key: 'staff', label: '🛡 管理员' },
  { key: 'audit', label: '📜 日志' },
];

/**
 * 配置项的分组归属（显示层元数据，以前端这张表为准）。
 * 云端的 group 字段只给表里没有的新项兜底；表里查不到的归 advanced。
 * 好处：admin 云函数哪怕还是旧版（items 不带 group），分组渲染也正确。
 */
const CFG_GROUP = {
  LLM_PROVIDER: 'llm',
  LLM_API_KEY: 'llm',
  LLM_MODEL: 'llm',
  LLM_BASE_URL: 'llm',
  AMAP_KEY: 'amap',
};

Page({
  data: {
    loading: true,
    loggedIn: false,
    isAdmin: false,
    isSuper: false,
    claimEnabled: false,
    claimCode: '',
    me: null,
    stats: null,
    showAdvanced: false,   // 「其他配置」默认折叠
    tab: 'users',
    tabs: TABS,
    // 各页签数据是否已加载过（按需加载，见 ensureTabData）
    loadedTabs: { users: false, config: false, staff: false, audit: false },

    // 用户授权
    keyword: '',
    users: [],

    // 配置（configItems 是唯一数据源，llm/amap/advanced 三份是分组视图）
    configItems: [],
    llmItems: [],
    amapItems: [],
    advancedItems: [],
    configUpdatedAt: '',
    dirtyKeys: [],

    // 管理员名单
    staff: [],

    // 日志
    logs: [],
    ACTION_LABEL: {
      claim: '认领管理员', grant: '授权不限量', revoke: '取消授权',
      addAdmin: '新增管理员', removeAdmin: '撤销管理员',
      saveConfig: '修改配置', clearLogs: '清空日志',
    },
  },

  async onLoad() {
    if (!api.adminWhoami) {
      wx.showToast({ title: '当前构建不支持管理后台', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      this.setData({ loading: false });
      return;
    }
    await this.refresh();
  },

  onPullDownRefresh() {
    this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  async refresh(force) {
    const loggedIn = !!auth.isLoggedIn();
    this.setData({ loggedIn, loading: true });
    if (!loggedIn) {
      this.setData({ loading: false });
      return;
    }
    try {
      const r = await api.adminWhoami();
      const d = bodyOf(r);
      this.setData({
        isAdmin: !!d.isAdmin,
        isSuper: !!d.isSuper,
        claimEnabled: !!d.claimEnabled,
        me: d.me || null,
        stats: d.stats || null,
        loading: false,
      });
      if (force) {
        const loaded = Object.assign({}, this.data.loadedTabs);
        loaded[this.data.tab] = false;
        this.setData({ loadedTabs: loaded });
      }
      if (d.isAdmin) await this.ensureTabData(this.data.tab);
    } catch (e) {
      this.setData({ loading: false });
      console.error('[admin] 身份读取失败', e);
      wx.showToast({ title: e.message || '读取失败', icon: 'none' });
    }
  },

  /**
   * 按需加载：进后台只拉当前页签的数据，切过去才拉下一个，拉过就记住。
   * 之前是进页面就并发打 4 个云函数（用户/配置/名单/日志），用户越多越慢，
   * 而多数时候管理员只看「授权」一个页签 —— 那 3 个请求纯属白跑。
   */
  async ensureTabData(tab) {
    const loaded = Object.assign({}, this.data.loadedTabs);
    const jobs = [];
    if (tab === 'users' && !loaded.users) {
      jobs.push(this.loadUsers().then(() => { loaded.users = true; }));
    } else if (tab === 'config' && !loaded.config) {
      jobs.push(this.loadConfig().then(() => { loaded.config = true; }));
    } else if (tab === 'staff' && !loaded.staff) {
      jobs.push(this.loadStaff().then(() => { loaded.staff = true; }));
    } else if (tab === 'audit' && !loaded.audit) {
      jobs.push(this.loadLogs().then(() => { loaded.audit = true; }));
    }
    if (!jobs.length) return;
    await Promise.all(jobs);
    this.setData({ loadedTabs: loaded });
  },

  onSwitchTab(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ tab: key });
    this.ensureTabData(key);
  },

  // ---------- 认领管理员 ----------

  onClaimInput(e) {
    this.setData({ claimCode: e.detail.value });
  },

  async onClaim() {
    const code = (this.data.claimCode || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入口令', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '校验中…', mask: true });
    try {
      await api.adminClaim(code);
      wx.hideLoading();
      wx.showToast({ title: '已成为超级管理员', icon: 'success' });
      this.setData({ claimCode: '' });
      await this.refresh();
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '认领失败', icon: 'none' });
    }
  },

  // ---------- 用户授权 ----------

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  async onSearch() {
    await this.loadUsers();
  },

  async loadUsers() {
    try {
      const r = await api.adminSearchUsers((this.data.keyword || '').trim());
      const list = bodyOf(r).list || [];
      this.setData({
        users: list.map((u) => Object.assign({}, u, {
          createdAtText: u.createdAt ? this.timeText(u.createdAt) : '',
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '搜索失败', icon: 'none' });
    }
  },

  /**
   * 授予 / 取消「不限量」。
   * 取消是随手操作，直接执行不再弹确认；授权才弹一次确认（避免误点送额度）。
   * 授权状态不另挂标签，按钮文案自身就是状态（授权不限量 / 取消授权不限量）。
   */
  async toggleUnlimited(u, enable) {
    const word = enable ? '授权不限量' : '取消授权不限量';
    wx.showLoading({ title: '处理中…', mask: true });
    try {
      await api.adminSetUnlimited(u.userId, enable);
      wx.hideLoading();
      wx.showToast({ title: enable ? '已授权不限量' : '已取消授权', icon: 'success' });
      await Promise.all([this.loadUsers(), this.loadStaff()]);
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  onToggleUnlimited(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const u = this.data.users[idx];
    if (!u) return;
    const enable = !u.unlimited;
    if (!enable) {
      this.toggleUnlimited(u, false);        // 取消：直接执行
      return;
    }
    wx.showModal({
      title: '授权不限量',
      content: `确定对「${u.nickname}」开放不限量使用吗？`,
      success: async (res) => {
        if (res.confirm) await this.toggleUnlimited(u, true);
      },
    });
  },

  /** 把普通用户直接提拔为管理员（超级管理员可见） */
  async onMakeAdmin(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const u = this.data.users[idx];
    if (!u) return;
    wx.showModal({
      title: '设为管理员',
      content: `「${u.nickname}」将成为管理员，可不限量使用并管理授权与配置。确定吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中…', mask: true });
        try {
          await api.adminSetAdmin(u.userId, true);
          wx.hideLoading();
          wx.showToast({ title: '已设为管理员', icon: 'success' });
          await Promise.all([this.loadUsers(), this.loadStaff()]);
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  // ---------- 配置 ----------

  async loadConfig() {
    try {
      const r = await api.adminGetConfig();
      const d = bodyOf(r);
      // 输入值先缓存一份：用户没改的项（脱敏值）提交时原样回传，云端会识别为"未修改"
      const items = (d.items || []).map((it) => Object.assign({}, it, { input: it.value }));
      this.setData({
        configItems: items,
        configUpdatedAt: d.updatedAt ? this.timeText(d.updatedAt) : '尚未修改过',
      });
      this.regroupConfig();
    } catch (e) {
      wx.showToast({ title: e.message || '配置读取失败', icon: 'none' });
    }
  },

  onToggleAdvanced() {
    this.setData({ showAdvanced: !this.data.showAdvanced });
  },

  /**
   * 把 configItems 分成三份，供三张卡片渲染。
   * 分组归属：前端 CFG_GROUP 表优先 → 云端 group 字段兜底 → advanced。
   * 分桶在这里算好，WXML 只管渲染，不再用 wx:for + wx:if 同标签过滤
   * （那种写法一旦 items 缺 group 字段，会整页一个输入框都不剩）。
   */
  regroupConfig() {
    const items = this.data.configItems;
    const groupOf = (it) => CFG_GROUP[it.key] || it.group || 'advanced';
    const pick = (g) => items.filter((it) => groupOf(it) === g);
    this.setData({
      llmItems: pick('llm'),
      amapItems: pick('amap'),
      advancedItems: pick('advanced'),
    });
  },

  onConfigInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    this.setData({
      configItems: this.data.configItems.map((it) => (
        it.key === key ? Object.assign({}, it, { input: value }) : it
      )),
    });
    this.regroupConfig();
  },

  onResetConfigItem(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({
      configItems: this.data.configItems.map((it) => (
        it.key === key ? Object.assign({}, it, { input: '' }) : it
      )),
    });
    this.regroupConfig();
  },

  /** 只收集「值真的变了」的项；空串 = 显式清空，交还给云函数环境变量（即用默认） */
  buildConfigPatch() {
    const patch = {};
    this.data.configItems.forEach((it) => {
      const input = String(it.input == null ? '' : it.input).trim();
      const origin = String(it.value == null ? '' : it.value).trim();
      if (input !== origin) patch[it.key] = input;
    });
    return patch;
  },

  hasUnsavedConfig() {
    return Object.keys(this.buildConfigPatch()).length > 0;
  },

  /** 提交 patch 到云端。resolve(false) 表示失败（调用方据此决定是否继续） */
  async persistConfig(patch) {
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const r = await api.adminSaveConfig(patch);
      wx.hideLoading();
      const refused = bodyOf(r).refused || [];
      wx.showToast({
        title: refused.length ? `有 ${refused.length} 项不允许在线改` : '已保存',
        icon: refused.length ? 'none' : 'success',
      });
      await this.loadConfig();
      return true;
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      return false;
    }
  },

  async onSaveConfig() {
    const patch = this.buildConfigPatch();
    const count = Object.keys(patch).length;
    if (!count) {
      wx.showToast({ title: '没有改动', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '保存配置',
      content: `将修改 ${count} 项，最长 60 秒内在全部云函数实例生效。确定保存？`,
      success: async (res) => {
        if (!res.confirm) return;
        await this.persistConfig(patch);
      },
    });
  },

  /**
   * 测试前守门：测试读的是服务端已保存的值，输入框里没保存的改动它看不见。
   * 有未保存改动时问一句「先保存再测吗」，不保存也放行（按已保存的值测）。
   */
  ensureSavedBeforeTest() {
    if (!this.hasUnsavedConfig()) return Promise.resolve(true);
    return new Promise((resolve) => {
      wx.showModal({
        title: '有改动还没保存',
        content: '测试用的是已保存的配置，输入框里的新值要保存后才会生效。先保存再测吗？',
        confirmText: '保存并测',
        success: async (res) => {
          if (!res.confirm) { resolve(true); return; }
          resolve(await this.persistConfig(this.buildConfigPatch()));
        },
        fail: () => resolve(false),
      });
    });
  },

  async onTestLlm() {
    if (!(await this.ensureSavedBeforeTest())) return;
    wx.showLoading({ title: '连通测试中…', mask: true });
    try {
      const r = await api.adminTestLlm();
      wx.hideLoading();
      const d = bodyOf(r);
      wx.showModal({
        title: '大模型连通正常',
        content: `模型：${d.model}\n端点：${d.base}\n耗时：${d.ms}ms`,
        showCancel: false,
      });
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '连通失败', content: e.message || '', showCancel: false });
    }
  },

  async onTestAmap() {
    if (!(await this.ensureSavedBeforeTest())) return;
    wx.showLoading({ title: '连通测试中…', mask: true });
    try {
      const r = await api.adminTestAmap();
      wx.hideLoading();
      wx.showModal({
        title: '高德 Key 正常',
        content: `参考坐标：${bodyOf(r).location}\n耗时：${bodyOf(r).ms}ms`,
        showCancel: false,
      });
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '连通失败', content: e.message || '', showCancel: false });
    }
  },

  // ---------- 管理员名单 ----------

  async loadStaff() {
    try {
      const r = await api.adminListStaff();
      this.setData({ staff: bodyOf(r).list || [] });
    } catch (e) {
      console.warn('[admin] 名单读取失败', e);
    }
  },

  async onToggleStaff(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const u = this.data.staff[idx];
    if (!u) return;
    const make = u.role !== 'admin';
    wx.showModal({
      title: make ? '设为管理员' : '撤销管理员',
      content: `确定对「${u.nickname}」执行该操作吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中…', mask: true });
        try {
          await api.adminSetAdmin(u.userId, make);
          wx.hideLoading();
          wx.showToast({ title: '已更新', icon: 'success' });
          await this.loadStaff();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  // ---------- 日志 ----------

  onClearLogs() {
    wx.showModal({
      title: '清空日志',
      content: '将删除全部操作记录，无法恢复。确定清空？',
      confirmText: '清空',
      confirmColor: '#e5484d',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '清空中…', mask: true });
        try {
          await api.adminClearAudit();
          wx.hideLoading();
          wx.showToast({ title: '已清空', icon: 'success' });
          await this.loadLogs();
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: err.message || '清空失败', icon: 'none' });
        }
      },
    });
  },

  async loadLogs() {
    try {
      const r = await api.adminAuditList();
      const list = bodyOf(r).list || [];
      this.setData({
        logs: list.map((a) => Object.assign({}, a, {
          actionText: this.data.ACTION_LABEL[a.action] || a.action,
          timeText: a.ts ? this.timeText(a.ts) : '',
        })),
      });
    } catch (e) {
      console.warn('[admin] 日志读取失败', e);
    }
  },

  timeText(ts) {
    const d = new Date(Number(ts));
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
});
