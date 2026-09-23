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

const PARTY = ['独自出行', '情侣出行', '朋友结伴', '亲子出行', '带父母'];
const BUDGET = ['经济实惠', '舒适适中', '品质优选'];
const PACE = ['轻松慢游', '劳逸适中', '紧凑充实'];
const TRANSPORT = ['高铁优先', '飞机优先', '自驾/包车', '大巴/直通车'];
const INTERESTS = [
  '自然山水', '古镇古村', '城市漫游', '博物馆展览',
  '亲子乐园', '当地美食', '拍照打卡', '徒步户外',
  '温泉度假', '海岛海滨', '宗教古迹', '夜生活',
];

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
    todayStr: todayStr(),
    daysText: '3 天 2 晚',
    people: 2,
    partyIdx: 1,
    partyOptions: PARTY,
    budgetIdx: 1,
    budgetOptions: BUDGET,
    paceIdx: 1,
    paceOptions: PACE,
    transportIdx: 0,
    transportOptions: TRANSPORT,
    interests: INTERESTS,
    interestOn: [0, 5, 6],   // 默认勾：自然山水 / 当地美食 / 拍照打卡
    mustGo: '',
    extra: '',

    // ---- 大纲 ----
    outline: null,
    outlineTitle: '',
    outlineSummary: '',
    outlineDays: [],
  },

  onLoad() {
    this._offAuth = auth.watch(this, {});
    this.updateDaysText();
  },

  onUnload() {
    if (this._offAuth) { this._offAuth(); this._offAuth = null; }
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

  // ---------- 表单交互 ----------

  updateDaysText() {
    const n = diffDays(this.data.startDate, this.data.endDate);
    this.setData({ daysText: `${n} 天 ${n - 1} 晚` });
  },

  onStartDate(e) {
    const v = e.detail.value;
    let end = this.data.endDate;
    if (diffDays(v, end) <= 0) end = plusDays(v, 1);
    this.setData({ startDate: v, endDate: end }, () => this.updateDaysText());
  },

  onEndDate(e) {
    const v = e.detail.value;
    let n = diffDays(this.data.startDate, v);
    if (n <= 0) return;                       // 结束日期不能早于出发日
    if (n > MAX_DAYS) {
      wx.showToast({ title: `最多支持 ${MAX_DAYS} 天`, icon: 'none' });
      this.setData({ endDate: plusDays(this.data.startDate, MAX_DAYS - 1) });
      n = MAX_DAYS;
    } else {
      this.setData({ endDate: v });
    }
    setTimeout(() => this.updateDaysText(), 0);
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
      case 'party': this.setData({ partyIdx: idx }); break;
      case 'budget': this.setData({ budgetIdx: idx }); break;
      case 'pace': this.setData({ paceIdx: idx }); break;
      case 'transport': this.setData({ transportIdx: idx }); break;
    }
  },

  onToggleInterest(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const on = this.data.interestOn.slice();
    const at = on.indexOf(idx);
    if (at >= 0) on.splice(at, 1);
    else {
      if (on.length >= 5) {
        wx.showToast({ title: '最多选 5 个偏好', icon: 'none' });
        return;
      }
      on.push(idx);
    }
    this.setData({ interestOn: on.sort((a, b) => a - b) });
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
      people: d.people,
      party: PARTY[d.partyIdx],
      budget: BUDGET[d.budgetIdx],
      pace: PACE[d.paceIdx],
      transport: TRANSPORT[d.transportIdx],
      interests: d.interestOn.map((i) => INTERESTS[i]),
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
    this.setData({ generating: true, genTip: 'AI 正在规划路线…' });
    try {
      const res = await api.generateOutline(this._input);
      const days = (res.outline && res.outline.days) || [];
      const outlineDays = days.map((d, i) => ({
        idx: i,
        date: d.d || d.date || '',
        theme: d.t || d.theme || '',
        city: d.city || '',
        overnight: d.ov || d.overnight || d.city || '',
        highlights: (d.hl || d.highlights || []).join(' · '),
      }));
      this.setData({
        step: 'outline',
        generating: false,
        genTip: '',
        outline: res.outline,
        outlineTitle: res.title || '我的行程',
        outlineSummary: res.summary || '',
        outlineDays,
        title: res.title,
        summary: res.summary,
      });
    } catch (err) {
      this.setData({ generating: false, genTip: '' });
      wx.showToast({ title: err.message || '路线规划失败', icon: 'none', duration: 3000 });
    }
  },

  onRegenOutline() {
    this.genOutline();
  },

  onBackToForm() {
    this.setData({ step: 'form', outline: null });
  },

  // 阶段二：展开逐天详情并入库
  async onConfirmOutline() {
    if (this.data.generating) return;
    this.setData({ generating: true, genTip: '正在细化每天的安排…' });
    try {
      const payload = Object.assign({}, this._input, {
        title: this.data.title,
        summary: this.data.summary,
        outline: this.data.outline,
      });
      const result = await api.buildPlan(payload, payload);
      wx.showToast({ title: '攻略已生成', icon: 'success' });
      app.globalData.currentTripId = result.tripId;
      homeCache.clear();
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 800);
    } catch (err) {
      this.setData({ generating: false, genTip: '' });
      wx.showToast({ title: err.message || '生成失败', icon: 'none', duration: 3000 });
    }
  },
});
