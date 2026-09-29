// miniprogram/config.js
// ⚙️ 全局配置（小程序端）
//
// 📩 订阅消息模板 ID 配置方法：
//   1. 登录 mp.weixin.qq.com → 功能 → 订阅消息 → 「我的模板」→ 添加
//   2. 选一个「提醒」类目的模板，字段建议包含：事项(thing)、日期(date)、时间(time)、备注(thing)
//   3. 把模板 ID（形如 XXXXXXXXXXXXXXXXXXX-xxxxxx）填到下面
//   4. 同时在云函数 sendAlarm 的「云端安装依赖 → 配置 → 环境变量」里
//      配置 SUBSCRIBE_TEMPLATE_ID = 同一个值
//   ⚠️ 模板字段顺序若与代码里 thing1/date2/time3/thing4 不一致，推送会报 47003，
//      告诉阿稳实际模板字段，我来对齐。
//
// 🧪 开发者功能开关（推送自检、闹钟「测试」按钮）：
//   'auto'  = 自动（开发时推荐）：只在开发版显示；体验版 / 正式版自动隐藏
//   'trial' = 开发版 + 体验版都显示（真机排查时临时改，用完改回 'auto'）
//   true    = 任何环境都显示（本地排查时用）
//   false   = 任何环境都隐藏 ← **部署 / 上线时保持这个值**
//
// ⚠️ 上线态为 false：调试入口在所有环境（含开发版）都不渲染。
//    以前那套「连点关于 5 次解锁 24 小时」的隐藏入口已删除，不要再找它——
//    真要临时排查，把这行改成 'trial' 或 true，排查完改回 false 重新编译。
//
// 🏷 关于弹窗的文案（版本 / 出品方）也在这里维护：
//    ⚠️ APP_VERSION 每次上传发布时手动同步成你填的版本号（微信不会把
//    上传时填的版本号暴露给代码，只能自己维护一致）。
module.exports = {
  SUBSCRIBE_TEMPLATE_ID: 'zgClp-3rm8ljGYxKarmDkrzA0oZHqbgZHBvKX9RpeaY',   // 留空 = 不发微信推送，闹钟测试只做本地震动+弹窗
  SHOW_DEV_TOOLS: false,   // ⚠️ 上线态：任何环境都隐藏调试入口（开发自测时改 'auto'）

  // —— 关于弹窗 ——
  APP_NAME: '微信旅游小程序',
  APP_VERSION: '1.0.0',      // 发布时与开发者工具上传时填的版本号保持一致
  APP_BRAND: 'Tiger 出品',
};
