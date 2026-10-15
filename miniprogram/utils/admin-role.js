// 管理入口的本地展示提示：按 openid 缓存，进“我的”时同步渲染；
// 云端每次管理操作仍重新验 users.role，缓存绝不是权限凭证。
const api = require('../services/api');
const PREFIX = 'admin_role_hint_v1_';
const inflight = new Map();
const generations = new Map();

function advance(openid) {
  generations.set(openid, (generations.get(openid) || 0) + 1);
}

function cached(openid) {
  if (!openid) return false;
  try {
    const value = wx.getStorageSync(PREFIX + openid);
    return !!(value && value.isAdmin === true);
  } catch (e) { return false; }
}

function remember(openid, isAdmin) {
  if (!openid || typeof isAdmin !== 'boolean') return;
  advance(openid);
  try { wx.setStorageSync(PREFIX + openid, { isAdmin, checkedAt: Date.now() }); } catch (e) {}
}

function clear(openid) {
  if (!openid) return;
  advance(openid);
  try { wx.removeStorageSync(PREFIX + openid); } catch (e) {}
}

function refresh(openid) {
  if (!openid || !api.adminRole) return Promise.resolve(false);
  if (inflight.has(openid)) return inflight.get(openid);
  const generation = generations.get(openid) || 0;
  const request = Promise.resolve().then(() => api.adminRole()).then((result) => {
    const body = result && result.data && typeof result.data === 'object' ? result.data : result;
    if (!body || typeof body.isAdmin !== 'boolean') throw new Error('管理员身份响应无效');
    // 请求飞行期间可能退出或换账号；旧账号的回包不可污染新账号入口。
    if (wx.getStorageSync('__openid_cache__') !== openid || (generations.get(openid) || 0) !== generation) {
      return cached(openid);
    }
    remember(openid, body.isAdmin);
    return body.isAdmin;
  }).finally(() => inflight.delete(openid));
  inflight.set(openid, request);
  return request;
}

module.exports = { cached, remember, clear, refresh };
