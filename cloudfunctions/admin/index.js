// cloudfunctions/admin/index.js
// 管理后台后端：管理员身份、无限使用授权、在线配置（大模型 Key / 高德 Key 等）
//
// 设计目标（生产可用，而不是玩具）：
//   1. 身份用数据库里的 users.role / users.unlimited 表示，而不是写死 openid ——
//      换手机、换环境都不用改代码；
//   2. 第一个管理员靠**一次性认领码**拿到（环境变量 ADMIN_CLAIM_CODE，只配在本函数），
//      用完即废：同一个码第二次来会被拒绝，想再招人就换一个新的码；
//   3. 所有写操作都要过 actor 鉴权 + 审计日志，敏感值**不写进日志**；
//   4. 配置写进 admin_config 集合（权限设为"仅管理端可读写"，小程序端直接读不到），
//      由消费方云函数的 cloudCfg.apply() 拉走，KEY 从不出现在小程序代码里。
//
// ⚠️ 部署：右键本函数 → 上传并部署（云端安装依赖）
// ⚠️ 环境变量：ADMIN_CLAIM_CODE（认领码，认领完可以留着但已失效）
// ⚠️ 数据库：users（加字段）、admin_config（配置）、admin_audit（审计日志，自动建）

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require('https');
const http = require('http');
const { allowed, COL_CONFIG, DOC_ID, resetCache } = require('./cloudCfg');

const ADMIN_VERSION = 'v1.0-admin';

const COL_USER = 'users';
const COL_AUDIT = 'admin_audit';

const db = cloud.database();

// ============================================================
// 可在管理页编辑的配置项（同时也是后端的白名单，防止前端乱塞 key）
// secret=true 的字段返回时脱敏（只留后 4 位），编辑时留空 = 不修改。
// ============================================================
const CONFIG_ITEMS = [
  {
    key: 'LLM_PROVIDER', label: '大模型服务商', secret: false,
    group: 'llm',
    hint: 'qwen / deepseek / hunyuan / minimax；留空则必须填自定义端点',
  },
  {
    key: 'LLM_API_KEY', label: '大模型 API Key', secret: true,
    group: 'llm',
    hint: '填了才生效；留空并保存 = 清掉，回落用云函数环境变量',
  },
  {
    key: 'LLM_MODEL', label: '模型名称', secret: false,
    group: 'llm',
    hint: '留空=用该供应商默认模型。带 qwen3/qwq/r1 等字样的会自动关思考',
  },
  {
    key: 'LLM_BASE_URL', label: '自定义端点（可选）', secret: false,
    group: 'llm',
    hint: '兼容 OpenAI 的端点；填了会覆盖 LLM_PROVIDER 推导出的地址',
  },
  {
    key: 'LLM_ENABLE_SEARCH', label: '联网检索（航班等时刻核对）', secret: false,
    group: 'advanced',
    hint: '留空=默认开启；填 0 关闭（铁路段走 12306 或关也按 0 回落）',
  },
  {
    key: 'LLM_SEARCH_BUDGET_MS', label: '班次检索预算(ms)', secret: false,
    group: 'advanced',
    hint: '默认 26000。超时会静默降级为模型编排，不影响出行程',
  },
  {
    key: 'LLM_TIMEOUT_MS', label: '单次 LLM 超时(ms)', secret: false,
    group: 'advanced',
    hint: '默认 45000。⚠️ 这项在函数启动后 60 秒才可能变（读取时机不同）',
  },
  {
    key: 'LLM_MAX_TOKENS', label: '输出 token 上限', secret: false,
    group: 'advanced',
    hint: '留空/0 = 不限制（推荐，截断会丢行程条目）',
  },
  {
    key: 'AMAP_KEY', label: '高德 Web 服务 Key', secret: true,
    group: 'amap',
    hint: '地理编码用，必须是「Web服务」类型；不填则地图导航走兜底文案',
  },
  {
    key: 'GEOCODE_BUDGET_MS', label: '地理编码预算(ms)', secret: false,
    group: 'advanced',
    hint: '默认 12000。超时的地点前端导航时降级，不影响生成',
  },
  {
    key: 'RAIL12306_ENABLED', label: '直连 12306 查班次', secret: false,
    group: 'advanced',
    hint: '留空=开启（准，但非官方开放接口）；填 0 关闭，退回模型检索',
  },
];

