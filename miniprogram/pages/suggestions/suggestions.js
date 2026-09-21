// pages/suggestions/suggestions.js
const api = require('../../services/api');
const homeCache = require('../../utils/homecache');

const app = getApp();

// 建议快照缓存 key
const CACHE_KEY = 'suggestions';

// LLM 偶尔会把某个字段（尤其 budget）输出成对象/数组而不是字符串，
// 直接渲染会变成 [object Object]。这里统一拍平成可读文本。
function toText(v, depth) {
  depth = depth || 0;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (depth > 3) return ''; // 防御：异常深层嵌套直接丢弃
  if (Array.isArray(v)) {
    return v.map((it) => toText(it, depth + 1)).filter(Boolean).join('\n');
  }
  // 普通对象 → 「键：值」逐行
  return Object.keys(v)
    .map((k) => {
      const val = toText(v[k], depth + 1);
      if (!val) return '';
      // 值本身有多行时，首行接在键后面，其余行缩进
      const lines = val.split('\n');
      return lines.length === 1
        ? `${k}：${lines[0]}`
        : `${k}：\n${lines.map((l) => (l ? '  ' + l : l)).join('\n')}`;
    })
    .filter(Boolean)
    .join('\n');
}

function normalize(list) {
  if (!list || typeof list !== 'object') return list;
  const out = {};
  ['weather', 'gear', 'food', 'tips', 'transport', 'budget'].forEach((k) => {
    out[k] = toText(list[k]);
  });
  out.generatedAt = list.generatedAt || '';
  return out;
}

Page({
  data: {
    loading: true,
    generating: false,   // AI 正在生成建议（区别于普通加载）
    refreshing: false,
    suggestions: null,
  },

  onShow() {
    this.load();
  },

  async load() {
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      this.setData({ loading: false, suggestions: null });
      return;
    }

    // 换了行程 → 旧快照作废
    if (this._tripId !== tripId) {
      this._tripId = tripId;
      this._sig = '';
    }

    // ① 先用本地快照秒开，有缓存就不转圈
    if (!this._sig) {
      const snap = homeCache.readPage(CACHE_KEY);
      if (snap && snap.tripId === tripId && snap.suggestions) {
        const cached = normalize(snap.suggestions);
        this._sig = JSON.stringify({ tripId, suggestions: cached });
        this.setData({ loading: false, suggestions: cached });
      } else {
        this.setData({ loading: true });
      }
    }

    try {
      let list = normalize(await api.getSuggestions(tripId));
      // 没有建议时自动生成一次（约 10-20 秒，带生成中提示）
      // 注意：这是最慢的一步，同一个行程 12 小时内只自动尝试一次，
      // 否则每次切到这个 tab 都要重跑一遍大模型
      const empty = !list || (!list.weather && !list.food);
      if (empty && homeCache.shouldAutoTry(tripId)) {
        homeCache.markAutoTried(tripId);
        this.setData({ loading: true, generating: true });
        try {
          list = normalize(await api.refreshSuggestions(tripId));
        } catch (e) {
          // 生成失败就用原来的空结果，页面会显示空态 + 手动刷新按钮
          console.warn('[suggestions] 自动生成失败:', e.message);
        }
        this.setData({ generating: false });
      }
      // 已自动尝试过（12 小时内）→ 直接显示空态，不再白等，由用户手动刷新

      // ② 内容没变就不 setData
      const snap = { tripId, suggestions: list || null };
      const sig = JSON.stringify(snap);
      if (sig !== this._sig) {
        this._sig = sig;
        this.setData({ suggestions: list || null });
        // 只缓存有内容的，空结果不写（否则空态会被当成"已有数据"）
        if (list && (list.weather || list.food)) homeCache.writePage(CACHE_KEY, snap);
      }
      this.setData({ loading: false });
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  async onRefresh() {
    const tripId = app.globalData.currentTripId;
    if (!tripId) {
      wx.showToast({ title: '请先上传攻略', icon: 'none' });
      return;
    }
    this.setData({ refreshing: true });
    try {
      await api.refreshSuggestions(tripId);
      // 手动刷新：清掉快照和自动尝试标记，下一轮 load 直接拿新数据
      homeCache.clearPage(CACHE_KEY);
      homeCache.clearAutoTried(tripId);
      this._sig = '';
      await this.load();
      wx.showToast({ title: '已更新', icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err.message || '更新失败', icon: 'none' });
    } finally {
      this.setData({ refreshing: false });
    }
  },
});