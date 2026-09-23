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
//   'auto'  = 自动（推荐，默认）：只在开发版显示；体验版 / 正式版自动隐藏
//             —— 体验成员看不到调试入口，避免误点
//   'trial' = 开发版 + 体验版都显示（真机排查时临时改，用完改回 'auto'）
//   true    = 任何环境都显示（本地排查时用）
//   false   = 任何环境都隐藏（提前演练正式版效果）
//
// 💡 体验版想临时自查：在「我的」页连点「关于」5 次即可解锁 24 小时，
//    到期自动失效，不用改代码重新发版。
module.exports = {
  SUBSCRIBE_TEMPLATE_ID: 'zgClp-3rm8ljGYxKarmDkrzA0oZHqbgZHBvKX9RpeaY',   // 留空 = 不发微信推送，闹钟测试只做本地震动+弹窗
  SHOW_DEV_TOOLS: 'auto',
};