const CONFIG_KEYS = CONFIG_ITEMS.map((i) => i.key);
/** 脱敏标记：前端原样回传这个值时，表示"没改" */
const MASK_PREFIX = '••••';

// ============================================================
// 工具
// ============================================================

function nowTs() { return Date.now(); }

async function ensureColl(name) {
  try {
    await db.createCollection(name);
  } catch (e) {
    // 已存在时会报错，忽略即可
  }
}

async function loadUserByOpenid(openid) {
  const res = await db.collection(COL_USER).where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
  return (res.data && res.data[0]) || null;
}

function isAdminUser(u) { return !!u && (u.role === 'admin' || u.role === 'super'); }

async function requireAdmin(openid) {
  const u = await loadUserByOpenid(openid);
  if (!isAdminUser(u)) return { ok: false, msg: '不是管理员' };
  return { ok: true, user: u };
}

async function requireSuper(openid) {
  const u = await loadUserByOpenid(openid);
  if (!u || u.role !== 'super') return { ok: false, msg: '只有超级管理员能做这个操作' };
  return { ok: true, user: u };
}

/** 审计日志：只记"做了什么"，不记敏感值 */
async function audit(actorOpenid, actorLabel, action, targetLabel, extra) {
  try {
    await db.collection(COL_AUDIT).add({
      data: Object.assign({
        actorOpenid,
        actorLabel: String(actorLabel || ''),
        action,
        targetLabel: String(targetLabel || ''),
        ts: nowTs(),
      }, extra || {}),
    });
  } catch (e) {
    await ensureColl(COL_AUDIT);
    try {
      await db.collection(COL_AUDIT).add({ data: { actorOpenid, action, ts: nowTs() } });
    } catch (e2) {
      console.warn('[admin] 审计写入失败:', e2.message);
    }
  }
}

async function readConfigDoc() {
  try {
    const res = await db.collection(COL_CONFIG).doc(DOC_ID).get();
    return (res && res.data) || {};
  } catch (e) {
    await ensureColl(COL_CONFIG);
    return {};
  }
}

/** 前端展示用的脱敏（只留末尾 4 位） */
function maskTail(v) {
  const s = String(v || '');
  if (!s) return '';
  return MASK_PREFIX + s.slice(-4);
}

function publicUser(u) {
  return {
    userId: u._id,
    nickname: u.nickname || '旅行者',
    avatarUrl: u.avatarUrl || '',
    role: u.role || '',
    isAdmin: isAdminUser(u),
    unlimited: !!u.unlimited,
    unlimitedAt: u.unlimitedAt || 0,
    unlimitedBy: u.unlimitedBy || '',
    totalGen: u.totalGen || 0,
    quota: Math.max(0, u.quota || 0),
    createdAt: u.createdAt || 0,
  };
}

// ============================================================
// Actions
// ============================================================

/** 我是谁 + 平台概况 */
async function actionWhoami(openid) {
  const u = await loadUserByOpenid(openid);
  if (!u) {
    return {
      code: 0,
      data: {
        version: ADMIN_VERSION,
        loggedIn: false, isAdmin: false, isSuper: false, role: '',
        claimEnabled: !!process.env.ADMIN_CLAIM_CODE,
      },
    };
  }
  const [userCount, adminCount, unlimitedCount] = await Promise.all([
    db.collection(COL_USER).count().catch(() => ({ total: 0 })),
    db.collection(COL_USER).where({ role: db.command.in(['admin', 'super']) }).count().catch(() => ({ total: 0 })),
    db.collection(COL_USER).where({ unlimited: true }).count().catch(() => ({ total: 0 })),
  ]);
  return {
    code: 0,
    data: {
      version: ADMIN_VERSION,
      loggedIn: true,
      isAdmin: isAdminUser(u),
      isSuper: u.role === 'super',
      role: u.role || '',
      me: publicUser(u),
      claimEnabled: !!process.env.ADMIN_CLAIM_CODE,
      stats: {
        users: userCount.total || 0,
        admins: adminCount.total || 0,
        unlimited: unlimitedCount.total || 0,
      },
    },
  };
}

