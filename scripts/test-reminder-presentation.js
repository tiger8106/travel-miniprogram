// 离线验证：用户提示不泄露诊断，旧/新攻略提醒共享展示规则、不改票务原记录。
// 可选：--replay <既有模型结果.json>（仅展示重放，不调用模型或微信）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { alarmTitleOf, alarmNotificationTitleOf } = require('../miniprogram/utils/alarm-title');
const { userErrorMessage } = require('../miniprogram/utils/user-error');
const root = path.resolve(__dirname, '..');
let passed = 0;
function equal(actual, expected, message) {
  assert.strictEqual(actual, expected, message);
  passed++;
}
const train = Object.freeze({
  _id: 'train-1', type: 'train', completed: true, leadMinutes: 10,
  title: '准备2027-09-30 重庆北→桂林西（G2249）（车票）',
  usageInfo: '乘车日期：2027-09-30；时间：14:44–19:38；重庆北→桂林西（G2249）',
  bookingInfo: '重庆北→桂林西（G2249）', fireAtStr: '2027-09-16 11:00',
  fireAt: Date.now() + 600000, note: '原文起售时间，开售后去12306确认。',
});
const expectedTrain = '2027-09-30 14:44–19:38 重庆北→桂林西（G2249）';
equal(alarmTitleOf(train), expectedTrain, '车票仅使用日、运行时间、路线和车次');
equal(alarmNotificationTitleOf(train), '09-30 G2249 重庆北→桂林西', '订阅消息20字限制内保留日期车次及路线');
const generated = {
  type: 'train', title: '预计开售：返程火车票：苏州站→上海站（参考车次 G7281）',
  usageInfo: '乘车日期：2026-11-11；时间：17:29-18:07；G7281；路线：苏州站→上海站',
  bookingInfo: '苏州站→上海站 G7281',
};
equal(alarmTitleOf(generated), '2026-11-11 17:29-18:07 苏州站→上海站 G7281', '生成路线不带开售、返程火车票前缀');
equal(alarmTitleOf({ type: 'train', title: '开抢2027-09-30 G2249 重庆北→桂林西' }),
  '2027-09-30 G2249 重庆北→桂林西', '旧记录没有结构化信息时不丢车次');
equal(alarmTitleOf({ type: 'ticket', title: '核验2027-10-01 龙脊梯田门票/预约' }),
  '2027-10-01 龙脊梯田门票', '门票清理核验及预约');
equal(alarmTitleOf({ type: 'ticket', title: '其他生成标题', ticketProduct: '龙脊梯田景区索道票',
  usageInfo: '使用时间：2027-10-01 15:30；龙脊梯田景区索道票' }),
  '2027-10-01 15:30 龙脊梯田景区索道票', '独立索道票产品优先');
equal(alarmTitleOf({ type: 'ticket', title: '预约提醒', ticketProduct: '象鼻山免费入园预约',
  visitDate: '2027-10-02' }), '2027-10-02 象鼻山免费入园', '免费信息保留，不冒充付费门票');
equal(alarmTitleOf({ type: 'ticket', title: '预计开放预约/购票：拙政园门票/预约放票',
  usageInfo: '使用时间：2026-11-10 11:30-11:45；核验预约码、身份证入园' }),
  '2026-11-10 11:30-11:45 拙政园门票', '使用说明不替换真实门票名称');
equal(alarmTitleOf({ type: 'ticket', title: '预约2027-10-06 游览德天瀑布（观景台、界碑）及午餐' }),
  '2027-10-06 德天瀑布', '游线/餐饮不混入门票标题');
equal(alarmTitleOf({ type: 'ticket', title: '预计开放预约/购票：狮子林：体验假山迷宫景区门票/预约放票' }),
  '狮子林门票', '旧门票标题中的游览文案清理');
equal(alarmTitleOf({ type: 'bus', title: '准备2027-10-01 大巴〔接送酒店→停车场〕（车票）',
  usageInfo: '乘车日期：2027-10-01；时间：08:00–10:30；乘坐桂林站→金坑大寨的直通车' }),
  '2027-10-01 08:00–10:30 桂林站→金坑大寨直通车', '汽车用实际路线，不把酒店接送点塞进标题');
