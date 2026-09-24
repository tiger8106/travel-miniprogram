// pages/planner/planner.js
// AI 制定新攻略：填几个关键问题 → AI 出路线大纲 → 确认后展开逐天详情并入库
//
// 为什么要两步：一次跑完「大纲 + 逐天细化」要 60~80 秒，超过云函数 60 秒上限。
// 拆开后每步都在期限内，而且大纲先给用户看一眼，不满意可以换一版（重新生成成本也低）。

const api = require('../../services/api');
const auth = require('../../utils/auth');
const homeCache = require('../../utils/homecache');

const app = getApp();

// 今天/明天（本地时间，用于 date picker 的 start / end 边界）
function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function plusDays(str, n) {
  const [y, m, d] = String(str).split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  const p = (x) => (x < 10 ? '0' + x : '' + x);
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}
function diffDays(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((new Date(pb[0], pb[1] - 1, pb[2]) - new Date(pa[0], pa[1] - 1, pa[2])) / 86400000) + 1;
}
// ---- 自研三列日期选择器（年/月/日）----
// 为什么不用原生 mode="date"：原生滚轮永远显示 1~31 号，9 月选了 31 号确认后会
// 悄悄变成 30 号，用户一脸懵。自己算"该年该月有几天"，日列只显示合法天数。
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}
const YEAR0 = new Date().getFullYear();
const PICK_YEARS = [YEAR0, YEAR0 + 1, YEAR0 + 2].map((y) => `${y}年`);
const PICK_MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
function pickDays(y, m) {
  const n = daysInMonth(y, m);
  return Array.from({ length: n }, (_, i) => `${i + 1}日`);
}
function pickRange(dateStr) {
  const [y, m] = String(dateStr).split('-').map(Number);
  return [PICK_YEARS, PICK_MONTHS, pickDays(y, m)];
}
function pickVal(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return [PICK_YEARS.indexOf(`${y}年`), m - 1, d - 1];
}
function pickDate(val) {
  const y = YEAR0 + val[0];
  const m = val[1] + 1;
  const d = Math.min(val[2] + 1, daysInMonth(y, m)); // 双保险：日列越界取当月最后一天
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${y}-${p(m)}-${p(d)}`;
}

const PARTY = ['独自出行', '情侣出行', '朋友结伴', '亲子出行', '带父母'];
// 选同行方式时人数给个合理默认，用户之后仍可手改
const PARTY_PEOPLE = { '独自出行': 1, '情侣出行': 2, '朋友结伴': 2, '亲子出行': 3, '带父母': 3 };
const BUDGET = ['经济实惠', '舒适适中', '品质优选'];
const PACE = ['轻松慢游', '劳逸适中', '紧凑充实'];
const TRANSPORT = ['高铁优先', '飞机优先', '自驾/包车', '大巴/直通车'];
const INTERESTS = [
  '自然山水', '古镇古村', '城市漫游', '博物馆展览',
  '亲子乐园', '当地美食', '拍照打卡', '徒步户外',
  '温泉度假', '海岛海滨', '宗教古迹', '夜生活',
];
// 兴趣偏好渲染模型：{name, on}。为什么不用 interestOn 下标数组 +
// WXML 里 indexOf() 判断选中：WXML 表达式不支持方法调用，选中态永远算
// 不出来（表现为"兴趣偏好选不了"）。改成对象数组后直接绑 item.on。
function buildInterestItems(defaultNames) {
  return INTERESTS.map((name) => ({ name, on: defaultNames.indexOf(name) >= 0 }));
}

// 兴趣偏好持久化：被用户 ✕ 掉的标签不再出现（没删的无论选没选都保留）
const INTEREST_KEY = 'planner_interests';
function loadInterests() {
  try {
    const v = wx.getStorageSync(INTEREST_KEY);
    if (Array.isArray(v) && v.length && v.every((x) => x && x.name)) {
      return v.map((x) => ({ name: String(x.name), on: !!x.on }));
    }
  } catch (e) { /* 读不到就用默认 */ }
  return buildInterestItems(['自然山水', '当地美食', '拍照打卡']);
}
function saveInterests(items) {
  try { wx.setStorageSync(INTEREST_KEY, items); } catch (e) { /* 存不了不影响使用 */ }
}

const MAX_DAYS = 12;

Page({
  data: {
    needLogin: false,
    step: 'form',            // form（填需求）→ outline（看大纲）→ 生成中
    generating: false,
    genTip: '',

    // ---- 表单 ----
    origin: '',
    dest: '',
    startDate: todayStr(),
    endDate: plusDays(todayStr(), 2),
    daysText: '3 天 2 晚',
    // 三列日期选择器（年/月/日）：range 随年月联动刷新，日数永远合法
    startRange: pickRange(todayStr()),
    startVal: pickVal(todayStr()),
    endRange: pickRange(plusDays(todayStr(), 2)),
    endVal: pickVal(plusDays(todayStr(), 2)),
    // 去程/返程时刻（精确到分钟）：AI 必须把首末两天的大交通卡在这个时刻上
    goTime: '08:00',
    backTime: '18:00',
    people: 2,
    partyIdx: 1,
    partyOptions: PARTY,
    budgetIdx: 1,
    budgetOptions: BUDGET,
    paceIdx: 1,
    paceOptions: PACE,
    transportIdx: 0,
    transportOptions: TRANSPORT,
    interestItems: [],            // onLoad 时从 storage 恢复（✕ 掉的不再出现）
    customText: '',
    mustGo: '',
    extra: '',

    // ---- 大纲 ----
    outline: null,
    outlineTitle: '',
    outlineSummary: '',
    outlineDays: [],
    itemH: 0,                     // 每天卡片高度（px，拖动排序用）
    areaH: 0,                     // 列表内容总高度（n × itemH）
    listH: 0,                     // 可视区高度（超出才滚动）
    // 拖动排序状态：长按才开始拖，拖动中卡片悬浮置顶并显示参考线
    dragging: false,
    dragIdx: -1,
    dragShift: 0,                 // 拖动卡片的纵向位移（px）
    guideTop: 0,                  // 参考线位置（px）
    dayForm: null,                // 正在编辑的那一天（null = 抽屉关闭）
    dayFormIdx: -1,
  },

  onLoad() {
    this._offAuth = auth.watch(this, {});
    // 兴趣偏好从本地恢复：上次 ✕ 掉的不再出现，没删的（选没选都算）全保留
    this.setData({ interestItems: loadInterests() });
    // 拖动排序用：卡片高度固定 240rpx，换算成 px
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || {};
    const winW = info.windowWidth || 375;
    const winH = info.windowHeight || 667;
    this._itemH = Math.round((winW / 750) * 240);
    // 列表可视区：屏幕减去上方卡片和底部按钮，给滚动留出空间
    this._listMaxH = Math.max(280, Math.round(winH - 330));
    this.setData({ itemH: this._itemH });
    this.updateDaysText();
  },

  onUnload() {
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
    this.stopTicker();
  },

  // ---------- 生成计时器 ----------
  // 等 AI 的时候最怕"不知道还要多久"。每秒刷新已用秒数 + 已细化天数，
  // 用户能判断是正常在跑还是卡死了，也方便截图告诉我卡在第几天。
  startTicker(baseText) {
    this.stopTicker();
    this._tipBase = baseText;
    this._tipExtra = '';
    this._t0 = Date.now();
    this.setData({ genTip: `${baseText} 0s` });
    this._ticker = setInterval(() => {
      const s = Math.round((Date.now() - this._t0) / 1000);
      const extra = this._tipExtra ? ` · ${this._tipExtra}` : '';
      this.setData({ genTip: `${this._tipBase} ${s}s${extra}` });
    }, 1000);
  },

  setTipExtra(text) {
    this._tipExtra = text || '';
  },

  stopTicker() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  },

  async onShow() {
    const ok = await auth.requireLogin();
    if (!ok) {
      this.setData({ needLogin: true });
      return;
    }
    if (this.data.needLogin) this.setData({ needLogin: false });
  },

  onLoginSuccess() {
    this.setData({ needLogin: false });
  },

  // 遮罩层事件穿透拦截（catchtouchmove 用）
  noop() {},

  // ---------- 表单交互 ----------

  updateDaysText() {
    const n = diffDays(this.data.startDate, this.data.endDate);
    this.setData({ daysText: `${n} 天 ${n - 1} 晚` });
  },

  // ---------- 三列日期选择器 ----------

  // 滑动年/月列时，重算该年该月的天数并刷新日列（2 月只显示 28/29，9 月只到 30）
  onStartDateCol(e) {
    if (e.detail.column > 1) return;
    const val = this.data.startVal.slice();
    val[e.detail.column] = e.detail.value;
    const days = pickDays(YEAR0 + val[0], val[1] + 1);
    if (val[2] > days.length - 1) val[2] = days.length - 1;
    this.setData({ startRange: [PICK_YEARS, PICK_MONTHS, days], startVal: val });
  },

  onEndDateCol(e) {
    if (e.detail.column > 1) return;
    const val = this.data.endVal.slice();
    val[e.detail.column] = e.detail.value;
    const days = pickDays(YEAR0 + val[0], val[1] + 1);
    if (val[2] > days.length - 1) val[2] = days.length - 1;
    this.setData({ endRange: [PICK_YEARS, PICK_MONTHS, days], endVal: val });
  },

  onStartDate(e) {
    const v = e.detail.value;
    const start = pickDate(v);
    let end = this.data.endDate;
    if (diffDays(start, end) <= 0) end = plusDays(start, 1);
    this.setData({
      startDate: start,
      startVal: v,
      endDate: end,
      endRange: pickRange(end),
      endVal: pickVal(end),
    }, () => this.updateDaysText());
  },

  onEndDate(e) {
    const v = e.detail.value;
    const end = pickDate(v);
    let n = diffDays(this.data.startDate, end);
    if (n <= 0) {
      wx.showToast({ title: '返程不能早于出发日', icon: 'none' });
      // 弹回去：把选择器值复位成当前合法的 endDate
      this.setData({ endVal: pickVal(this.data.endDate), endRange: pickRange(this.data.endDate) });
      return;
    }
    if (n > MAX_DAYS) {
      wx.showToast({ title: `最多支持 ${MAX_DAYS} 天`, icon: 'none' });
      end = plusDays(this.data.startDate, MAX_DAYS - 1);
      n = MAX_DAYS;
    }
    this.setData({ endDate: end, endRange: pickRange(end), endVal: pickVal(end) },
      () => this.updateDaysText());
  },

  onPeopleChange(e) {
    let n = parseInt(e.detail.value, 10) || 2;
    if (n < 1) n = 1;
    if (n > 20) n = 20;
    this.setData({ people: n });
  },

  onPickSingle(e) {
    const { field } = e.currentTarget.dataset;
    const idx = Number(e.currentTarget.dataset.idx);
    switch (field) {
      case 'party': {
        // 同行方式定了，人数给个合理默认（之后仍可手动改）
        const name = PARTY[idx];
        this.setData({ partyIdx: idx, people: PARTY_PEOPLE[name] || this.data.people });
        break;
      }
      case 'budget': this.setData({ budgetIdx: idx }); break;
      case 'pace': this.setData({ paceIdx: idx }); break;
      case 'transport': this.setData({ transportIdx: idx }); break;
    }
  },

  // ---------- 兴趣偏好 ----------

  onToggleInterest(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.interestItems[idx];
    if (!item) return;
    const key = `interestItems[${idx}].on`;
    if (item.on) {
      this.setData({ [key]: false }, () => saveInterests(this.data.interestItems));
      return;
    }
    const onCount = this.data.interestItems.filter((i) => i.on).length;
    if (onCount >= 5) {
      wx.showToast({ title: '最多选 5 个偏好', icon: 'none' });
      return;
    }
    this.setData({ [key]: true }, () => saveInterests(this.data.interestItems));
  },

  // ✕ 掉一个偏好：以后制定攻略时不再出现（预置和自定义一视同仁）
  onRemoveInterest(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.interestItems[idx];
    if (!item) return;
    const rest = this.data.interestItems.filter((_, i) => i !== idx);
    this.setData({ interestItems: rest }, () => saveInterests(rest));
    wx.showToast({ title: `已移除「${item.name}」`, icon: 'none', duration: 1200 });
  },

  onCustomInput(e) {
    this.setData({ customText: e.detail.value });
  },

  onAddCustom() {
    const name = (this.data.customText || '').trim();
    if (!name) return;
    if (name.length > 20) {
      wx.showToast({ title: '自定义偏好不超过 20 字', icon: 'none' });
      return;
    }
    const items = this.data.interestItems;
    if (items.some((i) => i.name === name)) {
      wx.showToast({ title: '已经有这个偏好了', icon: 'none' });
      return;
    }
    const onCount = items.filter((i) => i.on).length;
    if (onCount >= 5) {
      wx.showToast({ title: '最多选 5 个偏好', icon: 'none' });
      return;
    }
    const next = items.concat([{ name, on: true }]);
    this.setData({ interestItems: next, customText: '' }, () => saveInterests(next));
  },

  // ---------- 去程 / 返程时刻 ----------

  onGoTime(e) {
    this.setData({ goTime: e.detail.value });
  },

  onBackTime(e) {
    this.setData({ backTime: e.detail.value });
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value });
  },

  // ---------- 提交 ----------

  buildInput() {
    const d = this.data;
    return {
      origin: (d.origin || '').trim(),
      dest: (d.dest || '').trim(),
      startDate: d.startDate,
      endDate: d.endDate,
      startTime: d.goTime,      // 去程时刻（分钟级）
      endTime: d.backTime,      // 返程时刻（分钟级）
      people: d.people,
      party: PARTY[d.partyIdx],
      budget: BUDGET[d.budgetIdx],
      pace: PACE[d.paceIdx],
      transport: TRANSPORT[d.transportIdx],
      interests: d.interestItems.filter((i) => i.on).map((i) => i.name),
      mustGo: (d.mustGo || '').trim(),
      extra: (d.extra || '').trim(),
    };
  },

  checkInput(input) {
    if (!input.dest) return '想去哪儿？先填目的地';
    if (!input.origin) return '填一下出发城市，AI 才知道从哪出发、怎么返程';
    return '';
  },

  async onSubmit() {
    // 防连点：连按两下会并发两次大纲请求，钱花两份、结果还互相覆盖
    if (this.data.generating) return;
    const input = this.buildInput();
    const err = this.checkInput(input);
    if (err) {
      wx.showToast({ title: err, icon: 'none' });
      return;
    }
    const ok = await auth.ensureLogin('制定攻略');
    if (!ok) return;
    this._input = input;
    this.genOutline();
  },

  // 阶段一：出路线大纲
  async genOutline() {
    this.setData({ generating: true });
    this.startTicker('AI 正在规划路线');
    try {
      const res = await api.generateOutline(this._input);
      const days = (res.outline && res.outline.days) || [];
      const outlineDays = days.map((d, i) => ({
        idx: i,
        // 稳定 uid：movable-view 的 wx:key 必须用它。若用 idx 当 key，
        // 重排后组件按 key 复用、内容换家，表现为"松手卡片又弹回去"。
        uid: 'd' + i,
        __src: i,               // 对应 outline.days 的下标，拖动排序后据此重排
        date: d.d || d.date || '',
        theme: d.t || d.theme || '',
        city: d.city || '',
        overnight: d.ov || d.overnight || d.city || '',
        note: d.n || d.note || '',
        moveText: ((d.mv || d.moves) || []).map((m) => {
          const p = [m.c || m.code, `${m.f || m.from || ''}→${m.to || ''}`, `${m.s || m.startTime || ''}${m.e || m.endTime ? '-' + (m.e || m.endTime) : ''}`];
          return p.filter(Boolean).join(' ');
        }).join('；'),
        highlights: (d.hl || d.highlights || []).join(' · '),
        y: i * this._itemH,
      }));
      const areaH = outlineDays.length * this._itemH;
      this.stopTicker();
      this.setData({
        step: 'outline',
        generating: false,
        genTip: '',
        outline: res.outline,
        outlineTitle: res.title || '我的行程',
        outlineSummary: res.summary || '',
        outlineDays,
        areaH,
        listH: Math.min(areaH, this._listMaxH),
        title: res.title,
        summary: res.summary,
      });
    } catch (err) {
      this.stopTicker();
      this.setData({ generating: false, genTip: '' });
      this.showDiag(err);
    }
  },

  // 生成失败时顺手跑一次云函数体检，把"缺哪个环境变量 / 模型连不连得上"
  // 直接弹给用户看 —— 省掉翻云开发日志、来回截图确认的功夫。
  async showDiag(err) {
    const msg = (err && err.message) || '生成失败';
    let report = '';
    try {
      const d = await api.generateDiag();
      const NEED = ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY'];
      // LLM_BASE_URL 是可选项（配了 provider 就不用配），缺了不算问题
      const miss = NEED.filter((k) => !(d.env || {})[k]);
      report = [
        `云函数版本：${d.version || '未知'}`,
        `模型：${d.model || '未取到'}`,
        `端点：${d.baseURL || '未取到'}`,
        `连通性：${d.ping || '未探测'}`,
        miss.length ? `❌ 缺少环境变量：${miss.join('、')}（AMAP_KEY 只影响导航，可后补）` : '✅ 必需环境变量已配齐',
        d.cfgError ? `配置错误：${d.cfgError}` : '',
      ].filter(Boolean).join('\n');
    } catch (e) {
      report = '（云函数体检也失败了，多半是这个云函数还没上传部署）';
    }
    wx.showModal({
      title: msg.slice(0, 20) || '生成失败',
      content: `${msg}\n\n—— 体检报告 ——\n${report}`,
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onRegenOutline() {
    if (this.data.generating) return;   // 同上：别让"换个方案"连点出两个并发请求
    this.genOutline();
  },

  onBackToForm() {
    this.setData({ step: 'form', outline: null });
  },

  // ---------- 大纲：编辑某一天 ----------

  onEditDay(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const d = this.data.outlineDays[idx];
    if (!d) return;
    this.setData({
      dayFormIdx: idx,
      dayForm: {
        theme: d.theme || '',
        city: d.city || '',
        highlights: d.highlights || '',
        overnight: d.overnight || '',
        note: d.note || '',
        moveText: d.moveText || '',
      },
    });
  },

  onDayFormInput(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [`dayForm.${field}`]: e.detail.value });
  },

  onCancelDayForm() {
    this.setData({ dayForm: null, dayFormIdx: -1 });
  },

  // 保存对某一天的修改（同步回 outline，最后生成时用的就是改过的版本）
  onSaveDayForm() {
    const idx = this.data.dayFormIdx;
    const f = this.data.dayForm;
    if (idx < 0 || !f) return;
    const hl = String(f.highlights || '').split(/[、,，·\s]+/).map((s) => s.trim()).filter(Boolean);
    const key = (k) => `outlineDays[${idx}].${k}`;
    this.setData({
      [key('theme')]: f.theme,
      [key('city')]: f.city,
      [key('highlights')]: (f.highlights || '').trim(),
      [key('overnight')]: f.overnight,
      [key('note')]: f.note,
      [key('moveText')]: f.moveText,
      dayForm: null,
      dayFormIdx: -1,
    }, () => {
      this.syncOutlineDay(idx, { theme: f.theme, city: f.city, highlights: hl, overnight: f.overnight, note: f.note });
      wx.showToast({ title: '已更新第 ' + (idx + 1) + ' 天', icon: 'none', duration: 1200 });
    });
  },

  // 把编辑结果写回 this.data.outline（发给云函数的那份数据）
  syncOutlineDay(idx, patch) {
    const outline = this.data.outline;
    if (!outline || !outline.days || !outline.days[idx]) return;
    const day = Object.assign({}, outline.days[idx], { hl: patch.highlights, highlights: patch.highlights });
    day.city = patch.city;
    day.t = patch.theme; day.theme = patch.theme;
    day.ov = patch.overnight; day.overnight = patch.overnight;
    day.n = patch.note; day.note = patch.note;
    const days = outline.days.slice();
    days[idx] = day;
    this.setData({ outline: Object.assign({}, outline, { days }) });
  },

  // ---------- 大纲：拖动排序 ----------

  // 长按卡片进入拖动模式（避免上下滑页面时误拖）
  onDayLongPress(e) {
    if (this.data.generating) return;
    const idx = Number(e.currentTarget.dataset.idx);
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    this._dragStartY = t ? t.clientY : 0;
    this._dragTarget = idx;
    this.setData({
      dragging: true,
      dragIdx: idx,
      dragShift: 0,
      guideTop: idx * (this._itemH || 0),
    });
    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });
  },

  // 拖动中：卡片跟着手指走，实时算出落点并画参考线
  onDayTouchMove(e) {
    if (!this.data.dragging) return;
    const idx = this.data.dragIdx;
    const n = this.data.outlineDays.length;
    const h = this._itemH || 1;
    const t = (e.touches && e.touches[0]) || {};
    if (typeof t.clientY !== 'number') return;

    // 位移限制在列表内，拖不出界
    let dy = t.clientY - this._dragStartY;
    dy = Math.max(-idx * h, Math.min((n - 1 - idx) * h, dy));

    // 落点 = 有几张"其他"卡片的顶部在这张卡上方（i*h < 拖动卡当前顶部）
    const pos = idx + dy / h;
    let target = 0;
    for (let i = 0; i < n; i++) {
      if (i !== idx && i < pos) target++;
    }
    target = Math.max(0, Math.min(n - 1, target));

    const shift = Math.round(dy);
    if (shift === this.data.dragShift && target === this._dragTarget) return; // 节流
    this._dragTarget = target;
    this.setData({ dragShift: shift, guideTop: target * h });
  },

  // 松手：落到参考线所在位置
  onDayTouchEnd() {
    if (!this.data.dragging) return;
    const idx = this.data.dragIdx;
    const target = typeof this._dragTarget === 'number' ? this._dragTarget : idx;
    this.setData({ dragging: false, dragIdx: -1, dragShift: 0 });
    this._dragTarget = null;
    if (target === idx) return;   // 没换位置
    const list = this.data.outlineDays.slice();
    const moved = list.splice(idx, 1)[0];
    list.splice(target, 0, moved);
    this.applyDayOrder(list);
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
  },

  // 重排后统一刷新：序号 / 日期 / 纵坐标 / 云函数用的 outline
  applyDayOrder(list) {
    const h = this._itemH || 1;
    const outlineDays = list.map((d, i) => Object.assign({}, d, {
      idx: i,
      date: plusDays(this.data.startDate, i),   // 日期跟着顺序重新连续排
      y: i * h,
    }));
    const endDate = outlineDays.length ? outlineDays[outlineDays.length - 1].date : this.data.startDate;

    // 云函数用的 outline.days 也按新顺序重排，并重算每天日期
    const outline = this.data.outline;
    let newDays = null;
    const srcDays = (outline && outline.days) || [];
    if (srcDays.length === outlineDays.length) {
      newDays = outlineDays.map((d) => {
        const src = srcDays[d.__src == null ? d.idx : d.__src] || srcDays[d.idx];
        return src ? Object.assign({}, src, { d: d.date, date: d.date }) : null;
      }).filter(Boolean);
    }

    this.setData({
      outlineDays,
      areaH: outlineDays.length * h,
      endDate,
      endRange: pickRange(endDate),
      endVal: pickVal(endDate),
      outline: newDays ? Object.assign({}, outline, { days: newDays }) : outline,
    }, () => this.updateDaysText());
  },

  // ---------- 阶段二：展开逐天详情并入库 ----------
  //
  // 无感续跑：云函数一次最多跑 45 秒，天多的时候会返回 partial=true
  // （已生成的天已经存进库里了）。这里立刻接着调下一次，loading 文案与遮罩
  // 全程不中断，用户只会觉得"AI 一直在细化"，感觉不到中间续过。
  async onConfirmOutline() {
    if (this.data.generating) return;
    this.setData({ generating: true });
    this.startTicker('正在细化每天的安排');

    const base = Object.assign({}, this._input, {
      title: this.data.title,
      summary: this.data.summary,
      outline: this.data.outline,
    });
    const totalDays = this.data.outlineDays.length || 1;

    let result = null;
    let payload = base;
    let attempts = {};        // 每轮云函数回传的失败次数，下一轮原样带回（决定谁能再重试）
    try {
      for (let round = 0; round < 6; round++) {
        const res = await api.buildPlan(payload, payload);
        result = res;
        if (!res || !res.partial) break;
        attempts = res.attempts || attempts;
        const done = (res.doneDayIndexes || []).length;
        this.setTipExtra(`已细化 ${Math.min(done, totalDays)}/${totalDays} 天`);
        // 还有天没生成完（或某天失败要重试）：带上 tripId 继续，loading 全程不中断
        payload = Object.assign({}, base, {
          tripId: res.tripId,
          doneDayIndexes: res.doneDayIndexes || [],
          attempts,
        });
      }
      if (!result || !result.tripId) throw new Error('生成失败，请重试');
      this.stopTicker();

      app.globalData.currentTripId = result.tripId;
      homeCache.clear();
      this.gotoTrip(result);
    } catch (err) {
      this.stopTicker();
      this.setData({ generating: false, genTip: '' });
      this.showDiag(err);
    }
  },

  // 生成完直接进攻略详情（整份展开），而不是回首页 —— 刚生成的攻略，
  // 用户第一眼想看的就是内容本身。返回时回到「我的」。
  gotoTrip(result) {
    const gaveUp = result.gaveUpDayIndexes || [];
    const go = () => {
      // 用 redirectTo 而不是 switchTab：itinerary 不是 tab 页，
      // 替换掉向导页后返回栈更干净（不会退回已经没用的大纲页）
      wx.redirectTo({ url: `/pages/itinerary/itinerary?tripId=${result.tripId}&all=1` });
    };
    if (gaveUp.length) {
      // 有几天重试 3 次都没生成出来：明确告诉用户是哪几天，别让他自己发现行程少了
      wx.showModal({
        title: '有几天没生成出来',
        content: `第 ${gaveUp.map((i) => i + 1).join('、')} 天 AI 几次都没生成成功，已跳过。\n` +
          `其余 ${result.itemCount} 条安排都在，你可以在行程页手动补这几天。`,
        showCancel: false,
        confirmText: '去看看',
        success: go,
      });
      return;
    }
    wx.showToast({ title: '攻略已生成', icon: 'success' });
    setTimeout(go, 800);
  },
});
