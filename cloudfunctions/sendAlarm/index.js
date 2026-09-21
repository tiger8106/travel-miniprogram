// cloudfunctions/sendAlarm/index.js
// 定时触发器：每分钟检查一次到点的闹钟，推送通知
// 在云函数后台配置定时触发器，cron: "0 * * * * * *"（每分钟）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL = 'ticket_alarms';

// 诊断标记：改一次升一次，用来确认线上跑的是不是最新代码
const DEPLOY_TAG = 'v3-layout';

exports.main = async (event, context) => {
  // action = 'test'：立即给当前用户推一条订阅消息（闹钟页「测试」按钮用）
  // action = 'status'：只做体检，不发消息，返回模板/布局/openid 等诊断信息
  if (event && event.action === 'test') {
    return await sendTestNow(event);
  }
  if (event && event.action === 'status') {
    return await diagnose(event);
  }

  return await pollAndPush();
};

// ---------- 体检：不发消息，只回报配置是否正确 ----------
async function diagnose({ templateId }) {
  const wxContext = cloud.getWXContext();
  const envTmpl = process.env.SUBSCRIBE_TEMPLATE_ID || '';
  const tmplId = templateId || envTmpl;
  let tmplOk = false;
  let tmplState = '未获取';

  // 查一下这个模板在账号下是否真的存在（通过/审核中/被拒）
  if (tmplId) {
    try {
      const list = await cloud.openapi.subscribeMessage.getTemplateList({});
      const hit = ((list && list.data) || []).find((t) => t.priTmplId === tmplId);
      if (hit) {
        tmplOk = true;
        tmplState = `模板已生效：${hit.title || '日程提醒'}`;
      } else {
        tmplState = '后台「我的模板」里查不到这个 ID（填错了，或模板还没审核通过）';
      }
    } catch (err) {
      tmplState = '查询接口受限（-604101），不影响推送，以「测试」结果为准';
    }
  }

  const openid = wxContext.OPENID || '';
  return {
    code: 0,
    data: {
      deployTag: DEPLOY_TAG,
      hasTemplateId: !!tmplId,
      templateIdTail: tmplId ? tmplId.slice(-6) : '',
      templateFromEnv: !!envTmpl,
      tmplState,
      tmplOk,
      layout: process.env.SUBSCRIBE_LAYOUT || '(自动探测)',
      openidTail: openid ? openid.slice(-6) : '',
      now: Date.now(),
    },
  };
}

// ---------- 立即推送（测试用） ----------
// 模板 ID 取值优先级：前端 config.js 带过来 > 云函数环境变量
// 字段布局优先级：event.layout > 环境变量 SUBSCRIBE_LAYOUT > 自动探测（47003 时逐个试）
async function sendTestNow({ title, note, fireAt, templateId, layout, probe }) {
  const wxContext = cloud.getWXContext();
  const tmplId = templateId || process.env.SUBSCRIBE_TEMPLATE_ID;
  if (!tmplId) {
    return { code: -1, msg: '没拿到模板 ID：请填 miniprogram/config.js 的 SUBSCRIBE_TEMPLATE_ID' };
  }
  const ts = Number(fireAt) || Date.now();
  const vals = {
    title: String(title || '行程提醒').slice(0, 20),
    date: formatDate(ts),
    time: formatTime(ts),
    note: String(note || '点击查看详情').slice(0, 20),
  };

  const ordered = [];
  if (layout) ordered.push(layout);
  if (process.env.SUBSCRIBE_LAYOUT) ordered.push(process.env.SUBSCRIBE_LAYOUT);
  Object.keys(LAYOUTS).forEach((k) => ordered.push(k));

  // probe=1 或没指定 layout 时，逐个试；否则只试指定的第一个
  const tryAll = probe === 1 || probe === '1' || !layout;
  const list = tryAll ? ordered : [ordered[0]];

  let lastErr = null;
  for (const key of list) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: wxContext.OPENID,
        templateId: tmplId,
        page: 'pages/tickets/tickets',
        data: LAYOUTS[key](vals),
      });
      console.log('[sendAlarm:test] 推送成功，字段布局 =', key);
      return {
        code: 0,
        data: {
          layout: key,
          deployTag: DEPLOY_TAG,
          templateIdTail: tmplId.slice(-6),
          openidTail: (wxContext.OPENID || '').slice(-6),
          sentAt: ts,
        },
      };
    } catch (err) {
      lastErr = err;
      console.error('[sendAlarm:test] 布局', key, '失败:', err.errCode, err.errMsg || err.message);
      // 只有字段不匹配才继续试下一种布局；授权/额度类错误直接返回
      if (!isFieldMismatch(err)) break;
    }
  }
  return { code: -1, msg: explainError(lastErr) };
}