equal(alarmTitleOf({ type: 'bus', title: '准备2027-10-06 在游客中心购买第二天前往德天瀑布的公交车票',
  visitDate: '2027-10-06' }), '2027-10-06 德天瀑布公交', '汽车准备动作清理，不猜缺失班次');
equal(alarmTitleOf({ type: 'hotel', title: '梵泊美地酒店（桂林两江四湖象鼻山景区店）' }),
  '梵泊美地酒店（桂林两江四湖象鼻山景区店）', '酒店标题不改');
equal(alarmTitleOf({ type: 'other', title: '准备证件和药品' }), '准备证件和药品', '其他准备事项不误清理');
equal(alarmTitleOf({ type: 'ticket', title: '核验2027-10-01 并州古城门票' }),
  '2027-10-01 并州古城门票', '地名里的并字不是附加活动');
equal(alarmTitleOf({ type: 'train', title: 'G2249 重庆北→桂林西', fireAtStr: '2027-09-16 11:00' }),
  'G2249 重庆北→桂林西', '没有使用日期时不拿放票时间凑标题');
const editedTicket = { type: 'ticket', title: '2027-10-01 10:40 龙脊梯田门票',
  usageInfo: '使用时间：2027-10-01 10:40；龙脊梯田' };
equal(alarmTitleOf(editedTicket), editedTicket.title, '已精简并保存的标题再次展示不重复时间');
equal(alarmTitleOf({ type: 'ticket', title: editedTicket.title }), editedTicket.title, '无结构化信息的精简标题不丢时间');
equal(fs.readFileSync(path.join(root, 'miniprogram/utils/alarm-title.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'cloudfunctions/sendAlarm/alarm-title.js'), 'utf8'), '独立部署副本保持一致');

const rawError = 'cloud.callFunction:fail -504003 (trace: start->poll result expired)\n—— 体检报告 ——\n模型 qwen endpoint https://internal.invalid/v1 LLM_API_KEY';
for (const raw of [new Error(rawError), { errMsg: rawError }, rawError]) {
  const msg = userErrorMessage(raw, '请稍后重试。');
  assert(!/cloud|trace|体检|qwen|endpoint|LLM|https/i.test(msg));
  passed++;
}
equal(userErrorMessage(new Error('额度不足')), '可用次数不足，请查看我的额度。', '额度错误保持可执行提示');
equal(userErrorMessage(new Error('请先登录')), '请重新登录后再试。', '保留登录引导');
equal(userErrorMessage(new Error('暂未读取到结果'), '后台解析中，请稍后返回查看。'),
  '后台解析中，请稍后返回查看。', '读取进度失败不宣称任务中断');
equal(userErrorMessage(new Error(rawError), '后台解析中，请稍后返回查看。'),
  '后台解析中，请稍后返回查看。', 'SDK 结果过期不误判持久化任务过期');
for (const name of ['index', 'mytrips']) {
  const markup = fs.readFileSync(path.join(root, `miniprogram/pages/${name}/${name}.wxml`), 'utf8');
  assert(!/\{\{[^}]*\.(?:genError|error)[^}]*\}\}/.test(markup), '首页/我的行程不回显后台原始错误（包括旧快照）');
  passed++;
}

const modals = [];
let calendar;
let diagCalls = 0;
global.wx = { getStorageSync: () => 5, showModal: (m) => modals.push(m),
  addPhoneCalendar: (o) => { calendar = o; o.success({}); } };
const alarm = require('../miniprogram/utils/alarm');
function page(relative, extras = {}) {
  const filename = path.join(root, relative);
  let p;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    console: { log() {}, error() {} }, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    wx: global.wx, getApp: () => ({ globalData: {} }), Page: (o) => { p = o; },
    require(name) {
      if (name.endsWith('/api')) return { generateDiag: async () => { diagCalls++; }, ...extras.api };
      return require(path.resolve(path.dirname(filename), name));
    },
  }, { filename });
  p.setData = (patch) => Object.assign(p.data, patch);
  return p;
}