/**
 * 认领超级管理员。
 * 只有环境变量 ADMIN_CLAIM_CODE 配了、且这个码还没被用过时才成功。
 * 换一个新码 → 旧的失效记录不再拦新的（used 记录里存的是当时用的码）。
 */
async function actionClaim(openid, event) {
  const expect = String(process.env.ADMIN_CLAIM_CODE || '').trim();
  const code = String((event && event.code) || '').trim();
  if (!expect) {
    return { code: -1, msg: '未开启认领：需在 admin 云函数环境变量配置 ADMIN_CLAIM_CODE' };
  }
  if (!code) return { code: -1, msg: '请输入管理员口令' };

  const cfg = await readConfigDoc();
  const rec = cfg.claim || {};
  if (rec.used && rec.code === expect) {
    return { code: -1, msg: '这个口令已经被用过了，请在云函数环境变量里换一个新的 ADMIN_CLAIM_CODE' };
  }
  if (code !== expect) return { code: -1, msg: '口令不正确' };

  const u = await loadUserByOpenid(openid);
  if (!u) return { code: -1, msg: '还没登录，请先到「我的」页登录' };

  const patch = { role: 'super', adminSince: nowTs() };
  await db.collection(COL_USER).doc(u._id).update({ data: patch });

  await db.collection(COL_CONFIG).doc(DOC_ID).set({
    data: Object.assign({}, cfg, {
      claim: { used: true, code: expect, openid, ts: nowTs() },
      updatedAt: nowTs(),
    }),
  }).catch(async () => {
    await ensureColl(COL_CONFIG);
    await db.collection(COL_CONFIG).doc(DOC_ID).set({
      data: { claim: { used: true, code: expect, openid, ts: nowTs() }, updatedAt: nowTs() },
    });
  });

  await audit(openid, u.nickname || '', 'claim', '成为超级管理员');
  resetCache();
  return { code: 0, data: { ok: true, role: 'super' } };
}

/** 按微信号 / 昵称搜用户 */
async function actionSearchUsers(actorOpenid, event) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const kw = String((event && event.keyword) || '').trim();
  if (!kw) {
    // 不给关键词时返回最近注册的一批，方便直接操作
    const res = await db.collection(COL_USER)
      .orderBy('createdAt', 'desc').limit(20).get().catch(() => ({ data: [] }));
    return { code: 0, data: { list: (res.data || []).map(publicUser) } };
  }
  const res = await db.collection(COL_USER)
    .where({ nickname: db.RegExp({ regexp: kw, options: 'i' }) })
    .limit(20)
    .get()
    .catch(() => ({ data: [] }));
  return { code: 0, data: { list: (res.data || []).map(publicUser) } };
}

/** 授权 / 取消授权「不限量使用」 */
async function actionSetUnlimited(actorOpenid, event) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const userId = String((event && event.userId) || '');
  const enable = event && event.enable !== false;
  if (!userId) return { code: -1, msg: '缺少用户 ID' };

  const target = await db.collection(COL_USER).doc(userId).get().catch(() => null);
  const targetUser = target && target.data;
  if (!targetUser) return { code: -1, msg: '用户不存在' };
  // 管理员自己天然无限，不需要单独授权（也不允许被取消）
  if (isAdminUser(targetUser)) {
    return { code: -1, msg: '该用户是管理员，本身就无限使用' };
  }

  const patch = enable
    ? { unlimited: true, unlimitedAt: nowTs(), unlimitedBy: auth.user.nickname || '管理员' }
    : { unlimited: false, unlimitedAt: 0, unlimitedBy: '' };
  await db.collection(COL_USER).doc(userId).update({ data: patch });
  await audit(actorOpenid, auth.user.nickname || '', enable ? 'grant' : 'revoke',
    String(targetUser.nickname || userId));

  return {
    code: 0,
    data: { ok: true, user: publicUser(Object.assign({}, targetUser, patch)) },
  };
}

