// 兼容旧版特权用户：成功生成已写 quota_logs，但 users.totalGen 没有递增。
async function generationCount(db, user) {
  const stored = Math.max(0, Number(user && user.totalGen) || 0);
  if (!user || !user._openid) return stored;
  try {
    const result = await db.collection('quota_logs')
      .where({ _openid: user._openid, action: 'consume' }).count();
    return Math.max(stored, Number(result && result.total) || 0);
  } catch (e) {
    console.warn('[admin] 读取生成流水失败，沿用用户统计:', e.message);
    return stored;
  }
}

module.exports = { generationCount };
