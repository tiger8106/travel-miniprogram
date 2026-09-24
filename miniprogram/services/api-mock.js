// services/api-mock.js
// Mock 版本的 API，所有方法返回内存数据，不调用云函数
const { STORE, TRIP_ID } = require('./mock-data');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 攻略解析（模拟 AI 解析的延迟）
// ============================================================================
async function parseTravelPlan(/* fileID */) {
  await delay(1500);
  return {
    tripId: TRIP_ID,
    title: STORE.itinerary.title,
    subtitle: STORE.itinerary.subtitle,
    startDate: STORE.itinerary.startDate,
    endDate: STORE.itinerary.endDate,
    days: STORE.itinerary.days,
    tripTitle: STORE.itinerary.title,
    itemCount: STORE.itinerary.items.length,
    alarmCount: STORE.alarms.length,
    suggestions: STORE.suggestions,
  };
}

// ============================================================================
// 行程 CRUD
// ============================================================================
async function saveItinerary(payload) {
  await delay(300);
  if (payload && payload.items) {
    STORE.itinerary.items = payload.items;
  }
  if (payload && payload.title) STORE.itinerary.title = payload.title;
  return { tripId: TRIP_ID };
}

async function getItinerary(tripId) {
  await delay(200);
  if (tripId !== TRIP_ID) return null;
  return JSON.parse(JSON.stringify(STORE.itinerary));
}

async function listItineraries() {
  await delay(150);
  return [JSON.parse(JSON.stringify(STORE.itinerary))];
}

async function updateItinerary(tripId, patch) {
  await delay(200);
  if (tripId !== TRIP_ID) throw new Error('行程不存在');
  if (patch.op === 'addItem') {
    const newItem = {
      _id: 'it_' + Date.now(),
      dayIndex: patch.item.dayIndex,
      startTime: patch.item.startTime || '',
      endTime: patch.item.endTime || '',
      activity: patch.item.activity || '',
      startLocation: patch.item.startLocation || '',
      endLocation: patch.item.endLocation || '',
      transportType: patch.item.transportType || 'car',
      category: patch.item.category || 'sight',
      note: patch.item.note || '',
    };
    STORE.itinerary.items.push(newItem);
    return { ok: true, item: newItem };
  }
  if (patch.op === 'updateItem') {
    const idx = STORE.itinerary.items.findIndex((i) => i._id === patch.item._id);
    if (idx >= 0) STORE.itinerary.items[idx] = { ...STORE.itinerary.items[idx], ...patch.item };
    return { ok: true };
  }
  if (patch.op === 'deleteItem') {
    STORE.itinerary.items = STORE.itinerary.items.filter((i) => i._id !== patch.itemId);
    return { ok: true };
  }
  return { ok: true };
}

async function deleteItinerary(tripId) {
  await delay(200);
  return { ok: true };
}

// ============================================================================
// 闹钟 CRUD
// ============================================================================
async function saveAlarms(tripId, alarms) {
  await delay(200);
  STORE.alarms = alarms || [];
  return { ok: true };
}

async function listAlarms(tripId) {
  await delay(200);
  return JSON.parse(JSON.stringify(STORE.alarms));
}

async function updateAlarm(alarmId, patch) {
  await delay(200);
  const idx = STORE.alarms.findIndex((a) => a._id === alarmId);
  if (idx >= 0) {
    STORE.alarms[idx] = { ...STORE.alarms[idx], ...patch };
    return { ok: true };
  }
  // 找不到就新增
  const newAlarm = {
    _id: alarmId,
    tripId: TRIP_ID,
    title: patch.title || '新闹钟',
    fireAt: patch.fireAt || '',
    triggerAt: patch.triggerAt || Date.now(),
    leadMinutes: patch.leadMinutes || 5,
    note: patch.note || '',
  };
  STORE.alarms.push(newAlarm);
  return { ok: true, alarm: newAlarm };
}

async function deleteAlarm(alarmId) {
  await delay(200);
  STORE.alarms = STORE.alarms.filter((a) => a._id !== alarmId);
  return { ok: true };
}

// ============================================================================
// 旅行建议
// ============================================================================
async function getSuggestions(tripId) {
  await delay(200);
  return JSON.parse(JSON.stringify(STORE.suggestions));
}

