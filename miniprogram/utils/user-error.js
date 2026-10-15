// 原始 SDK/云函数异常只写开发日志，不向用户回显端点、版本、调用轨迹等诊断。
function userErrorMessage(error, fallback) {
  const raw = String(error && (error.errMsg || error.message) || error || '');
  if (/额度|次数.*(?:用完|不足)|每日.*上限/.test(raw)) return '可用次数不足，请查看我的额度。';
  if (/未登录|请先登录|登录.*失效/.test(raw)) return '请重新登录后再试。';
  if (/文件.*(?:过大|太大)|size.*limit/i.test(raw)) return '文件过大，请精简后重新上传。';
  if (/不支持.*(?:文件|格式)|仅支持.*(?:doc|文档)/i.test(raw)) return '请上传支持的 Word 攻略文件。';
  // SDK 的 poll result expired 只表示本次取结果超时，不代表持久化任务已失效。
  if (/^(?:解析|大纲)?任务(?:已)?(?:过期|失效|不存在)/.test(raw)) return '暂时无法读取任务，请重新登录或稍后重试。';
  return fallback || '暂时无法完成，请稍后重试。';
}

module.exports = { userErrorMessage };
