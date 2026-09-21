// 本地端到端测试 suggestions 云函数的 dayTips action
// 用法：node test-daytips.js [dayIndex]
// 原理：stub 掉 wx-server-sdk，真实调用 Qwen API，验证完整链路

const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

// 1. 读 Key
const envLocal = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf-8');
const keyMatch = envLocal.match(/LLM_API_KEY\s*=\s*(\S+)/);
if (!keyMatch) {
  console.error('未在 .env.local 找到 LLM_API_KEY');
  process.exit(1);
}
process.env.LLM_API_KEY = keyMatch[1];
process.env.LLM_PROVIDER = 'qwen';
process.env.LLM_MODEL = 'qwen-turbo';

// 2. Stub wx-server-sdk
const tripData = JSON.parse(fs.readFileSync(path.join(__dirname, 'cloudfn-result.json'), 'utf-8'));
tripData._openid = 'test-openid';

const addedDocs = [];
const fakeDb = {
  collection(name) {
    return {
      doc(id) {
        return {
          get: async () => ({ data: id === 'trip1' ? tripData : null }),
        };
      },
      where(cond) {
        return {
          limit() { return this; },
          orderBy() { return this; },
          get: async () => ({ data: [] }),
          remove: async () => ({ stats: { removed: 0 } }),
        };
      },
      add: async ({ data }) => {
        addedDocs.push({ coll: name, data });
        return { _id: 'mock_' + addedDocs.length };
      },
      orderBy() { return this; },
      limit() { return this; },
      get: async () => ({ data: [] }),
    };
  },
  command: {
    neq: (v) => ({ __op: 'neq', v }),
  },
};

const fakeSdk = {
  DYNAMIC_CURRENT_ENV: Symbol('env'),
  init() {},
  getWXContext() { return { OPENID: 'test-openid' }; },
  database() { return fakeDb; },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeSdk;
  return origLoad(request, parent, isMain);
};

// 3. 调用云函数
const fnPath = path.join(ROOT, 'cloudfunctions', 'suggestions', 'index.js');
const fn = require(fnPath);

(async () => {
  const dayIndex = Number(process.argv[2] || 0);
  console.log(`=== dayTips dayIndex=${dayIndex} ===`);
  const t0 = Date.now();
  const res = await fn.main({ action: 'dayTips', tripId: 'trip1', dayIndex });
  const cost = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`耗时: ${cost}s  code: ${res.code}`);
  if (res.code !== 0) {
    console.error('失败:', res.msg);
    process.exit(1);
  }
  console.log('\n--- 建议 tips ---');
  (res.data.tips || []).forEach((t) => console.log(' ✅', t));
  console.log('\n--- 注意事项 notices ---');
  (res.data.notices || []).forEach((t) => console.log(' ⚠️', t));
  console.log(`\n入库文档数: ${addedDocs.length}, kind=${addedDocs[0] && addedDocs[0].data.kind}`);

  // 再验证 get action 不会把 dayTips 文档当总览建议返回（此处 stub 始终返回空，仅验证不报错）
  const g = await fn.main({ action: 'get', tripId: 'trip1' });
  console.log('get action code:', g.code);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
