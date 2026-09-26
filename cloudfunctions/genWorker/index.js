// cloudfunctions/genWorker/index.js
// 后台生成任务的「接力员」：每分钟醒一次，把没人接着跑的生成任务继续跑完。
//
// 为什么需要它：
//   云函数单次上限 60s，一份多天行程要 2~4 轮才细化完。以前这个"多跑几轮"的
//   循环写在前端页面里 —— 用户一退出小程序，循环就断了，行程永远停在半成品
//   （只有前几天的条目，没有闹钟和建议）。
//   现在进度写在 gen_jobs 表里：用户在页面上时前端自己接着跑（快，无空档）；
//   用户离开/关掉小程序后，轮到本函数每分钟捞一次"已经没人管了"的任务继续跑，
//   跑完自动把闹钟和建议补上并标记完成。用户回来直接看结果。
//
// ⚠️ 部署：右键本函数 → 上传并部署（云端安装依赖）
// ⚠️ 触发器：config.json 里声明了每分钟的定时触发器；首次上传后要到
//    云开发控制台 → 云函数 → genWorker → 触发器，确认它是「启用」状态。
// ⚠️ 超时时间：保持 60 秒（一次只接手 1 个任务，够用）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COL_JOB = 'gen_jobs';

// 一次只接手一个任务：单个任务一轮最长能跑 55s，本函数自己也有 60s 上限，
// 贪多会让本函数超时（超时还会被平台判定失败重试，反而更乱）。
// 有多个任务排队时，下一分钟自然轮到它们。
const PICK_LIMIT = 1;

exports.main = async (event) => {
  const db = cloud.database();
  const now = Date.now();
  let jobs = [];
  try {
    const res = await db.collection(COL_JOB)
      .where({ status: 'running', leaseUntil: db.command.lt(now) })
      .limit(PICK_LIMIT)
      .get();
    jobs = res.data || [];
  } catch (e) {
    // 集合还没建过（一个任务都没有时会是这样）→ 没有活干，正常返回
    console.log('[genWorker] 暂无待续跑任务:', e.message);
    return { code: 0, picked: 0, results: [] };
  }

  if (!jobs.length) return { code: 0, picked: 0, results: [] };

  const results = [];
  const runnerId = `worker-${now}-${Math.floor(Math.random() * 1000000000)}`;
  for (const job of jobs) {
    try {
      // 云函数间调用拿不到微信上下文，所以把任务归属的 openid 显式带过去；
      // generatePlan 侧还会校验 job._openid 是否一致，冒充不了别人的任务。
      const r = await cloud.callFunction({
        name: 'generatePlan',
        data: { action: 'resume', jobId: job._id, openid: job._openid, runnerId },
      });
      const out = (r && r.result) || {};
      results.push({
        jobId: job._id,
        ok: out.code === 0,
        status: (out.data && out.data.status) || (out.code === 0 ? 'done' : 'error'),
        progress: (out.data && out.data.progress) || null,
        error: out.code === 0 ? '' : (out.msg || 'unknown'),
      });
      console.log('[genWorker] 接手任务 %s → %s', job._id, JSON.stringify(results[results.length - 1]));
    } catch (e) {
      results.push({ jobId: job._id, ok: false, status: 'error', error: e.message });
      console.error('[genWorker] 任务 %s 续跑失败:', job._id, e.message);
    }
  }
  return { code: 0, picked: jobs.length, results };
};