/** 管理员名单 */
async function actionListStaff(actorOpenid) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const res = await db.collection(COL_USER)
    .where({ role: db.command.in(['admin', 'super']) })
    .limit(50).get().catch(() => ({ data: [] }));
  return { code: 0, data: { list: (res.data || []).map(publicUser) } };
}

/** 增删管理员（只有超级管理员能做，且不允许把自己降掉） */
async function actionSetAdmin(actorOpenid, event) {
  const auth = await requireSuper(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const userId = String((event && event.userId) || '');
  const isAdmin = event && event.isAdmin !== false;
  if (!userId) return { code: -1, msg: '缺少用户 ID' };
  if (userId === auth.user._id) return { code: -1, msg: '不能变更自己的管理员身份' };

  const target = await db.collection(COL_USER).doc(userId).get().catch(() => null);
  const targetUser = target && target.data;
  if (!targetUser) return { code: -1, msg: '用户不存在' };

  const patch = isAdmin ? { role: 'admin', adminSince: nowTs() } : { role: '' };
  await db.collection(COL_USER).doc(userId).update({ data: patch });
  await audit(actorOpenid, auth.user.nickname || '', isAdmin ? 'addAdmin' : 'removeAdmin',
    String(targetUser.nickname || userId));
  return { code: 0, data: { ok: true, user: publicUser(Object.assign({}, targetUser, patch)) } };
}

/** 配置项清单（含当前生效值，敏感项脱敏） */
async function actionGetConfig(actorOpenid) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const cfg = await readConfigDoc();
  const over = (cfg && typeof cfg.over === 'object' && cfg.over) || {};
  const items = CONFIG_ITEMS.map((it) => {
    const raw = Object.prototype.hasOwnProperty.call(over, it.key)
      ? String(over[it.key] || '') : String(process.env[it.key] || '');
    return {
      key: it.key,
      label: it.label,
      hint: it.hint || '',
      secret: !!it.secret,
      value: it.secret ? maskTail(raw) : raw,
      hasValue: !!raw,
      overridden: Object.prototype.hasOwnProperty.call(over, it.key),
    };
  });
  return {
    code: 0,
    data: {
      items,
      updatedAt: (cfg && cfg.updatedAt) || 0,
      updatedBy: (cfg && cfg.updatedBy) || '',
      version: ADMIN_VERSION,
    },
  };
}

