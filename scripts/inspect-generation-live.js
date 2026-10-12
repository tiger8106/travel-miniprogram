// 只读当前管理员账号最近的生成任务；不调用 resume、不生成、不部署、不扣额度。
const assert = require('assert');
const path = require('path');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const automator = require(option('--automator', 'miniprogram-automator'));
const appid = require(path.resolve(__dirname, '../project.config.json')).appid;
(async () => {
  let timer;
  const bounded = (promise, ms) => Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('开发者工具连接/读取超时')), ms);
  })]).finally(() => clearTimeout(timer));
  const mini = await bounded(automator.connect({ wsEndpoint: option('--ws', 'ws://127.0.0.1:9420') }), 15000);
  try {
    const report = await bounded(mini.evaluate(async (versionOnly) => {
      const identity = await wx.cloud.callFunction({ name: 'admin', data: { action: 'identity' } });
      if (!identity.result || identity.result.code !== 0 || !identity.result.data.isAdmin) throw new Error('当前不是管理员账号');
      const own = getApp().globalData.openid;
      if (!own) throw new Error('当前账号未登录');
      if (versionOnly) {
        const diagnostic = await wx.cloud.callFunction({ name: 'generatePlan', data: { action: 'diag', ping: false } });
        const status = await wx.cloud.callFunction({ name: 'generatePlan', data: { action: 'jobStatus' } });
        const job = status.result?.data?.job;
        return { appid: wx.getAccountInfoSync().miniProgram.appId, version: diagnostic.result?.data?.version,
          activeJob: job ? { status: job.status, round: job.round, progress: job.progress, error: job.error } : null };
      }
      const result = await wx.cloud.callFunction({ name: 'generatePlan', data: { action: 'inspectJobs' } });
      if (!result.result || result.result.code !== 0) throw new Error(result.result?.msg || '请先部署支持只读摘要的 generatePlan');
      return { appid: wx.getAccountInfoSync().miniProgram.appId, ...result.result.data };
    }, args.includes('--version-only')), 20000);
    assert.equal(report.appid, appid, '连接到其它项目');
    console.log(JSON.stringify(report, null, 2));
  } finally { await mini.disconnect(); }
})().catch((error) => { console.error('生成任务只读检查失败：' + error.message); process.exit(1); });
