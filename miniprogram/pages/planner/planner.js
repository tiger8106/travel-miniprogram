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
    areaH: 0,                     // 拖动区总高度
    dayForm: null,                // 正在编辑的那一天（null = 抽屉关闭）
    dayFormIdx: -1,
  },

  onLoad() {
    this._offAuth = auth.watch(this, {});
    // 兴趣偏好从本地恢复：上次 ✕ 掉的不再出现，没删的（选没选都算）全保留
    this.setData({ interestItems: loadInterests() });
    // 拖动排序用：卡片高度固定 240rpx，换算成 px
    const winW = (wx.getWindowInfo && wx.getWindowInfo().windowWidth) || 375;
    this._itemH = Math.round((winW / 750) * 240);
    this.setData({ itemH: this._itemH });
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
      this.setData({
        step: 'outline',
        generating: false,
        genTip: '',
        outline: res.outline,
        outlineTitle: res.title || '我的行程',
        outlineSummary: res.summary || '',
        outlineDays,
        areaH: outlineDays.length * this._itemH,
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

  onDayMove(e) {
    if (e.detail && e.detail.source && e.detail.source !== 'touch') return;
    this._dragY = e.detail.y;
    this._dragIdx = Number(e.currentTarget.dataset.idx);
  },

  // 松手：按落点算出目标位置 → 重排 → 自动重算第几天和日期
  onDayMoveEnd(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const y = typeof this._dragY === 'number' ? this._dragY : idx * this._itemH;
    const h = this._itemH || 1;
    let target = Math.round(y / h);
    target = Math.max(0, Math.min(this.data.outlineDays.length - 1, target));
    this._dragY = null;
    if (target === idx) {
      // 没换位置：把卡片弹回原位
      this.setData({ [`outlineDays[${idx}].y`]: idx * h });
      return;
    }
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
    this.setData({ generating: true, genTip: '正在细化每天的安排…' });

    const base = Object.assign({}, this._input, {
      title: this.data.title,
      summary: this.data.summary,
      outline: this.data.outline,
    });

    let result = null;
    let payload = base;
    try {
      for (let round = 0; round < 6; round++) {
        const res = await api.buildPlan(payload, payload);
        result = res;
        if (!res || !res.partial) break;
        // 还有天没生成完：带上 tripId 和已完成的天继续，界面上不做任何提示
        payload = Object.assign({}, base, {
          tripId: res.tripId,
          doneDayIndexes: res.doneDayIndexes || [],
        });
        this.setData({ genTip: '正在细化每天的安排…' });
      }
      if (!result || !result.tripId) throw new Error('生成失败，请重试');

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
