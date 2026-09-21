// cloudfunctions/_init/index.js
// 数据库初始化 —— 一次性创建所有 collection + 索引
// 调用方式：在小程序里手动 wx.cloud.callFunction({ name: '_init' })

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 要建的 collection 列表
const COLLECTIONS = [
  { name: 'users',         desc: '用户档案' },
  { name: 'trips',         desc: '行程主表' },
  { name: 'ticket_alarms', desc: '抢票闹钟' },
  { name: 'suggestions',   desc: '旅行建议' },
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

  // 给 trips 建一个示例行（避免空表引发其他问题）
  try {
    const trips = await db.collection('trips').limit(1).get();
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

  return {
    code: 0,
    data: { results, openid },
    msg: '初始化完成',
  };
};