/** 保存配置 patch（{} 表示清空该项，落到云函数环境变量兜底） */
async function actionSaveConfig(actorOpenid, event) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const patch = (event && event.patch && typeof event.patch === 'object') ? event.patch : {};
  const cfg = await readConfigDoc();
  const over = Object.assign({}, (cfg && typeof cfg.over === 'object' && cfg.over) || {});

  const changed = [];
  const refused = [];
  Object.keys(patch).forEach((k) => {
    // 双重校验：既要在本文件的白名单里，也要通过 cloudCfg 的 allowed（防前端绕过）
    if (CONFIG_KEYS.indexOf(k) < 0 || !allowed(k)) { refused.push(k); return; }
    const v = String(patch[k] == null ? '' : patch[k]).trim();
    if (v.indexOf(MASK_PREFIX) === 0) return;          // 没改，原样回传的脱敏值
    if (v) over[k] = v;
    else delete over[k];                                // 清空 = 交还给环境变量
    changed.push(k);
  });

  const next = Object.assign({}, cfg, {
    over,
    updatedAt: nowTs(),
    updatedBy: auth.user && (auth.user.nickname || auth.user._id) || '',
  });
  // doc().get() 读回的数据带 _id，set 的 data 里不允许出现（-501007 invalid param），必须剥掉
  delete next._id;
  await db.collection(COL_CONFIG).doc(DOC_ID).set({ data: next }).catch(async () => {
    await ensureColl(COL_CONFIG);
    await db.collection(COL_CONFIG).doc(DOC_ID).set({ data: next });
  });

  resetCache();
  // ⚠️ 审计只记键名，绝不记值（里面可能有 API Key）
  if (changed.length) {
    await audit(actorOpenid, auth.user.nickname || '', 'saveConfig', changed.join(','),
      { count: changed.length });
  }
  return {
    code: 0,
    data: { ok: true, changed, refused, tip: '最长 60 秒内在所有云函数实例上生效' },
  };
}

/** 审计日志 */
async function actionAuditList(actorOpenid) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const res = await db.collection(COL_AUDIT)
    .orderBy('ts', 'desc').limit(30).get().catch(() => ({ data: [] }));
  return { code: 0, data: { list: (res.data || []).map((a) => ({
    action: a.action, actorLabel: a.actorLabel || '', targetLabel: a.targetLabel || '', ts: a.ts,
  })) } };
}

/** 清空审计日志（仅超级管理员）。清完留一条「清空日志」记录，留个痕迹 */
async function actionClearAudit(actorOpenid) {
  const auth = await requireSuper(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const _ = db.command;
  const res = await db.collection(COL_AUDIT).where({ ts: _.gte(0) }).remove();
  const removed = (res && res.stats && res.stats.removed) || 0;
  await audit(actorOpenid, auth.user.nickname || '', 'clearLogs', `${removed}条`);
  return { code: 0, data: { ok: true, removed } };
}

// ============================================================
// 连通性测试（用「即将生效的最终配置」测，而不是用本函数的环境变量）
// ============================================================

/** 有效值：远程覆盖优先，其次本函数环境变量 */
async function effective(key) {
  const cfg = await readConfigDoc();
  const over = (cfg && typeof cfg.over === 'object' && cfg.over) || {};
  if (Object.prototype.hasOwnProperty.call(over, key)) return String(over[key] || '');
  return String(process.env[key] || '');
}

function httpPost(urlStr, bodyObj, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(bodyObj);
    const started = Date.now();
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, headers || {}),
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data, ms: Date.now() - started }));
    });
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data, ms: Date.now() - started }));
    });
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** provider → 端点（必须与 generatePlan/llm.js 的映射保持一致） */
function baseUrlOf(provider, custom) {
  if (custom) return custom;
  switch (String(provider || 'auto').toLowerCase()) {
    case 'deepseek': return 'https://api.deepseek.com/v1';
    case 'qwen': return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    case 'hunyuan': return 'https://api.hunyuan.tencent.com/v1';
    case 'minimax': return 'https://api.minimaxi.com/v1';
    default: return '';
  }
}

/** provider → 默认模型（与 generatePlan/llm.js 的 getModel 保持一致） */
function modelOf(provider) {
  switch (String(provider || 'auto').toLowerCase()) {
    case 'deepseek': return 'deepseek-chat';
    case 'qwen': return 'qwen-turbo';
    case 'hunyuan': return 'hunyuan-pro';
    case 'minimax': return 'MiniMax-M3';
    default: return '';
  }
}

