// cloudfunctions/<消费方>/cloudCfg.js
// 远程配置下发：管理后台改出来的配置，要能在云函数里生效，而不用改环境变量再重新部署。
//
// 原理（这个项目能零侵入做配置中心的唯一原因）：
//   云函数的 process.env 是**可写的**，而下游模块（llm.js / schedule.js / plan.js 等）
//   都是在**调用时**才读 process.env（不是模块加载时固化）。所以只要在业务逻辑开始前
//   把数据库里的覆盖值写进 process.env，下游一行代码都不用改。
//
// 四条设计约束（改这个文件时要一起守）：
//   1. 白名单：只允许覆盖配置类变量。支付/内部令牌类（XPAY_* / MP_* / INTERNAL_TOKEN /
//      ADMIN_*）**永不允许**从管理页改——谁也不该因为误填一格就把线上支付搞挂。
//   2. 失败静止：读不到库、集合不存在、超时 → 一律静默沿用环境变量，绝对不能影响生成。
//   3. 有缓存：60 秒本地缓存 + 失败 10 秒冷却，别每个请求都打数据库。
//   4. 空串=关闭：值为空字符串时 delete process.env[k]，才能真正把手上的能力关掉
//      （比如把 LLM_ENABLE_SEARCH 清空恢复默认，而不是留一个脏值）。
//
// ⚠️ 本文件在 generatePlan / parseTravelPlan / suggestions 里各有一份（云函数各自打包，
//    不跨目录引用），改一处必须同步三处 —— scripts/check-bindings.js 有断言盯着。

const cloud = require('wx-server-sdk');

const COL_CONFIG = 'admin_config';
const DOC_ID = 'global';
const TTL_MS = 60 * 1000;        // 配置生效延迟上限：改完最多 1 分钟内生效
const FAIL_COOLDOWN_MS = 10 * 1000;

// 允许远程覆盖的前缀（配置类）
const ALLOW_PREFIX = ['LLM_', 'AMAP_'];
// 允许远程覆盖的显式名单（不属于上面前缀，但也是纯配置）
const ALLOW_EXPLICIT = ['GEOCODE_BUDGET_MS', 'RAIL12306_ENABLED'];
// 永不允远程覆盖（兜底：这些一旦被改可能造成资损或安全事件）
const FORBID_PREFIX = ['XPAY_', 'MP_', 'INTERNAL_', 'ADMIN_', 'OPENID', 'WX_', 'TOKEN'];

let cache = { ts: 0, over: null };
let lastFailTs = 0;

/** 能不能被远程覆盖（白名单 + 黑名单 + 变量名形态三重判定） */
function allowed(key) {
  const k = String(key || '');
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(k)) return false;
  if (FORBID_PREFIX.some((p) => k.indexOf(p) === 0)) return false;
  return ALLOW_PREFIX.some((p) => k.indexOf(p) === 0) || ALLOW_EXPLICIT.indexOf(k) >= 0;
}

async function fetchOverrides() {
  const now = Date.now();
  if (cache.over && now - cache.ts < TTL_MS) return cache.over;
  if (lastFailTs && now - lastFailTs < FAIL_COOLDOWN_MS) return cache.over || {};
  const db = cloud.database();
  const res = await db.collection(COL_CONFIG).doc(DOC_ID).get();
  const data = (res && res.data) || {};
  const over = (data && typeof data.over === 'object' && data.over) || {};
  cache = { ts: now, over };
  return over;
}

/**
 * 把远程配置写进 process.env（幂等，可重复调用）
 * @param {boolean} [force] 跳过缓存强制重拉（管理页改完想立刻看效果时用）
 * @returns {Promise<{ok:boolean, count:number}>}
 */
async function apply(force) {
  if (force) cache = { ts: 0, over: null };
  try {
    const over = await fetchOverrides();
    let count = 0;
    Object.keys(over).forEach((k) => {
      if (!allowed(k)) return;
      const v = over[k] == null ? '' : String(over[k]);
      if (v) process.env[k] = v;
      else delete process.env[k];
      count++;
    });
    if (count) console.log('[cloudCfg] 已应用 %d 项远程配置', count);
    return { ok: true, count };
  } catch (e) {
    // 最常见的错是集合还没建：这种情况静默走环境变量，等管理员在后台建好了自然生效
    lastFailTs = Date.now();
    console.warn('[cloudCfg] 远程配置不可用，沿用环境变量:', e.message);
    return { ok: false, count: 0 };
  }
}

/** 测试用：清掉缓存 */
function resetCache() { cache = { ts: 0, over: null }; lastFailTs = 0; }

module.exports = { apply, allowed, fetchOverrides, resetCache, COL_CONFIG, DOC_ID };
