// cloudfunctions/initdb/index.js
// 数据库初始化 —— 一次性创建所有 collection + 索引
// 调用方式：在小程序里手动 wx.cloud.callFunction({ name: 'initdb' })

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const INIT_VERSION = 'v1.1-safe-init';

// 要建的 collection 列表
const COLLECTIONS = [
  { name: 'users',         desc: '用户档案' },
  { name: 'trips',         desc: '行程主表' },
  { name: 'ticket_alarms', desc: '旅行提醒事项' },
  { name: 'suggestions',   desc: '旅行建议' },
  { name: 'parse_tasks',   desc: '分步解析任务态' },
  { name: 'orders',        desc: '虚拟支付订单' },
  { name: 'quota_logs',    desc: '额度流水（扣费幂等用）' },
  { name: 'gen_jobs',      desc: 'AI 行程后台生成任务' },
  { name: 'schedule_cache', desc: '按日期缓存官方班次' },
];

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || 'system-init';

  const results = [];

  for (const { name, desc } of COLLECTIONS) {
    try {
      // 尝试读取（如果表存在，返回 0 条或现有数据）
      await db.collection(name).limit(1).get();
      results.push({ name, desc, status: 'exists' });
    } catch (err) {
      // 表不存在，createCollection 创建
      if (err.errCode === -502005 || /not exist/i.test(err.errMsg || '')) {
        try {
          await db.createCollection(name);
          results.push({ name, desc, status: 'created' });
        } catch (e2) {
          results.push({ name, desc, status: 'fail', err: e2.errMsg || e2.message });
        }
      } else {
        results.push({ name, desc, status: 'fail', err: err.errMsg || err.message });
      }
    }
  }

  // 生产环境默认不写示例行程，避免初始化账号看到不属于自己的演示数据。
  // 本地演示确实需要时，显式配置 INIT_SAMPLE_TRIP=1 再执行一次即可。
  if (process.env.INIT_SAMPLE_TRIP === '1') {
    try {
      const trips = await db.collection('trips').where({ _openid: openid }).limit(1).get();
      if (!trips.data || trips.data.length === 0) {
        const now = Date.now();
        await db.collection('trips').add({
          data: {
            _openid: openid,
            title: '示例行程 - 删除或编辑',
            summary: '这是初始化的示例行程',
            startDate: '2026-10-01',
            endDate: '2026-10-07',
            items: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        results.push({ name: 'trips-sample', status: 'created' });
      }
    } catch (e) {
      results.push({ name: 'trips-sample', status: 'fail', err: e.errMsg || e.message });
    }
  }

  return {
    code: 0,
    data: { results, openid, version: INIT_VERSION },
    msg: '初始化完成',
  };
};