async function actionTestLlm(actorOpenid) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const [apiKey, baseURL, model, provider] = await Promise.all([
    effective('LLM_API_KEY'), effective('LLM_BASE_URL'), effective('LLM_MODEL'), effective('LLM_PROVIDER'),
  ]);
  const base = baseUrlOf(provider, baseURL);
  // 模型没填就按 provider 用默认（与生成侧一致），没有默认才要求显式填
  const effModel = model || modelOf(provider);
  if (!apiKey) return { code: -1, msg: '还没填大模型 API Key' };
  if (!base) return { code: -1, msg: '还缺供应商：填 LLM_PROVIDER（qwen / deepseek / hunyuan / minimax），或自定义 LLM_BASE_URL' };
  if (!effModel) return { code: -1, msg: '还没填模型名称（LLM_MODEL），且该供应商没有默认模型' };

  try {
    const r = await httpPost(`${base}/chat/completions`, {
      model: effModel,
      messages: [{ role: 'user', content: '说"OK"两个字' }],
      max_tokens: 16,
    }, { Authorization: `Bearer ${apiKey}` }, 20000);
    if (r.status >= 200 && r.status < 300) {
      return { code: 0, data: { ok: true, ms: r.ms, model: effModel, base, msg: '大模型连通正常' } };
    }
    return { code: -1, msg: `HTTP ${r.status}: ${r.data.slice(0, 200)}` };
  } catch (e) {
    return { code: -1, msg: e.message || '连通失败' };
  }
}

async function actionTestAmap(actorOpenid) {
  const auth = await requireAdmin(actorOpenid);
  if (!auth.ok) return { code: -1, msg: auth.msg };
  const key = await effective('AMAP_KEY');
  if (!key) return { code: -1, msg: '还没填高德 Key' };
  try {
    const r = await httpGet(
      `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent('解放碑')}&city=${encodeURIComponent('重庆')}&key=${encodeURIComponent(key)}`,
      15000,
    );
    if (r.status >= 200 && r.status < 300) {
      const parsed = JSON.parse(r.data);
      if (parsed.status === '1') {
        const p = (parsed.geocodes || [])[0] || {};
        return { code: 0, data: { ok: true, ms: r.ms, location: p.location || '', msg: '高德 Key 正常' } };
      }
      return { code: -1, msg: `高德返回：${parsed.info || r.data.slice(0, 120)}（status=${parsed.status}）` };
    }
    return { code: -1, msg: `HTTP ${r.status}` };
  } catch (e) {
    return { code: -1, msg: e.message || '连通失败' };
  }
}

async function actionDiag() {
  const cfg = await readConfigDoc();
  const over = (cfg && typeof cfg.over === 'object' && cfg.over) || {};
  return {
    code: 0,
    data: {
      version: ADMIN_VERSION,
      claimEnabled: !!process.env.ADMIN_CLAIM_CODE,
      claimUsed: !!(cfg.claim && cfg.claim.used),
      overriddenKeys: Object.keys(over),
      allowedKeys: CONFIG_KEYS,
    },
  };
}

// ============================================================
// 入口
// ============================================================

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = String((event && event.action) || 'whoami');

  // 云端自检：不需要登录（不返回任何用户数据，只说配了什么）
  if (action === 'diag') return await actionDiag();

  if (!openid) return { code: -1, msg: '未登录' };

  try {
    switch (action) {
      case 'whoami': return await actionWhoami(openid);
      case 'claim': return await actionClaim(openid, event);
      case 'searchUsers': return await actionSearchUsers(openid, event);
      case 'setUnlimited': return await actionSetUnlimited(openid, event);
      case 'listStaff': return await actionListStaff(openid);
      case 'setAdmin': return await actionSetAdmin(openid, event);
      case 'getConfig': return await actionGetConfig(openid);
      case 'saveConfig': return await actionSaveConfig(openid, event);
      case 'auditList': return await actionAuditList(openid);
      case 'clearAudit': return await actionClearAudit(openid);
      case 'testLlm': return await actionTestLlm(openid);
      case 'testAmap': return await actionTestAmap(openid);
      default: return { code: -1, msg: `未知 action：${action}` };
    }
  } catch (e) {
    console.error('[admin] %s error:', action, e);
    return { code: -1, msg: e.message || '管理服务异常' };
  }
};
