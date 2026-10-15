// 定时接力上传攻略解析：每分钟推进一项，用户离开或退出小程序后仍持续运行。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const db = cloud.database();
  let tasks;
  try {
    const result = await db.collection('parse_tasks')
      .where({ status: 'running', leaseUntil: db.command.lt(Date.now()) })
      .limit(1).get();
    tasks = result.data || [];
  } catch (e) {
    console.log('[parseWorker] 暂无可接力任务:', e.message);
    return { code: 0, picked: 0 };
  }
  if (!tasks.length) return { code: 0, picked: 0 };
  const task = tasks[0];
  try {
    const response = await cloud.callFunction({
      name: 'parseTravelPlan',
      data: { action: 'resume', taskId: task._id, openid: task._openid },
    });
    return { code: 0, picked: 1, taskId: task._id,
      status: response && response.result && response.result.data && response.result.data.status || 'unknown' };
  } catch (e) {
    console.error('[parseWorker] 接力失败:', e.message);
    return { code: -1, picked: 1, taskId: task._id, msg: e.message };
  }
};