(async () => {
  const planner = page('miniprogram/pages/planner/planner.js');
  await planner.showGenerationError(new Error(rawError));
  equal(diagCalls, 0, '用户失败流程不额外调用体检');
  assert(!/cloud|trace|体检|模型|端点|环境变量/.test(JSON.stringify(modals.at(-1)))); passed++;
  const upload = page('miniprogram/pages/upload/upload.js');
  upload.showTaskStatus({ status: 'failed', error: rawError });
  assert(!/cloud|trace|体检|模型|端点|环境变量/.test(upload.data.errorMsg)); passed++;
  equal(upload.data.parsing, false, '失败状态仍能展示重试，不掩盖任务失败');
  const before = JSON.stringify(train);
  await alarm.addToCalendar(train);
  equal(calendar.title, expectedTrain, '系统日历使用同一简洁标题');
  equal(calendar.startTime, Math.floor(alarm.actionAtOf(train) / 1000), '日历仍在办理时刻提醒，不是乘车时刻');
  equal(alarm.alarmPopupContent(train, 'advance').split('\n')[0], expectedTrain, '前台提醒弹窗同样清理');
  let component;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/components/ticket-alarm/ticket-alarm.js'), 'utf8'), {
    require: () => ({ alarmTitleOf }), Component: (o) => { component = o; },
  });
  const view = { setData: (data) => { view.data = data; } };
  component.observers.item.call(view, train);
  equal(view.data.displayTitle, expectedTrain, '分类卡片直接兼容旧原始记录');
  const tickets = page('miniprogram/pages/tickets/tickets.js');
  const views = tickets.buildViews([{ ...train, completed: false, remindAt: Date.now(), remindFriendly: '今天' }]);
  equal(views.nowAlarms[0].displayTitle, expectedTrain, '缓存首帧的正在进行标题');
  equal(views.groups[0].nextTitle, expectedTrain, '缓存首帧的分类摘要标题');
  equal(JSON.stringify(train), before, '原始标题、票务字段、时间、已完成状态不变');

  // 定时推送桩：核对真实入口组装的数据，不发送微信消息。
  let pushed;
  let marked = false;
  const row = { ...train, completed: false, fireAt: Date.now() + 300000, leadMinutes: 5, _openid: 'test' };
  const db = { command: { and() {}, gte() {}, lte() {}, neq() {} }, collection: () => ({
    where: () => ({ limit: () => ({ get: async () => ({ data: [row] }) }) }),
    doc: () => ({ update: async () => { marked = true; } }),
  }) };
  const cloud = { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db, getWXContext: () => ({ OPENID: 'test' }),
    openapi: { subscribeMessage: { send: async (msg) => { pushed = msg; } } } };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions/sendAlarm/index.js'), 'utf8'), {
    exports, process: { env: { SUBSCRIBE_TEMPLATE_ID: 'test' } }, Date, console,
    require: (name) => name === 'wx-server-sdk' ? cloud : require('../cloudfunctions/sendAlarm/alarm-title'),
  });
  const result = await exports.main({});
  equal(result.data.sent, 1, '定时推送仍成功并标记已发送');
  equal(marked, true, '通知状态仍保存');
  assert(Object.values(pushed.data).some((o) => o.value === alarmNotificationTitleOf(train))); passed++;
  const testResult = await exports.main({ ...train, action: 'test', templateId: 'test' });
  equal(testResult.code, 0, '显式推送测试入口仍可用');
  assert(Object.values(pushed.data).some((o) => o.value === alarmNotificationTitleOf(train))); passed++;
  const replayAt = process.argv.indexOf('--replay');
  if (replayAt >= 0) {
    const source = JSON.parse(fs.readFileSync(process.argv[replayAt + 1], 'utf8'));
    for (const item of source.alarms || []) {
      const snapshot = JSON.stringify(item);
      const display = alarmTitleOf(item);
      assert(display, '展示标题非空');
      equal(alarmTitleOf({ ...item, title: display }), display, '编辑保存后的展示幂等');
      if (['train', 'plane', 'bus', 'ticket', 'ship'].includes(item.type)) {
        assert(!/准备|核验|预约|预订|放票|开售|开抢/.test(display), display);
        if (['train', 'plane', 'bus'].includes(item.type)) assert(!/车票/.test(display), display);
      }
      equal(JSON.stringify(item), snapshot, '重放不修改原记录');
      console.log(`[${item.type}] ${display}`);
    }
    console.log('以上仅对已有模型结果做展示重放，未重新调用模型或微信。');
  }
  console.log(`✅ 提醒展示与用户错误提示：${passed} 项通过（离线）`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