async function refreshSuggestions(tripId) {
  await delay(1500);  // 模拟 AI 重生成
  // 重新生成时随机打乱建议顺序（模拟"新内容"）
  const shuffled = (arr) => [...arr].sort(() => Math.random() - 0.5);
  STORE.suggestions = {
    ...STORE.suggestions,
    generatedAt: Date.now(),
    food: shuffled(STORE.suggestions.food),
    play: shuffled(STORE.suggestions.play),
  };
  return JSON.parse(JSON.stringify(STORE.suggestions));
}

// ============================================================================
// 上传 / 下载 —— mock 直接假装成功
// ============================================================================
async function uploadDoc(localPath) {
  await delay(500);
  return 'cloud://mock/' + (localPath || 'mock.docx');
}

async function downloadFromCloud(fileID) {
  await delay(300);
  return '/tmp/mock-file.docx';
}

// 按天的建议与注意事项（mock 版本）
async function getDayTips(tripId, dayIndex, force) {
  await delay(force ? 1500 : 300);
  const pool = [
    { tips: ['早上 7:30 出发，预留 40 分钟打车到南宁东站', '午餐在青瓦房·古村人家解决，人均 60', '下午北海银沙滩紫外线强，带防晒衣'], notices: ['G2249 次 09:28 发车，开车前 5 分钟停止检票', '海边风大，帽子眼镜注意保管'] },
    { tips: ['涠洲岛船票提前 30 分钟到码头取票', '上岛后先租电瓶车，一天 80 元砍到 60', '滴水丹屏日落 18:40 左右，提前占机位'], notices: ['北游 25 船容易晕，提前吃晕船药', '岛上医疗点少，带好常用药'] },
    { tips: ['早晨 6:20 退房赶高铁，前一晚收拾好行李', '德天瀑布下午 3 点后光线最适合拍照', '返程预留 2.5 小时车程'], notices: ['国庆高速可能拥堵，导航实时看路况', '身份证、车票统一放一个证件包'] },
  ];
  const d = pool[Number(dayIndex) % pool.length];
  return { code: 0, data: d };
}

// AI 制定新攻略（mock 版：返回一个假大纲，第二步直接假装成功）
async function generateOutline(input) {
  await delay(1200);
  const days = [];
  const start = new Date(input.startDate || Date.now());
  const n = input.days || 3;
  for (let i = 0; i < n; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const p = (x) => (x < 10 ? '0' + x : '' + x);
    days.push({
      d: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      city: input.dest || '目的地',
      t: i === 0 ? '抵达目的地，市区慢逛' : i === n - 1 ? '返程' : '深度游玩',
      mv: [],
      hl: ['主景区', '老街', '本地美食'],
      ml: ['当地特色菜'],
      ov: input.dest || '目的地',
      n: '',
    });
  }
  return {
    title: `${input.dest || '目的地'}${n}日游`,
    summary: 'mock 模式的示例行程',
    startDate: input.startDate,
    endDate: input.endDate,
    days: n,
    outline: { days },
  };
}

async function buildPlan() {
  await delay(1500);
  return { tripId: 'mock-trip', itemCount: 12, alarmCount: 2, mock: true };
}

module.exports = {
  parseTravelPlan,
  // mock 模式没有真实地理编码，返回 null 让前端走降级
  geocode: async function () { await delay(200); return null; },
  saveItinerary,
  getItinerary,
  listItineraries,
  updateItinerary,
  deleteItinerary,
  saveAlarms,
  listAlarms,
  updateAlarm,
  deleteAlarm,
  // mock 模式下没有真实推送，直接返回成功
  sendTestAlarm: async function () { await delay(300); return { code: 0, data: { mock: true } }; },
  getAlarmStatus: async function () {
    await delay(200);
    return { code: 0, data: { deployTag: 'mock', hasTemplateId: false, tmplState: 'mock 模式' } };
  },
  getSuggestions,
  refreshSuggestions,
  getDayTips,
  generateOutline,
  buildPlan,
  // mock 模式没有真实云函数，体检直接返回"全部就绪"，方便本地跑通界面
  generateDiag: async function () {
    await delay(200);
    return {
      version: 'mock',
      env: { LLM_PROVIDER: true, LLM_BASE_URL: false, LLM_MODEL: true, LLM_API_KEY: true, AMAP_KEY: true },
      provider: 'mock', model: 'mock-model', baseURL: 'mock://', cfgError: '', ping: '正常（mock）',
    };
  },
  uploadDoc,
  downloadFromCloud,
};