// 常见字段布局：H 是后台实际模板（571 日程提醒）的字段，永远第一个试
const LAYOUTS = {
  H_thing2_date4_time30_thing11: (v) => ({
    thing2: { value: v.title }, date4: { value: v.date },
    time30: { value: v.time }, thing11: { value: v.note },
  }),
  A_thing1_date2_time3_thing4: (v) => ({
    thing1: { value: v.title }, date2: { value: v.date },
    time3: { value: v.time }, thing4: { value: v.note },
  }),
  B_thing1_time2_date3_thing4: (v) => ({
    thing1: { value: v.title }, time2: { value: v.time },
    date3: { value: v.date }, thing4: { value: v.note },
  }),
  C_thing1_thing2_date3_time4: (v) => ({
    thing1: { value: v.title }, thing2: { value: v.note },
    date3: { value: v.date }, time4: { value: v.time },
  }),
  D_thing1_date2_thing3_time4: (v) => ({
    thing1: { value: v.title }, date2: { value: v.date },
    thing3: { value: v.note }, time4: { value: v.time },
  }),
  E_thing1_time2_thing3_date4: (v) => ({
    thing1: { value: v.title }, time2: { value: v.time },
    thing3: { value: v.note }, date4: { value: v.date },
  }),
  F_thing1_thing2_thing3_thing4: (v) => ({
    thing1: { value: v.title }, thing2: { value: v.note },
    thing3: { value: v.date }, thing4: { value: v.time },
  }),
  G_thing1_thing2_thing3: (v) => ({
    thing1: { value: v.title }, thing2: { value: v.note },
    thing3: { value: `${v.date} ${v.time}` },
  }),
};

// 47003 = 模板参数不准确（字段缺失或类型不匹配），值得换布局重试
function isFieldMismatch(err) {
  return !err || !err.errCode || err.errCode === 47003 || err.errCode === 47001;
}

function explainError(err) {
  const code = err && err.errCode;
  const raw = (err && (err.errMsg || err.message)) || '推送失败';
  const known = {
    40001: 'access_token 无效 —— 云函数权限问题，重新部署一次即可',
    40003: 'OPENID 无效',
    41030: 'page 路径错误（pages/tickets/tickets 未在 app.json 注册）',
    43101: '用户没有订阅额度：测试授权弹窗里要勾选「总是保持以上选择」并点允许；一次性订阅只能用一次',
    47003: '模板字段不匹配：请把小程序后台「我的模板」里的关键词列表截图发我，或告诉我每个关键词前面的编号（如 thing1/date2）',
    48001: 'API 功能未授权',
  };
  const tip = known[code] || '';
  return `错误码 ${code || '-'}：${raw}${tip ? '\n\n💡 ' + tip : ''}`;
}

// ---------- 定时轮询（每分钟） ----------
async function pollAndPush() {
  const now = Date.now();
  const tenMinLater = now + 10 * 60 * 1000;
  const db = cloud.database();
  const _ = db.command;

  // 查找在 [now - 5min, now + 10min] 区间内的闹钟
  const window = [
    now - 5 * 60 * 1000,
    tenMinLater,
  ];

  try {
    const res = await db.collection(COL)
      .where({
        fireAt: _.and(_.gte(window[0]), _.lte(window[1])),
        notified: _.neq(true),
      })
      .limit(100)
      .get();

    if (!res.data || !res.data.length) {
      return { code: 0, data: { sent: 0 } };
    }

    let sent = 0;
    for (const alarm of res.data) {
      try {
        const layoutKey = process.env.SUBSCRIBE_LAYOUT || 'H_thing2_date4_time30_thing11';
        const build = LAYOUTS[layoutKey] || LAYOUTS.H_thing2_date4_time30_thing11;
        const vals = {
          title: String(alarm.title || '行程提醒').slice(0, 20),
          date: formatDate(alarm.fireAt),
          time: formatTime(alarm.fireAt),
          note: String(alarm.note || '点击查看详情').slice(0, 20),
        };
        await cloud.openapi.subscribeMessage.send({
          touser: alarm._openid,
          templateId: process.env.SUBSCRIBE_TEMPLATE_ID || '',
          page: 'pages/tickets/tickets',
          data: build(vals),
        });
        // 标记已通知
        await db.collection(COL).doc(alarm._id).update({
          data: { notified: true, notifiedAt: now },
        });
        sent++;
      } catch (err) {
        console.error('推送失败:', alarm._id, err.message);
      }
    }

    return { code: 0, data: { sent, total: res.data.length } };
  } catch (err) {
    console.error('[sendAlarm]', err);
    return { code: -1, msg: err.message };
  }
};

function pad(n) { return n < 10 ? '0' + n : '' + n; }
// 服务器是 UTC，推送文案里的日期/时间必须按北京时间（UTC+8）格式化
function formatDate(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function formatTime(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}